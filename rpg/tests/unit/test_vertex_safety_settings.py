"""Vertex 安全过滤接线回归:safety_settings 的记忆隔离 + 拦截信号采集。

两处易漏:
  · `_SAFETY_REJECTED` 是进程级记忆。键里不带 user_id 的话,一个用户撞上 400 会让同 worker 上
    **所有**用户都不再发 safety_settings —— 包括把档位设在「禁止」(最严阈值)的人。
  · 提示词被拦时 candidates 为空、usage_metadata 也不存在,唯一信号是 prompt_feedback.block_reason。
    不采它,「为什么这轮是空回复」在链路上完全没有痕迹。
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from agents.gm import content_policy as cp  # noqa: E402
from agents.gm.backends import vertex  # noqa: E402


class _Enum:
    def __init__(self, name):
        self.name = name


class _Cand:
    def __init__(self, name):
        self.finish_reason = _Enum(name)


class _Feedback:
    def __init__(self, name):
        self.block_reason = _Enum(name)


class _Resp:
    def __init__(self, candidates=(), usage=None, feedback=None):
        self.candidates = list(candidates)
        if usage is not None:
            self.usage_metadata = usage
        if feedback is not None:
            self.prompt_feedback = _Feedback(feedback)


def _backend(user_id=1):
    b = vertex._VertexBackend.__new__(vertex._VertexBackend)
    b.user_id = user_id
    b.model_name = "gemini-3.5-flash"
    b.last_usage = {}
    return b


# ── 记忆隔离:一个用户的拒绝不该影响别人 ────────────────────────────────────

def test_rejection_is_scoped_to_the_user(monkeypatch):
    from agents.gm.backends import _gen_params

    monkeypatch.setattr(vertex, "_SAFETY_REJECTED", {("vertex_ai", "gemini-3.5-flash", 1)})
    monkeypatch.setattr(cp, "safety_settings_for_user", lambda uid: ["FAKE"])
    monkeypatch.setattr(_gen_params, "resolve_gen_params", lambda uid: {})
    # 用户 1 已记忆被拒 → 不发;用户 2 不该被牵连
    assert "safety_settings" not in vertex._user_gen_config(1, "gemini-3.5-flash")
    assert vertex._user_gen_config(2, "gemini-3.5-flash")["safety_settings"] == ["FAKE"]


def test_safety_key_includes_user():
    assert _backend(user_id=42)._safety_key() == ("vertex_ai", "gemini-3.5-flash", 42)


# ── 拦截信号采集 ────────────────────────────────────────────────────────────

def test_finish_reason_from_candidates():
    assert vertex._finish_reason_normalized(_Resp(candidates=[_Cand("STOP")])) == "STOP"
    assert vertex._finish_reason_normalized(_Resp(candidates=[_Cand("MAX_TOKENS")])) == "length"
    assert vertex._finish_reason_normalized(_Resp(candidates=[_Cand("SAFETY")])) == "SAFETY"


def test_finish_reason_from_prompt_feedback_when_no_candidates():
    """提示词被拦:candidates 为空,只有 prompt_feedback.block_reason。"""
    assert vertex._finish_reason_normalized(_Resp(feedback="SAFETY")) == "SAFETY"
    assert vertex._finish_reason_normalized(_Resp(feedback="PROHIBITED_CONTENT")) == "PROHIBITED_CONTENT"
    assert vertex._finish_reason_normalized(_Resp(feedback="JAILBREAK")) == "JAILBREAK"


def test_unspecified_block_reason_is_not_a_signal():
    assert vertex._finish_reason_normalized(_Resp(feedback="BLOCKED_REASON_UNSPECIFIED")) is None
    assert vertex._finish_reason_normalized(_Resp()) is None


def test_capture_records_block_reason_without_usage():
    """没有 usage_metadata 也要采 finish_reason —— 被拦的响应正是这种形状。"""
    b = _backend()
    b._capture_usage(_Resp(feedback="SAFETY"))
    assert b.last_usage.get("finish_reason") == "SAFETY"


def test_capture_records_block_reason_alongside_usage():
    b = _backend()
    b._capture_usage(_Resp(candidates=[_Cand("SAFETY")], usage=_Usage(10, 0)))
    assert b.last_usage["finish_reason"] == "SAFETY"
    assert b.last_usage["input_tokens"] == 10


class _Usage:
    def __init__(self, prompt, candidates):
        self.prompt_token_count = prompt
        self.candidates_token_count = candidates
