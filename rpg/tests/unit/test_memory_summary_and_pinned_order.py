"""固定记忆优先注入 + 真摘要压缩(归档事实不再失忆,而是压缩成概要继续注入)。

背景:
- 旧注入顺序 pinned 排在 facts 之后 → 事实一多,预算耗尽,玩家显式固定的权威记忆
  反而被挤出 GM 上下文。修:pinned 置顶(预算装填即优先级)。
- 旧归档 = 超龄 facts 静默移出注入,远期剧情对 GM 彻底失忆,且面板无任何说明。
  修:归档扫描把本批 facts 压缩成一条「第X-Y轮：…」摘要存 memory.summaries,
  随「概要：」行继续注入 —— 历史从「原文在场」降级为「压缩在场」而非消失。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from context_providers.memory import (  # noqa: E402
    MemoryProvider,
    _append_scan_summary,
    _condense_fact,
    _maybe_auto_archive,
    _SUMMARY_ENTRY_MAX_CHARS,
)
from schemas.memory import MemorySettings  # noqa: E402


class _State:
    def __init__(self, data):
        self.data = data


class _Svc:
    user_id = None


def _svc(uid: int = 1):
    """带 user_id 的 services:collect 会经它读 get_memory_settings(monkeypatch 生效的前提)。"""
    return type("_SvcUid", (), {"user_id": uid})()


def _collect_text(state, services=None):
    return MemoryProvider().collect(
        state, manifest=None, demand=None, services=services or _Svc()
    ).layers[0]["content"]


def _fact_text(i: int) -> str:
    return f"第{i}章主角在地点{i}与敌人{i}交战并取得了胜利，随后继续向北前进探索新的区域。"


def _long_fact_text(i: int) -> str:
    """~200 字的长事实(≈100 token),用于撑爆小预算。"""
    return (
        f"第{i}章主角在地点{i}与敌人{i}展开了一场漫长的拉锯战，"
        f"双方使用了各种策略与地形优势反复争夺，最终主角凭借关键道具扭转了战局，"
        f"敌人{i}败退并留下了重要的战利品，主角顺势搜刮了物资并治疗了伤势，"
        f"随后继续向北前进探索新的区域，途中还遇到一队商旅并交换了情报。"
    )


def _big_session(turn: int, n_facts: int = 12, fact_fn=None):
    fact_fn = fact_fn or _fact_text
    facts = [fact_fn(i) for i in range(n_facts)]
    items = [
        {"id": f"f{i}", "kind": "runtime_fact", "text": t, "turn": i + 1, "status": "active", "legacy_bucket": "facts"}
        for i, t in enumerate(facts)
    ]
    return _State({
        "turn": turn,
        "memory": {
            "pinned": ["主角真实身份是穿越者"],
            "facts": list(facts),
            "items": items,
        },
    })


# ── 固定记忆优先注入 ─────────────────────────────────────────────────────────

def test_pinned_injected_before_facts():
    s = _big_session(10)
    text = _collect_text(s)
    assert "固定记忆：主角真实身份是穿越者" in text
    assert "事实：" in text
    assert text.find("固定记忆：") < text.find("事实："), "固定记忆应先于事实占预算"


def test_collect_writes_last_memory_injection_for_panel():
    """面板 ✓徽章/「注入 N 条」计数的数据源:collect 必须把记忆层实际注入原文
    落到 memory.last_memory_injection(不能用 last_retrieval —— 那是小说检索层
    文本,从不含记忆层行)。"""
    s = _big_session(10)
    _collect_text(s)
    inj = s.data["memory"].get("last_memory_injection")
    assert isinstance(inj, str) and inj, "collect 未写 last_memory_injection"
    assert "固定记忆：主角真实身份是穿越者" in inj
    assert "事实：" in inj
    # 占位行为:无任何记忆时写占位文案,面板计数(按前缀过滤)自然为 0
    s_empty = _State({"turn": 1, "memory": {"items": []}})
    _collect_text(s_empty)
    assert s_empty.data["memory"]["last_memory_injection"] == "（暂无长期记忆）"


def _fact_lines(text: str) -> int:
    """数「事实：」注入行数 —— 不能用 text.count(),优先级提示行里也含「事实：」字样。"""
    return len([l for l in text.split("\n") if l.startswith("事实：")])


def test_pinned_survives_budget_that_truncates_facts(monkeypatch):
    # 5 条长事实(≈60 token/条,depth=5 全部有资格) + 优先级提示;预算 300 必然
    # 在第 4 条事实附近耗尽。置顶的 pinned 必须仍然在场,且事实被预算截断。
    import platform_app.settings as settings_mod
    ms = MemorySettings(token_budget=300)
    monkeypatch.setattr(settings_mod, "get_memory_settings", lambda uid: ms)
    s = _big_session(10, n_facts=5, fact_fn=_long_fact_text)
    text = _collect_text(s, services=_svc())

    assert "固定记忆：主角真实身份是穿越者" in text, "预算截断时固定记忆被挤出(置顶失效)"
    assert _fact_lines(text) < 5, "预算 300 下 5 条长事实不应全部注入(测试前提失效)"


# ── 真摘要压缩 ───────────────────────────────────────────────────────────────

def _archive_turn_for(ms):
    return ((ms.auto_archive_after_turns // ms.summary_window) + 2) * ms.summary_window


def test_archive_creates_condensed_summary_entry():
    ms = MemorySettings()
    s = _big_session(_archive_turn_for(ms), n_facts=3)
    _maybe_auto_archive(s, ms)
    mem = s.data["memory"]
    # facts 被剥出桶、items 标 archived(既有行为)
    assert mem["facts"] == []
    assert all(it.get("archived") for it in mem["items"])
    # 新行为:生成一条带轮次范围前缀的压缩摘要
    assert len(mem["summaries"]) == 1
    entry = mem["summaries"][0]
    assert entry.startswith("第1-3轮：")
    assert "第0章主角在地点0" in entry  # 压缩保留首子句关键信息
    assert "随后继续向北前进" not in entry  # 首子句之后的内容被裁掉


def test_archive_without_new_archives_makes_no_summary():
    ms = MemorySettings()
    s = _big_session(_archive_turn_for(ms), n_facts=3)
    _maybe_auto_archive(s, ms)
    n = len(s.data["memory"]["summaries"])
    assert n == 1
    # 同一回合再跑(幂等):没有新归档 → 不再追加摘要
    _maybe_auto_archive(s, ms)
    assert len(s.data["memory"]["summaries"]) == n


def test_summary_entry_length_capped():
    mem: dict = {}
    frags = [{"text": _fact_text(i), "turn": i} for i in range(200)]
    _append_scan_summary(mem, frags)
    entry = mem["summaries"][0]
    assert len(entry) <= _SUMMARY_ENTRY_MAX_CHARS + 2  # + 省略号
    assert entry.endswith("……")


def test_summary_injected_and_gated_by_world_bucket(monkeypatch):
    s = _State({
        "turn": 1,
        "memory": {"summaries": ["第1-20轮：主角离开新手村"], "items": []},
    })
    text = _collect_text(s)
    assert "概要：第1-20轮：主角离开新手村" in text

    # 关世界桶 → 概要一并关闭(概要属于世界历史)。services 必须带 user_id,
    # collect 才会走 get_memory_settings(monkeypatch 的 ms_off 才会被读到)。
    import platform_app.settings as settings_mod
    ms_off = MemorySettings(bucket_world_enabled=False)
    monkeypatch.setattr(settings_mod, "get_memory_settings", lambda uid: ms_off)
    text_off = _collect_text(s, services=_svc())
    assert "概要：" not in text_off


def test_condense_fact_takes_first_sentence():
    assert _condense_fact("主角拿到了钥匙。然后打开了门。") == "主角拿到了钥匙"
    assert _condense_fact("主角拿到了钥匙，然后打开了门。") == "主角拿到了钥匙"
    assert _condense_fact("金币 1,000 枚在袋中") == "金币 1,000 枚在袋中"  # ASCII 逗号不断
    assert _condense_fact("  多  个 空  格 折叠  ") == "多 个 空 格 折叠"
    long = "x" * 200
    assert _condense_fact(long) == "x" * 50
    assert _condense_fact("") == ""
