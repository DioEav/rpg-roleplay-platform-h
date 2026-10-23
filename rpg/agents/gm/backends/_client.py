"""agents.gm.backends._client — OpenAI SDK client 构造的统一入口。

Chat Completions 与 Responses 两个 backend 共用同一份 BYOK / base_url_override /
超时 / 代理 / SSRF / UA / OpenCode 会话头逻辑，避免「修 A 漏 B」。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from core.logging import get_logger

log = get_logger(__name__)


@dataclass
class PreparedOpenAIClient:
    client: Any
    key: str
    source: str
    effective_base: str
    read_timeout: float
    proxy: str | None


def prepare_openai_client(
    *,
    model: str,
    base_url: str,
    env_key: str,
    display_kind: str = "openai_compat",
    user_id: int | None = None,
    api_id: str | None = None,
) -> PreparedOpenAIClient:
    """构造 OpenAI SDK client，返回 client + 解析结果（供日志/诊断）。

    行为与历史 `_OpenAICompatBackend.__init__` 逐项一致：
      · BYOK 严格模式拒绝 env fallback；
      · 用户 base_url_override 优先于 catalog base_url；
      · 用户 proxy 仅本地模式生效；
      · 统一 safe_httpx_client（SSRF 防线）+ openai_default_headers_for（UA/provider 头）。
    """
    from openai import OpenAI

    from platform_app.user_credentials import (
        resolve_api_key,
        resolved_auth_token,
        resolved_is_usable,
    )

    # task: LLM 严格 BYOK — 生产模式拒绝平台 env fallback,防用户白嫖你的 OPENAI_API_KEY / DEEPSEEK_API_KEY 等
    try:
        from core.config import require_auth as _require_auth
        byok_only = bool(_require_auth())
    except Exception:
        byok_only = True
    env_fb = "" if (byok_only and user_id) else env_key
    result = resolve_api_key(user_id, api_id or display_kind, env_fallback=env_fb)
    key = resolved_auth_token(result)
    if not resolved_is_usable(result):
        raise ValueError(
            f"{api_id or display_kind} 的 API Key 未配置。请在「设置 → API 设置」添加你自己的 API Key。"
            "(测试服 LLM 调用必须 BYOK,平台不提供共享 key;本地/自托管模型可勾选「免 API Key」)"
        )
    # 用户覆盖了 base_url 的话优先用用户的
    effective_base = result.get("base_url_override") or base_url
    import os as _os
    # 读超时:单一来源 config.llm_timeout_seconds —— 用户 settings.request_timeout(UI 可调)
    # > env RPG_GM_TIMEOUT > 部署默认(本地/桌面 1800s 给慢的本地大模型留足首 token 时间;服务器 300s)。
    try:
        from core.config import llm_timeout_seconds as _llm_to
        read_to = _llm_to(user_id)
    except Exception:
        read_to = float(_os.environ.get("RPG_GM_TIMEOUT", "300"))
    # 出站代理:用户在凭据里配的 proxy URL。**仅本地模式(非 require_auth)才真正使用** ——
    # 托管多用户后端永不使用用户 proxy(防 SSRF:代理合法地可指向 127.0.0.1,无法用「禁私网」
    # 校验拦截;故把使用面收窄到自托管单用户场景)。本地梯子用户选「HTTP 代理」即生效。
    proxy = (result.get("proxy") or "").strip()
    use_proxy = proxy if (proxy and not byok_only) else None
    if use_proxy:
        log.info(f"[GM] {display_kind} 出站走用户代理 {use_proxy}")
    # 覆盖 openai SDK 默认 UA(`OpenAI/Python x.y.z`)→ 浏览器 UA。否则挂在 Cloudflare 后的
    # 中转站会按 UA 用 WAF 把它当 AI 爬虫拦掉(403「Your request was blocked」/ error 1010),
    # 导致这类中转站聊天/校验/拉取模型全部「不可访问」。详见 core.outbound_ua(已实测)。
    # provider 专属头(目前只有 OpenCode Go 的 x-opencode-session)也在这里按 effective_base
    # 作用域注入,其它渠道的请求头保持零变化。
    from core.outbound import safe_httpx_client
    from core.outbound_ua import openai_default_headers_for
    kwargs: dict[str, Any] = {
        # key 已由 resolved_auth_token 归一:有 key 用 key,免鉴权用占位 token
        # (绝不能是空串 —— openai SDK 对空串同样抛 Missing credentials,构造即崩)。
        "api_key": key,
        "timeout": httpx.Timeout(read_to, connect=10.0),
        "default_headers": openai_default_headers_for(
            effective_base, user_id=user_id, api_id=api_id or display_kind),
        # SEC(H-5 + 审计): base_url_override 是 user/admin 可控 → 必须走 SSRF 安全出站层。
        # 裸 httpx.Client 只 follow_redirects=False,挡 30x 但挡不住 DNS rebinding(写时闸过后
        # TTL 过期即可把域名指向 169.254.169.254 / 内网)。safe_httpx_client 在传输层 use-time
        # 重解析 + 私网校验(服务器模式 fail-closed;本地/代理模式 no-op,不影响本机大模型/梯子)。
        "http_client": safe_httpx_client(timeout=read_to, proxy=use_proxy),
    }
    if effective_base:
        kwargs["base_url"] = effective_base
    client = OpenAI(**kwargs)
    return PreparedOpenAIClient(
        client=client, key=key, source=str(result.get("source") or ""),
        effective_base=effective_base or "", read_timeout=read_to, proxy=use_proxy,
    )
