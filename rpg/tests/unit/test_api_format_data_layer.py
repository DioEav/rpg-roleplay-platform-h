"""数据层：api_format 解析、目录/凭据传播。

锁定不变量：
  · 凭据覆盖 > 目录默认 > chat_completions；
  · 空值 = 继承；非法/旧脏值读取时回退 chat；
  · 自建中转站的 overlay 行携带凭据格式；
  · base_url 同时剥 /chat/completions 与 /responses 后缀。
"""
from __future__ import annotations

import pytest

import model_registry
import platform_app.user_credentials as uc
from model_formats import (
    API_FORMAT_CHAT,
    API_FORMAT_RESPONSES,
    coerce_api_format,
    is_responses,
    parse_api_format,
)


@pytest.fixture(autouse=True)
def _clear_format_cache():
    model_registry._API_FORMAT_CACHE.clear()
    yield
    model_registry._API_FORMAT_CACHE.clear()


def test_parse_and_coerce():
    assert parse_api_format("") == API_FORMAT_CHAT
    assert parse_api_format("", allow_empty=True) == ""
    assert parse_api_format("responses") == API_FORMAT_RESPONSES
    assert parse_api_format(" CHAT_COMPLETIONS ") == API_FORMAT_CHAT
    assert coerce_api_format("bogus") == API_FORMAT_CHAT
    assert is_responses("responses") is True
    assert is_responses("chat_completions") is False
    with pytest.raises(ValueError):
        parse_api_format("anthropic_messages")


def test_normalize_base_url_strips_known_endpoint_suffixes():
    assert uc._normalize_openai_base_url("https://relay/v1/responses") == "https://relay/v1"
    assert uc._normalize_openai_base_url("https://relay/v1/responses/") == "https://relay/v1"
    assert uc._normalize_openai_base_url("https://relay/v1/chat/completions") == "https://relay/v1"
    # 普通 /v1 与其它路径保持不动
    assert uc._normalize_openai_base_url("https://relay/v1") == "https://relay/v1"
    assert uc._normalize_openai_base_url("https://relay/api/plan") == "https://relay/api/plan"


def test_resolve_format_credential_overrides_catalog(monkeypatch):
    monkeypatch.setattr(
        "core.request_cache.get_api_cred_cached",
        lambda user_id, api_id: {"api_format": API_FORMAT_RESPONSES},
    )
    assert model_registry.resolve_api_format(
        "myrelay", 7, catalog_api={"api_format": API_FORMAT_CHAT},
    ) == API_FORMAT_RESPONSES


def test_resolve_format_falls_back_to_catalog(monkeypatch):
    monkeypatch.setattr(
        "core.request_cache.get_api_cred_cached",
        lambda user_id, api_id: {"api_format": ""},
    )
    assert model_registry.resolve_api_format(
        "myrelay", 7, catalog_api={"api_format": API_FORMAT_RESPONSES},
    ) == API_FORMAT_RESPONSES


def test_resolve_format_defaults_to_chat(monkeypatch):
    monkeypatch.setattr(
        "core.request_cache.get_api_cred_cached",
        lambda user_id, api_id: None,
    )
    monkeypatch.setattr(model_registry, "load_model_catalog", lambda: {"apis": []})
    assert model_registry.resolve_api_format("unknown", 7) == API_FORMAT_CHAT


def test_resolve_format_accepts_explicit_credential_without_cache(monkeypatch):
    called = {"n": 0}

    def _boom(*a, **k):
        called["n"] += 1
        raise AssertionError("should not hit cache when credential passed")

    monkeypatch.setattr("core.request_cache.get_api_cred_cached", _boom)
    assert model_registry.resolve_api_format(
        "x", 7, credential={"api_format": API_FORMAT_RESPONSES},
    ) == API_FORMAT_RESPONSES
    assert called["n"] == 0


def test_resolve_format_old_credential_without_field_defaults_chat(monkeypatch):
    """旧调用方/测试桩的 credential 不带该字段：按 chat，不触发目录 DB 查询。"""
    def _boom():
        raise AssertionError("should not load catalog for field-less credential")

    monkeypatch.setattr(model_registry, "load_model_catalog", _boom)
    assert model_registry.resolve_api_format(
        "legacy", 7, credential={"key": "sk-legacy"},
    ) == API_FORMAT_CHAT


def test_apply_user_overlay_custom_relay_carries_format(monkeypatch):
    monkeypatch.setattr(
        "platform_app.user_models.load_overlay",
        lambda uid: {"myrelay": [{"id": "m1", "real_name": "m1"}]},
    )
    monkeypatch.setattr(
        "platform_app.user_credentials.list_credentials",
        lambda uid: {"items": [{
            "api_id": "myrelay",
            "base_url_override": "https://relay/v1",
            "api_format": API_FORMAT_RESPONSES,
        }]},
    )
    out = model_registry.apply_user_overlay({"apis": []}, 1)
    api = model_registry.find_api(out, "myrelay")
    assert api is not None
    assert api["kind"] == "openai_compat"
    assert api["api_format"] == API_FORMAT_RESPONSES


def test_migrate_catalog_defaults_and_preserves_format():
    out = model_registry._migrate_catalog({
        "apis": [
            {"id": "custom-no-fmt", "kind": "openai_compat", "models": []},
            {"id": "custom-resp", "kind": "openai_compat",
             "api_format": API_FORMAT_RESPONSES, "models": []},
        ],
    })
    no_fmt = model_registry.find_api(out, "custom-no-fmt")
    resp = model_registry.find_api(out, "custom-resp")
    assert no_fmt["api_format"] == API_FORMAT_CHAT
    assert resp["api_format"] == API_FORMAT_RESPONSES


def test_upsert_api_updates_format_only(monkeypatch):
    catalog = {"apis": [{
        "id": "myrelay", "kind": "openai_compat",
        "api_format": API_FORMAT_CHAT, "models": [],
    }]}
    monkeypatch.setattr(model_registry, "load_model_catalog", lambda: catalog)
    monkeypatch.setattr(model_registry, "save_model_catalog", lambda c: None)
    model_registry.upsert_api({"api_id": "myrelay", "api_format": API_FORMAT_RESPONSES})
    assert model_registry.find_api(catalog, "myrelay")["api_format"] == API_FORMAT_RESPONSES


def test_upsert_api_rejects_invalid_format(monkeypatch):
    catalog = {"apis": [{"id": "myrelay", "kind": "openai_compat", "models": []}]}
    monkeypatch.setattr(model_registry, "load_model_catalog", lambda: catalog)
    monkeypatch.setattr(model_registry, "save_model_catalog", lambda c: None)
    with pytest.raises(ValueError):
        model_registry.upsert_api({"api_id": "myrelay", "api_format": "bogus"})
