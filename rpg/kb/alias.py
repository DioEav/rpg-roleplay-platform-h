"""kb/alias.py — canon 实体别名的确定性归并(运行时名字治理)。

群反馈(斗破档):①GM 写 relationships.云芝 与 relationships.云韵 = 人物面板同人两卡
(云芝=云韵化名,canon aliases 数据本来是对的,写入点没查);②GM 给原创路人起名薅了
后文角色名(韩枫/紫妍)。归并/识别都必须是代码缝,不指望 LLM(确定性铁律)。
"""
from __future__ import annotations

import logging
from functools import lru_cache

log = logging.getLogger(__name__)


@lru_cache(maxsize=4096)
def _alias_to_canonical(script_id: int, name: str) -> str:
    """名字命中某 canon 实体的 aliases(且非其主名)→返回主名;否则返回原名。
    失败原样返回(非致命)。lru 缓存:同剧本同名只查一次。"""
    if not script_id or not name or len(name) < 2:
        return name
    try:
        from platform_app.db import connect
        with connect() as db:
            row = db.execute(
                "select name from kb_canon_entities "
                "where script_id = %s and name <> %s and aliases ? %s limit 1",
                (int(script_id), name, name),
            ).fetchone()
        return str(row["name"]) if row and row.get("name") else name
    except Exception:
        return name


_SCRIPT_ID_CACHE: dict[int, int] = {}


def _script_id_for_save(save_id: int) -> int:
    """save_id → script_id（本次记忆修复：缓存避免每次记忆写入都查一次 DB）。

    只缓存成功结果；DB 暂时失败返回 0 但不写缓存，下一条记忆写入/下一回合仍会重试。
    用普通 dict 而不是 lru_cache，就是为了不把一次失败永久缓存到进程结束。
    """
    sid = int(save_id or 0)
    if not sid:
        return 0
    cached = _SCRIPT_ID_CACHE.get(sid)
    if cached is not None:
        return cached
    try:
        from platform_app.db import connect
        with connect() as db:
            row = db.execute(
                "select script_id from game_saves where id = %s", (sid,)).fetchone()
        script_id = int((row or {}).get("script_id") or 0)
        if script_id:
            _SCRIPT_ID_CACHE[sid] = script_id
        return script_id
    except Exception:
        return 0


def canonical_name_for_save(save_id: int | None, name: str) -> str:
    """按存档所属剧本做别名归并。查不到剧本/任何失败=原名。"""
    n = str(name or "").strip()
    if not save_id or not n:
        return n
    sid = _script_id_for_save(int(save_id))
    return _alias_to_canonical(sid, n) if sid else n


def canonical_names_for_save(save_id: int | None, names) -> list[str]:
    """批量别名归并（本次记忆修复）。

    记忆写入会一次识别多个角色名；逐个调 canonical_name_for_save 会重复查
    save_id→script_id。这里只查一次，再走已缓存的 _alias_to_canonical。
    """
    cleaned = [str(n or "").strip() for n in (names or [])]
    cleaned = [n for n in cleaned if n]
    if not save_id or not cleaned:
        return cleaned
    sid = _script_id_for_save(int(save_id))
    if not sid:
        return cleaned
    out: list[str] = []
    for n in cleaned:
        c = _alias_to_canonical(sid, n)
        if c and c not in out:
            out.append(c)
    return out
