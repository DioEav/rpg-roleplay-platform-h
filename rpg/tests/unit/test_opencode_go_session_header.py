"""OpenCode Go 的 x-opencode-session 注入边界。

OpenCode Go 网关强制 chat 请求带 `x-opencode-session`(缺失 → 400 MissingSessionID),
但这不是 OpenAI 兼容协议的一部分。本仓只在 base_url 命中 `opencode.ai/zen/go` 时注入;
其它 provider 的请求头必须与 openai_default_headers() **完全一致**。
"""
from __future__ import annotations

import json
import urllib.error

import pytest

from core.outbound_ua import (
    is_opencode_go_base_url,
    openai_default_headers,
    openai_default_headers_for,
    opencode_session_id,
)

OPENCODE_GO_URLS = [
    "https://opencode.ai/zen/go",
    "https://opencode.ai/zen/go/",
    "https://opencode.ai/zen/go/v1",
    "https://opencode.ai/zen/go/v1/",
    "https://opencode.ai/zen/go/v1/chat/completions",
    "https://www.opencode.ai/zen/go/v1",
    "https://OpenCode.AI/zen/go/v1",
]

OTHER_PROVIDER_URLS = [
    None,
    "",
    "https://api.openai.com/v1",
    "https://api.deepseek.com/v1",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "https://api.x.ai/v1",
    "https://token-plan-cn.xiaomimimo.com/v1",
    "https://api.siliconflow.com/v1",
    "https://funhpc.com/v1",
    # OpenCode 的另一个端点(非 Go)/ 相似路径 / 相似域名:都不该命中
    "https://opencode.ai/zen/v1",
    "https://opencode.ai/zen/gopher/v1",
    "https://notopencode.ai/zen/go/v1",
    "https://opencode.ai.evil.com/zen/go/v1",
]


@pytest.mark.parametrize("url", OPENCODE_GO_URLS)
def test_detects_opencode_go_base_url(url):
    assert is_opencode_go_base_url(url) is True


@pytest.mark.parametrize("url", OTHER_PROVIDER_URLS)
def test_ignores_non_opencode_go_base_url(url):
    assert is_opencode_go_base_url(url) is False


def test_header_added_only_for_opencode_go():
    headers = openai_default_headers_for(
        "https://opencode.ai/zen/go/v1", user_id=7, api_id="opencode-go")
    assert headers["x-opencode-session"].startswith("rpg-")
    # UA 逻辑完全不变
    assert headers["User-Agent"] == openai_default_headers()["User-Agent"]


@pytest.mark.parametrize("url", OTHER_PROVIDER_URLS)
def test_other_providers_headers_unchanged(url):
    assert openai_default_headers_for(url, user_id=7, api_id="any") == openai_default_headers()


def test_session_id_stable_per_user_and_api():
    first = opencode_session_id(7, "opencode-go")
    assert first == opencode_session_id(7, "opencode-go")
    assert first != opencode_session_id(8, "opencode-go")
    assert first != opencode_session_id(7, "another-relay")


def _make_backend(monkeypatch, base_url: str):
    """构造真实 backend,只把凭证解析换成固定 base_url(不发网络请求)。"""
    import platform_app.user_credentials as uc

    monkeypatch.setattr(
        uc, "resolve_api_key",
        lambda user_id, api_id, env_fallback="": {
            "key": "sk-test", "source": "user_db",
            "base_url_override": base_url, "proxy": "", "auth_mode": "api_key",
        },
    )
    # 避免读 users.preferences 的 DB 查询
    monkeypatch.setattr("core.config.llm_timeout_seconds", lambda user_id=None: 60.0)

    from agents.gm.backends.openai_compat import _OpenAICompatBackend
    return _OpenAICompatBackend(
        model="deepseek-v4.1-flash", base_url="", env_key="X",
        display_kind="opencode-go", user_id=7, api_id="opencode-go",
    )


def test_backend_injects_session_header_for_opencode_go(monkeypatch):
    backend = _make_backend(monkeypatch, "https://opencode.ai/zen/go/v1")
    headers = backend.client.default_headers
    assert headers.get("x-opencode-session")
    assert headers["User-Agent"] == openai_default_headers()["User-Agent"]


def test_backend_session_header_survives_rebuild(monkeypatch):
    """backend 被 LRU 重建 / 每次探查新建时,同一 (user, api) 的会话 ID 保持不变。"""
    first = _make_backend(monkeypatch, "https://opencode.ai/zen/go/v1").client.default_headers
    second = _make_backend(monkeypatch, "https://opencode.ai/zen/go").client.default_headers
    assert first["x-opencode-session"] == second["x-opencode-session"]


@pytest.mark.parametrize("url", [
    "https://api.deepseek.com/v1",
    "https://token-plan-cn.xiaomimimo.com/v1",
    "https://opencode.ai/zen/v1",
])
def test_backend_headers_unchanged_for_other_providers(monkeypatch, url):
    backend = _make_backend(monkeypatch, url)
    headers = backend.client.default_headers
    assert "x-opencode-session" not in headers
    assert headers["User-Agent"] == openai_default_headers()["User-Agent"]


# ── agent harness(子代理/extractor 等)的原始 urllib 请求 ────────────────────
# 历史 bug:主 GM 走 SDK(_client.prepare_openai_client)会注入 session 头,而
# _harness._openai_function_call / _openai_compat_json_mode 用裸 urllib 只带
# Authorization → 同一 key/模型「GM 能聊、子代理 400 MissingSessionID」。

TOOL_SCHEMA = {
    "name": "emit_curator_plan",
    "description": "x",
    "input_schema": {"type": "object", "properties": {}},
}


def _fake_response(payload: dict):
    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    return _Resp()


def _lower_headers(req) -> dict[str, str]:
    return {k.lower(): v for k, v in req.headers.items()}


def _patch_harness_creds(monkeypatch, base_url: str):
    import platform_app.user_credentials as uc
    monkeypatch.setattr(
        uc, "resolve_api_key",
        lambda user_id, api_id, env_fallback="": {
            "key": "sk-test", "source": "user_db",
            "base_url_override": base_url, "proxy": "", "auth_mode": "api_key",
        },
    )
    from agents import _harness as h
    # 避免走 model_registry.resolve_api_format 的 DB 查询
    monkeypatch.setattr(h, "_effective_api_format", lambda *a, **kw: "chat_completions")
    return h


def test_harness_tools_request_and_json_fallback_carry_session_header(monkeypatch):
    """子代理第一跳 tools 被 400 拒 → json_object 降级;两次请求都必须带 session 头。"""
    h = _patch_harness_creds(monkeypatch, "https://opencode.ai/zen/go/v1")
    seen: list[dict[str, str]] = []

    def fake_urlopen(req, *, timeout):
        seen.append(_lower_headers(req))
        if len(seen) == 1:
            raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, None)
        return _fake_response({
            "choices": [{"message": {"content": '{"ok":true}'}}],
            "usage": {},
        })

    monkeypatch.setattr(h, "_no_redirect_urlopen", fake_urlopen)
    text, _usage = h._openai_function_call(
        "opencode-go", "deepseek-v4.1-flash", "sys", "user",
        TOOL_SCHEMA, 7, 30, 200,
    )

    assert text == '{"ok":true}'
    assert len(seen) == 2, "tools 400 应降级到 json_object 重发一次"
    for headers in seen:
        assert headers.get("x-opencode-session", "").startswith("rpg-")
        assert headers.get("authorization") == "Bearer sk-test"
        assert headers.get("user-agent") == openai_default_headers()["User-Agent"]


def test_harness_json_mode_retry_keeps_session_header(monkeypatch):
    """json_object 被 400 拒 → 去掉 response_format 的重发同样要带 session 头。"""
    h = _patch_harness_creds(monkeypatch, "https://opencode.ai/zen/go/v1")
    seen: list[dict[str, str]] = []

    def fake_urlopen(req, *, timeout):
        seen.append(_lower_headers(req))
        if len(seen) == 1:
            raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, None)
        return _fake_response({
            "choices": [{"message": {"content": "{}"}}],
            "usage": {},
        })

    monkeypatch.setattr(h, "_no_redirect_urlopen", fake_urlopen)
    text, _usage = h._openai_compat_json_mode(
        "opencode-go", "deepseek-v4.1-flash", "sys", "user", 7, 30, 200,
    )

    assert text == "{}"
    assert len(seen) == 2
    assert all(hdrs.get("x-opencode-session") for hdrs in seen)


@pytest.mark.parametrize("base_url", ["https://api.deepseek.com/v1", "https://opencode.ai/zen/v1"])
def test_harness_headers_unchanged_for_other_providers(monkeypatch, base_url):
    h = _patch_harness_creds(monkeypatch, base_url)
    captured: dict[str, dict[str, str]] = {}

    def fake_urlopen(req, *, timeout):
        captured["headers"] = _lower_headers(req)
        return _fake_response({
            "choices": [{"message": {"content": "{}"}}],
            "usage": {},
        })

    monkeypatch.setattr(h, "_no_redirect_urlopen", fake_urlopen)
    h._openai_compat_json_mode("relay", "m", "sys", "user", 7, 30, 200)

    headers = captured["headers"]
    assert "x-opencode-session" not in headers
    assert headers["user-agent"] == openai_default_headers()["User-Agent"]


# ── 同面横扫:extractor / command_agent 自己的 OpenAI 兼容原始请求 ─────────────
# 这两个模块与 _harness 是平行的 urllib 实现,同样会选中 opencode-go(模块模型可配),
# 少 session 头就会 400。修复后必须都走同一个 _openai_compat_headers。

def test_extractor_chat_request_and_retry_carry_session_header(monkeypatch):
    from agents import extractor

    _patch_harness_creds(monkeypatch, "https://opencode.ai/zen/go/v1")
    seen: list[dict[str, str]] = []

    def fake_urlopen(req, *, timeout):
        seen.append(_lower_headers(req))
        if len(seen) == 1:
            raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, None)
        return _fake_response({
            "choices": [{"message": {"content": "[]"}}],
        })

    monkeypatch.setattr("core.outbound.safe_urlopen", fake_urlopen)
    out = extractor._call_openai_compat_json_mode(
        "opencode-go", "deepseek-v4.1-flash", "sys", "user", 7, 30,
    )

    assert out == "[]"
    assert len(seen) == 2, "response_format 被 400 拒后应退参重发一次"
    assert all(hdrs.get("x-opencode-session") for hdrs in seen)


def test_command_agent_chat_request_carries_session_header(monkeypatch):
    from agents import command_agent

    _patch_harness_creds(monkeypatch, "https://opencode.ai/zen/go/v1")
    captured: dict[str, dict[str, str]] = {}

    def fake_urlopen(req, *, timeout):
        captured["headers"] = _lower_headers(req)
        return _fake_response({"choices": [{"message": {"content": "[]"}}]})

    monkeypatch.setattr("core.outbound.safe_urlopen", fake_urlopen)
    out = command_agent._call_openai_compat_tools(
        "opencode-go", "deepseek-v4.1-flash", "user", 7, 30,
    )

    assert out == []
    assert captured["headers"].get("x-opencode-session", "").startswith("rpg-")
