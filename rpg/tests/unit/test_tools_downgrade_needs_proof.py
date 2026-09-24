"""native tools 降级:400 只是候选,不带 tools 的重试被接受才记成「不支持」。

旧逻辑首跳见任何 400 就把 (api, model, user) 永久(进程内)记成不支持 tools。可 400 还包括
内容风控(DeepSeek 的 Content Exists Risk)、上下文超长、消息格式错 —— 一次风控拒绝,该用户
此后每一轮都走 text-marker 降级路径,工具调用靠模型自觉写文本格式(反馈 #106 的来路)。
"""
import httpx
import pytest
from openai import BadRequestError, RateLimitError

from agents.gm.backends.openai_compat import _OpenAICompatBackend

_TOOLS = [{"server_id": "srv", "name": "get_weather", "schema": {"type": "object", "properties": {}}}]


class _D:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _err(cls, code, msg):
    return cls(msg, response=httpx.Response(code, request=httpx.Request("POST", "https://x/v1/chat/completions")),
               body=None)


def _text_stream(text):
    yield _D(usage=None, choices=[_D(finish_reason="stop",
                                     delta=_D(content=text, reasoning_content=None, tool_calls=None))])


def _backend(api_id, create):
    b = object.__new__(_OpenAICompatBackend)
    b.api_id, b.model_name, b.user_id = api_id, "m", 1
    b.last_usage = {}
    b._tuning_kwargs = lambda _t: {}
    b._capture_usage = lambda *a, **k: None
    b._create = create
    return b


def _run(b):
    return list(b.stream_with_mcp_loop(system="s", messages=[{"role": "user", "content": "hi"}],
                                       mcp_tools=_TOOLS, max_iterations=2, max_tokens=64,
                                       mcp_call=lambda *a: {"ok": True}))


def test_content_risk_400_is_not_remembered():
    calls = []

    def create(**kw):
        calls.append("tools" in kw)
        raise _err(BadRequestError, 400, "Content Exists Risk")

    b = _backend("t_risk", create)
    try:
        with pytest.raises(BadRequestError):
            _run(b)
        assert calls == [True, False], "带 tools 被拒后应试一次不带 tools"
        assert ("t_risk", "m", 1) not in b._unsupported_combos, "不带 tools 也被拒 = 与 tools 无关,不许记"
    finally:
        b._unsupported_combos.discard(("t_risk", "m", 1))


def test_real_tools_rejection_still_downgrades_and_is_remembered():
    calls = []

    def create(**kw):
        calls.append("tools" in kw)
        if "tools" in kw:
            raise _err(BadRequestError, 400, "tools is not supported")
        return _text_stream("好的。")

    b = _backend("t_notools", create)
    try:
        text = "".join(e["text"] for e in _run(b) if e["type"] == "text")
        assert text == "好的。"
        assert ("t_notools", "m", 1) in b._unsupported_combos
        calls.clear()
        _run(b)
        assert calls == [False], "记住之后直接走 text marker,不再先撞一次 400"
    finally:
        b._unsupported_combos.discard(("t_notools", "m", 1))


def test_rate_limit_is_not_even_tried():
    calls = []

    def create(**kw):
        calls.append("tools" in kw)
        raise _err(RateLimitError, 429, "slow down")

    b = _backend("t_429", create)
    with pytest.raises(RateLimitError):
        _run(b)
    assert calls == [True]
    assert ("t_429", "m", 1) not in b._unsupported_combos
