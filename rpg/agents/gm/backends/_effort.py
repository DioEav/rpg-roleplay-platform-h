"""agents.gm.backends._effort — 旧版思考档位入口(兼容层)。

2026-10 起思考控制已收敛到 `rpg/model_reasoning.py`:
  · 三个 GM backend 直接调用 resolve_spec_for_call / build_*_params
  · 前端按模型级 reasoning spec 渲染控件
本模块保留旧函数名,供历史测试/外部脚本 import;新代码请直接用 model_reasoning。

旧语义:
- 偏好写 user_preferences.model_effort["{api_id}:{model_id}"] = effort
- 没配偏好 → 四家老 provider 默认 "high";新模型默认 "auto"
"""
from __future__ import annotations

import logging

from model_reasoning import (
    DEFAULT_BUDGET_TOKENS,
    VALID_LEVELS,
    budget_for_level,
    resolve_level,
    spec_for_model,
)

log = logging.getLogger(__name__)

# effort 枚举 → 预算 token 数(保留导出,兼容旧 import)
EFFORT_TO_BUDGET_TOKENS = dict(DEFAULT_BUDGET_TOKENS)
EFFORT_TO_BUDGET_TOKENS.update({"off": 0})

# OpenAI / GPT-5 系列 reasoning.effort 是 string,不是 token 数(保留旧映射)
EFFORT_TO_OPENAI_REASONING = {
    "off": None,
    "low": "minimal",
    "medium": "medium",
    "high": "high",
    "extra": "high",
    "max": "high",
}

DEFAULT_EFFORT = "high"
VALID_EFFORTS = {"off", "low", "medium", "high", "extra", "max"}


def resolve_effort(user_id: int | None, api_id: str, model_id: str) -> str:
    """兼容旧调用:返回 off/low/.../max。

    auto(服务商默认)对旧调用方没有对应枚举 → 落到 off(显式不发思考字段),
    与「不干预」语义一致。
    """
    try:
        spec = spec_for_model(api_id, model_id, user_id=user_id)
        level = resolve_level(user_id, api_id, model_id, spec)
        if level in VALID_EFFORTS:
            return level
        return "off"
    except Exception as exc:
        log.warning("[effort] resolve failed user_id=%s key=%s:%s: %s",
                    user_id, api_id, model_id, exc)
        return DEFAULT_EFFORT


def resolve_budget_tokens(user_id: int | None, api_id: str, model_id: str) -> int:
    """兼容旧调用:读 effort → token budget(0 = 关闭/不干预)。"""
    try:
        spec = spec_for_model(api_id, model_id, user_id=user_id)
        level = resolve_level(user_id, api_id, model_id, spec)
        return int(budget_for_level(spec, level) or 0)
    except Exception:
        return EFFORT_TO_BUDGET_TOKENS.get(DEFAULT_EFFORT, 8192)


def resolve_openai_reasoning(user_id: int | None, api_id: str, model_id: str) -> str | None:
    """兼容旧调用:读 effort → OpenAI reasoning_effort 字符串。"""
    try:
        spec = spec_for_model(api_id, model_id, user_id=user_id)
        level = resolve_level(user_id, api_id, model_id, spec)
        if level not in VALID_LEVELS:
            return None
        return (spec.get("effort_values") or {}).get(level) or EFFORT_TO_OPENAI_REASONING.get(level)
    except Exception:
        return EFFORT_TO_OPENAI_REASONING.get(DEFAULT_EFFORT)
