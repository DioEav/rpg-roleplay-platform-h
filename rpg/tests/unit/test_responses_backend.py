"""Responses backend 行为回归（无网络 / 无 DB）。

覆盖：请求体、probe、流式事件、工具循环、结构化输出、400 分段退参、
usage/finish_reason 映射、GameMaster 路由，以及 harness/extractor/command 的自分发。
"""
from __future__ import annotations

import json

import httpx
import pytest
from openai import BadRequestError

from agents.gm.backends.responses import _ResponsesBackend


def _bad_request(msg: str = "bad request") -> BadRequestError:
    req = httpx.Request("POST", "https://example.test/v1/responses")
    resp = httpx.Response(400, request=req, json={"error": {"message": msg}})
    return BadRequestError(msg, response=resp, body={"error": {"message": msg}})


class _FakeResponses:
    def __init__(self, script):
        self.script = list(script)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class _FakeClient:
    def __init__(self, script):
        self.responses = _FakeResponses(script)


def _make_backend(script, *, reasoning=False):
    b = object.__new__(_ResponsesBackend)
    b.client = _FakeClient(script)
    b.model_name = "test-model"
    b.api_id = "test-api"
    b.kind = "openai_compat"
    b.user_id = 1
    b.api_format = "responses"
    b._model_meta = None
    b._reasoning_override = None
    b._last_effective_max_tokens = None
    b.last_usage = {}
    b._reasoning_state = lambda: (
        ({"supported": True, "levels": ["auto", "low", "high"],
          "dialect": "openai_effort", "effort_values": {"low": "low", "high": "high"}}, "low")
        if reasoning else
        ({"supported": False, "levels": ["auto"]}, "auto")
    )
    b._sampling_kwargs = lambda default_temperature: {"temperature": default_temperature}
    return b


@pytest.fixture(autouse=True)
def _clear_memos():
    for name in (
        "_unsupported_combos", "_sampling_rejected_combos",
        "_reasoning_rejected_combos", "_text_rejected_combos", "_store_rejected_combos",
    ):
        getattr(_ResponsesBackend, name).clear()


def _ok(text: str, *, output_tokens=10, reasoning_tokens=0):
    return {
        "status": "completed",
        "output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": text}],
        }],
        "usage": {
            "input_tokens": 21, "output_tokens": output_tokens,
            "total_tokens": 21 + output_tokens,
            "input_tokens_details": {"cached_tokens": 7},
            "output_tokens_details": {"reasoning_tokens": reasoning_tokens},
        },
    }


def test_call_builds_responses_request_and_captures_usage():
    b = _make_backend([_ok("OK", reasoning_tokens=10)], reasoning=True)
    out = b.call("Be terse.", [{"role": "user", "content": "hi"}], 128)
    assert out == "OK"
    kw = b.client.responses.calls[0]
    assert kw["model"] == "test-model"
    assert kw["instructions"] == "Be terse."
    assert kw["input"] == [{"role": "user", "content": "hi"}]
    assert kw["max_output_tokens"] == 128
    assert kw["store"] is False
    assert kw["reasoning"] == {"effort": "low"}
    assert "messages" not in kw
    assert b.last_usage["input_tokens"] == 21
    assert b.last_usage["cached_input_tokens"] == 7
    assert b.last_usage["reasoning_tokens"] == 10
    assert b.last_usage["finish_reason"] == "stop"


def test_probe_is_minimal_and_has_output_floor():
    b = _make_backend([_ok("1")])
    assert b.probe(timeout_sec=12) == "1"
    kw = b.client.responses.calls[0]
    assert kw["input"] == "1"
    assert kw["max_output_tokens"] == 64
    assert "instructions" not in kw
    assert "temperature" not in kw
    assert "reasoning" not in kw
    assert kw["timeout"] == 12.0


def test_call_clamps_tiny_max_output_tokens():
    b = _make_backend([_ok("1")])
    b.call("", [{"role": "user", "content": "hi"}], 8)
    assert b.client.responses.calls[0]["max_output_tokens"] == 16


def test_stream_emits_text_and_usage():
    events = [
        {"type": "response.output_text.delta", "delta": "1"},
        {"type": "response.output_text.delta", "delta": " 2"},
        {"type": "response.completed", "response": _ok("1 2")},
    ]
    b = _make_backend([events])
    assert list(b.stream("", [{"role": "user", "content": "count"}], 64)) == ["1", " 2"]
    assert b.last_usage["finish_reason"] == "stop"


def test_stream_falls_back_to_final_output_when_no_deltas():
    events = [{"type": "response.completed", "response": _ok("final text")}]
    b = _make_backend([events])
    assert list(b.stream("", [{"role": "user", "content": "x"}], 64)) == ["final text"]


def test_structured_uses_text_format_and_strips_on_400():
    b = _make_backend([
        _bad_request("text.format unsupported"),
        _ok('{"ok": true}'),
    ])
    out = b.call_structured("Return JSON.", [{"role": "user", "content": "go"}], 64)
    assert out == '{"ok": true}'
    assert b.client.responses.calls[0]["text"] == {"format": {"type": "json_object"}}
    assert "text" not in b.client.responses.calls[1]
    assert ("test-api", "test-model", 1) in _ResponsesBackend._text_rejected_combos


def test_400_strips_reasoning_only_after_sampling():
    b = _make_backend([
        _bad_request("reasoning unsupported"),
        _bad_request("reasoning unsupported"),
        _ok("OK"),
    ], reasoning=True)
    assert b.call("", [{"role": "user", "content": "hi"}], 64) == "OK"
    # 第一次原样；第二次剥采样；第三次剥思考
    assert "temperature" in b.client.responses.calls[0]
    assert "temperature" not in b.client.responses.calls[1]
    assert "reasoning" in b.client.responses.calls[1]
    assert "reasoning" not in b.client.responses.calls[2]
    assert ("test-api", "test-model", 1) in _ResponsesBackend._reasoning_rejected_combos


def test_non_400_is_not_downgraded():
    b = _make_backend([RuntimeError("401 unauthorized")])
    with pytest.raises(RuntimeError):
        b.call("", [{"role": "user", "content": "hi"}], 64)


def test_finish_reason_maps_incomplete_and_tool_calls():
    b = _make_backend([])
    assert b._finish_reason({"status": "completed"}) == "stop"
    assert b._finish_reason({
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
    }) == "length"
    assert b._finish_reason({
        "status": "incomplete",
        "incomplete_details": {"reason": "content_filter"},
    }) == "content_filter"
    assert b._finish_reason({"status": "completed"}, calls=[{}]) == "tool_calls"


def test_tool_loop_round_trip_uses_call_id_and_function_call_output():
    first = {
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": [{"type": "summary_text", "text": "need tool"}]},
            {"type": "function_call", "call_id": "call-1", "name": "test__get_score",
             "arguments": '{"player":"Alice"}'},
        ],
        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    }
    second = _ok("Alice's score is 42.")
    b = _make_backend([
        [
            {"type": "response.output_item.done",
             "item": {"type": "function_call", "call_id": "call-1",
                      "name": "test__get_score", "arguments": '{"player":"Alice"}'}},
            {"type": "response.completed", "response": first},
        ],
        [
            {"type": "response.output_text.delta", "delta": "Alice's score is 42."},
            {"type": "response.completed", "response": second},
        ],
    ])
    seen = []

    def _mcp(server_id, tool_name, args):
        seen.append((server_id, tool_name, args))
        return {"ok": True, "result": {"score": 42}}

    events = list(b.stream_with_mcp_loop(
        "You must call the tool.",
        [{"role": "user", "content": "Alice score?"}],
        [{"server_id": "test", "name": "get_score", "description": "Get score",
          "schema": {"type": "object", "properties": {"player": {"type": "string"}}}}],
        3, 128, _mcp,
    ))
    assert seen == [("test", "get_score", {"player": "Alice"})]
    assert any(e["type"] == "tool_call" for e in events)
    assert any(e["type"] == "tool_result" and e["ok"] for e in events)
    assert any(e["type"] == "text" and "42" in e["text"] for e in events)
    # 第二轮请求必须带回 function_call + function_call_output
    second_input = b.client.responses.calls[1]["input"]
    assert any(i.get("type") == "function_call" and i.get("call_id") == "call-1"
               for i in second_input if isinstance(i, dict))
    assert any(i.get("type") == "function_call_output" and i.get("call_id") == "call-1"
               for i in second_input if isinstance(i, dict))


# ── GameMaster 路由 ────────────────────────────────────────────────────────

def _game_master(monkeypatch, api_format: str):
    catalog = {"apis": [{
        "id": "relay", "kind": "openai_compat", "api_format": api_format,
        "base_url": "https://relay.example/v1", "models": [
            {"id": "m", "real_name": "m", "enabled": True},
        ],
    }], "selected": {"api_id": "relay", "model_id": "m"}}
    monkeypatch.setattr("model_registry.load_model_catalog", lambda: catalog)
    monkeypatch.setattr(
        "core.request_cache.get_api_cred_cached",
        lambda user_id, api_id: {"api_format": "", "base_url_override": ""},
    )
    import platform_app.user_credentials as uc
    monkeypatch.setattr(uc, "resolve_api_key", lambda user_id, api_id, env_fallback="": {
        "key": "sk-test", "source": "user_db", "base_url_override": "",
        "api_format": "", "proxy": "",
    })
    monkeypatch.setattr("core.config.llm_timeout_seconds", lambda user_id=None: 60.0)
    from agents.gm import GameMaster
    return GameMaster(api_id="relay", model="m", user_id=1)


def test_gamemaster_routes_responses(monkeypatch):
    gm = _game_master(monkeypatch, "responses")
    assert isinstance(gm._backend, _ResponsesBackend)


def test_gamemaster_keeps_chat_default(monkeypatch):
    gm = _game_master(monkeypatch, "chat_completions")
    assert not isinstance(gm._backend, _ResponsesBackend)
    assert type(gm._backend).__name__ == "_OpenAICompatBackend"


def test_gamemaster_custom_relay_uses_credential_format(monkeypatch):
    """自建中转站不在全局目录：格式必须从用户凭据解析，而不是回落 chat。"""
    empty = {"apis": [], "selected": {}}
    monkeypatch.setattr("model_registry.load_model_catalog", lambda: empty)
    monkeypatch.setattr("model_registry.load_catalog_for_user", lambda uid: empty)
    cred = {"key": "sk-test", "source": "user_db",
            "base_url_override": "https://relay.example/v1",
            "api_format": "responses", "proxy": "", "auth_mode": "api_key"}
    monkeypatch.setattr("platform_app.user_credentials.get_credential",
                        lambda uid, aid: dict(cred))
    monkeypatch.setattr("core.request_cache.get_api_cred_cached",
                        lambda uid, aid: dict(cred))
    monkeypatch.setattr("platform_app.user_credentials.resolve_api_key",
                        lambda user_id, api_id, env_fallback="": dict(cred))
    monkeypatch.setattr("core.config.llm_timeout_seconds", lambda user_id=None: 60.0)
    from agents.gm import GameMaster
    gm = GameMaster(api_id="myrelay", model="m", user_id=1)
    assert isinstance(gm._backend, _ResponsesBackend)


# ── harness / extractor / command 自分发 ────────────────────────────────────

def test_harness_json_mode_dispatches_to_responses(monkeypatch):
    import agents._harness as h
    monkeypatch.setattr(h, "_effective_api_format", lambda *a, **k: "responses")
    called = {}

    def _fake(*args, **kwargs):
        called["hit"] = (args, kwargs)
        return "{}", {}

    monkeypatch.setattr(h, "_responses_json_mode", _fake)
    monkeypatch.setattr(
        "platform_app.user_credentials.resolve_api_key",
        lambda user_id, api_id: {"key": "k", "source": "user_db",
                                 "base_url_override": "https://relay/v1",
                                 "api_format": "responses"},
    )
    out = h._openai_compat_json_mode("relay", "m", "sys", "user", 1, 10, 100)
    assert out == ("{}", {})
    assert called["hit"]


def test_harness_function_call_dispatches_to_responses(monkeypatch):
    import agents._harness as h
    monkeypatch.setattr(h, "_effective_api_format", lambda *a, **k: "responses")
    called = {}

    def _fake(*args, **kwargs):
        called["hit"] = (args, kwargs)
        return '{"ok":true}', {}

    monkeypatch.setattr(h, "_responses_function_call", _fake)
    monkeypatch.setattr(
        "platform_app.user_credentials.resolve_api_key",
        lambda user_id, api_id: {"key": "k", "source": "user_db",
                                 "base_url_override": "https://relay/v1",
                                 "api_format": "responses"},
    )
    out = h._openai_function_call(
        "relay", "m", "sys", "user", {"name": "t", "input_schema": {}}, 1, 10, 100)
    assert out == ('{"ok":true}', {})
    assert called["hit"]


def test_extractor_dispatches_to_responses(monkeypatch):
    import agents._harness as h
    import agents.extractor as ext
    monkeypatch.setattr(h, "_effective_api_format", lambda *a, **k: "responses")
    monkeypatch.setattr(
        "platform_app.user_credentials.resolve_api_key",
        lambda user_id, api_id: {"key": "k", "source": "user_db",
                                 "base_url_override": "https://relay/v1",
                                 "api_format": "responses"},
    )
    monkeypatch.setattr(h, "_responses_json_mode",
                        lambda *a, **k: ('{"ops":[{"op":"set","value":1}]}', {}))
    out = ext._call_openai_compat_json_mode("relay", "m", "sys", "user", 1, 10)
    assert json.loads(out) == [{"op": "set", "value": 1}]


def test_command_agent_dispatches_to_responses(monkeypatch):
    import agents._harness as h
    import agents.command_agent as ca
    monkeypatch.setattr(h, "_effective_api_format", lambda *a, **k: "responses")
    monkeypatch.setattr(
        "platform_app.user_credentials.resolve_api_key",
        lambda user_id, api_id: {"key": "k", "source": "user_db",
                                 "base_url_override": "https://relay/v1",
                                 "api_format": "responses"},
    )
    monkeypatch.setattr(h, "_responses_json_mode",
                        lambda *a, **k: ('{"calls":[{"name":"set_player_name","input":{"name":"A"}}]}', {}))
    out = ca._call_openai_compat_tools("relay", "m", "把名字设为 A", 1, 10)
    assert out == [{"name": "set_player_name", "input": {"name": "A"}}]


def test_probe_classifies_protocol_unsupported():
    import model_probe
    exc = RuntimeError(
        "Error code: 400 - {'type': 'error', 'error': "
        "{'type': 'ModelProtocolUnsupported', 'message': 'Model does not support this protocol.'}}")
    assert model_probe._classify_probe_error(exc, str(exc)) == "protocol_unsupported"
    assert "API 格式" in model_probe._probe_error_message("protocol_unsupported")


def _fake_cred():
    return {"key": "k", "source": "user_db",
            "base_url_override": "https://relay/v1", "api_format": "responses"}


def test_responses_function_call_returns_arguments(monkeypatch):
    import agents._harness as h
    monkeypatch.setattr(
        "platform_app.user_credentials.resolve_api_key",
        lambda user_id, api_id: _fake_cred(),
    )
    payload = {
        "output": [{"type": "function_call", "name": "emit_state_ops",
                    "arguments": '{"ops":[]}'}],
        "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
    }
    monkeypatch.setattr(h, "_responses_post", lambda *a, **k: payload)
    args, usage = h._responses_function_call(
        "relay", "m", "sys", "user",
        {"name": "emit_state_ops", "input_schema": {}}, 1, 10, 100)
    assert args == '{"ops":[]}'
    assert usage["total_tokens"] == 3


def test_responses_function_call_degrades_to_json_on_tools_403(monkeypatch):
    """OpenCode/中转站拒绝 tools 形态(403)时，史官/司命仍能拿到 JSON 结果。"""
    import io
    import urllib.error

    import agents._harness as h
    monkeypatch.setattr(
        "platform_app.user_credentials.resolve_api_key",
        lambda user_id, api_id: _fake_cred(),
    )
    calls = {"n": 0}

    def _post(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.HTTPError(
                "https://relay/v1/responses", 403, "Forbidden", None,
                io.BytesIO(b'{"error":{"message":"Endpoint is unavailable"}}'))
        return {"output_text": '{"ok":true}',
                "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}

    monkeypatch.setattr(h, "_responses_post", _post)
    args, usage = h._responses_function_call(
        "relay", "m", "sys", "user",
        {"name": "emit_state_ops", "input_schema": {}}, 1, 10, 100)
    assert args == '{"ok":true}'
    assert usage["total_tokens"] == 2
    assert calls["n"] == 2
