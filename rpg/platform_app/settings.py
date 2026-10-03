from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb

from .db import connect, init_db


def get_memory_settings(user_id: int):
    """读取用户的记忆系统配置，缺失 key 时返回默认值。

    值来源（后者逐键覆盖前者）：
    1. settings 表 —— 旧 /api/settings 路径，前端从无调用方，仅作历史数据兜底；
    2. user_preferences.preferences —— 前端 MemorySection（桌面/移动）经
       /api/me/preference 写入的扁平 dotted key（"memory.recall_depth" 等）。
       修复前本函数只查 settings 表，与前端写入的表不同 → 界面调参从不生效。

    逐字段校验：单个非法值只回落该字段默认，不整表清零。
    返回 MemorySettings 实例（Pydantic model），调用方可直接属性访问。
    Import 放在函数内部，避免循环依赖。
    """
    from schemas.memory import MemorySettings

    raw: dict[str, Any] = {}
    try:
        raw.update(list_settings(user_id))
    except Exception:
        pass
    try:
        init_db()
        with connect() as db:
            row = db.execute(
                "select preferences from user_preferences where user_id = %s", (user_id,)
            ).fetchone()
        prefs = dict(row["preferences"]) if row and row["preferences"] else {}
        raw.update(prefs)
    except Exception:
        pass

    prefix = "memory."
    model_fields = MemorySettings.model_fields
    clean: dict[str, Any] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not k.startswith(prefix):
            continue
        field_name = k[len(prefix):]
        if field_name not in model_fields:
            continue
        try:
            ok = MemorySettings.model_validate({field_name: v})
            clean[field_name] = getattr(ok, field_name)
        except Exception:
            continue
    return MemorySettings(**clean)


def list_settings(user_id: int) -> dict[str, Any]:
    init_db()
    with connect() as db:
        return {
            row["key"]: row["value"]
            for row in db.execute("select key, value from settings where user_id = %s", (user_id,)).fetchall()
        }


_VALID_KEY_RE = __import__("re").compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")


def set_setting(user_id: int, key: str, value: Any) -> dict[str, Any]:
    init_db()
    key = (key or "").strip()
    if not key:
        raise ValueError("setting key 不能为空")
    if not _VALID_KEY_RE.match(key):
        raise ValueError("setting key 必须以字母开头，仅含字母数字 _ . - 且 ≤64 字符")
    with connect() as db:
        db.execute(
            """
            insert into settings(user_id, key, value)
            values (%s, %s, %s)
            on conflict(user_id, key)
            do update set value = excluded.value, updated_at = now()
            """,
            (user_id, key, Jsonb(value)),
        )
    return list_settings(user_id)
