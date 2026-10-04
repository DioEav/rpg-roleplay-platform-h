"""真摘要压缩第二步:归档扫描写 summary_pending 任务,收尾 LLM 精修覆盖机械保底。

纪律验证:精修失败/关闭/无模型 → 保底摘要仍在且绝不抛异常;attempts 封顶防坏
模型反复烧 token;成功 → 覆盖保底并清任务(Phase 5 随回合持久化)。
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agents._harness as harness_mod  # noqa: E402
import agents.recorder as recorder_mod  # noqa: E402
import platform_app.settings as settings_mod  # noqa: E402
from chat_pipeline.memory_summary import (  # noqa: E402
    _MAX_ATTEMPTS,
    _build_prompts,
    _sanitize_summary,
    refine_pending_summary,
)
from context_providers.memory import _maybe_auto_archive  # noqa: E402
from schemas.memory import MemorySettings  # noqa: E402


class _State:
    def __init__(self, data):
        self.data = data


def _fact(i: int) -> str:
    return f"第{i}章主角在地点{i}与敌人{i}交战并取得了胜利，随后继续向北前进探索新的区域。"


@pytest.fixture(autouse=True)
def _patch_llm_env(monkeypatch):
    """默认:设置读取走内存默认(LLM 开),模型解析给假值,harness 桩默认禁止调用
    (预期调 LLM 的用例自行 monkeypatch 覆盖)。"""
    monkeypatch.setattr(settings_mod, "get_memory_settings", lambda uid: MemorySettings())
    monkeypatch.setattr(recorder_mod, "_resolve_recorder_api_and_model",
                        lambda uid, a, m: ("openai", "test-model"))

    def _must_not_call(**kw):
        raise AssertionError("本用例不应触发 LLM 调用")

    monkeypatch.setattr(harness_mod, "call_agent_json_guarded", _must_not_call)


def test_archive_scan_writes_pending_job_with_raw_texts():
    facts = [_fact(i) for i in range(3)]
    items = [
        {"id": f"f{i}", "kind": "runtime_fact", "text": t, "turn": i + 1, "status": "active", "legacy_bucket": "facts"}
        for i, t in enumerate(facts)
    ]
    s = _State({"turn": 70, "memory": {"facts": list(facts), "items": items}})
    _maybe_auto_archive(s, MemorySettings())
    mem = s.data["memory"]
    # 机械保底在场
    assert len(mem["summaries"]) == 1
    # pending 任务:下标指向保底、轮次范围、原始全文(给 LLM 足够细节)
    p = mem["summary_pending"]
    assert p["index"] == 0
    assert p["turn_range"] == [1, 3]
    assert p["texts"] == facts  # 原始全文,非压缩片段
    assert p["attempts"] == 0


def test_refine_replaces_mechanical_and_clears_pending(monkeypatch):
    def fake_harness(**kw):
        fake_harness.kw = kw
        return '{"summary": "主角接连击败三处敌人，获得附魔短剑后一路向北探索。"}', {}

    monkeypatch.setattr(harness_mod, "call_agent_json_guarded", fake_harness)
    s = _State({"turn": 70, "memory": {
        "summaries": ["第1-3轮：主角战斗；主角探索"],
        "summary_pending": {"index": 0, "turn_range": [1, 3],
                            "texts": [_fact(0), _fact(1)], "attempts": 0},
        "items": [],
    }})
    ok = refine_pending_summary(s, 1)
    assert ok is True
    mem = s.data["memory"]
    assert mem["summaries"][0] == "主角接连击败三处敌人，获得附魔短剑后一路向北探索。"
    assert mem["summary_pending"] == {}
    # prompt 带上了原始事实全文与轮次范围
    assert "第1-3轮" in fake_harness.kw["user_prompt"]
    assert _fact(0) in fake_harness.kw["user_prompt"]
    assert fake_harness.kw["agent_kind"] == "memory_summary"


def test_refine_disabled_clears_pending_without_call(monkeypatch, _patch_llm_env):
    monkeypatch.setattr(settings_mod, "get_memory_settings",
                        lambda uid: MemorySettings(summary_llm_enabled=False))

    def _must_not_call(**kw):
        raise AssertionError("关闭 summary_llm_enabled 时不应调 LLM")

    monkeypatch.setattr(harness_mod, "call_agent_json_guarded", _must_not_call)
    s = _State({"turn": 70, "memory": {
        "summaries": ["第1-3轮：机械保底"],
        "summary_pending": {"index": 0, "turn_range": [1, 3], "texts": [_fact(0)], "attempts": 0},
    }})
    assert refine_pending_summary(s, 1) is False
    assert s.data["memory"]["summary_pending"] == {}
    assert s.data["memory"]["summaries"] == ["第1-3轮：机械保底"]


def test_refine_llm_failure_keeps_pending_and_fallback(monkeypatch, _patch_llm_env):
    def boom(**kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(harness_mod, "call_agent_json_guarded", boom)
    s = _State({"turn": 70, "memory": {
        "summaries": ["第1-3轮：机械保底"],
        "summary_pending": {"index": 0, "turn_range": [1, 3], "texts": [_fact(0)], "attempts": 0},
    }})
    assert refine_pending_summary(s, 1) is False
    mem = s.data["memory"]
    assert mem["summaries"] == ["第1-3轮：机械保底"]  # 保底仍在
    assert mem["summary_pending"]["attempts"] == 1   # 任务保留待下轮重试


def test_refine_gives_up_after_max_attempts(_patch_llm_env):
    s = _State({"turn": 70, "memory": {
        "summaries": ["第1-3轮：机械保底"],
        "summary_pending": {"index": 0, "turn_range": [1, 3], "texts": [_fact(0)],
                            "attempts": _MAX_ATTEMPTS},
    }})
    assert refine_pending_summary(s, 1) is False
    assert s.data["memory"]["summary_pending"] == {}  # 超限清任务,保底即终稿


def test_refine_garbage_output_keeps_pending(monkeypatch, _patch_llm_env):
    monkeypatch.setattr(harness_mod, "call_agent_json_guarded",
                        lambda **kw: ("这不是JSON输出", {}))
    s = _State({"turn": 70, "memory": {
        "summaries": ["第1-3轮：机械保底"],
        "summary_pending": {"index": 0, "turn_range": [1, 3], "texts": [_fact(0)], "attempts": 0},
    }})
    assert refine_pending_summary(s, 1) is False
    assert s.data["memory"]["summaries"] == ["第1-3轮：机械保底"]
    assert s.data["memory"]["summary_pending"]["attempts"] == 1


def test_refine_out_of_range_index_appends(monkeypatch, _patch_llm_env):
    monkeypatch.setattr(harness_mod, "call_agent_json_guarded",
                        lambda **kw: ('{"summary": "精修摘要内容足够长可用"}', {}))
    s = _State({"turn": 70, "memory": {
        "summaries": ["第1-3轮：机械保底"],
        "summary_pending": {"index": 99, "turn_range": [1, 3], "texts": [_fact(0)], "attempts": 0},
    }})
    assert refine_pending_summary(s, 1) is True
    assert s.data["memory"]["summaries"] == ["第1-3轮：机械保底", "精修摘要内容足够长可用"]


def test_sanitize_summary_folds_and_caps():
    assert _sanitize_summary("  多  行\n摘要\t折叠  ") == "多 行 摘要 折叠"
    long = "x" * 1000
    out = _sanitize_summary(long)
    assert len(out) == 600 + 2  # 600 字 + 省略号


def test_build_prompts_contract():
    system, user = _build_prompts({"turn_range": [4, 9], "texts": ["事实A", "事实B"]})
    assert '{"summary":' in system
    assert "第4-9轮" in user
    assert "事实A" in user and "事实B" in user


def test_no_pending_is_noop():
    s = _State({"turn": 1, "memory": {"summaries": []}})
    assert refine_pending_summary(s, 1) is False
    assert s.data["memory"]["summaries"] == []
