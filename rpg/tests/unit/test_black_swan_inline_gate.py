"""黑天鹅「内联 + 频率闸门」回归(2026-10 重新接线)。

修复前:黑天鹅接在 postproc 队列 + worker 上,而 worker 进程拿不到实时内存 state,
handler 被迫 enable_llm=False → 默认部署下静默空转(世界心跳同款老坑)。
修复后:gm.py async 生产路径内联执行(create_task + 双 return await),频率闸门
should_attempt 三级节流(最少开局回合/尝试间隔/事件冷却),meta 随 Phase 5 持久化。
"""
import sys
from pathlib import Path

sys_path = str(Path(__file__).resolve().parents[2])
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

import inspect  # noqa: E402

import agents.black_swan_agent as bs  # noqa: E402
from agents.black_swan_agent import (  # noqa: E402
    ATTEMPT_INTERVAL_TURNS,
    EVENT_COOLDOWN_TURNS,
    MIN_TURN_TO_START,
    maybe_trigger,
    should_attempt,
)


class _State:
    def __init__(self, data):
        self.data = data


# ── 频率闸门 should_attempt ──────────────────────────────────────────────────

def test_gate_blocks_before_min_turn():
    ok, reason = should_attempt({"turn": 2})
    assert ok is False and str(MIN_TURN_TO_START) in reason


def test_gate_allows_fresh_state_past_min_turn():
    ok, reason = should_attempt({"turn": 10})
    assert ok is True and reason == ""


def test_gate_attempt_interval_blocks_then_opens():
    s = {"turn": 10, "black_swan_meta": {"last_attempt_turn": 8}}   # 距上次尝试 2 回合
    ok, reason = should_attempt(s)
    assert ok is False and "距上次尝试" in reason
    s["turn"] = 12  # 距上次尝试 4 回合,仍 < 5 → 依旧拦截
    ok2, _ = should_attempt(s)
    assert ok2 is False
    s["turn"] = 8 + ATTEMPT_INTERVAL_TURNS  # 13 回合,恰好满间隔 → 放行
    ok3, reason3 = should_attempt(s)
    assert ok3 is True and reason3 == ""


def test_gate_event_cooldown_blocks_then_opens(monkeypatch):
    s = {"turn": 30, "black_swan_meta": {"last_event_turn": 25}}  # 事件后 5 回合
    monkeypatch.setattr(bs, "ATTEMPT_INTERVAL_TURNS", 3)  # 不让尝试间隔先拦
    ok, reason = should_attempt(s)
    assert ok is False and "冷却" in reason
    s["turn"] = 25 + EVENT_COOLDOWN_TURNS
    ok2, reason2 = should_attempt(s)
    assert ok2 is True and reason2 == ""


def test_gate_prefers_attempt_interval_before_event_cooldown(monkeypatch):
    """两个窗口都命中时,先报尝试间隔(更近的节流)。"""
    monkeypatch.setattr(bs, "ATTEMPT_INTERVAL_TURNS", 3)
    s = {"turn": 30, "black_swan_meta": {"last_attempt_turn": 29, "last_event_turn": 25}}
    ok, reason = should_attempt(s)
    assert ok is False and "距上次尝试" in reason


# ── maybe_trigger 的 meta 记账 ───────────────────────────────────────────────

class _State:
    def __init__(self, data):
        self.data = data


def _state(turn=10):
    return _State({"turn": turn, "world": {"timeline": {}}, "player": {},
                   "worldline": {}, "active_entities": [], "known_events": []})


def _no_op_caller(snapshot, schema, prev_failure=None):
    return {"event_kind": "no_op", "summary": "无可触发事件"}


def test_maybe_trigger_records_attempt_turn_even_on_no_op(monkeypatch):
    s = _state(10)
    # llm_caller 直接给 no_op → 不触发,但 last_attempt_turn 必须记账
    r = maybe_trigger(s, user_id=0, save_id=0, llm_caller=_no_op_caller, enable_llm=False)
    assert r["triggered"] is False
    assert s.data["black_swan_meta"]["last_attempt_turn"] == 10


def test_maybe_trigger_no_llm_records_nothing(monkeypatch):
    """无 LLM 通道(enable_llm=False 且无 llm_caller)→ 不记账尝试间隔:
    空转尝试不应消耗节流窗口(worker 兼容路径同理)。"""
    s = _state(10)
    r = maybe_trigger(s, user_id=0, save_id=0, enable_llm=False)  # 无 llm_caller
    assert r["triggered"] is False
    meta = (s.data.get("black_swan_meta") or {})
    assert meta.get("last_attempt_turn") in (None, 0), "无通道空转不应记账尝试间隔"


# ── gm.py 接线断言(防 v1.41.0 式错接复发)──────────────────────────────────

def test_gm_async_path_wires_black_swan_inline():
    """黑天鹅必须接线在 gm.py 的 async 生产默认路径(create_task + 双 return await),
    且队列入参必须 is_bs_enabled=False(不再入队,防 worker 空转双跑)。"""
    import chat_pipeline.gm as gm_mod
    src = inspect.getsource(gm_mod)
    assert "_bs_should" in src, "async 路径未引用频率闸门"
    assert "_bs_task = asyncio.create_task" in src, "async 路径未接线黑天鹅内联任务"
    assert src.count("await _bs_task") >= 2, "两个 return 前都必须 await _bs_task"
    assert "is_bs_enabled=False" in src, "队列入参必须显式关闭 black_swan(防双跑)"
