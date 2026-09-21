"""user_prefs —— user_preferences.preferences 的读取约定(单一来源)。

前端设置页把值写成 **`settings.<key>`** 这种点号扁平键:桌面 `useAutoSave(label, "settings")`
与移动 `usePrefSave('settings')` 都拼 `${scope}.${field}`,而 POST /api/me/preference 做的是
JSONB 浅合并 —— 点号是键名的一部分,原样落库。

后端读取必须同语义:先查 `settings.<key>`,再回退裸 `<key>`(兼容更早的写入形式)。否则会
**静默取不到值** —— 采样参数与 NSFW 两组偏好都曾因只查裸键而整套失效,且不报错、界面照常回显,
极难定位。本模块是后端唯一实现,与前端 frontend/src/lib/prefs.js::readScopedPref 一一对应。

同理,**判断"有没有设过"用 `in` 而不是 truthy**:0 / "" / [] 都是有效取值(例如 temperature=0
表示最确定、nsfw_intensity=0 表示仅在玩家明确请求时),用 truthy 判定会把它们当成"没设过"。
"""
from __future__ import annotations

from typing import Any


def scoped_pref(prefs: dict | None, key: str, default: Any = None) -> Any:
    """按命名空间回退读取:`settings.<key>` 优先,其次裸 `<key>`,都没有返回 default。"""
    if not isinstance(prefs, dict):
        return default
    dotted = f"settings.{key}"
    if dotted in prefs:
        return prefs[dotted]
    if key in prefs:
        return prefs[key]
    return default


def has_pref(prefs: dict | None, key: str) -> bool:
    """用户是否显式设过该键(两种命名空间任一命中即算)。"""
    if not isinstance(prefs, dict):
        return False
    return f"settings.{key}" in prefs or key in prefs


def read_user_prefs(user_id: int | None) -> dict:
    """取该用户的 preferences dict(请求内缓存,非请求上下文直接查库)。

    读失败/无用户 → {}:调用方据此走"沿用默认"分支,绝不因为读偏好失败而中断主流程。
    """
    if not user_id:
        return {}
    try:
        from core.request_cache import get_user_prefs_cached

        prefs = get_user_prefs_cached(int(user_id))
        return prefs if isinstance(prefs, dict) else {}
    except Exception:
        return {}
