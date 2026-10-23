"""model_formats.py — provider API 协议格式的单一真源。

目前支持两种 OpenAI 家族协议：
  · chat_completions — 经典 `/chat/completions`（默认，所有旧 provider 行为不变）
  · responses        — OpenAI Responses API `/responses`（OpenCode Go / OpenAI 新版）

只影响 OpenAI 兼容 provider；Anthropic / Vertex 仍由各自的 kind 决定，忽略本字段。
"""
from __future__ import annotations

API_FORMAT_CHAT = "chat_completions"
API_FORMAT_RESPONSES = "responses"
API_FORMATS: tuple[str, ...] = (API_FORMAT_CHAT, API_FORMAT_RESPONSES)
DEFAULT_API_FORMAT = API_FORMAT_CHAT


def parse_api_format(value: object, *, allow_empty: bool = False) -> str:
    """写入校验：只接受 '' / chat_completions / responses。

    allow_empty=True 时保留 '' 语义（凭据层：空 = 继承目录默认）。
    非法值抛 ValueError，让 API 返回 400 而不是静默回落。
    """
    raw = str(value or "").strip().lower()
    if not raw:
        return "" if allow_empty else DEFAULT_API_FORMAT
    if raw not in API_FORMATS:
        raise ValueError(
            f"不支持的 API 格式：{value!r}（可选 {API_FORMAT_CHAT} / {API_FORMAT_RESPONSES}）"
        )
    return raw


def coerce_api_format(value: object, default: str = DEFAULT_API_FORMAT) -> str:
    """读取兼容：缺失/非法/旧数据一律回退 default，绝不抛错。"""
    try:
        return parse_api_format(value, allow_empty=False)
    except ValueError:
        return default


def is_responses(value: object) -> bool:
    """该格式是否走 Responses 协议。"""
    return coerce_api_format(value) == API_FORMAT_RESPONSES
