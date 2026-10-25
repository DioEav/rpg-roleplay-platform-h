"""console_assistant.write_guard — 待确认写操作的目标状态指纹。

问题:destructive 写工具在"生成改动预览 → 用户点批准"之间有一段任意长的时间窗。
此前只有章节有 base_chapter_id(只防重排,不防内容变化),世界书/角色卡/锚点/canon
以及 resplit / 整本导入完全没有版本复核:作者在这段时间里手动保存、另一个标签写入、
或 AI 先写了同一实体,批准时都会静默覆盖。

做法:创建 pending 时对目标当前状态做一份只读指纹(不含大正文,只用 md5/版本列),
批准执行前再算一次;不一致就拒绝本次写入,要求助手重新读取后再改。

- 章节另有 base_updated_at 原子条件(update_chapter 的 UPDATE WHERE),这里是兜底。
- 指纹计算失败不阻断确认(返回 None):DB 抖动时宁可保持原有工具行为,也不能
  让所有写操作都点不下去。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def _digest(payload: Any) -> str:
    """稳定指纹:排序 JSON + sha256 前 32 位。datetime 用 str 兜底。"""
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def _ts(value: Any) -> str:
    return "" if value is None else str(value)


def _chapter(db, sid: int, ci: Any) -> Any:
    try:
        ci = int(ci)
    except (TypeError, ValueError):
        return None
    return db.execute(
        "select id, title, volume_title, md5(coalesce(content,'')) as content_md5, "
        "updated_at from script_chapters where script_id=%s and chapter_index=%s",
        (sid, ci),
    ).fetchone()


def _worldbook(db, sid: int, entry_id: Any) -> Any:
    try:
        eid = int(entry_id)
    except (TypeError, ValueError):
        return None
    return db.execute(
        "select id, title, md5(coalesce(content,'')) as content_md5, updated_at "
        "from worldbook_entries where id=%s and script_id=%s",
        (eid, sid),
    ).fetchone()


def _card(db, sid: int, card_id: Any) -> Any:
    try:
        cid = int(card_id)
    except (TypeError, ValueError):
        return None
    return db.execute(
        "select id, row_version, updated_at from character_cards "
        "where id=%s and script_id=%s and card_type='npc'",
        (cid, sid),
    ).fetchone()


def _anchor(db, sid: int, anchor_id: Any) -> Any:
    try:
        aid = int(anchor_id)
    except (TypeError, ValueError):
        return None
    return db.execute(
        "select id, md5(coalesce(sample_summary,'')) as content_md5, updated_at "
        "from script_timeline_anchors where id=%s and script_id=%s",
        (aid, sid),
    ).fetchone()


def _canon(db, sid: int, logical_key: Any) -> Any:
    key = str(logical_key or "").strip()
    if not key:
        return None
    return db.execute(
        "select id, md5(coalesce(summary,'') || '|' || coalesce(identity,'') || '|' "
        "|| coalesce(background,'')) as content_md5, updated_at "
        "from kb_canon_entities where script_id=%s and logical_key=%s",
        (sid, key),
    ).fetchone()


def _chapter_structure(db, sid: int) -> Any:
    """章节结构/内容的总览指纹:章数 + 最大 id + 最近一次写入时间。

    用于 resplit / 整本导入这类没有单一实体 baselined 的破坏性操作。
    """
    return db.execute(
        "select count(*) as n, coalesce(max(id),0) as max_id, "
        "coalesce(max(updated_at)::text,'') as max_ts "
        "from script_chapters where script_id=%s",
        (sid,),
    ).fetchone()


# rebuild_script_module 的 module 别名(与 tools_dsl.command_tools_imports 保持一致)。
_MODULE_ALIASES = {
    "facts": "chapter-facts", "chapter_facts": "chapter-facts", "fact": "chapter-facts",
    "timeline": "anchors", "anchor": "anchors",
    "embedding": "embeddings", "embed": "embeddings", "vector": "embeddings", "vectors": "embeddings",
    "characters": "cards", "character": "cards", "card": "cards", "人设卡": "cards", "角色卡": "cards",
    "wb": "worldbook", "world_book": "worldbook", "世界书": "worldbook",
    "chunk": "chunks", "规范实体": "canon", "时间线": "anchors",
}


def _normalize_module(raw: Any) -> str:
    s = str(raw or "").strip().lower()
    return _MODULE_ALIASES.get(s, s)


def _module_state(db, sid: int, module: str) -> Any:
    """rebuild 目标模块的当前状态指纹。

    章节指纹只覆盖正文;cards/worldbook/canon/anchors 在确认期间被手动保存时,
    重建仍会按旧数据覆盖。这里把目标表也纳入指纹(查询失败返回 None,不阻断)。
    """
    try:
        if module == "cards":
            return db.execute(
                "select count(*) as n, coalesce(max(row_version),0) as mv, "
                "coalesce(max(updated_at)::text,'') as mts from character_cards "
                "where script_id=%s and card_type='npc'",
                (sid,),
            ).fetchone()
        if module == "worldbook":
            return db.execute(
                "select count(*) as n, coalesce(max(updated_at)::text,'') as mts "
                "from worldbook_entries where script_id=%s",
                (sid,),
            ).fetchone()
        if module == "canon":
            return db.execute(
                "select count(*) as n, coalesce(max(updated_at)::text,'') as mts "
                "from kb_canon_entities where script_id=%s",
                (sid,),
            ).fetchone()
        if module == "anchors":
            return db.execute(
                "select count(*) as n, coalesce(max(updated_at)::text,'') as mts "
                "from script_timeline_anchors where script_id=%s",
                (sid,),
            ).fetchone()
        if module == "chapter-facts":
            return db.execute(
                "select count(*) as n, coalesce(max(updated_at)::text,'') as mts "
                "from chapter_facts where script_id=%s",
                (sid,),
            ).fetchone()
    except Exception:
        return None
    # chunks/embeddings 等纯派生模块由章节指纹兜底(它们的输入就是章节正文)。
    return None


def preview_fingerprint(
    tool_name: str, args: dict[str, Any] | None, user_id: int | None, script_id: int | None,
) -> str | None:
    """返回目标当前状态指纹;None = 该工具没有单一目标 / 无需指纹 / 查询失败。"""
    if not script_id or user_id is None:
        return None
    args = dict(args or {})
    sid = int(script_id)
    tool = str(tool_name or "")
    try:
        from platform_app.db import connect, init_db
        from platform_app.perms import script_owned

        init_db()
        with connect() as db:
            if not script_owned(db, sid, user_id):
                return None

            if tool == "update_script_chapter":
                row = _chapter(db, sid, args.get("chapter_index"))
                return _digest({
                    "kind": "chapter",
                    "row": None if not row else {
                        "id": row.get("id"),
                        "title": row.get("title"),
                        "volume_title": row.get("volume_title"),
                        "content_md5": row.get("content_md5"),
                        "updated_at": _ts(row.get("updated_at")),
                    },
                })

            if tool in ("upsert_worldbook_entry", "delete_worldbook_entry"):
                row = _worldbook(db, sid, args.get("entry_id"))
                return _digest({
                    "kind": "worldbook",
                    "row": None if not row else {
                        "id": row.get("id"),
                        "title": row.get("title"),
                        "content_md5": row.get("content_md5"),
                        "updated_at": _ts(row.get("updated_at")),
                    },
                })

            if tool == "upsert_worldbook_entries":
                entries = args.get("entries")
                if not isinstance(entries, list):
                    return None
                rows = []
                for e in entries:
                    if not isinstance(e, dict) or e.get("entry_id") in (None, ""):
                        continue
                    row = _worldbook(db, sid, e.get("entry_id"))
                    rows.append(None if not row else {
                        "id": row.get("id"),
                        "content_md5": row.get("content_md5"),
                        "updated_at": _ts(row.get("updated_at")),
                    })
                return _digest({"kind": "worldbook_batch", "rows": rows}) if rows else None

            if tool == "update_npc_card":
                row = _card(db, sid, args.get("card_id"))
                return _digest({
                    "kind": "card",
                    "row": None if not row else {
                        "id": row.get("id"),
                        "row_version": row.get("row_version"),
                        "updated_at": _ts(row.get("updated_at")),
                    },
                })

            if tool in ("update_anchor", "delete_anchor"):
                row = _anchor(db, sid, args.get("anchor_id"))
                return _digest({
                    "kind": "anchor",
                    "row": None if not row else {
                        "id": row.get("id"),
                        "content_md5": row.get("content_md5"),
                        "updated_at": _ts(row.get("updated_at")),
                    },
                })

            if tool == "upsert_canon_entity":
                row = _canon(db, sid, args.get("logical_key"))
                return _digest({
                    "kind": "canon",
                    "row": None if not row else {
                        "id": row.get("id"),
                        "content_md5": row.get("content_md5"),
                        "updated_at": _ts(row.get("updated_at")),
                    },
                })

            if tool in ("resplit_script", "import_document_as_chapters", "rebuild_script_module"):
                row = _chapter_structure(db, sid)
                # rebuild:再把目标模块的数据状态纳入指纹(章节结构只覆盖正文)。
                module = _normalize_module(args.get("module")) if tool == "rebuild_script_module" else ""
                return _digest({
                    "kind": "structure",
                    "tool": tool,
                    "module": module,
                    "row": None if not row else {
                        "n": row.get("n"),
                        "max_id": row.get("max_id"),
                        "max_ts": _ts(row.get("max_ts")),
                    },
                    "module_state": _module_state(db, sid, module) if module else None,
                })
    except Exception:
        # 指纹是兜底而非唯一防线:DB 抖动/表结构差异时不要阻断确认流程。
        return None
    return None


STALE_WRITE_ERROR = (
    "确认预览后目标内容/结构已变化(可能刚手动保存、另一标签或 AI 写入),"
    "已取消本次写入。请让助手重新读取目标后再改。"
)


def preview_baseline(
    tool_name: str, args: dict[str, Any] | None, user_id: int | None, script_id: int | None,
) -> dict[str, Any] | None:
    """返回待确认写操作的目标版本基线(供工具在 UPDATE/DELETE WHERE 里原子复核)。

    指纹是「批准前再读一次」,仍有一个 verify→dispatch 的极小窗口;把版本列作为
    base_updated_at / base_row_version 注入 args,工具就能在**同一条 SQL** 里复核,
    彻底消除该窗口。章节已由 update_chapter 的 base_updated_at 处理,这里跳过。

    返回:
      {"base_updated_at": iso}                    世界书/锚点/canon/删除
      {"base_row_version": int}                   角色卡
      {"entries": {str(entry_id): iso}}           批量世界书(按条目)
      None                                        创建/无目标/查询失败
    """
    if not script_id or user_id is None:
        return None
    args = dict(args or {})
    sid = int(script_id)
    tool = str(tool_name or "")
    try:
        from platform_app.db import connect, init_db
        from platform_app.perms import script_owned

        init_db()
        with connect() as db:
            if not script_owned(db, sid, user_id):
                return None
            if tool in ("upsert_worldbook_entry", "delete_worldbook_entry"):
                row = _worldbook(db, sid, args.get("entry_id"))
                if not row:
                    return None
                return {"base_updated_at": _ts(row.get("updated_at")) or None}
            if tool == "upsert_worldbook_entries":
                entries = args.get("entries")
                if not isinstance(entries, list):
                    return None
                out: dict[str, Any] = {}
                for e in entries:
                    if not isinstance(e, dict) or e.get("entry_id") in (None, ""):
                        continue
                    row = _worldbook(db, sid, e.get("entry_id"))
                    if row and row.get("updated_at") is not None:
                        out[str(int(row.get("id")))] = _ts(row.get("updated_at"))
                return {"entries": out} if out else None
            if tool == "update_npc_card":
                row = _card(db, sid, args.get("card_id"))
                if not row:
                    return None
                return {"base_row_version": int(row.get("row_version") or 0)}
            if tool in ("update_anchor", "delete_anchor"):
                row = _anchor(db, sid, args.get("anchor_id"))
                if not row:
                    return None
                return {"base_updated_at": _ts(row.get("updated_at")) or None}
            if tool == "upsert_canon_entity":
                row = _canon(db, sid, args.get("logical_key"))
                if not row:
                    return None
                return {"base_updated_at": _ts(row.get("updated_at")) or None}
    except Exception:
        return None
    return None


def verify_pending_fingerprint(pending: dict[str, Any], user_id: int | None) -> str | None:
    """批准执行前的复核。返回错误文案(已过期)或 None(可以执行)。"""
    expected = pending.get("target_fingerprint")
    if not expected:
        return None
    current = preview_fingerprint(
        pending.get("tool") or "",
        pending.get("args") or {},
        user_id,
        pending.get("script_id"),
    )
    if current == expected:
        return None
    return STALE_WRITE_ERROR
