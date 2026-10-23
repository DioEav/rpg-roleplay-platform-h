"""OpenCode Go 的 x-opencode-session 注入边界。

OpenCode Go 网关强制 chat 请求带 `x-opencode-session`(缺失 → 400 MissingSessionID),
但这不是 OpenAI 兼容协议的一部分。本仓只在 base_url 命中 `opencode.ai/zen/go` 时注入;
其它 provider 的请求头必须与 openai_default_headers() **完全一致**。
"""
from __future__ import annotations

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
