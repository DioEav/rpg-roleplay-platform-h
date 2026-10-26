"""记忆注入/预算/归属修复回归集。

覆盖:
  1. MemoryProvider 预算装填 continue + pinned 与 recall_depth 解耦 + notes 先于 facts
  2. short_summary 的 prompt 专用裁剪（默认行为不变）
  3. fact_groups 不再重复 legacy 桶，只保留结构化补充
  4. confirm_hypothesis 双写 legacy facts
  5. 迁移 turn=0 的旧 facts 不再被首次归档一次性清空
  6. query_memory 过滤 archived / superseded
  7. GM fence + 史官 ops 合并时 GM 显式优先
  8. _turn_message/_turn_content 不再重复注入 state / user_input
  9. slim 保留集包含历史锚点工具
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from context_engine import build_context_bundle
from context_engine.layers import _fact_groups_layer
from context_providers import DEFAULT_FREEFORM_MANIFEST
from context_providers.memory import MemoryProvider, _maybe_auto_archive
from schemas.memory import MemorySettings
from state import GameState
from state.json_ops import merge_state_ops


class _Svc:
    user_id = 1


def _collect(state, ms: MemorySettings, monkeypatch):
    import platform_app.settings as settings_mod
    monkeypatch.setattr(settings_mod, "get_memory_settings", lambda uid: ms)
    return MemoryProvider().collect(
        state, manifest=None, demand=None, services=_Svc()
    ).layers[0]["content"]


def test_pinned_is_not_capped_by_recall_depth(monkeypatch):
    """固定记忆候选上限用 pinned_max；recall_depth=2 也不能把第 3 条 pinned 砍掉。"""
    s = GameState.new()
    s.data["memory"]["pinned"] = [f"固定{i}" for i in range(10)]
    ms = MemorySettings(recall_depth=2, pinned_max=10, token_budget=5000)
    text = _collect(s, ms, monkeypatch)
    for i in range(10):
        assert f"固定记忆：固定{i}" in text, f"第 {i} 条固定记忆被 recall_depth 砍掉"


def test_long_pinned_does_not_starve_later_pinned(monkeypatch):
    """continue 语义：一条装不下的长 pinned 只跳过自己，不能 break 掉后面较短的。"""
    s = GameState.new()
    s.data["memory"]["pinned"] = ["X" * 1200, "短固定"]
    ms = MemorySettings(recall_depth=8, pinned_max=20, token_budget=200)
    text = _collect(s, ms, monkeypatch)
    assert "固定记忆：短固定" in text, "长 pinned 把后面的 pinned 饿死了（break 未改 continue）"


def test_notes_are_injected_before_facts(monkeypatch):
    """笔记是玩家权威输入，预算装填必须先于自动累积的事实。"""
    s = GameState.new()
    s.data["memory"]["notes"] = ["金币现在是500"]
    s.data["memory"]["facts"] = ["金币是100"]
    text = _collect(s, MemorySettings(token_budget=1600), monkeypatch)
    assert text.find("笔记：金币现在是500") < text.find("事实：金币是100")


def test_hypotheses_not_duplicated_by_memory_provider(monkeypatch):
    """hypotheses 的唯一注入源是 context_engine 的通用层，MemoryProvider 不再重复。"""
    s = GameState.new()
    s.add_hypothesis("管家可能是凶手")
    text = _collect(s, MemorySettings(token_budget=1600), monkeypatch)
    assert "未确认推测" not in text


def test_short_summary_prompt_flags_are_opt_in():
    s = GameState.new()
    s.data["memory"]["facts"] = ["某事实"]
    s.data["memory"]["pinned"] = ["某固定"]
    s.data["worldline"]["user_variables"] = {"天气": {"value": "雨", "turn": 1}}

    full = s.short_summary()
    assert "【长期记忆】" in full and "【权限与世界线】" in full

    trimmed = s.short_summary(include_memory=False, include_worldline=False)
    assert "【长期记忆】" not in trimmed
    assert "【权限与世界线】" not in trimmed
    assert "【已知事件】" in trimmed and "【关系状态】" in trimmed

    only_memory_trimmed = s.short_summary(include_memory=False)
    assert "【长期记忆】" not in only_memory_trimmed
    assert "【权限与世界线】" in only_memory_trimmed


def test_fact_groups_does_not_repeat_legacy_buckets():
    s = GameState.new()
    s.data["memory"]["items"] = [
        {"kind": "runtime_fact", "text": "笔记内容", "turn": 3, "status": "active", "legacy_bucket": "notes"},
        {"kind": "runtime_fact", "text": "固定内容", "turn": 3, "status": "active", "legacy_bucket": "pinned"},
        {"kind": "runtime_fact", "text": "能力内容", "turn": 3, "status": "active", "legacy_bucket": "abilities"},
        {"kind": "runtime_fact", "text": "资源内容", "turn": 3, "status": "active", "legacy_bucket": "resources"},
        {"kind": "runtime_fact", "text": "事实内容", "turn": 3, "status": "active", "legacy_bucket": "facts"},
        {"kind": "runtime_fact", "text": "结构化补充", "turn": 2, "status": "active"},
    ]
    out = _fact_groups_layer(s)
    assert "结构化补充" in out
    for text in ("笔记内容", "固定内容", "能力内容", "资源内容", "事实内容"):
        assert text not in out, f"legacy 桶条目仍被 fact_groups 重复注入: {text}"


def test_confirm_hypothesis_dual_writes_legacy_facts(monkeypatch):
    s = GameState.new()
    hid = s.add_hypothesis("管家是凶手")
    assert s.confirm_hypothesis(hid)
    assert "管家是凶手" in s.data["memory"]["facts"]
    item = next(i for i in s.data["memory"]["items"]
                if i.get("text") == "管家是凶手" and i.get("legacy_bucket") == "facts")
    assert hid in (item.get("supersedes") or [])
    text = _collect(s, MemorySettings(token_budget=1600), monkeypatch)
    assert "事实：管家是凶手" in text


def test_legacy_turn_zero_is_not_auto_archived():
    s = GameState({"turn": 60, "memory": {
        "facts": ["旧迁移事实"],
        "items": [{
            "id": "m1", "kind": "runtime_fact", "text": "旧迁移事实",
            "turn": 0, "status": "active", "legacy_bucket": "facts",
        }],
    }})
    _maybe_auto_archive(s, MemorySettings())
    assert "旧迁移事实" in s.data["memory"]["facts"]
    assert not s.data["memory"]["items"][0].get("archived")


def test_query_memory_filters_archived_and_superseded():
    from tools_dsl.command_tools_queries import _t_query_memory

    s = GameState.new()
    active_id = s.add_hypothesis("活跃推测")
    old_id = s.add_hypothesis("已确认推测")
    s.confirm_hypothesis(old_id)
    s.add_memory_item(text="已归档事实", kind="runtime_fact")
    archived = next(i for i in s.data["memory"]["items"] if i.get("text") == "已归档事实")
    archived["archived"] = True

    hypos = json.loads(_t_query_memory(s, {"kind": "hypothesis", "limit": 20}))
    assert [h["text"] for h in hypos] == ["活跃推测"]
    assert active_id

    facts = json.loads(_t_query_memory(s, {"kind": "runtime_fact", "limit": 20}))
    assert any(f["text"] == "已确认推测" for f in facts)
    assert all(f["text"] != "已归档事实" for f in facts)


def test_merge_state_ops_gm_explicit_wins():
    gm = [
        {"op": "set", "path": "player.current_location", "value": "北港"},
        {"op": "append", "path": "memory.facts", "value": "GM 事实"},
    ]
    recorder = [
        {"op": "set", "path": "player.current_location", "value": "南港"},
        {"op": "append", "path": "memory.facts", "value": "GM 事实"},
        {"op": "append", "path": "memory.facts", "value": "史官补充"},
    ]
    merged = merge_state_ops(gm, recorder)
    locs = [o for o in merged if o.get("path") == "player.current_location"]
    facts = [o for o in merged if o.get("path") == "memory.facts"]
    assert locs == [{"op": "set", "path": "player.current_location", "value": "北港"}]
    assert {o["value"] for o in facts} == {"GM 事实", "史官补充"}


def test_merge_state_ops_recorder_set_does_not_clobber_gm_append():
    gm = [{"op": "append", "path": "memory.resources", "value": "钥匙"}]
    recorder = [{"op": "set", "path": "memory.resources", "value": ["别的"]}]
    merged = merge_state_ops(gm, recorder)
    assert merged == gm


def test_merge_state_ops_question_dedupes_by_text():
    gm = [{"op": "question", "question": "去哪", "options": ["东", "西"]}]
    recorder = [{"op": "question", "question": "去哪", "options": ["南"]}]
    assert merge_state_ops(gm, recorder) == gm


def test_turn_message_no_duplicate_state_or_input():
    from agents.gm.master import GameMaster

    s = GameState.new()
    s.data["memory"]["facts"] = ["事实甲"]
    s.data["memory"]["pinned"] = ["别忘了我"]
    s.data["memory"]["notes"] = ["笔记甲"]
    b = build_context_bundle(s, "你好", "", manifest=dict(DEFAULT_FREEFORM_MANIFEST))
    gm = object.__new__(GameMaster)
    gm._active_state = s
    text = gm._turn_message("你好", s, b["prompt"])
    assert text.count("【玩家本轮输入】") == 1
    assert text.count("【当前状态】") == 1
    assert "【当前剧情状态】" not in text
    assert text.count("【长期记忆】") == 1
    assert text.count("固定记忆：别忘了我") == 1


def test_turn_content_no_duplicate_state_or_input(monkeypatch):
    from agents.gm.master import GameMaster

    s = GameState.new()
    s.data["memory"]["facts"] = ["事实甲"]
    b = build_context_bundle(s, "你好", "", manifest=dict(DEFAULT_FREEFORM_MANIFEST))
    gm = object.__new__(GameMaster)
    gm._active_state = s
    gm._backend = object()
    monkeypatch.setattr(gm, "_tiered_enabled", lambda: True)
    content = gm._turn_content("你好", s, b["prompt"], prompt_segments=b["prompt_segments"])
    text = content if isinstance(content, str) else "\n".join(
        x.get("text", "") for x in content)
    assert text.count("【玩家本轮输入】") == 1
    assert text.count("【当前状态】") == 1
    assert "【当前剧情状态】" not in text


def test_state_layer_uses_prompt_summary_without_memory_duplication():
    s = GameState.new()
    s.data["memory"]["facts"] = ["事实甲"]
    b = build_context_bundle(s, "你好", "", manifest=dict(DEFAULT_FREEFORM_MANIFEST))
    prompt = b["prompt"]
    assert prompt.count("【长期记忆】") == 1, "state 层与 MemoryProvider 重复注入长期记忆"
    assert "【当前状态】" in prompt
    # state 层不再渲染【权限与世界线】；worldline provider 用「世界线 / 用户变量」标题，
    # 整个 prompt 里只应出现一次。
    assert prompt.count("【权限与世界线】") == 0
    assert prompt.count("【世界线 / 用户变量】") == 1


def test_slim_keep_tools_include_history_anchors():
    from gm_serving.serve import GM_ALL_KB_TOOLS, GM_SLIM_KEEP_TOOLS

    for name in ("list_recent_history", "record_history_anchor", "summarize_anchors", "ask_player_choice"):
        assert name in GM_SLIM_KEEP_TOOLS, f"slim 保留集缺少提示词要求的工具: {name}"
    assert set(GM_ALL_KB_TOOLS) <= set(GM_SLIM_KEEP_TOOLS)
