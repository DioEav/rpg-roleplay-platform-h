"""model_reasoning.py — 模型级「思考能力」描述 + 跨 provider 方言适配。

背景(2026-10):
- 旧实现把思考控制写死在 `agents/gm/backends/_effort.py` + 三个 backend 的
  `if api_id == "openai"/"deepseek"` 里,前端还有一份供应商白名单。
- 结果是只有 anthropic/vertex_ai/openai/deepseek 能控制;用户自建中转站、
  GLM/Kimi/Qwen/Grok/豆包等即使模型支持思考,控件也不显示、后端也不发参数。
- 本模块把「模型支持什么」与「字段怎么发」拆开:
    * spec: 每个模型一条能力描述(能否关闭、支持哪些档位、预算映射、方言)
    * dialect: 把统一档位翻译成各家/各中转站实际认识的 wire 字段
  backend 只消费 `resolve_spec_for_call()` + `build_*_params()`,不再判断供应商标识。

设计约束:
- 未知模型默认 `supported=False`(不发任何字段),避免给严格中转站塞未知参数。
- 已知但未经实测的模型标 `confidence="assumed"`,前端可显示「未验证」。
- 旧 `user_preferences.model_effort["{api_id}:{model_id}"]` 继续读取,零迁移。
- 新增用户级覆盖 `reasoning_model_overrides["{api_id}:{model_id}"]`,供中转站用户
  手动指定方言/档位;不写全局 catalog,不跨用户泄露。

本模块只做纯函数 + 一次偏好读取,不 import agents/gm,避免循环依赖。
"""
from __future__ import annotations

from typing import Any

try:  # model_aliases 是独立模块,正常不会失败;失败时退化为原样字符串。
    from model_aliases import normalize_api_id as _normalize_api_id
except Exception:  # pragma: no cover - 极端导入期异常
    def _normalize_api_id(api_id: str | None) -> str:  # type: ignore[misc]
        return str(api_id or "").strip()


# 统一档位。auto = 不发字段,沿用服务商默认;off = 显式关闭(仅 can_disable 的模型)。
LEVELS: tuple[str, ...] = ("auto", "off", "low", "medium", "high", "extra", "max")
VALID_LEVELS = frozenset(LEVELS)

# 预算 token 的默认映射(同时也是 effort 型方言的「等效预算」,用于输出上限兜底)。
DEFAULT_BUDGET_TOKENS: dict[str, int] = {
    "low": 1024,
    "medium": 4096,
    "high": 8192,
    "extra": 16384,
    "max": 24576,
}

# 已知 provider(用于判断「自建中转站」:不在表里的 api_id 视为 custom)。
_KNOWN_APIS = frozenset({
    "anthropic", "openai", "openrouter", "deepseek", "dashscope", "doubao",
    "ark_agent_plan", "siliconflow", "hunyuan", "minimax", "xiaomi_mimo",
    "vertex_ai", "xai",
})

# 旧版默认值:这四家过去没配偏好时默认 high(见 _effort.DEFAULT_EFFORT)。
# 新模型一律默认 auto,避免一上来就给中转站发思考字段。
_LEGACY_DEFAULT_APIS = frozenset({"anthropic", "vertex_ai", "openai", "deepseek"})


def _base(
    dialect: str,
    *,
    supported: bool = True,
    can_disable: bool = True,
    levels: tuple[str, ...] = ("auto", "off", "low", "medium", "high", "extra", "max"),
    effort_values: dict[str, str] | None = None,
    budget_tokens: dict[str, int] | None = None,
    min_budget: int = 0,
    max_budget: int | None = None,
    output_reserve_tokens: int = 1024,
    reasoning_counts_in_output: bool = True,
    confidence: str = "verified",
    source: str = "builtin",
    off_effort: str | None = None,
    send_budget: bool = True,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "supported": bool(supported),
        "dialect": dialect,
        "can_disable": bool(can_disable),
        "levels": [lv for lv in levels if lv in VALID_LEVELS],
        "default_level": "auto",
        "effort_values": dict(effort_values or {}),
        "budget_tokens": dict(budget_tokens or DEFAULT_BUDGET_TOKENS),
        "min_budget": int(min_budget or 0),
        "max_budget": max_budget,
        "output_reserve_tokens": int(output_reserve_tokens or 0),
        "reasoning_counts_in_output": bool(reasoning_counts_in_output),
        "confidence": confidence,
        "source": source,
        "off_effort": off_effort,
        "send_budget": bool(send_budget),
    }
    if extra:
        spec.update(extra)
    return spec


def _none_spec() -> dict[str, Any]:
    return _base("none", supported=False, can_disable=False, levels=("auto",),
                 budget_tokens={}, reasoning_counts_in_output=False,
                 source="builtin")


# ── 方言模板 ────────────────────────────────────────────────────────────────
# 说明:字段名以各家公开接口/本仓既有实现为准;中转兼容层可能改写,故这些模板
# 只是「默认猜测」,用户可在 reasoning_model_overrides 里覆盖。

_DIALECT_TEMPLATES: dict[str, dict[str, Any]] = {
    # OpenAI 官方 / 多数 OpenAI 兼容中转。o 系/gpt-5 系默认常驻推理,不提供真正的 off;
    # 这里不显示 off,避免「关不掉却显示已关闭」。
    "openai_effort": _base(
        "openai_effort",
        can_disable=False,
        levels=("auto", "low", "medium", "high"),
        effort_values={"low": "minimal", "medium": "medium", "high": "high"},
        reasoning_counts_in_output=True,
    ),
    # DeepSeek 直供:思考默认开;reasoning_effort 调档,thinking.type 关闭。
    "deepseek": _base(
        "deepseek",
        can_disable=True,
        levels=LEVELS,
        effort_values={"low": "low", "medium": "medium", "high": "high",
                       "extra": "xhigh", "max": "max"},
        reasoning_counts_in_output=True,
    ),
    # Anthropic 原生:budget_tokens,off = 不传 thinking(见 build_anthropic_thinking)。
    "anthropic_budget": _base(
        "anthropic_budget",
        can_disable=True,
        levels=LEVELS,
        budget_tokens=DEFAULT_BUDGET_TOKENS,
        min_budget=1024,
        max_budget=24576,
        output_reserve_tokens=1024,
        reasoning_counts_in_output=True,
    ),
    # Gemini 原生:thinking_budget。Flash 可 0;Pro 不能完全关闭(由模型名规则覆盖)。
    "gemini_budget": _base(
        "gemini_budget",
        can_disable=True,
        levels=LEVELS,
        budget_tokens=DEFAULT_BUDGET_TOKENS,
        min_budget=0,
        max_budget=24576,
        output_reserve_tokens=1024,
        reasoning_counts_in_output=True,
    ),
    # OpenRouter:统一 reasoning 对象;对跨厂商模型最通用。
    "openrouter_reasoning": _base(
        "openrouter_reasoning",
        can_disable=True,
        # OpenRouter 的 effort 只有 low/medium/high;不要再显示 Extra/Max 两个
        # 实际映射到 high 的档位(看起来可选、实际没区别)。
        levels=("auto", "off", "low", "medium", "high"),
        effort_values={"low": "low", "medium": "medium", "high": "high"},
        reasoning_counts_in_output=True,
    ),
    # 通义千问 / DashScope:enable_thinking + thinking_budget。
    "qwen_enable_thinking": _base(
        "qwen_enable_thinking",
        can_disable=True,
        levels=("auto", "off", "low", "medium", "high", "extra", "max"),
        budget_tokens=DEFAULT_BUDGET_TOKENS,
        reasoning_counts_in_output=True,
    ),
    # 智谱 GLM:通常只有 thinking.type 开/关,没有官方语义档位。
    "glm_thinking": _base(
        "glm_thinking",
        can_disable=True,
        levels=("auto", "off", "high"),
        budget_tokens={},
        reasoning_counts_in_output=False,
    ),
    # Moonshot Kimi:常见 thinking.type / enable_thinking,只有开/关。
    "kimi_thinking": _base(
        "kimi_thinking",
        can_disable=True,
        levels=("auto", "off", "high"),
        budget_tokens={},
        reasoning_counts_in_output=False,
    ),
    # xAI Grok:reasoning_effort low/high;Grok 4 系常驻推理,不提供 off。
    "grok_effort": _base(
        "grok_effort",
        can_disable=False,
        levels=("auto", "low", "high"),
        effort_values={"low": "low", "medium": "high", "high": "high",
                       "extra": "high", "max": "high"},
        reasoning_counts_in_output=True,
    ),
    # 火山方舟:thinking.type 开/关;不强行发档位。
    "doubao_thinking": _base(
        "doubao_thinking",
        can_disable=True,
        levels=("auto", "off", "high"),
        budget_tokens={},
        reasoning_counts_in_output=False,
    ),
    # 小米 MiMo:原生 OpenAI 兼容端点只认 thinking.type 开关,不认 reasoning_effort;
    # 官方 low/medium/high 目前也没有实质差异(部分接口接受但不改变行为)。
    "mimo_thinking": _base(
        "mimo_thinking",
        can_disable=True,
        levels=("auto", "off", "high"),
        budget_tokens={},
        # MiMo 只暴露开关、没有预算字段;reasoning_content 是否计入 max_tokens 未实测,
        # 先保持不抬高输出上限(避免无依据地放大成本)。
        reasoning_counts_in_output=False,
    ),
    # 本地 vLLM / Qwen 模板:chat_template_kwargs.enable_thinking。
    "vllm_chat_template": _base(
        "vllm_chat_template",
        can_disable=True,
        levels=("auto", "off", "high"),
        budget_tokens={},
        reasoning_counts_in_output=False,
    ),
    # 用户自定义:由 spec 里的 params_by_level / off_params 决定,见 build_openai_params。
    "custom_json": _base(
        "custom_json",
        can_disable=True,
        levels=LEVELS,
        budget_tokens=DEFAULT_BUDGET_TOKENS,
        reasoning_counts_in_output=False,
        confidence="assumed",
    ),
    "none": _none_spec(),
}


def _dialect_template(dialect: str) -> dict[str, Any]:
    tpl = _DIALECT_TEMPLATES.get(dialect) or _DIALECT_TEMPLATES["none"]
    # 深拷贝,避免调用方改到模板。
    out = {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v)
           for k, v in tpl.items()}
    return out


def _name_supports_reasoning(api_id: str, model_name: str) -> bool:
    """按模型名判断是否可能支持思考(用于自定义中转站,不依赖 catalog capabilities)。"""
    n = (model_name or "").lower()
    if not n:
        return False
    if "claude" in n:
        # extended thinking 从 3.7 开始;3.5/3.0 及更早不支持。
        # 不能用裸 "5" 判断 —— "claude-3-5-sonnet" 里的 5 会把老模型误判成支持。
        if any(k in n for k in ("claude-2", "claude-3-0", "claude-3-5")):
            return False
        # Haiku 系(4.x)不走 extended thinking;除非名字明确写了 thinking。
        if "haiku" in n and "thinking" not in n:
            return False
        return any(k in n for k in (
            "claude-3-7", "claude-4", "claude-opus-4", "claude-sonnet-4",
            "claude-opus-5", "claude-sonnet-5", "claude-fable",
        ))
    if "gpt-5" in n or "gpt-6" in n:
        # gpt-5.5-instant 这类非推理变体不能因为前缀 gpt-5 被放行。
        return "instant" not in n
    if n.startswith(("o1", "o3", "o4", "o5")):
        return True
    if "deepseek" in n:
        # DeepSeek 直供的现役思考型号:deepseek-flash / deepseek-v4-* / r1 / reasoner。
        # 不能写成 startswith("deepseek") —— deepseek-chat(非思考)会被误判成支持。
        if api_id == "deepseek":
            return any(k in n for k in (
                "deepseek-flash", "deepseek-v4", "deepseek-v3.2", "deepseek-v3.1",
                "deepseek-r1", "deepseek-reasoner", "deepseek-thinking",
            ))
        return any(k in n for k in (
            "r1", "reasoner", "v3.1", "v3.2", "v4", "v4.1", "thinking", "deepseek-flash",
        ))
    if "gemini" in n:
        if "lite" in n:
            return False
        return any(k in n for k in ("2.5", "3.", "3-", "thinking"))
    if "glm" in n:
        return any(k in n for k in ("4.5", "4.6", "4.7", "5"))
    if "kimi" in n or "moonshot" in n:
        # kimi-k2 基础版不一定带思考;k2-thinking / k1.5 / k2.5 才是推理型号。
        return any(k in n for k in ("thinking", "k1.5", "k2.5"))
    if "qwen" in n:
        if "thinking" in n:
            return True
        if "embedding" in n:
            return False
        # Qwen3 系(含开源 72B / coder)普遍支持 enable_thinking;Flash/Turbo 多数没有。
        return "3" in n and not any(k in n for k in ("flash", "turbo"))
    if "grok" in n:
        return "non-reasoning" not in n and any(k in n for k in ("3", "4"))
    if "doubao" in n:
        return any(k in n for k in ("seed-1.6", "thinking"))
    if "hunyuan" in n:
        return any(k in n for k in ("t1", "thinking"))
    if "minimax" in n:
        return "m2" in n or "thinking" in n
    if "mimo" in n:
        # MiMo 现役型号(7B-RL / v2.5 / v2.6)默认开思考;基础 7B 等不带 RL 的不放行。
        return "non-reasoning" not in n and any(k in n for k in ("rl", "v2", "thinking"))
    if "magistral" in n:
        return True
    return False


def _name_matches_provider_family(api_id: str, model_name: str) -> bool:
    """模型名是否属于该 provider 自家命名。

    用于判断「用户把 openai 这个 provider 的 base_url 改成中转站、同步来别家模型」
    的情况:名字明显不是自家模型时,capabilities 的 text/streaming 兜底不能用来否决
    思考能力,应退回名字推断。
    """
    n = (model_name or "").lower()
    if api_id == "openai":
        return n.startswith(("gpt-", "gpt5", "gpt6", "o1", "o3", "o4", "o5"))
    if api_id == "anthropic":
        return "claude" in n
    if api_id == "xai":
        return "grok" in n
    if api_id == "dashscope":
        return "qwen" in n
    if api_id == "deepseek":
        return "deepseek" in n
    if api_id == "doubao":
        return "doubao" in n
    if api_id == "xiaomi_mimo":
        return "mimo" in n
    if api_id == "vertex_ai":
        return "gemini" in n
    # 聚合站(openrouter/siliconflow/ark_agent_plan)本来就可能出现任意厂商模型。
    return True


def _infer_dialect(api_id: str, model_name: str, *, is_custom: bool) -> str:
    """返回方言名。自定义中转站优先按模型名猜,已知 provider 优先按 provider 定。"""
    n = (model_name or "").lower()
    if not is_custom:
        # 已知 provider 被用户改成中转站、跑别家模型:按模型名选方言,而不是按
        # 这个 provider 原本的家族方言(例如 dashscope 里跑 deepseek)。
        if not _name_matches_provider_family(api_id, model_name):
            return _infer_dialect(api_id, model_name, is_custom=True)
        if api_id == "anthropic":
            return "anthropic_budget"
        if api_id == "vertex_ai":
            return "gemini_budget"
        if api_id == "openai":
            return "openai_effort"
        if api_id == "deepseek":
            return "deepseek"
        if api_id == "openrouter":
            return "openrouter_reasoning"
        if api_id == "xai":
            return "grok_effort"
        if api_id == "dashscope":
            return "qwen_enable_thinking"
        if api_id == "doubao":
            return "doubao_thinking"
        if api_id == "xiaomi_mimo":
            return "mimo_thinking"
        if api_id == "ark_agent_plan":
            # Agent Plan 订阅套餐里是第三方模型(常见 deepseek-v4-pro),不能按豆包方言发。
            return _infer_dialect(api_id, model_name, is_custom=True)
        if api_id == "siliconflow":
            # 聚合站:按模型名选更接近的上游方言,但字段仍走 OpenAI 兼容层。
            # DeepSeek 走通用 reasoning_effort(中转不保证支持 thinking.type)。
            if "deepseek" in n:
                return "openai_effort"
            if "qwen" in n:
                return "qwen_enable_thinking"
            if "glm" in n:
                return "glm_thinking"
            if "kimi" in n:
                return "kimi_thinking"
            return "openai_effort"
        return "openai_effort"

    # 自建中转站:模型名是最强信号。
    if "glm" in n:
        return "glm_thinking"
    if "kimi" in n or "moonshot" in n:
        return "kimi_thinking"
    if "qwen" in n:
        return "qwen_enable_thinking"
    if "doubao" in n:
        return "doubao_thinking"
    if "mimo" in n:
        return "mimo_thinking"
    if "grok" in n:
        return "grok_effort"
    if "deepseek" in n:
        # 中转站通常透传 OpenAI 格式;deepseek 专属 thinking 字段未必支持。
        return "openai_effort"
    # Claude / GPT / Gemini 经 OpenAI 兼容中转时,最常见的是 reasoning_effort。
    if any(k in n for k in ("claude", "gpt-", "gpt5", "gemini", "o1", "o3", "o4")):
        return "openai_effort"
    # 名字能识别为推理模型、但没有专属方言(如 magistral / hunyuan-t1):用最通用的
    # OpenAI reasoning_effort;被中转站拒绝时 backend 会退参并记录。
    if _name_supports_reasoning(api_id, model_name):
        return "openai_effort"
    return "none"


def _apply_model_name_rules(spec: dict[str, Any], api_id: str, model_name: str) -> dict[str, Any]:
    """模型级微调(不是 provider 级):Gemini Pro 不能完全关、Grok 4 常驻推理等。"""
    n = (model_name or "").lower()
    if spec.get("dialect") == "gemini_budget":
        if "pro" in n and "flash" not in n:
            spec["can_disable"] = False
            spec["min_budget"] = 128
            spec["levels"] = [lv for lv in spec.get("levels") or [] if lv != "off"]
    if spec.get("dialect") == "grok_effort" and "non-reasoning" in n:
        spec.update(_none_spec())
    if spec.get("dialect") == "openai_effort":
        # o 系通常不提供真正的 off;当前模板已不列 off,这里保持。
        # o1/o3/o4 不认 "minimal"(那是 gpt-5 的档),low 要原样发 low。
        if n.startswith(("o1", "o3", "o4", "o5")):
            spec.setdefault("effort_values", {})["low"] = "low"
    return spec


def _merge_override(spec: dict[str, Any], override: dict[str, Any],
                    *, sanitize_levels: bool = False) -> dict[str, Any]:
    """把用户覆盖合并进 spec。只接受白名单键,避免把任意 JSON 灌进请求。

    sanitize_levels=True 时(用户覆盖路径),把 levels 收敛到该方言模板支持的档位:
    直接写 preferences 的调用方(设置页「思考发送方式」下拉)只换 dialect、保留旧
    方言的 levels/can_disable,不收敛会让 UI 显示并允许选择新方言根本不支持的档位。
    目录显式声明(metadata.reasoning)保持原样,允许管理员自定义映射。
    """
    if not isinstance(override, dict):
        return spec
    allowed = {
        "enabled", "supported", "dialect", "can_disable", "levels", "default_level",
        "effort_values", "budget_tokens", "min_budget", "max_budget",
        "output_reserve_tokens", "reasoning_counts_in_output", "off_effort",
        "send_budget", "params_by_level", "off_params", "extra_body",
    }
    out = dict(spec)
    # 覆盖里只写 dialect 时,从该方言模板补齐 levels / can_disable / 字段映射,
    # 否则会留下「dialect=deepseek 但 levels 只有 auto」的半截 spec。
    new_dialect = override.get("dialect")
    if new_dialect in _DIALECT_TEMPLATES and new_dialect != spec.get("dialect"):
        out = _dialect_template(new_dialect)
        out["supported"] = True
    for k, v in override.items():
        if k in allowed:
            out[k] = v
    # UI 用 "auto" 表示「删除覆盖」;如果历史偏好里残留了这个值,视为不覆盖,
    # 不能把它当成未知方言把模型降级成不支持。
    if out.get("dialect") in ("auto", ""):
        out["dialect"] = spec.get("dialect") or "none"
    if out.get("dialect") not in _DIALECT_TEMPLATES:
        # 覆盖里写了未知方言 → 回退 none,避免后端按未知字符串乱发。
        out["dialect"] = "none"
        out["supported"] = False
    if not isinstance(out.get("levels"), (list, tuple)):
        out["levels"] = list(spec.get("levels") or ["auto"])
    if sanitize_levels and out.get("dialect") != "custom_json":
        tpl = _DIALECT_TEMPLATES.get(out.get("dialect"))
        if tpl is not None:
            allowed_levels = set(tpl.get("levels") or ["auto"])
            levels = [lv for lv in out["levels"] if lv in allowed_levels]
            if "auto" not in levels:
                levels.insert(0, "auto")
            if not tpl.get("can_disable", True):
                out["can_disable"] = False
            if not out.get("can_disable"):
                levels = [lv for lv in levels if lv != "off"]
            out["levels"] = levels
    out["source"] = "user"
    out["confidence"] = "verified" if override.get("verified") else "assumed"
    return out


def _read_user_prefs(user_id: int | None) -> dict[str, Any]:
    """读用户偏好。优先 request cache,失败回落 DB(与旧 _effort 行为一致)。"""
    if not user_id:
        return {}
    try:
        from core.request_cache import get_user_prefs_cached
        prefs = get_user_prefs_cached(int(user_id))
        if prefs is not None:
            return dict(prefs or {})
    except Exception:
        pass
    try:
        from platform_app.db import connect as _conn
        with _conn() as db:
            r = db.execute(
                "select preferences from user_preferences where user_id = %s",
                (int(user_id),),
            ).fetchone()
        return dict((r or {}).get("preferences") or {})
    except Exception:
        return {}


def load_reasoning_overrides(user_id: int | None) -> dict[str, Any]:
    """一次性读取用户级模型覆盖(供 /api/models 批量注入,避免每个模型查一次库)。"""
    if not user_id:
        return {}
    prefs = _read_user_prefs(user_id)
    raw = prefs.get("reasoning_model_overrides") or {}
    return dict(raw) if isinstance(raw, dict) else {}


def load_model_tag_overrides(user_id: int | None) -> dict[str, Any]:
    """一次性读取用户级能力标签覆盖（capabilities / ui_tags）。"""
    if not user_id:
        return {}
    prefs = _read_user_prefs(user_id)
    raw = prefs.get("model_tag_overrides") or {}
    return dict(raw) if isinstance(raw, dict) else {}


def apply_tag_overrides(
    model_dict: dict[str, Any] | None,
    api_id: str,
    model_name: str,
    overrides: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """把用户标签覆盖合并到 model dict 的副本上。

    只改 capabilities / ui_tags，不修改调用方传入对象；没有覆盖时原样返回。
    """
    if not isinstance(overrides, dict) or not overrides:
        return model_dict
    api = _normalize_api_id(api_id) or str(api_id or "")
    name = str(model_name or "")
    ov = overrides.get(f"{api}:{name}") or overrides.get(name)
    if not isinstance(ov, dict):
        return model_dict
    caps = ov.get("capabilities")
    ui_tags = ov.get("ui_tags")
    if not isinstance(caps, list) and not isinstance(ui_tags, list):
        return model_dict
    out = dict(model_dict or {})
    if isinstance(caps, list):
        out["capabilities"] = [str(c) for c in caps]
    if isinstance(ui_tags, list):
        out["ui_tags"] = [str(t) for t in ui_tags]
    return out


def spec_for_model(
    api_id: str,
    model_name: str,
    *,
    model_dict: dict[str, Any] | None = None,
    api_dict: dict[str, Any] | None = None,
    user_id: int | None = None,
    override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """返回一个模型的 reasoning spec(不读用户偏好,只做能力/方言推断)。

    优先级:模型自带的 `reasoning` 描述 > 用户覆盖 > 内置 provider/名字规则。
    `user_id` 用于读 `reasoning_model_overrides`;传 None 时跳过用户覆盖。
    """
    api = _normalize_api_id(api_id) or str(api_id or "")
    name = str(model_name or "")
    is_custom = bool((api_dict or {}).get("_custom")) or (api not in _KNOWN_APIS)

    # 1) 模型目录显式声明(管理员/高级用户写入 metadata.reasoning)
    catalog_spec = None
    # 目录/用户是否显式给出 default_level。legacy_default_level(四家老 provider
    # 未配置时 high)只应作为「没配置」的兜底,不能盖掉显式配置。
    explicit_default_level = False
    if isinstance(model_dict, dict) and isinstance(model_dict.get("reasoning"), dict):
        _raw_catalog_spec = model_dict["reasoning"]
        if _raw_catalog_spec.get("enabled") is not False:
            catalog_spec = _merge_override(_dialect_template("none"), _raw_catalog_spec)
            catalog_spec["source"] = "catalog"
            # 目录显式声明视为已验证;只有用户覆盖才可能是 assumed。
            catalog_spec["confidence"] = str(
                _raw_catalog_spec.get("confidence") or "verified")
            explicit_default_level = "default_level" in _raw_catalog_spec

    # 2) 用户覆盖(per api:model)
    user_override = override
    if user_override is None and user_id:
        try:
            prefs = _read_user_prefs(user_id)
            overrides = prefs.get("reasoning_model_overrides") or {}
            if isinstance(overrides, dict):
                user_override = overrides.get(f"{api}:{name}") or overrides.get(name)
        except Exception:
            user_override = None
    if isinstance(user_override, dict) and user_override.get("enabled") is False:
        # 用户显式停用自定义配置 → 回退自动推断。
        user_override = None
    elif isinstance(user_override, dict) and "default_level" in user_override:
        explicit_default_level = True

    # 3) 内置推断
    if catalog_spec is not None:
        spec = catalog_spec
    else:
        dialect = _infer_dialect(api, name, is_custom=is_custom)
        spec = _dialect_template(dialect)

        caps: list[str] = []
        if isinstance(model_dict, dict):
            raw = model_dict.get("capabilities")
            if isinstance(raw, list):
                caps = [str(c) for c in raw]
            elif isinstance(raw, dict):
                caps = [str(k) for k in raw.keys()]
        # 已知 provider:capabilities 通常是权威。
        # 例外:Vertex / OpenRouter / SiliconFlow 的目录能力可能滞后或未标 reasoning
        # (例如 gemini-2.5-flash 实际支持 thinking,budget 路径也能用),允许名字兜底。
        # 其余 provider 若 caps 明确没有 reasoning,不能只凭名字放行 —— 否则
        # gpt-5.5-instant 这类非推理变体会被错误显示思考档位。
        if not is_custom and caps:
            caps_ok = "reasoning" in caps
            name_ok = _name_supports_reasoning(api, name)
            # 用户把已知 provider 的 base_url 改成中转站时,同步来的别家模型 caps 往往
            # 只是 text/streaming 兜底 —— 名字不属于该 provider 自家家族时允许名字兜底。
            _synced_foreign = bool(
                isinstance(model_dict, dict) and model_dict.get("synced")
                and not _name_matches_provider_family(api, name)
            )
            name_fallback = api in (
                "vertex_ai", "openrouter", "siliconflow", "doubao",
                # 这几家的 caps 表只覆盖部分型号,新型号靠名字识别
                # (claude-sonnet-4-5 / t1 / m2 / ...)。
                "openai", "anthropic", "hunyuan", "minimax", "xiaomi_mimo",
            ) or _synced_foreign
            if caps_ok or (name_fallback and name_ok):
                if spec.get("dialect") == "none":
                    spec = _dialect_template("openai_effort")
            else:
                spec = _none_spec()
        elif is_custom:
            # 自建中转站的 capabilities 往往是 text/streaming 的兜底值,不能拿来否决;
            # 但如果用户/同步源显式标了 reasoning,就按通用 OpenAI 方言启用。
            name_ok = _name_supports_reasoning(api, name)
            if not name_ok and "reasoning" in caps:
                spec = _dialect_template("openai_effort")
                spec["source"] = "heuristic"
                spec["confidence"] = "assumed"
            elif not name_ok:
                spec = _none_spec()
        else:
            if not _name_supports_reasoning(api, name):
                spec = _none_spec()

        spec = _apply_model_name_rules(spec, api, name)
        # 已知但非实测的模型标 assumed;四家老 provider 仍视为 verified。
        if spec.get("supported"):
            spec["confidence"] = "verified" if api in _LEGACY_DEFAULT_APIS else "assumed"
            spec["source"] = "builtin" if api in _LEGACY_DEFAULT_APIS else "heuristic"

    # 4) 用户覆盖最后合并(允许用户纠正自动推断)
    if user_override:
        spec = _merge_override(spec, user_override, sanitize_levels=True)

    # 5) 老 provider 未配置时默认 high,保持既有行为;新模型默认 auto。
    #    但目录/用户显式配置了 default_level 时必须以显式值为准 —— public_spec()
    #    和 resolve_level() 都优先读 legacy_default_level,否则「编辑模型 → 默认档位」
    #    保存后既不显示也不生效(用户反馈:mimo 自定义默认档位后设置页仍显示 Auto)。
    if explicit_default_level:
        spec["legacy_default_level"] = spec.get("default_level") or "auto"
    elif api in _LEGACY_DEFAULT_APIS and spec.get("supported"):
        spec["legacy_default_level"] = "high"
    else:
        spec.setdefault("legacy_default_level", "auto")

    spec["supported"] = bool(spec.get("supported"))
    spec.setdefault("default_level", "auto")
    # 保证 levels 至少包含 auto;去重保序。
    levels = [lv for lv in (spec.get("levels") or ["auto"]) if lv in VALID_LEVELS]
    if "auto" not in levels:
        levels.insert(0, "auto")
    spec["levels"] = list(dict.fromkeys(levels))
    return spec


_EFFORT_DIALECTS = frozenset({
    "openai_effort", "deepseek", "openrouter_reasoning", "grok_effort",
})
_BUDGET_DIALECTS = frozenset({"anthropic_budget", "gemini_budget"})
_CUSTOM_FORBIDDEN_REQUEST_KEYS = frozenset({
    "model", "messages", "input", "stream", "max_tokens", "max_completion_tokens",
    "n", "tools", "tool_choice", "functions", "function_call", "response_format",
})


def _normalize_custom_params(raw: Any) -> tuple[dict[str, Any] | None, list[str]]:
    """把用户填的每档参数规范成 extra_body 对象。

    允许两种写法：
      {"reasoning_effort": "high"}
      {"extra_body": {"thinking": {"type": "enabled"}}}
    第二种会被拆开；不允许覆盖请求主干字段。
    """
    if not isinstance(raw, dict):
        return None, ["每档参数必须是 JSON 对象"]
    body = dict(raw)
    nested = body.pop("extra_body", None)
    if nested is not None:
        if not isinstance(nested, dict):
            return None, ["extra_body 必须是 JSON 对象"]
        body.update(nested)
    bad = sorted(set(body.keys()) & _CUSTOM_FORBIDDEN_REQUEST_KEYS)
    if bad:
        return None, [f"不允许自定义请求主干字段: {', '.join(bad)}"]
    return body, []


def validate_custom_reasoning_spec(raw: dict[str, Any] | None) -> tuple[dict[str, Any] | None, list[str]]:
    """校验并规范化用户保存的 reasoning spec。

    返回 (spec, errors)。errors 非空时调用方应拒绝保存；spec 为 None 表示
    “删除覆盖 / 回退自动”（raw=None 或 enabled=false）。
    """
    if raw is None:
        return None, []
    if not isinstance(raw, dict):
        return None, ["reasoning 必须是 JSON 对象"]

    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        return None, ["enabled 必须是布尔值"]
    if enabled is False:
        return {"enabled": False}, []

    errors: list[str] = []
    dialect = raw.get("dialect")
    if not isinstance(dialect, str) or dialect not in _DIALECT_TEMPLATES or dialect == "none":
        return None, ["dialect 不是已知的思考方言"]
    template = _dialect_template(dialect)

    supported = raw.get("supported", True)
    if not isinstance(supported, bool):
        errors.append("supported 必须是布尔值")
        supported = True
    can_disable = raw.get("can_disable", template.get("can_disable", True))
    if not isinstance(can_disable, bool):
        errors.append("can_disable 必须是布尔值")
        can_disable = bool(template.get("can_disable", True))

    raw_levels = raw.get("levels", template.get("levels") or ["auto"])
    if not isinstance(raw_levels, (list, tuple)):
        errors.append("levels 必须是数组")
        raw_levels = template.get("levels") or ["auto"]
    levels = [str(lv).lower() for lv in raw_levels if str(lv).lower() in VALID_LEVELS]
    levels = list(dict.fromkeys(levels))
    if "auto" not in levels:
        levels.insert(0, "auto")
    template_levels = set(template.get("levels") or ["auto"])
    if dialect != "custom_json":
        bad_levels = [lv for lv in levels if lv not in template_levels]
        if bad_levels:
            errors.append(f"{dialect} 不支持档位: {', '.join(bad_levels)}")
            levels = [lv for lv in levels if lv in template_levels]
            if "auto" not in levels:
                levels.insert(0, "auto")
    if not can_disable:
        levels = [lv for lv in levels if lv != "off"]
    if not supported:
        levels = [lv for lv in levels if lv in ("auto", "off")]
    if supported and not any(lv not in ("auto", "off") for lv in levels):
        errors.append("支持思考时至少需要选择一个非 auto 档位")

    default_level = str(raw.get("default_level") or "auto").lower()
    if default_level not in levels:
        default_level = "auto"

    normalized: dict[str, Any] = dict(raw)
    normalized["supported"] = supported
    normalized["can_disable"] = can_disable
    normalized["levels"] = levels
    normalized["default_level"] = default_level
    normalized["enabled"] = True

    if dialect == "custom_json":
        raw_map = raw.get("params_by_level")
        if not isinstance(raw_map, dict):
            errors.append("custom_json 必须提供 params_by_level 对象")
            raw_map = {}
        params: dict[str, Any] = {}
        for lv in levels:
            if lv == "auto":
                continue
            value = raw_map.get(lv)
            if lv == "off":
                value = raw.get("off_params") or value
            if value is None:
                if supported:
                    errors.append(f"档位 {lv} 缺少参数映射")
                continue
            body, errs = _normalize_custom_params(value)
            errors.extend(errs)
            if body is not None:
                params[lv] = body
        normalized["params_by_level"] = params
        normalized["off_params"] = params.get("off")
        normalized.pop("extra_body", None)
    else:
        effort_values = raw.get("effort_values", template.get("effort_values") or {})
        if not isinstance(effort_values, dict):
            errors.append("effort_values 必须是对象")
            effort_values = {}
        normalized["effort_values"] = {
            str(k): str(v) for k, v in effort_values.items()
            if str(k) in VALID_LEVELS and isinstance(v, str)
        }
        budget_tokens = raw.get("budget_tokens", template.get("budget_tokens") or {})
        if not isinstance(budget_tokens, dict):
            errors.append("budget_tokens 必须是对象")
            budget_tokens = {}
        clean_budget: dict[str, int] = {}
        for k, v in budget_tokens.items():
            if str(k) not in VALID_LEVELS:
                continue
            try:
                iv = int(v)
            except (TypeError, ValueError):
                errors.append(f"budget_tokens.{k} 必须是整数")
                continue
            if iv < 0:
                errors.append(f"budget_tokens.{k} 不能为负数")
                continue
            clean_budget[str(k)] = iv
        normalized["budget_tokens"] = clean_budget
        if supported and dialect in _EFFORT_DIALECTS:
            for lv in levels:
                if lv not in ("auto", "off") and not normalized["effort_values"].get(lv):
                    errors.append(f"{dialect} 档位 {lv} 缺少 effort_values")
        if supported and dialect in _BUDGET_DIALECTS:
            for lv in levels:
                if lv not in ("auto", "off") and normalized["budget_tokens"].get(lv) is None:
                    errors.append(f"{dialect} 档位 {lv} 缺少 budget_tokens")
        if normalized["budget_tokens"]:
            try:
                normalized["min_budget"] = max(
                    0, int(raw.get("min_budget", template.get("min_budget") or 0) or 0))
            except (TypeError, ValueError):
                errors.append("min_budget 必须是整数")
                normalized["min_budget"] = 0
            max_budget = raw.get("max_budget", template.get("max_budget"))
            if isinstance(max_budget, (int, float)):
                normalized["max_budget"] = int(max_budget)
            elif max_budget is None:
                normalized["max_budget"] = None
    try:
        normalized["output_reserve_tokens"] = max(
            0, int(raw.get("output_reserve_tokens", template.get("output_reserve_tokens", 1024)) or 0))
    except (TypeError, ValueError):
        errors.append("output_reserve_tokens 必须是整数")
    normalized["reasoning_counts_in_output"] = bool(
        raw.get("reasoning_counts_in_output", template.get("reasoning_counts_in_output", False)))

    spec = _merge_override(_dialect_template(dialect), normalized)
    spec["source"] = "user"
    spec["confidence"] = "assumed"
    return (spec if not errors else None), errors


def _normalize_level(level: str | None, spec: dict[str, Any]) -> str:
    lv = str(level or "").strip().lower()
    if lv in ("", "none", "default"):
        lv = "auto"
    if lv == "0":
        lv = "off"
    levels = spec.get("levels") or ["auto"]
    if lv in levels:
        return lv
    # 不支持的档位就近收敛,不要因为旧偏好值把请求打崩。
    # 只有开/关两档的模型(GLM/Kimi/豆包)把低/中/极高/满都收敛到 high。
    if lv in ("low", "medium", "extra", "max") and "high" in levels:
        return "high"
    if lv == "off" and not spec.get("can_disable"):
        return "auto"
    if lv not in VALID_LEVELS:
        return "auto"
    if lv not in levels:
        return "auto"
    return lv


def resolve_level(
    user_id: int | None,
    api_id: str,
    model_name: str,
    spec: dict[str, Any],
    *,
    override: dict[str, Any] | None = None,
    prefs: dict[str, Any] | None = None,
) -> str:
    """解析本次调用实际使用的档位。

    override: 存档级覆盖 {"api_id","model_id","level"};只在 api/model 匹配时生效。
    prefs: 可选的已读取偏好快照,避免同一次调用里重复查库。
    读取顺序:存档覆盖 > user_preferences.model_effort > spec.legacy/default。
    """
    api = _normalize_api_id(api_id) or str(api_id or "")
    name = str(model_name or "")
    if isinstance(override, dict) and override.get("level"):
        _ov_api = _normalize_api_id(override.get("api_id") or "") or str(override.get("api_id") or "")
        if (_ov_api == api and str(override.get("model_id") or "") == name):
            return _normalize_level(str(override.get("level")), spec)
    if prefs is None:
        prefs = _read_user_prefs(user_id)
    model_effort = prefs.get("model_effort") or {}
    if isinstance(model_effort, dict):
        raw = model_effort.get(f"{api}:{name}")
        if raw is None:
            raw = model_effort.get(f"{api_id}:{name}")
        if raw not in (None, ""):
            return _normalize_level(str(raw), spec)
    return _normalize_level(
        str(spec.get("legacy_default_level") or spec.get("default_level") or "auto"), spec)


def resolve_spec_for_call(
    user_id: int | None,
    api_id: str,
    model_name: str,
    *,
    model_dict: dict[str, Any] | None = None,
    api_dict: dict[str, Any] | None = None,
    override: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    """后端单点入口:返回 (spec, level)。

    一次调用只读一次用户偏好,并让 spec(方言覆盖)与 level(model_effort)来自
    同一份快照 —— 否则两次读库之间用户改设置会造成方言/档位错配。
    """
    prefs = _read_user_prefs(user_id)
    api = _normalize_api_id(api_id) or str(api_id or "")
    model_overrides = prefs.get("reasoning_model_overrides") or {}
    spec_override = {}
    if isinstance(model_overrides, dict):
        spec_override = (
            model_overrides.get(f"{api}:{model_name}")
            or model_overrides.get(model_name)
            or {}
        )
    # 用户编辑的能力标签也要参与 backend 的自动能力判断，保证与 /api/models 一致。
    model_for_spec = apply_tag_overrides(
        model_dict, api_id, model_name,
        prefs.get("model_tag_overrides") if isinstance(prefs, dict) else None,
    )
    spec = spec_for_model(
        api_id, model_name, model_dict=model_for_spec, api_dict=api_dict,
        user_id=None,
        # 传 {} 而不是 None:spec_for_model 内部就不会再查一次偏好。
        override=spec_override,
    )
    level = resolve_level(
        user_id, api_id, model_name, spec, override=override, prefs=prefs)
    return spec, level


def budget_for_level(spec: dict[str, Any], level: str) -> int | None:
    if not spec.get("supported") or level in ("auto", "off", ""):
        return None
    budgets = spec.get("budget_tokens") or {}
    raw = budgets.get(level)
    if raw is None:
        raw = (DEFAULT_BUDGET_TOKENS.get(level)
               if spec.get("dialect") in ("anthropic_budget", "gemini_budget") else None)
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    lo = int(spec.get("min_budget") or 0)
    hi = spec.get("max_budget")
    if lo:
        value = max(lo, value)
    if isinstance(hi, int) and hi > 0:
        value = min(hi, value)
    return value


def effective_max_tokens(spec: dict[str, Any], level: str, max_tokens: int) -> int:
    """思考开启时的输出上限兜底:避免 reasoning 吃光 max_tokens 后正文为空。

    只对 `reasoning_counts_in_output=True` 的方言抬高上限;其余方言保持原值
    (某些 provider 的 reasoning token 不占 completion 预算,盲目抬高只会增加成本)。
    """
    try:
        current = int(max_tokens or 0)
    except (TypeError, ValueError):
        current = 0
    if not current:
        return max_tokens
    if not spec.get("supported") or level in ("auto", "off", ""):
        return current
    if not spec.get("reasoning_counts_in_output"):
        return current
    budget = budget_for_level(spec, level)
    if not budget:
        return current
    # 0 是合法值(用户显式关闭额外预留),不能像缺省值那样回退到 1024。
    raw_reserve = spec.get("output_reserve_tokens")
    try:
        reserve = int(raw_reserve) if raw_reserve is not None else 1024
    except (TypeError, ValueError):
        reserve = 1024
    reserve = max(0, reserve)
    return max(current, budget + reserve)


# ── OpenAI 兼容层 wire 构造 ─────────────────────────────────────────────────

def _extra_param(spec: dict[str, Any], level: str) -> dict[str, Any]:
    dialect = spec.get("dialect")
    if dialect == "openai_effort":
        if level == "off":
            # 模板不提供 off;万一旧偏好/覆盖传了 off,用 minimal 而非乱发。
            val = spec.get("off_effort") or "minimal"
            return {"reasoning_effort": val}
        val = (spec.get("effort_values") or {}).get(level)
        return {"reasoning_effort": val} if val else {}
    if dialect == "grok_effort":
        if level == "off":
            return {}
        val = (spec.get("effort_values") or {}).get(level)
        return {"reasoning_effort": val} if val else {}
    if dialect == "deepseek":
        if level == "off":
            return {"extra_body": {"thinking": {"type": "disabled"}}}
        val = (spec.get("effort_values") or {}).get(level)
        return {"reasoning_effort": val} if val else {}
    if dialect == "openrouter_reasoning":
        if level == "off":
            return {"extra_body": {"reasoning": {"enabled": False}}}
        val = (spec.get("effort_values") or {}).get(level)
        return {"extra_body": {"reasoning": {"effort": val}}} if val else {}
    if dialect == "qwen_enable_thinking":
        if level == "off":
            return {"extra_body": {"enable_thinking": False}}
        body: dict[str, Any] = {"enable_thinking": True}
        budget = budget_for_level(spec, level)
        if spec.get("send_budget", True) and budget:
            body["thinking_budget"] = int(budget)
        return {"extra_body": body}
    if dialect in ("glm_thinking", "kimi_thinking", "doubao_thinking", "mimo_thinking"):
        if level == "off":
            return {"extra_body": {"thinking": {"type": "disabled"}}}
        body = {"thinking": {"type": "enabled"}}
        # 部分中转/新版模型接受 reasoning_effort;只有 spec 显式给了才发。
        val = (spec.get("effort_values") or {}).get(level)
        if val:
            body["reasoning_effort"] = val
        return {"extra_body": body}
    if dialect == "vllm_chat_template":
        if level == "off":
            return {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}
        return {"extra_body": {"chat_template_kwargs": {"enable_thinking": True}}}
    if dialect == "custom_json":
        params = (spec.get("params_by_level") or {}).get(level)
        if level == "off":
            params = spec.get("off_params") or params
        if not isinstance(params, dict):
            return {}
        # 兼容用户直接写 {"extra_body": {...}}；否则把原始字段统一放进 extra_body，
        # 避免非标准键被展开成 SDK 顶层参数而抛 TypeError（那不是 400，退参救不了）。
        body = dict(params)
        nested = body.pop("extra_body", None)
        if isinstance(nested, dict):
            body.update(nested)
        return {"extra_body": body} if body else {}
    # 原生方言被错误地接到 OpenAI 兼容层(例如自定义中转声明成 anthropic):
    # 退化为 reasoning_effort,避免发 native thinking 结构;未实测,可能 400,
    # 由 backend 的 400 退参自愈兜底。
    val = (spec.get("effort_values") or {}).get(level)
    return {"reasoning_effort": val} if val else {}


def build_openai_params(spec: dict[str, Any], level: str) -> dict[str, Any]:
    """返回可直接展开进 chat.completions.create 的参数字典。"""
    if not spec.get("supported") or level == "auto":
        return {}
    if level == "off" and not spec.get("can_disable"):
        return {}
    return _extra_param(spec, level)


# ── 原生 backend wire 构造 ──────────────────────────────────────────────────

def build_anthropic_thinking(spec: dict[str, Any], level: str) -> dict[str, Any] | None:
    """Anthropic extended thinking;auto/off → None(不传字段 = 关闭)。"""
    # 原生 backend 只接受 Anthropic 方言。用户如果把 provider 改成中转站并选了
    # openai_effort/custom_json,不能把 budget 结构硬塞给 Anthropic SDK。
    if spec.get("dialect") != "anthropic_budget":
        return None
    if not spec.get("supported") or level in ("auto", "off", ""):
        return None
    budget = budget_for_level(spec, level)
    if not budget:
        return None
    return {"type": "enabled", "budget_tokens": int(budget)}


def build_gemini_thinking_budget(spec: dict[str, Any], level: str) -> int | None:
    """Gemini thinking_budget;None = 不传 thinking_config(auto)。"""
    if spec.get("dialect") != "gemini_budget":
        return None
    if not spec.get("supported"):
        return None
    if level == "auto":
        return None
    if level == "off":
        if spec.get("can_disable"):
            return 0
        # Pro 等不能完全关闭的模型:退到最小预算,而不是发 0 撞 400。
        lo = int(spec.get("min_budget") or 0)
        return lo or None
    return budget_for_level(spec, level)


def public_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """给前端下发的精简描述(去掉内部字段)。"""
    return {
        "supported": bool(spec.get("supported")),
        "dialect": spec.get("dialect") or "none",
        "can_disable": bool(spec.get("can_disable")),
        "levels": list(spec.get("levels") or ["auto"]),
        # 对四家老 provider 保持「未配置 = high」的既有行为;新模型 default=auto。
        "default_level": spec.get("legacy_default_level") or spec.get("default_level") or "auto",
        "budget_tokens": dict(spec.get("budget_tokens") or {}),
        "confidence": spec.get("confidence") or "assumed",
        "source": spec.get("source") or "builtin",
        "notes": spec.get("notes") or "",
    }


__all__ = [
    "LEVELS",
    "VALID_LEVELS",
    "DEFAULT_BUDGET_TOKENS",
    "spec_for_model",
    "load_reasoning_overrides",
    "load_model_tag_overrides",
    "apply_tag_overrides",
    "validate_custom_reasoning_spec",
    "resolve_level",
    "resolve_spec_for_call",
    "budget_for_level",
    "effective_max_tokens",
    "build_openai_params",
    "build_anthropic_thinking",
    "build_gemini_thinking_budget",
    "public_spec",
]
