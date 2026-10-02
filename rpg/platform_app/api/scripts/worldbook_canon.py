"""platform_app.api.scripts.worldbook_canon —— 世界书 + canon 实体只读端点。

worldbook 列表、canon 实体列表/详情(MD 编辑器按类型拉取)。纯机械搬家,行为零变化。
"""
from __future__ import annotations

import re

from fastapi import Depends

from ... import knowledge
from ...db import connect
from .._deps import json_response, require_user, value_error_response
from ._shared import router


@router.get("/api/scripts/{script_id}/worldbook")
async def api_script_worldbook(script_id: int, limit: int | None = None, cursor: str | None = None, fetch_all: bool = False, user=Depends(require_user)):
    # fetch_all=true:编辑器一次性全量加载(绕开游标分页漏条);否则走默认游标分页。
    try:
        return json_response({"ok": True, **knowledge.list_worldbook_entries(
            user["id"], script_id, limit, cursor, fetch_all=fetch_all)})
    except ValueError as exc:
        return value_error_response(exc)


# canon 实体列表(MD 编辑器按类型拉取)。鉴权 owner 或 subscriber(只读),与 GET worldbook
# 的访问模型一致;分页/返回沿用 page_payload(items + page.{limit,next_cursor,has_more})。
_CANON_LIST_COLS = (
    "id, logical_key, name, full_name, type, entity_subtype, parent_logical_key, "
    "summary, identity, background, aliases, attrs, "
    "first_revealed_chapter, public_knowledge, importance, created_at"
)


@router.get("/api/scripts/{script_id}/canon-entities")
async def api_script_canon_entities(
    script_id: int, limit: int | None = None, cursor: str | None = None,
    type: str | None = None, q: str | None = None, order: str = "desc",
    page: int | None = None, user=Depends(require_user)
):
    """列出 canon 实体(服务端分页),供实体编辑器使用。owner 或 subscriber 可读。

    分页语义(数据不设总量上限,按页展示):
      · page(1-based) + limit(默认 200,单页上限 1000 防滥用,非数据截断) → offset 分页;
      · 响应带 total = 当前过滤条件下的真实总数,前端计数/页码由此驱动;
      · type: 类型过滤(character/faction/location/item/concept...);
      · q:    模糊匹配 name/full_name/logical_key/entity_subtype(%,_ 已转义);
      · order: importance 排序方向 asc|desc(默认 desc)。
    兼容:旧式 cursor 单参翻页仍可用(不与 page 同用,走 page_payload 旧响应形状)。
    """
    from ...db import cursor_id, limit_value, page_payload
    page_limit = limit_value(limit, default=200, maximum=1000)
    with connect() as db:
        owned = db.execute(
            """select 1 from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)

        # 公共过滤片段:type 等值 + q 模糊(转义 LIKE 通配符)
        q_pat = None
        if (q or "").strip():
            q_pat = "%" + re.sub(r"([\\%_])", r"\\\1", q.strip()) + "%"
        where_extra = ""
        args_extra: list = []
        if type:
            where_extra += " and type = %s"
            args_extra.append(type)
        if q_pat:
            where_extra += (
                " and (name ilike %s or coalesce(full_name,'') ilike %s "
                "or logical_key ilike %s or coalesce(entity_subtype,'') ilike %s)"
            )
            args_extra.extend([q_pat] * 4)

        # 旧式 cursor 翻页(兼容保留;page 参数优先)
        before_id = cursor_id(cursor)
        if page is None and before_id is not None:
            rows = db.execute(
                f"""
                select {_CANON_LIST_COLS} from kb_canon_entities
                where script_id = %s{where_extra}
                  and id < %s
                order by importance desc, id desc
                limit %s
                """,
                (script_id, *args_extra, before_id, page_limit + 1),
            ).fetchall()
            return json_response({"ok": True, **page_payload([dict(r) for r in rows], page_limit)})

        # 新式 offset 分页
        try:
            cur_page = max(1, int(page or 1))
        except (TypeError, ValueError):
            cur_page = 1
        direction = "asc" if str(order).lower() == "asc" else "desc"
        offset = (cur_page - 1) * page_limit

        total_row = db.execute(
            f"select count(*) as c from kb_canon_entities where script_id = %s{where_extra}",
            (script_id, *args_extra),
        ).fetchone()
        total = int(total_row["c"]) if total_row else 0
        rows = db.execute(
            f"""
            select {_CANON_LIST_COLS} from kb_canon_entities
            where script_id = %s{where_extra}
            order by importance {direction} nulls last, id {direction}
            limit %s offset %s
            """,
            (script_id, *args_extra, page_limit, offset),
        ).fetchall()
    items = [dict(r) for r in rows]
    return json_response({
        "ok": True,
        "items": items,
        "total": total,
        "page": cur_page,
        "page_size": page_limit,
        "has_more": offset + len(items) < total,
    })


@router.get("/api/scripts/{script_id}/canon-entities/{logical_key}")
async def api_script_canon_entity(script_id: int, logical_key: str, user=Depends(require_user)):
    """单个 canon 实体全字段。owner 或 subscriber 可读。"""
    with connect() as db:
        owned = db.execute(
            """select 1 from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        row = db.execute(
            f"select {_CANON_LIST_COLS} from kb_canon_entities where script_id = %s and logical_key = %s",
            (script_id, logical_key),
        ).fetchone()
    if not row:
        return json_response({"ok": False, "error": "canon entity 不存在"}, status_code=404)
    return json_response({"ok": True, "entity": dict(row)})
