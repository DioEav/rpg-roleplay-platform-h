"""自动节奏推进(A+B)契约:设置 schema、跨回合/导出白名单、prompt 收紧。

A: 收紧 progress_motion 提示词 —— 纯聊天/日常/等待/纯关系升温判 0。
B: 存档级 auto_pace_advance 开关 —— off 时只停 pace 兜底,锚点/估章/手动跳章仍推进。
本文件只锁源码/schema 契约,不连 DB。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_settings_schema_has_auto_pace_advance():
    from gm_serving.settings import _DEFAULTS, _VALID, SETTINGS_SCHEMA
    field = next((f for f in SETTINGS_SCHEMA if f["key"] == "auto_pace_advance"), None)
    assert field is not None, "SETTINGS_SCHEMA 必须暴露 auto_pace_advance(设置表单靠它渲染)"
    assert field["default"] == "on", "默认 on:保持既有行为,玩家可逐档关掉"
    assert set(field["options"]) == {"on", "off"}
    assert _DEFAULTS["auto_pace_advance"] == "on"
    assert _VALID["auto_pace_advance"] == {"on", "off"}


def test_whitelists_include_auto_pace_advance():
    """设置必须在两处白名单里,否则每回合 worldline 整列重写会把它抹掉。"""
    session_repo = _read("platform_app/knowledge/_session_repo.py")
    save_io = _read("platform_app/save_io.py")
    assert "'auto_pace_advance'" in session_repo, \
        "_PRESERVE_SETTINGS_SQL 漏了 auto_pace_advance → 下一回合设置被抹回默认 on"
    assert '"auto_pace_advance"' in save_io, \
        "_WORLDLINE_SETTINGS_KEYS 漏了 auto_pace_advance → 导出/导入后设置丢失"


def test_pace_fallback_checks_save_setting():
    src = _read("gm_serving/anchor_reconcile.py")
    assert "auto_pace_advance_enabled(conn, save_id)" in src, \
        "节奏兜底必须读取存档级开关;否则 UI 关了也没用"


def test_recorder_prompt_tightened():
    src = _read("agents/recorder.py")
    assert "同一场景内的对话、日常、感情互动、等待" in src
    assert "关系发生不可逆的实质变化" in src
    assert "只想聊天/不想推进剧情" in src
    assert "progress_motion" in src


def test_default_judge_prompt_tightened():
    src = _read("gm_serving/anchor_reconcile.py")
    assert "同一场景内的对话/日常/等待" in src
    assert "关系不可逆变化" in src
    assert "只想聊天/不推进" in src
