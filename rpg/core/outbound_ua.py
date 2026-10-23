"""core.outbound_ua —— 统一出站 OpenAI 兼容请求的 User-Agent。

背景(确定性,已实测):不少用户自建中转站(中国区尤甚)挂在 Cloudflare 后,WAF 规则
按 User-Agent 拦截。实测某中转站对:
  · `OpenAI/Python x.y.z`(openai SDK 默认 UA) → 403 "Your request was blocked"
  · `Python-urllib/3.x`                        → 403 error 1010
而浏览器 / `curl` / `python-httpx` 的 UA 能正常到达源站(401 Invalid token = 已穿透 WAF)。

openai SDK 默认带 `OpenAI/Python <ver>` UA → 对这类中转站「校验连接 / 拉取模型 / 聊天」
**全部不可用**(表现为「不可访问」)。故对所有出站 OpenAI 兼容请求统一覆盖 UA。

可用环境变量 `RPG_OUTBOUND_UA` 覆盖默认值(自托管用户若想用别的签名)。
"""
from __future__ import annotations

import os
import threading
import uuid
from urllib.parse import urlsplit

# 浏览器 UA 最稳:实测能穿透按「已知 AI SDK / 爬虫签名」拦截的 WAF。
_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def outbound_user_agent() -> str:
    return (os.environ.get("RPG_OUTBOUND_UA") or "").strip() or _DEFAULT_UA


def openai_default_headers() -> dict[str, str]:
    """传给 openai SDK 的 `default_headers`,覆盖其内置的 `OpenAI/Python` UA。

    openai SDK 把构造期传入的 default_headers 合并在 `default_headers` 属性最后一位,
    会覆盖内置 User-Agent(已对 openai==2.38 实测验证)。
    """
    return {"User-Agent": outbound_user_agent()}


# ── provider 级附加头 ────────────────────────────────────────────────────
# OpenCode Go(opencode.ai/zen/go)的网关强制要求 chat 请求带 `x-opencode-session`,
# 缺失直接 400 `MissingSessionID`。这个头**不是 OpenAI 兼容协议的一部分**,用途是
# 会话级路由 + prompt cache,只有 OpenCode 自己的网关认。其它 provider(OpenAI /
# DeepSeek / Qwen / xAI / 小米 MiMo / 硅基流动 / 各类中转)都不需要它。
#
# 只在 base_url 命中 opencode.ai/zen/go 时注入:虽然 HTTP 规范要求服务端忽略未知头,
# 但严格网关/WAF 可能把它当异常指纹,且这个会话 ID 对别家没有任何意义。新增 provider
# 的特殊头时也照此「按 base_url 作用域」扩展,不要下沉进全局 openai_default_headers()。
_OPENCODE_HOST = "opencode.ai"
_OPENCODE_GO_PATH = "/zen/go"
_OPENCODE_SESSION_IDS: dict[tuple[str, str], str] = {}
_OPENCODE_SESSION_LOCK = threading.Lock()


def is_opencode_go_base_url(base_url: str | None) -> bool:
    """base_url 是否指向 OpenCode Go 的 OpenAI 兼容端点。

    判定 = host 为 opencode.ai(或其子域)+ path 为 /zen/go 或 /zen/go/...。
    用 path 边界而不是 startswith('/zen/go') 裸匹配,避免 /zen/gopher 之类误命中;
    非 opencode.ai 的相似域名(notopencode.ai、opencode.ai.evil.com)一律不命中。
    """
    raw = (base_url or "").strip()
    if not raw:
        return False
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    if host != _OPENCODE_HOST and not host.endswith("." + _OPENCODE_HOST):
        return False
    path = (parsed.path or "").lower().rstrip("/")
    return path == _OPENCODE_GO_PATH or path.startswith(_OPENCODE_GO_PATH + "/")


def opencode_session_id(user_id: int | None = None, api_id: str | None = None) -> str:
    """返回同一 (user, api) 维度稳定的会话 ID。

    官方只要求「每个会话一个稳定 ID」,不限制格式。backend 会被按用户 LRU 重建、探查
    每次又新建实例,若每次随机生成,同一会话的路由/缓存会不断漂移;故按 (user, api)
    缓存到进程生命周期。多 worker 各自生成不同 ID 不影响功能——官方语义只要求单会话内
    稳定,不要求跨进程一致。
    """
    key = (str(user_id or ""), (api_id or "").strip().lower())
    with _OPENCODE_SESSION_LOCK:
        sid = _OPENCODE_SESSION_IDS.get(key)
        if not sid:
            sid = "rpg-" + uuid.uuid4().hex
            _OPENCODE_SESSION_IDS[key] = sid
        return sid


def openai_default_headers_for(
    base_url: str | None = None,
    *,
    user_id: int | None = None,
    api_id: str | None = None,
) -> dict[str, str]:
    """按 base_url 返回 openai SDK 的 default_headers(UA + provider 专属头)。

    未命中任何特殊 provider 时,返回值与 openai_default_headers() **完全一致**,
    保证其它渠道的请求头零变化。
    """
    headers = openai_default_headers()
    if is_opencode_go_base_url(base_url):
        headers["x-opencode-session"] = opencode_session_id(user_id, api_id)
    return headers
