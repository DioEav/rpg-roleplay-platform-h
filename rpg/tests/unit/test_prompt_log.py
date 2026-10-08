"""core.prompt_log 提示词日志门控/截断 + harness 接线回归。

RPG_LOG_PROMPTS 门控(默认关);RPG_LOG_PROMPTS_TRUNCATE 默认截 2000 字符、
"0" 打完整、数字自定义;接线打点在 harness call_agent_json(子代理咽喉)。
"""
import sys
from pathlib import Path

import pytest

sys_path = str(Path(__file__).resolve().parents[2])
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

import core.prompt_log as plog  # noqa: E402
import agents._harness as harness_mod  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_env(monkeypatch):
    monkeypatch.delenv("RPG_LOG_PROMPTS", raising=False)
    monkeypatch.delenv("RPG_LOG_PROMPTS_TRUNCATE", raising=False)


def _capture_debug(monkeypatch):
    lines = []
    monkeypatch.setattr(plog, "log", type("_L", (), {"debug": staticmethod(lambda msg, *a: lines.append(msg))}))
    return lines


def test_disabled_by_default(monkeypatch):
    lines = _capture_debug(monkeypatch)
    plog.log_llm_prompt(kind="t", system="s", user="u")
    assert lines == [], "未开 RPG_LOG_PROMPTS 时不应有日志"


def test_visible_even_when_root_level_is_info(monkeypatch):
    """生产配置:app.py setup_default_logging 把根 logger 设为 INFO。
    prompt_log 的 logger 显式 DEBUG 级 → debug 记录仍应发出(不被全局级别过滤)。"""
    import logging
    lines = _capture_debug(monkeypatch)
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    root = logging.getLogger()
    old_level, old_handlers = root.level, list(root.handlers)
    root.setLevel(logging.INFO)
    # _capture_debug 只替换了 plog.log;这里还要让根 handler 能接收传播记录
    handler = logging.Handler()
    handler.emit = lambda record: lines.append(record.getMessage())
    root.handlers = [handler]
    try:
        plog.log_llm_prompt(kind="t", system="S", user="U")
    finally:
        root.setLevel(old_level)
        root.handlers = old_handlers
    assert lines, "根 logger 为 INFO 时 prompt debug 记录不应被过滤"
    assert "[PROMPT][t]" in lines[0]


def test_enabled_logs_with_kind_model_and_lengths(monkeypatch):
    lines = _capture_debug(monkeypatch)
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    plog.log_llm_prompt(kind="harness:curator", api_id="openai", model="gpt-x",
                        system="SYS", user="USER")
    out = "\n".join(lines)
    assert "[PROMPT][harness:curator]" in out
    assert "api=openai" in out and "model=gpt-x" in out
    assert "共 3 字符" in out  # system/user 长度标注


def test_truncate_default_2000(monkeypatch):
    lines = _capture_debug(monkeypatch)
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    long = "字" * 5000
    plog.log_llm_prompt(kind="t", system=long, user="u")
    out = "\n".join(lines)
    assert "已截断,共 5000 字符" in out
    assert "共 5000 字符) ---" in out  # 标注总长
    assert long not in out


def test_truncate_off_shows_full(monkeypatch):
    lines = _capture_debug(monkeypatch)
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    monkeypatch.setenv("RPG_LOG_PROMPTS_TRUNCATE", "0")
    long = "字" * 5000
    plog.log_llm_prompt(kind="t", system=long, user="u")
    out = "\n".join(lines)
    assert "已截断" not in out
    assert long in out, "关闭截断时应展示完整内容"


def test_truncate_custom_limit(monkeypatch):
    lines = _capture_debug(monkeypatch)
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    monkeypatch.setenv("RPG_LOG_PROMPTS_TRUNCATE", "500")
    plog.log_llm_prompt(kind="t", system="x" * 1000, user="u")
    out = "\n".join(lines)
    assert "已截断,共 1000 字符" in out


def test_messages_variant_rendered(monkeypatch):
    lines = _capture_debug(monkeypatch)
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": [{"type": "text", "text": "U"}]}]
    plog.log_llm_prompt(kind="gm_chat", api_id="anthropic", model="claude-x", messages=msgs)
    out = "\n".join(lines)
    assert "#0 system" in out and "#1 user" in out
    assert '"type": "text"' in out  # 非字符串 content 转 JSON


def test_harness_call_agent_json_wired(monkeypatch):
    """接线:call_agent_json 必须经 log_llm_prompt 打点(dispatch 失败也应有日志)。"""
    seen = {}
    monkeypatch.setenv("RPG_LOG_PROMPTS", "1")
    monkeypatch.setattr(plog, "log_llm_prompt",
                        lambda **kw: seen.update(kw))
    # openai 通道无凭据 → dispatch 抛错,但日志打点在 dispatch 之前
    with pytest.raises(Exception):
        harness_mod.call_agent_json(api_id="openai", model="m", system_prompt="SYS-P",
                                    user_prompt="USER-P", user_id=None, agent_kind="curator")
    assert seen["kind"] == "harness:curator"
    assert seen["system"] == "SYS-P"
    assert seen["user"] == "USER-P"


def test_harness_not_logged_when_disabled(monkeypatch):
    """门控关闭时:真实 log_llm_prompt 运行但 gate 拦下 → 底层 logger 零输出。"""
    lines = _capture_debug(monkeypatch)
    with pytest.raises(Exception):
        harness_mod.call_agent_json(api_id="openai", model="m", system_prompt="SYS-P",
                                    user_prompt="USER-P", user_id=None, agent_kind="curator")
    assert lines == [], "门控关闭时不应有任何 prompt 日志输出"
