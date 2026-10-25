"""platform_app.api.script_edit.canon —— canon 实体写侧 CRUD(编辑/新增/软删除)。

写 commit(canon_edit/add/delete)。纯机械搬家,行为零变化。
"""
from __future__ import annotations

from fastapi import Depends, Request
from psycopg.types.json import Jsonb

from ...db import connect
from .._deps import json_response, require_user, value_error_response
from ._shared import _jsonable, _parse_baseline_ts, _require_owner, _write_commit, router

# ─── canon-entities CRUD ─────────────────────────────────────────────────────

@router.put("/api/scripts/{script_id}/canon-entities/{logical_key}")
async def api_canon_update(
    request: Request, script_id: int, logical_key: str, user=Depends(require_user)
):
    """编辑 canon entity，写 commit kind=canon_edit。

    body: {summary?, identity?, background?, parent_logical_key?, entity_subtype?,
           full_name?, type?, importance?, aliases?, attrs?, first_revealed_chapter?,
           public_knowledge?, base_updated_at?}
    （aliases 为 jsonb 字符串数组,attrs 为 jsonb 开放对象）

    base_updated_at(可选,乐观锁):编辑器打开/上次保存时拿到的 updated_at。canon 表
    原先只有 created_at,迁移 110 补了 updated_at;传了基线就把版本条件放进 UPDATE
    的 WHERE,不一致返回 409 + server_entity;不传保持覆盖语义(AI 工具/老客户端)。
    """
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "body 必须是合法 JSON"}, status_code=400)

    try:
        base_ts = _parse_baseline_ts(body.get("base_updated_at"))
    except ValueError as exc:
        return json_response({"ok": False, "error": str(exc)}, status_code=400)

    _CANON_COLS = (
        "id, logical_key, name, full_name, type, entity_subtype, parent_logical_key, "
        "summary, identity, background, aliases, attrs, "
        "first_revealed_chapter, public_knowledge, importance, created_at, updated_at"
    )

    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        before_row = db.execute(
            f"SELECT {_CANON_COLS} FROM kb_canon_entities WHERE script_id = %s AND logical_key = %s",
            (script_id, logical_key),
        ).fetchone()
        if not before_row:
            return json_response({"ok": False, "error": "canon entity 不存在"}, status_code=404)

        before = dict(before_row)
        sets, args = [], []
        # full_name 是 md-editor canon schema 的可写字段,必须支持更新:否则用户在
        # 编辑器/冲突合并里改了它,界面显示已保存、DB 实际没落库。
        for col in ("summary", "identity", "background", "parent_logical_key", "entity_subtype", "full_name"):
            if col in body:
                sets.append(f"{col}=%s")
                args.append(str(body[col]))
        if "type" in body:
            # type 是 NOT NULL 且参与知识库筛选。允许改,但不允许改成空串(否则 500)。
            _new_type = str(body.get("type") or "").strip()
            if not _new_type:
                return json_response({"ok": False, "error": "type 不能为空"}, status_code=400)
            sets.append("type=%s")
            args.append(_new_type)
        if "name" in body:
            # 名称可改(知识库人物表格的内联编辑)。注意:logical_key 不跟随改名 ——
            # 它是实体的稳定标识(防剧透门控/锚点引用/commit 历史都按它),改名只影响展示名。
            _new_name = str(body.get("name") or "").strip()
            if _new_name:
                sets.append("name=%s")
                args.append(_new_name)
        if "importance" in body:
            sets.append("importance=%s")
            args.append(int(body["importance"]))
        if "first_revealed_chapter" in body:
            sets.append("first_revealed_chapter=%s")
            args.append(int(body["first_revealed_chapter"]))
        if "public_knowledge" in body:
            sets.append("public_knowledge=%s")
            args.append(bool(body["public_knowledge"]))
        if "aliases" in body and isinstance(body["aliases"], list):
            # aliases 为 jsonb 字符串数组
            sets.append("aliases=%s")
            args.append(Jsonb([str(x) for x in body["aliases"]]))
        if "attrs" in body and isinstance(body["attrs"], dict):
            # attrs 为 jsonb 开放对象,原样写回
            sets.append("attrs=%s")
            args.append(Jsonb(body["attrs"]))

        if not sets:
            return json_response({"ok": False, "error": "无可更新字段"}, status_code=400)

        # canon 原先没有 updated_at(迁移 110 补齐)。每次真实编辑都推进版本,
        # 否则乐观锁基线永远不变,编辑器保存无法发现 AI/其他会话的写入。
        sets.append("updated_at=now()")
        args.extend([script_id, logical_key])
        where = "script_id=%s AND logical_key=%s"
        if base_ts is not None:
            # 版本条件与写入同语句,避免「先查后写」窗口里的并发覆盖。
            where += " AND updated_at=%s"
            args.append(base_ts)
        cur = db.execute(
            f"UPDATE kb_canon_entities SET {', '.join(sets)} WHERE {where}",
            tuple(args),
        )
        if base_ts is not None and cur.rowcount == 0:
            current_row = db.execute(
                f"SELECT {_CANON_COLS} FROM kb_canon_entities WHERE script_id = %s AND logical_key = %s",
                (script_id, logical_key),
            ).fetchone()
            if not current_row:
                return json_response({"ok": False, "error": "canon entity 不存在"}, status_code=404)
            return json_response(
                {
                    "ok": False,
                    "conflict": True,
                    "error": "canon entity 已被他方更新",
                    # 与章节 server_chapter 同构;datetime 走 _jsonable,可直接 JSON 序列化。
                    "server_entity": _jsonable(dict(current_row)),
                },
                status_code=409,
            )

        after_row = db.execute(
            f"SELECT {_CANON_COLS} FROM kb_canon_entities WHERE script_id = %s AND logical_key = %s",
            (script_id, logical_key),
        ).fetchone()
        after = dict(after_row)

        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind="canon_edit",
            message=f"编辑 canon entity: {logical_key}",
            payload={"table": "kb_canon_entities", "op": "edit", "before": before, "after": after, "ids": {"logical_key": logical_key}},
        )
        db.commit()

    return json_response({"ok": True, "entity": _jsonable(after), "commit_id": commit_id})


@router.post("/api/scripts/{script_id}/canon-entities")
async def api_canon_add(
    request: Request, script_id: int, user=Depends(require_user)
):
    """新增 canon entity，写 commit kind=canon_add。

    body: {logical_key, name, type, summary?, identity?, background?, entity_subtype?,
           parent_logical_key?, importance?, full_name?, aliases?, attrs?,
           first_revealed_chapter?, public_knowledge?}
    （aliases 为 jsonb 字符串数组,attrs 为 jsonb 开放对象）
    """
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "body 必须是合法 JSON"}, status_code=400)

    logical_key = str(body.get("logical_key") or "").strip()
    name = str(body.get("name") or "").strip()
    entity_type = str(body.get("type") or "").strip()
    if not logical_key or not name or not entity_type:
        return json_response(
            {"ok": False, "error": "缺少必填字段 logical_key / name / type"},
            status_code=400,
        )

    aliases = body.get("aliases")
    aliases_jsonb = Jsonb([str(x) for x in aliases]) if isinstance(aliases, list) else Jsonb([])
    attrs = body.get("attrs")
    attrs_jsonb = Jsonb(attrs) if isinstance(attrs, dict) else Jsonb({})

    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        new_row = db.execute(
            """
            INSERT INTO kb_canon_entities
              (script_id, logical_key, name, full_name, type, summary, identity, background,
               entity_subtype, parent_logical_key, importance,
               aliases, attrs, first_revealed_chapter, public_knowledge)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (script_id, logical_key) DO NOTHING
            RETURNING id, logical_key, name, full_name, type, summary, identity, background,
                      entity_subtype, parent_logical_key, importance,
                      aliases, attrs, first_revealed_chapter, public_knowledge,
                      created_at, updated_at
            """,
            (
                script_id, logical_key, name,
                str(body.get("full_name") or ""),
                entity_type,
                str(body.get("summary") or ""),
                str(body.get("identity") or ""),
                str(body.get("background") or ""),
                str(body.get("entity_subtype") or ""),
                str(body.get("parent_logical_key") or ""),
                int(body.get("importance") or 0),
                aliases_jsonb,
                attrs_jsonb,
                int(body.get("first_revealed_chapter") or 0),
                bool(body.get("public_knowledge", False)),
            ),
        ).fetchone()
        if not new_row:
            return json_response(
                {"ok": False, "error": f"logical_key '{logical_key}' 已存在"},
                status_code=409,
            )
        after = dict(new_row)

        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind="canon_add",
            message=f"新增 canon entity: {logical_key}",
            payload={"table": "kb_canon_entities", "op": "add", "after": after, "ids": {"logical_key": logical_key}},
        )
        db.commit()

    return json_response({"ok": True, "entity": _jsonable(after), "commit_id": commit_id})


@router.delete("/api/scripts/{script_id}/canon-entities/{logical_key}")
async def api_canon_delete(
    script_id: int, logical_key: str, user=Depends(require_user)
):
    """软删除 canon entity（importance=-1 标记删除），写 commit kind=canon_delete。"""
    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        before_row = db.execute(
            "SELECT id, logical_key, name, summary, importance FROM kb_canon_entities WHERE script_id = %s AND logical_key = %s",
            (script_id, logical_key),
        ).fetchone()
        if not before_row:
            return json_response({"ok": False, "error": "canon entity 不存在"}, status_code=404)

        before = dict(before_row)
        # 用 importance=-1 做软删除标记（保留行供 checkout 回放）。
        # 同时推进 updated_at:软删除也是一次写,打开中的编辑标签保存时应触发 409,
        # 而不是把刚删掉的实体又静默写活。
        db.execute(
            "UPDATE kb_canon_entities SET importance=-1, updated_at=now() "
            "WHERE script_id=%s AND logical_key=%s",
            (script_id, logical_key),
        )

        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind="canon_delete",
            message=f"删除 canon entity: {logical_key}",
            payload={"table": "kb_canon_entities", "op": "delete", "before": before, "ids": {"logical_key": logical_key}},
        )
        db.commit()

    return json_response({"ok": True, "deleted": True, "commit_id": commit_id})
