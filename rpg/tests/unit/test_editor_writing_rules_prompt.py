"""编辑器右栏系统提示必须直接注入作者的 writing_rules。

回归:此前写作规范只进入续写/改写、内联 ghost 和 get_chapter_context 工具;
右栏聊天若没调该工具就完全看不到,和 UI 文案「每次生成都会遵守」不一致。
"""
from __future__ import annotations

from unittest import mock

from console_assistant.prompts import build_system_prompt


def test_editor_prompt_injects_writing_rules():
    rules = "【作者写作规范(最高优先,务必遵守)】\n全程第三人称限知,禁止上帝视角"
    with mock.patch(
        "console_assistant.editor_context.build_writing_rules_block",
        return_value=rules,
    ):
        prompt = build_system_prompt({"tab": "md-editor", "script_id": 7})
    assert "全程第三人称限知" in prompt
    assert "作者写作规范" in prompt


def test_editor_prompt_survives_rule_load_failure():
    with mock.patch(
        "console_assistant.editor_context.build_writing_rules_block",
        side_effect=RuntimeError("db down"),
    ):
        prompt = build_system_prompt({"tab": "md-editor", "script_id": 7})
    # 规则读取失败不能把整个系统提示打崩。
    assert "专属写作搭档" in prompt


def test_console_prompt_does_not_load_writing_rules():
    with mock.patch(
        "console_assistant.editor_context.build_writing_rules_block",
    ) as load_rules:
        build_system_prompt({"tab": "platform.home"})
    load_rules.assert_not_called()
