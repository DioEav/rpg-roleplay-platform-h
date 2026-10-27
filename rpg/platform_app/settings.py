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


def validate_memory_settings_patch_with_errors(
    patch: Any,
) -> tuple[dict[str, Any], dict[str, str]]:
    """逐字段校验 per-save memory override，返回 (合法字段, 字段→错误说明)。

    与旧版的区别（本次记忆修复）：非法值不再静默丢弃，而是把原因回给 API/UI，
    用户输入 token_budget=99 时能看到“必须 >= 200”，而不是保存后莫名其妙回弹。
    未知字段也单独标注（不写入 effective，但提示拼写/版本问题）。
    """
    from schemas.memory import MemorySettings

    clean: dict[str, Any] = {}
    errors: dict[str, str] = {}
    if not isinstance(patch, dict):
        return clean, errors
    model_fields = MemorySettings.model_fields
    for k, v in patch.items():
        if not isinstance(k, str) or k not in model_fields:
            errors[str(k)] = "未知设置项"
            continue
        try:
            ok = MemorySettings.model_validate({k: v})
            clean[k] = getattr(ok, k)
        except Exception as exc:
            # pydantic 的 str(exc) 第一行是“1 validation error for …”，对用户没用；
            # 优先取结构化 errors()[0].msg（如 “Input should be greater than or equal to 200”）。
            msg = "取值非法"
            try:
                errs = exc.errors()  # type: ignore[attr-defined]
                if errs:
                    msg = str(errs[0].get("msg") or msg)
            except Exception:
                msg = str(exc).splitlines()[0].strip() or msg
            errors[k] = msg
    return clean, errors


def validate_memory_settings_patch(patch: Any) -> dict[str, Any]:
    """逐字段校验一份 per-save memory override；保留旧调用方的“只返回合法字段”语义。

    与 get_memory_settings 的逐字段校验同口径，供 effective 解析共用。
    API 写入路径用 validate_memory_settings_patch_with_errors 拿错误明细。
    """
    clean, _ = validate_memory_settings_patch_with_errors(patch)
    return clean


def get_effective_memory_settings(user_id: int | None, state_data: dict | None = None):
    """用户全局 MemorySettings + 当前存档 override（本次记忆修复）。

    per-save override 存于 state.data["memory_settings"]（只含用户改过的字段）。
    解析顺序：全局 user_preferences → 存档 override 逐字段覆盖 → 逐字段校验。
    MemoryProvider / memory_maintenance 都走这里，保证「本存档设置」真正生效。
    """
    from schemas.memory import MemorySettings

    base = None
    if user_id is not None:
        try:
            base = get_memory_settings(int(user_id))
        except Exception:
            base = None
    if base is None:
        base = MemorySettings()
    raw = (state_data or {}).get("memory_settings") if isinstance(state_data, dict) else None
    clean = validate_memory_settings_patch(raw)
    return base.model_copy(update=clean) if clean else base


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
