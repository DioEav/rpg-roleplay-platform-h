"""开场预算 / 截断检查回归。

背景：开场原先写死 guided=600 / rail=1600，设置页「最大输出 Tokens」只作用于主 GM/控制台，
导致 `deepseek-v4.1-flash` 这类长输出模型在开场写到一半就被 max_tokens 截断。现在开场
统一使用 `_chat_max_tokens`（设置页值），并移除 prompt 里的固定字数限制；同时用
`finish_reason == "length"` 检测截断，避免半截文本被当成正常开场落库。
"""
from __future__ import annotations

from agents.gm.master import (
    _OPENING_PROMPT,
    _SYSTEM_BASE,
    _strip_tool_protocol_for_opening,
)
from routes.game.opening import (
    _RAIL_OPENING_INSTRUCTION,
    _game_opening_policy,
    _opening_hit_max_tokens,
)


def test_guided_opening_uses_user_budget():
    prompt, budget = _game_opening_policy("guided", 4096)
    assert prompt is None
    assert budget == 4096


def test_rail_opening_uses_user_budget():
    prompt, budget = _game_opening_policy("rail", 8192)
    assert prompt == _RAIL_OPENING_INSTRUCTION
    assert budget == 8192


def test_opening_budget_never_zero():
    _, budget = _game_opening_policy("guided", 0)
    assert budget == 1


def test_opening_prompts_have_no_fixed_word_limit():
    assert "150-250" not in _OPENING_PROMPT
    assert "500-900" not in _RAIL_OPENING_INSTRUCTION
    assert "不设固定字数限制" in _OPENING_PROMPT


def test_opening_system_removes_tool_protocol_entirely():
    """开场 system 不能再带锚点/历史工具清单与 <<TOOL_CALL>> 格式。

    只追加一句“没有工具”压不住弱模型（deepseek-v4.1-flash 仍照抄前面的
    “每轮先扫锚点/调 list_recent_history”），所以必须整段删除。
    """
    s = _strip_tool_protocol_for_opening(_SYSTEM_BASE)
    for banned in (
        "<<TOOL_CALL>>",
        "list_pending_anchors",
        "list_recent_history",
        "mark_anchor_satisfied",
        "检查待发生锚点",
        "# 工具调用",
        "# 世界线收束",
    ):
        assert banned not in s, banned
    assert "# 写作准则" in s
    assert "# 叙事语言一致性" in s


class _Backend:
    def __init__(self, usage: dict):
        self.last_usage = usage


class _GM:
    def __init__(self, usage: dict):
        self._backend = _Backend(usage)


def test_opening_hit_max_tokens_detects_length():
    assert _opening_hit_max_tokens(
        _GM({"finish_reason": "length", "max_tokens": 4096}), 600) == 4096
    # max_tokens 缺失时退回本次请求预算
    assert _opening_hit_max_tokens(_GM({"finish_reason": "length"}), 1200) == 1200


def test_opening_hit_max_tokens_ignores_other_reasons():
    assert _opening_hit_max_tokens(
        _GM({"finish_reason": "stop", "max_tokens": 4096}), 600) is None
    assert _opening_hit_max_tokens(_GM({}), 600) is None
    assert _opening_hit_max_tokens(object(), 600) is None
