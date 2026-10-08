"""prompt_log — 发送给 LLM 的提示词日志(排查/调优用,默认全关)。

环境变量门控(核心层直接读 os.environ,与 core.config 的 env 家族同风格):
  RPG_LOG_PROMPTS=1              开启(debug 级);默认关闭
  RPG_LOG_PROMPTS_TRUNCATE       截断控制:
                                 · 未设 / "1"  → 截断到 2000 字符(默认)
                                 · 数字(如 5000) → 自定义截断长度
                                 · "0" / "false" → 不截断,打印完整内容

⚠️ 提示词含用户剧情内容(隐私敏感),多人部署不建议常开;量体上也建议截断。

接线点(两处咽喉覆盖全部 LLM 调用,新增调用通道时也应接线):
  · agents/_harness.py  call_agent_json / call_agent_tool_loop —— 所有子代理
    (kind=harness:<agent_kind>:策展/黑天鹅/世界心跳/摘要精修/史官部分调用/…)
  · agents/gm/backends/{openai_compat,anthropic,vertex}.py 的 call / call_structured
    —— 主聊天 GM 与导出管线(kind=gm_chat / gm_structured)

用法:
  from core.prompt_log import log_llm_prompt
  log_llm_prompt(kind="harness:curator", api_id=api_id, model=model,
                 system=system_prompt, user=user_prompt)
本模块自身任何异常都被吞掉 —— 日志失败绝不影响 LLM 调用主流程。
"""
from __future__ import annotations

import json
import logging
import os

from core.logging import get_logger

# 本模块 logger 显式 DEBUG 级:提示词日志的可见性【只】由 RPG_LOG_PROMPTS 门控,
# 不随 app.py setup_default_logging 的全局 INFO 级被过滤(否则开了开关也看不到)。
# debug 记录经本 logger 发出后向上传播到根 handler 输出。
log = get_logger(__name__)
log.setLevel(logging.DEBUG)

_DEFAULT_TRUNCATE_CHARS = 2000
_FALSY = ("0", "false", "no", "off", "")


def prompts_enabled() -> bool:
    """RPG_LOG_PROMPTS=1 时开启。每次调用都读 env(开销可忽略,且便于测试注入)。"""
    raw = (os.environ.get("RPG_LOG_PROMPTS") or "").strip()
    return bool(raw) and raw.lower() not in _FALSY


def _truncate_limit() -> int | None:
    """截断上限;None = 不截断(打印完整内容)。未设 = 默认截 2000。"""
    raw = os.environ.get("RPG_LOG_PROMPTS_TRUNCATE")
    if raw is None:
        return _DEFAULT_TRUNCATE_CHARS
    raw = raw.strip()
    if raw.lower() in _FALSY:
        return None
    try:
        n = int(raw)
    except ValueError:
        return _DEFAULT_TRUNCATE_CHARS
    return n if n > 0 else None


def _clip(text: str, limit: int | None) -> str:
    text = text or ""
    if limit is None or len(text) <= limit:
        return text
    return text[:limit] + f"…[已截断,共 {len(text)} 字符]"


def _content_text(content) -> str:
    """消息 content 兼容:str 直接用;OpenAI 多段数组(list)转 JSON;None → 空。"""
    if isinstance(content, str):
        return content
    try:
        return json.dumps(content, ensure_ascii=False)
    except Exception:
        return str(content)


def log_llm_prompt(*, kind: str, api_id: str = "", model: str = "",
                   system: str = "", user: str = "", messages: list | None = None) -> None:
    """按门控与截断配置打印一条 debug 提示词日志。system/user 与 messages 至少给一个。

    所有异常吞掉 —— 日志失败绝不影响 LLM 调用主流程。
    """
    try:
        if not prompts_enabled():
            return
        limit = _truncate_limit()
        header = f"[PROMPT][{kind}] api={api_id or '—'} model={model or '—'}"
        parts: list[str] = [header]
        if system:
            parts.append(f"--- system(共 {len(system)} 字符) ---\n" + _clip(system, limit))
        if messages:
            total = sum(len(_content_text(m.get("content") if isinstance(m, dict) else None))
                        for m in (messages or []) if isinstance(m, dict))
            parts.append(f"--- messages({len(messages or [])} 条, 共约 {total} 字符) ---")
            for i, m in enumerate(messages or []):
                if not isinstance(m, dict):
                    continue
                text = _content_text(m.get("content"))
                parts.append(f"[#{i} {m.get('role') or '?'}(共 {len(text)} 字符)]\n" + _clip(text, limit))
        if user:
            parts.append(f"--- user(共 {len(user)} 字符) ---\n" + _clip(user, limit))
        log.debug("\n".join(parts))
    except Exception:
        pass
