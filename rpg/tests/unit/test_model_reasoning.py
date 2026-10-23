"""model_reasoning —— 模型级思考能力 + 方言适配回归。

2026-10 起思考控制不再按 provider 白名单写死:
  · 每个模型由 spec_for_model 推断 supported / dialect / levels / can_disable
  · backend 只调用 build_openai_params / build_anthropic_thinking /
    build_gemini_thinking_budget,不再 if api_id == "openai"/"deepseek"
  · 未知模型默认不发字段;用户可用 reasoning_model_overrides 覆盖

这些测试锁住「什么模型显示什么档位」以及「每个档位实际发的 wire 字段」。
"""
from __future__ import annotations

import model_reasoning as mr


def _no_prefs(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda user_id: {})


# ── 能力推断 ────────────────────────────────────────────────────────────

def test_deepseek_chat_is_not_mistaken_for_reasoning():
    assert mr.spec_for_model("deepseek", "deepseek-chat")["supported"] is False


def test_deepseek_official_models_are_reasoning_even_without_caps():
    """backend 调用时没有 catalog caps;deepseek-flash 不能被名字规则漏掉。"""
    spec = mr.spec_for_model("deepseek", "deepseek-flash")
    assert spec["supported"] and spec["dialect"] == "deepseek"
    assert spec["can_disable"] and "off" in spec["levels"]


def test_openai_reasoning_models_do_not_offer_fake_off():
    spec = mr.spec_for_model("openai", "gpt-5.6-sol")
    assert spec["supported"] and spec["dialect"] == "openai_effort"
    assert spec["can_disable"] is False
    assert "off" not in spec["levels"]


def test_o_series_low_uses_low_not_minimal():
    spec = mr.spec_for_model("openai", "o3-mini")
    assert spec["dialect"] == "openai_effort"
    assert mr.build_openai_params(spec, "low") == {"reasoning_effort": "low"}


def test_o3_o4_capability_defaults_are_updated():
    """旧能力表只列到 o1;o3/o4 已 sync 的用户必须能拿到 reasoning cap 与控件。"""
    import model_probe
    for name in ("o3", "o3-mini", "o3-pro", "o4", "o4-mini"):
        caps = model_probe.get_capabilities("openai", name)
        assert "reasoning" in caps, name
        spec = mr.spec_for_model(
            "openai", name, model_dict={"capabilities": caps})
        assert spec["supported"] is True, name


def test_claude_old_generation_is_not_reasoning():
    assert mr.spec_for_model("anthropic", "claude-3-5-sonnet")["supported"] is False


def test_claude_newer_generation_falls_back_when_caps_stale():
    """caps 表漏标 claude-sonnet-4-5,但名字规则应允许显示思考控件。"""
    spec = mr.spec_for_model(
        "anthropic", "claude-sonnet-4-5",
        model_dict={"capabilities": ["text", "streaming", "tools", "json_mode"]})
    assert spec["supported"] is True and spec["dialect"] == "anthropic_budget"


def test_gemini_pro_cannot_fully_disable_but_flash_can():
    pro = mr.spec_for_model("vertex_ai", "gemini-2.5-pro")
    flash = mr.spec_for_model("vertex_ai", "gemini-3.8-flash")
    assert pro["supported"] and pro["can_disable"] is False and "off" not in pro["levels"]
    assert flash["supported"] and flash["can_disable"] is True and "off" in flash["levels"]


def test_ark_agent_plan_third_party_models_do_not_use_doubao_dialect():
    """Agent Plan 订阅套餐里是 deepseek 等第三方模型,不能按豆包 thinking.type 发。"""
    spec = mr.spec_for_model("ark_agent_plan", "deepseek-v4-pro")
    assert spec["supported"] is True
    assert spec["dialect"] == "openai_effort"


def test_custom_relay_is_inferred_by_model_name():
    assert mr.spec_for_model("myrelay", "glm-4.6")["dialect"] == "glm_thinking"
    assert mr.spec_for_model("myrelay", "kimi-k2-thinking")["dialect"] == "kimi_thinking"
    assert mr.spec_for_model("myrelay", "qwen3.8-max")["dialect"] == "qwen_enable_thinking"
    assert mr.spec_for_model("myrelay", "qwen3-72b")["supported"] is True
    assert mr.spec_for_model("myrelay", "claude-sonnet-4-6")["dialect"] == "openai_effort"
    assert mr.spec_for_model("myrelay", "deepseek-flash")["supported"] is True
    # 名字能识别、但没有专属方言的模型 → 通用 reasoning_effort,而不是直接判不支持。
    magistral = mr.spec_for_model("myrelay", "magistral-medium")
    assert magistral["supported"] is True and magistral["dialect"] == "openai_effort"


def test_known_provider_caps_can_veto_name_heuristic():
    """OpenAI 目录明确标了非推理的变体,不能因为名字里有 gpt-5 就放行。"""
    spec = mr.spec_for_model(
        "openai", "gpt-5.5-instant",
        model_dict={"capabilities": ["text", "streaming", "tools", "json_mode"]})
    assert spec["supported"] is False
    # Vertex 是已知例外:旧目录可能漏标 2.5-flash 的 reasoning,名字兜底仍要放行。
    v = mr.spec_for_model(
        "vertex_ai", "gemini-2.5-flash",
        model_dict={"capabilities": ["text", "streaming", "tools", "json_mode"]})
    assert v["supported"] is True and v["dialect"] == "gemini_budget"
    # 豆包 seed-1.6 不在旧 caps 表里,但确实支持 thinking。
    d = mr.spec_for_model(
        "doubao", "doubao-seed-1.6",
        model_dict={"capabilities": ["text", "streaming"]})
    assert d["supported"] is True and d["dialect"] == "doubao_thinking"
    # 混元 T1 同样不在旧 caps 表里。
    h = mr.spec_for_model(
        "hunyuan", "hunyuan-t1",
        model_dict={"capabilities": ["text", "streaming"]})
    assert h["supported"] is True


def test_known_provider_with_relay_models_falls_back_to_name():
    """用户把 openai provider 的 base_url 改成中转站、同步来 deepseek 模型:
    caps 只是 text/streaming 兜底,不能因此把思考能力否决掉。"""
    relay_model = {
        "real_name": "deepseek-v4-pro", "synced": True,
        "capabilities": ["text", "streaming"],
    }
    spec = mr.spec_for_model("openai", "deepseek-v4-pro", model_dict=relay_model)
    assert spec["supported"] is True
    assert spec["dialect"] == "openai_effort"

    # 但自家家族的模型仍以目录 caps 为准,不能靠名字放行。
    instant = {
        "real_name": "gpt-5.5-instant", "synced": True,
        "capabilities": ["text", "streaming"],
    }
    assert mr.spec_for_model("openai", "gpt-5.5-instant", model_dict=instant)["supported"] is False


def test_non_reasoning_variants_do_not_get_fake_levels():
    """flash-lite / qwen flash / haiku 这类容易被子串误判的型号必须保持关闭。"""
    assert mr.spec_for_model("vertex_ai", "gemini-3.5-flash-lite")["supported"] is False
    assert mr.spec_for_model("dashscope", "qwen3.6-flash")["supported"] is False
    assert mr.spec_for_model("anthropic", "claude-haiku-4-5")["supported"] is False


def test_unknown_relay_model_stays_unsupported():
    spec = mr.spec_for_model("myrelay", "mystery-1")
    assert spec["supported"] is False and spec["levels"] == ["auto"]
    assert mr.build_openai_params(spec, "high") == {}


def test_custom_relay_with_explicit_reasoning_cap_gets_generic_dialect():
    spec = mr.spec_for_model(
        "myrelay", "mystery-1", model_dict={"capabilities": ["text", "reasoning"]})
    assert spec["supported"] is True
    assert spec["dialect"] == "openai_effort"
    assert spec["confidence"] == "assumed"


# ── wire 字段 ───────────────────────────────────────────────────────────

def test_deepseek_off_and_levels():
    spec = mr.spec_for_model("deepseek", "deepseek-v4-pro")
    assert mr.build_openai_params(spec, "off") == {
        "extra_body": {"thinking": {"type": "disabled"}}}
    assert mr.build_openai_params(spec, "high") == {"reasoning_effort": "high"}
    assert mr.build_openai_params(spec, "extra") == {"reasoning_effort": "xhigh"}
    assert mr.build_openai_params(spec, "auto") == {}


def test_openrouter_uses_unified_reasoning_object():
    spec = mr.spec_for_model("openrouter", "anthropic/claude-opus-4-7")
    assert mr.build_openai_params(spec, "high") == {
        "extra_body": {"reasoning": {"effort": "high"}}}
    assert mr.build_openai_params(spec, "off") == {
        "extra_body": {"reasoning": {"enabled": False}}}


def test_qwen_sends_enable_thinking_and_budget():
    spec = mr.spec_for_model("dashscope", "qwen3.8-max")
    out = mr.build_openai_params(spec, "high")
    assert out["extra_body"]["enable_thinking"] is True
    assert out["extra_body"]["thinking_budget"] == 8192
    assert mr.build_openai_params(spec, "off") == {
        "extra_body": {"enable_thinking": False}}


def test_mimo_uses_thinking_type_only():
    """MiMo 原生 OpenAI 兼容端点只认 thinking.type;不要发 reasoning_effort。"""
    spec = mr.spec_for_model("xiaomi_mimo", "mimo-v2.6-flash")
    assert spec["supported"] is True and spec["dialect"] == "mimo_thinking"
    assert spec["levels"] == ["auto", "off", "high"]
    assert mr.build_openai_params(spec, "high") == {
        "extra_body": {"thinking": {"type": "enabled"}}}
    assert mr.build_openai_params(spec, "off") == {
        "extra_body": {"thinking": {"type": "disabled"}}}
    assert mr.build_openai_params(spec, "auto") == {}
    # 自建中转站把 api_id 写成 mimo 也要识别。
    custom = mr.spec_for_model("mimo", "mimo-v2.6-flash")
    assert custom["supported"] is True and custom["dialect"] == "mimo_thinking"


def test_mimo_capabilities_include_reasoning():
    import model_probe
    for name in ("mimo-7b-rl", "mimo-v2.5-pro", "mimo-v2.6-flash"):
        assert "reasoning" in model_probe.get_capabilities("xiaomi_mimo", name), name


def test_glm_kimi_doubao_use_thinking_type():
    for api, model in (("myrelay", "glm-4.6"),
                       ("myrelay", "kimi-k2-thinking"),
                       ("myrelay", "doubao-seed-1.6")):
        spec = mr.spec_for_model(api, model)
        assert mr.build_openai_params(spec, "high") == {
            "extra_body": {"thinking": {"type": "enabled"}}}
        assert mr.build_openai_params(spec, "off") == {
            "extra_body": {"thinking": {"type": "disabled"}}}


def test_anthropic_thinking_budget():
    spec = mr.spec_for_model("anthropic", "claude-opus-5")
    assert mr.build_anthropic_thinking(spec, "high") == {
        "type": "enabled", "budget_tokens": 8192}
    assert mr.build_anthropic_thinking(spec, "off") is None
    assert mr.build_anthropic_thinking(spec, "auto") is None
    # 原生 backend 不能被非原生方言误导发 budget 结构。
    wrong = dict(spec, dialect="openai_effort")
    assert mr.build_anthropic_thinking(wrong, "high") is None


def test_gemini_budget_refuses_non_native_dialect():
    spec = mr.spec_for_model("vertex_ai", "gemini-3.8-flash")
    wrong = dict(spec, dialect="custom_json")
    assert mr.build_gemini_thinking_budget(wrong, "high") is None


def test_gemini_budget_and_pro_clamp():
    flash = mr.spec_for_model("vertex_ai", "gemini-3.8-flash")
    assert mr.build_gemini_thinking_budget(flash, "off") == 0
    assert mr.build_gemini_thinking_budget(flash, "high") == 8192
    assert mr.build_gemini_thinking_budget(flash, "auto") is None
    pro = mr.spec_for_model("vertex_ai", "gemini-2.5-pro")
    assert mr.build_gemini_thinking_budget(pro, "off") == 128


def test_effective_max_tokens_reserves_room_for_thinking():
    spec = mr.spec_for_model("deepseek", "deepseek-v4-pro")
    assert mr.effective_max_tokens(spec, "high", 4096) == 9216
    assert mr.effective_max_tokens(spec, "auto", 4096) == 4096
    assert mr.effective_max_tokens(spec, "off", 4096) == 4096


def test_effective_max_tokens_honors_zero_reserve_and_counts_flag():
    spec = dict(mr.spec_for_model("deepseek", "deepseek-v4-pro"))
    spec["output_reserve_tokens"] = 0
    # 0 = 用户显式关闭额外预留,仍然保证 budget 本身放得下。
    assert mr.effective_max_tokens(spec, "high", 4096) == 8192

    spec["reasoning_counts_in_output"] = False
    assert mr.effective_max_tokens(spec, "high", 4096) == 4096


# ── 作用域/偏好 ─────────────────────────────────────────────────────────

def test_save_override_beats_model_preference(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "model_effort": {"deepseek:deepseek-v4-pro": "low"},
    })
    spec = mr.spec_for_model("deepseek", "deepseek-v4-pro")
    level = mr.resolve_level(
        1, "deepseek", "deepseek-v4-pro", spec,
        override={"api_id": "deepseek", "model_id": "deepseek-v4-pro", "level": "max"},
    )
    assert level == "max"


def test_save_override_only_applies_to_matching_model(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "model_effort": {"deepseek:deepseek-v4-pro": "low"},
    })
    spec = mr.spec_for_model("deepseek", "deepseek-v4-pro")
    level = mr.resolve_level(
        1, "deepseek", "deepseek-v4-pro", spec,
        override={"api_id": "deepseek", "model_id": "other-model", "level": "max"},
    )
    assert level == "low"


def test_unsupported_level_collapses_to_nearest_real_level(monkeypatch):
    """GLM/Kimi 这类只有开/关的模型,旧偏好 medium 不能变成「没选中任何档位」。"""
    _no_prefs(monkeypatch)
    spec = mr.spec_for_model("myrelay", "glm-4.6")
    assert mr.resolve_level(1, "myrelay", "glm-4.6", spec) == "auto"
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "model_effort": {"myrelay:glm-4.6": "medium"},
    })
    assert mr.resolve_level(1, "myrelay", "glm-4.6", spec) == "high"


def test_legacy_providers_default_high_but_new_models_default_auto(monkeypatch):
    _no_prefs(monkeypatch)
    legacy = mr.spec_for_model("deepseek", "deepseek-v4-pro")
    assert mr.resolve_level(1, "deepseek", "deepseek-v4-pro", legacy) == "high"
    custom = mr.spec_for_model("myrelay", "glm-4.6")
    assert mr.resolve_level(1, "myrelay", "glm-4.6", custom) == "auto"


def test_user_override_can_change_dialect(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "reasoning_model_overrides": {
            "myrelay:mystery-1": {"dialect": "openai_effort", "supported": True},
        },
    })
    spec = mr.spec_for_model("myrelay", "mystery-1", user_id=1)
    assert spec["supported"] is True
    assert spec["dialect"] == "openai_effort"
    assert spec["levels"] == ["auto", "low", "medium", "high"]
    assert mr.build_openai_params(spec, "medium") == {"reasoning_effort": "medium"}


def test_public_spec_exposes_legacy_default_for_ui():
    spec = mr.spec_for_model("deepseek", "deepseek-v4-pro")
    pub = mr.public_spec(spec)
    assert pub["supported"] is True
    assert pub["default_level"] == "high"


def test_user_default_level_wins_over_legacy_high():
    """编辑模型里显式设的默认档位必须被 UI/请求使用,不能被 legacy=high 盖掉。"""
    spec = mr.spec_for_model(
        "anthropic", "claude-sonnet-4-5", user_id=None,
        override={
            "enabled": True, "supported": True, "dialect": "anthropic_budget",
            "can_disable": True,
            "levels": ["auto", "off", "low", "medium", "high"],
            "default_level": "low",
        })
    assert mr.public_spec(spec)["default_level"] == "low"
    assert mr.resolve_level(None, "anthropic", "claude-sonnet-4-5", spec) == "low"


def test_user_default_level_applies_to_custom_relay():
    """mimo / 自建中转站自定义默认档位后,设置页与请求都应使用该档位。"""
    spec = mr.spec_for_model(
        "myrelay", "mimo-v2.6-flash", api_dict={"_custom": True}, user_id=None,
        override={
            "enabled": True, "supported": True, "dialect": "mimo_thinking",
            "can_disable": True,
            "levels": ["auto", "off", "high"], "default_level": "high",
        })
    assert mr.public_spec(spec)["default_level"] == "high"
    assert mr.resolve_level(None, "myrelay", "mimo-v2.6-flash", spec) == "high"


def test_dialect_only_override_keeps_legacy_default_high():
    """只改发送方式、不写 default_level 的旧覆盖:老 provider 仍保持 legacy high。"""
    spec = mr.spec_for_model(
        "deepseek", "deepseek-v4-pro", user_id=None,
        override={"dialect": "openai_effort", "supported": True})
    assert mr.public_spec(spec)["default_level"] == "high"
    assert mr.resolve_level(None, "deepseek", "deepseek-v4-pro", spec) == "high"


def test_catalog_explicit_default_level_wins_over_legacy():
    spec = mr.spec_for_model(
        "deepseek", "deepseek-v4-pro",
        model_dict={"reasoning": {
            "dialect": "deepseek", "supported": True,
            "levels": ["auto", "off", "low", "high"], "default_level": "low",
        }},
        user_id=None)
    assert mr.public_spec(spec)["default_level"] == "low"
    assert mr.resolve_level(None, "deepseek", "deepseek-v4-pro", spec) == "low"


def test_disabled_override_does_not_pin_default_level(monkeypatch):
    """enabled=false 的旧覆盖视为不存在,老 provider 仍回退 legacy high。"""
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "reasoning_model_overrides": {
            "anthropic:claude-sonnet-4-5": {
                "enabled": False, "default_level": "low",
            },
        },
    })
    spec = mr.spec_for_model("anthropic", "claude-sonnet-4-5", user_id=1)
    assert mr.public_spec(spec)["default_level"] == "high"


def test_user_dialect_change_sanitizes_stale_levels():
    """设置页只换 dialect、保留旧方言 levels/can_disable 时,不能带出新方言不支持的档位。"""
    spec = mr.spec_for_model(
        "myrelay", "mimo-v2.6-flash", api_dict={"_custom": True}, user_id=None,
        override={
            "dialect": "openai_effort", "supported": True, "can_disable": True,
            "levels": ["auto", "off", "low", "medium", "high"],
            "default_level": "high",
        })
    assert spec["levels"] == ["auto", "low", "medium", "high"]
    assert spec["can_disable"] is False
    assert mr.public_spec(spec)["default_level"] == "high"


def test_user_custom_json_levels_are_not_sanitized():
    """custom_json 允许任意档位,不能被当成内置方言裁掉。"""
    spec = mr.spec_for_model(
        "myrelay", "mimo-v2.6-flash", api_dict={"_custom": True}, user_id=None,
        override={
            "dialect": "custom_json", "supported": True, "can_disable": True,
            "levels": ["auto", "off", "max"], "default_level": "max",
        })
    assert "max" in spec["levels"]
    assert spec["default_level"] == "max"


def test_api_models_injection_attaches_reasoning(monkeypatch):
    """前端能力驱动 UI 的唯一数据源:每个 model 必须带 reasoning 描述。"""
    from routes import models as routes_models
    monkeypatch.setattr(mr, "load_reasoning_overrides", lambda uid: {})
    cat = {"apis": [{
        "id": "myrelay", "_custom": True,
        "models": [
            {"real_name": "glm-4.6", "capabilities": ["text", "streaming"]},
            {"real_name": "mystery-1", "capabilities": ["text", "streaming"]},
        ],
    }]}
    out = routes_models._inject_reasoning(cat, 1)
    models = out["apis"][0]["models"]
    assert models[0]["reasoning"]["supported"] is True
    assert models[0]["reasoning"]["dialect"] == "glm_thinking"
    assert models[1]["reasoning"]["supported"] is False
    assert models[1]["reasoning"]["levels"] == ["auto"]


# ── 自定义模型配置（标签覆盖 + custom spec）────────────────────────────

def test_disabled_override_falls_back_to_auto(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "reasoning_model_overrides": {
            "myrelay:glm-4.6": {
                "enabled": False, "supported": True, "dialect": "openai_effort",
                "levels": ["auto", "high"],
            },
        },
    })
    spec = mr.spec_for_model("myrelay", "glm-4.6", user_id=1)
    assert spec["dialect"] == "glm_thinking"
    assert spec["source"] != "user"


def test_custom_json_params_are_wrapped_in_extra_body(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "reasoning_model_overrides": {
            "myrelay:mystery-1": {
                "enabled": True,
                "supported": True,
                "dialect": "custom_json",
                "can_disable": True,
                "levels": ["auto", "off", "high"],
                "default_level": "auto",
                "params_by_level": {
                    "high": {"reasoning_effort": "high"},
                    "off": {"thinking": {"type": "disabled"}},
                },
            },
        },
    })
    spec = mr.spec_for_model("myrelay", "mystery-1", user_id=1)
    assert spec["supported"] is True
    assert mr.build_openai_params(spec, "high") == {
        "extra_body": {"reasoning_effort": "high"}}
    assert mr.build_openai_params(spec, "off") == {
        "extra_body": {"thinking": {"type": "disabled"}}}


def test_validate_custom_spec_accepts_and_rejects():
    spec, errors = mr.validate_custom_reasoning_spec({
        "enabled": True,
        "supported": True,
        "dialect": "openai_effort",
        "can_disable": False,
        "levels": ["auto", "low", "medium", "high"],
        "default_level": "auto",
        "effort_values": {"low": "minimal", "medium": "medium", "high": "high"},
    })
    assert not errors and spec["supported"] is True

    bad, errs = mr.validate_custom_reasoning_spec({
        "enabled": True,
        "supported": True,
        "dialect": "custom_json",
        "levels": ["auto", "high"],
        "params_by_level": {"high": {"model": "hacked"}},
    })
    assert bad is None and any("请求主干" in e for e in errs)


def test_tag_override_participates_in_spec_resolution(monkeypatch):
    monkeypatch.setattr(mr, "_read_user_prefs", lambda uid: {
        "model_tag_overrides": {
            "myrelay:mystery-1": {"capabilities": ["text", "reasoning"]},
        },
    })
    spec, _level = mr.resolve_spec_for_call(
        1, "myrelay", "mystery-1",
        model_dict={"real_name": "mystery-1", "capabilities": ["text", "streaming"]},
    )
    assert spec["supported"] is True
    assert spec["dialect"] == "openai_effort"


def test_inject_model_overrides_after_capabilities(monkeypatch):
    from routes import models as routes_models
    monkeypatch.setattr(mr, "load_model_tag_overrides", lambda uid: {
        "myrelay:mystery-1": {"capabilities": ["text", "reasoning"]},
    })
    cat = {"apis": [{"id": "myrelay", "models": [
        {"real_name": "mystery-1", "capabilities": ["text", "streaming"]},
    ]}]}
    out = routes_models._inject_model_overrides(cat, 1)
    assert out["apis"][0]["models"][0]["capabilities"] == ["text", "reasoning"]
