"""platform_app.api.script_edit.worldbook —— 世界书条目写侧 CRUD(编辑/新增/删除/批量)。

写 commit(worldbook_edit/add/delete/bulk_*),改动后清 constant 层缓存。纯机械搬家,行为零变化。
"""
from __future__ import annotations

from typing import Any

from fastapi import Depends, Request
from psycopg.types.json import Jsonb

from ...db import connect
from .._deps import json_response, require_user, value_error_response
from ._shared import _parse_baseline_ts, _require_owner, _write_commit, router

# ─── worldbook CRUD ───────────────────────────────────────────────────────────

def _wb_changed_fields(body: dict[str, Any], before: dict[str, Any]) -> set[str]:
    """本次编辑真正改变的字段集合（用于字段级手编标记）。

    编辑器保存会整包提交 title/content/priority/enabled/tags 等所有字段，
    不能把 body 里出现的键都算成手编 —— 否则改一个字段会让全部字段亮「手编」，
    与 NPC 角色卡的"逐字段 diff"不一致。这里与 before 行逐字段比较，只返回
    值确实变化的列；enabled/probability 即使变化也不在 WORLDBOOK_MANUAL_FIELDS
    里，不会点亮手编标签。
    """
    changed: set[str] = set()
    for col in ("title", "content", "insertion_position"):
        if col in body and str(body.get(col) or "") != str(before.get(col) or ""):
            changed.add(col)
    for col in ("priority", "token_budget", "sticky_turns", "cooldown_turns", "first_revealed_chapter"):
        if col in body:
            try:
                if int(body[col]) != int(before.get(col) or 0):
                    changed.add(col)
            except (TypeError, ValueError):
                pass
    if "probability" in body:
        try:
            if float(body["probability"]) != float(before.get("probability") or 0):
                changed.add("probability")
        except (TypeError, ValueError):
            pass
    if "enabled" in body and bool(body["enabled"]) != bool(before.get("enabled", True)):
        changed.add("enabled")
    for col in ("keys", "regex_keys", "character_filter", "scene_filter"):
        if col in body and isinstance(body[col], list):
            if [str(x) for x in body[col]] != [str(x) for x in (before.get(col) or [])]:
                changed.add(col)
    if "tags" in body and isinstance(body["tags"], list):
        _meta = before.get("metadata")
        old_tags = (_meta.get("tags") if isinstance(_meta, dict) else None) or []
        if [str(x) for x in body["tags"]] != [str(x) for x in old_tags]:
            changed.add("tags")
    return changed


@router.put("/api/scripts/{script_id}/worldbook/{entry_id}")
async def api_worldbook_update(
    request: Request, script_id: int, entry_id: int, user=Depends(require_user)
):
    """编辑 worldbook entry，写 commit kind=worldbook_edit。

    body: {title?, content?, priority?, enabled?, tags?, keys?, regex_keys?,
           character_filter?, scene_filter?, token_budget?, sticky_turns?,
           cooldown_turns?, probability?, insertion_position?,
           first_revealed_chapter?, base_updated_at?}
    （keys/regex_keys/character_filter/scene_filter 为 jsonb 字符串数组列）

    base_updated_at(可选,乐观锁):编辑器打开/上次保存时拿到的 updated_at。传了就把
    版本条件放进 UPDATE 的 WHERE,与当前行不一致返回 409 + server_entry(当前整行),
    前端转三方合并。不传 = 沿用覆盖语义(AI 工具 / 老客户端),行为完全不变。
    """
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "body 必须是合法 JSON"}, status_code=400)

    # 先解析基线:非法时间戳直接 400,避免把坏参数丢给 Postgres 冒成 500。
    try:
        base_ts = _parse_baseline_ts(body.get("base_updated_at"))
    except ValueError as exc:
        return json_response({"ok": False, "error": str(exc)}, status_code=400)

    _WB_COLS = (
        "id, title, content, priority, enabled, metadata, "
        "keys, regex_keys, character_filter, scene_filter, "
        # probability 是 numeric → psycopg 读出 Decimal,JSON 不可序列化 → 必须 ::float8 转浮点
        "token_budget, sticky_turns, cooldown_turns, probability::float8 as probability, insertion_position, "
        # first_revealed_chapter 是 md-editor worldbook schema 的可写字段,快照必须带上:
        # 少了它,冲突合并会把「本地有值 / 服务端空串」误判成一段真实差异。
        "first_revealed_chapter, "
        # updated_at 是乐观锁基线:随行返回给编辑器,保存时再回传比对。
        "updated_at"
    )

    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        before_row = db.execute(
            f"SELECT {_WB_COLS} FROM worldbook_entries WHERE id = %s AND script_id = %s",
            (entry_id, script_id),
        ).fetchone()
        if not before_row:
            return json_response({"ok": False, "error": "worldbook entry 不存在"}, status_code=404)

        before = dict(before_row)

        sets, args = [], []
        _before_meta = before.get("metadata")
        _old_meta = dict(_before_meta) if isinstance(_before_meta, dict) else {}
        for col in ("title", "content", "insertion_position"):
            if col in body:
                sets.append(f"{col}=%s")
                args.append(str(body[col]))
        for col in ("priority", "token_budget", "sticky_turns", "cooldown_turns", "first_revealed_chapter"):
            if col in body:
                try:
                    value = int(body[col])
                except (TypeError, ValueError):
                    # 前端清空 integer 字段时 YAML 会解析成 null/'';回可行动 400,
                    # 而不是裸 TypeError/ValueError 冒成 500(编辑器只显示「保存失败」)。
                    return json_response(
                        {"ok": False, "error": f"{col} 必须是整数"}, status_code=400,
                    )
                sets.append(f"{col}=%s")
                args.append(value)
        if "probability" in body:
            sets.append("probability=%s")
            args.append(float(body["probability"]))
        if "enabled" in body:
            sets.append("enabled=%s")
            args.append(bool(body["enabled"]))
        # jsonb 字符串数组列(与 init.py 实际 schema 一致):keys/regex_keys/character_filter/scene_filter
        for col in ("keys", "regex_keys", "character_filter", "scene_filter"):
            if col in body and isinstance(body[col], list):
                sets.append(f"{col}=%s")
                args.append(Jsonb([str(x) for x in body[col]]))
        if "tags" in body and isinstance(body["tags"], list):
            # tags 存进 metadata.tags
            _old_meta["tags"] = body["tags"]

        # 关键：编辑器保存会整包提交所有字段，手编标记只认"值真的变了"的字段。
        # 用 before 行做 diff（与 NPC 角色卡同一口径），否则改一个字段会让全部字段亮手编。
        changed = _wb_changed_fields(body, before)

        # KB 卫生(设计 O §5.2):正文/标题变了 → 脏化向量(NULL embedding_vec)。否则编辑后行仍带
        # 旧内容的向量,而「重做」的增量循环 `WHERE embedding_vec IS NULL` 命中 0 行 → 秒完成且向量过期
        # (群反馈 行者无疆「改了世界书条目后重做秒完成、实际没重新生成」的根因)。脏化后重做/增量会真重嵌。
        if ("title" in body) or ("content" in body):
            sets.append("embedding_vec=NULL")
            sets.append("embedded_at=NULL")

        if not sets and not changed:
            return json_response({"ok": False, "error": "无可更新字段"}, status_code=400)

        # 字段级手编标记(2026-10):记录本次实际改动的列。旧数据只有
        # meta.source='editor' 没有 manual_fields → 先按整行兜底，再并上本次改动。
        # 只有"内容类"字段变化才写标记：仅切换 enabled/probability 不把手编标签点亮，
        # 否则条目会被误判成整行手编、后续重建无法刷新正文。
        from platform_app.knowledge._manual import WORLDBOOK_MANUAL_FIELDS, is_legacy_editor
        _manual = set(_old_meta.get("manual_fields") or [])
        _legacy = is_legacy_editor(_old_meta)
        if _legacy:
            _manual |= set(WORLDBOOK_MANUAL_FIELDS)
        _manual_delta = changed & set(WORLDBOOK_MANUAL_FIELDS)
        _manual |= _manual_delta
        if _manual_delta or _manual or _legacy:
            _new_meta = {**_old_meta, "source": "editor", "manual_fields": sorted(_manual)}
            sets.append("metadata=%s")
            args.append(Jsonb(_new_meta))

        sets.append("updated_at=now()")
        args.extend([entry_id, script_id])
        where = "id=%s AND script_id=%s"
        if base_ts is not None:
            # 乐观锁与 UPDATE 同一条语句:版本条件放进 WHERE,而不是「先查后写」。
            # 后者在两次查询之间仍可能被另一个请求插队,导致双方都认为版本没变。
            where += " AND updated_at=%s"
            args.append(base_ts)
        cur = db.execute(
            f"UPDATE worldbook_entries SET {', '.join(sets)} WHERE {where}",
            tuple(args),
        )
        if base_ts is not None and cur.rowcount == 0:
            # 0 行 = 版本不匹配(或并发删除)。重查当前行:还在 → 409 交前端合并;
            # 已不存在 → 404,与进入本函数时的检查保持一致。
            current_row = db.execute(
                f"SELECT {_WB_COLS} FROM worldbook_entries WHERE id = %s AND script_id = %s",
                (entry_id, script_id),
            ).fetchone()
            if not current_row:
                return json_response({"ok": False, "error": "worldbook entry 不存在"}, status_code=404)
            return json_response(
                {
                    "ok": False,
                    "conflict": True,
                    "error": "worldbook entry 已被他方更新",
                    # server_entry 与章节的 server_chapter 同构:前端据此做三方合并。
                    "server_entry": dict(current_row),
                },
                status_code=409,
            )

        after_row = db.execute(
            f"SELECT {_WB_COLS} FROM worldbook_entries WHERE id = %s",
            (entry_id,),
        ).fetchone()
        after = dict(after_row)

        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind="worldbook_edit",
            message=f"编辑 worldbook: {after.get('title', entry_id)}",
            payload={"table": "worldbook_entries", "op": "edit", "before": before, "after": after, "ids": {"entry_id": entry_id}},
        )
        db.commit()

    # L-4: worldbook 改动后清 constant 层缓存(本 worker 即时;其余 worker 300s TTL 自愈)。
    try:
        from gm_serving.context_inject import invalidate_constant_cache
        invalidate_constant_cache(script_id)
    except Exception:
        pass
    return json_response({"ok": True, "entry": after, "commit_id": commit_id})


@router.post("/api/scripts/{script_id}/worldbook")
async def api_worldbook_add(
    request: Request, script_id: int, user=Depends(require_user)
):
    """新建 worldbook entry，写 commit kind=worldbook_add。

    body: {title, content, priority?, enabled?, tags?, keys?, regex_keys?,
           character_filter?, scene_filter?, token_budget?, sticky_turns?,
           cooldown_turns?, probability?, insertion_position?, first_revealed_chapter?}
    （keys/regex_keys/character_filter/scene_filter 为 jsonb 字符串数组列）
    """
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "body 必须是合法 JSON"}, status_code=400)

    title = str(body.get("title") or "").strip()
    content = str(body.get("content") or "")
    if not title:
        return json_response({"ok": False, "error": "缺少 title"}, status_code=400)

    def _strlist(v: Any) -> list[str]:
        return [str(x) for x in v] if isinstance(v, list) else []

    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        # book_id 是遗留列、可空(migration 85);有 books 行就带上,没有就 NULL,归属看 script_id。
        book_row = db.execute(
            "SELECT id FROM books WHERE script_id = %s", (script_id,)
        ).fetchone()
        book_id = int(book_row["id"]) if book_row else None

        tags = body.get("tags") if isinstance(body.get("tags"), list) else []
        # source='editor':标记为「用户/编辑器手写」,与 AI 工具 upsert_worldbook_entry 一致,
        # 让重建时按字段豁免本条。新建 = 用户提供的字段都是手编字段（字段级标记）。
        from platform_app.knowledge._manual import WORLDBOOK_MANUAL_FIELDS
        _manual = {
            k for k in WORLDBOOK_MANUAL_FIELDS
            if k in body and body.get(k) is not None
        }
        meta: dict[str, Any] = {
            "tags": tags,
            "source": "editor",
            "manual_fields": sorted(_manual),
        }

        new_row = db.execute(
            """
            INSERT INTO worldbook_entries
              (book_id, script_id, title, content, priority, enabled, metadata,
               keys, regex_keys, character_filter, scene_filter,
               token_budget, sticky_turns, cooldown_turns, probability, insertion_position,
               first_revealed_chapter)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id, title, content, priority, enabled, metadata,
                      keys, regex_keys, character_filter, scene_filter,
                      token_budget, sticky_turns, cooldown_turns,
                      probability::float8 as probability, insertion_position,
                      first_revealed_chapter
            """,
            (
                book_id, script_id, title, content,
                int(body.get("priority") or 50),
                bool(body.get("enabled", True)),
                Jsonb(meta),
                Jsonb(_strlist(body.get("keys"))),
                Jsonb(_strlist(body.get("regex_keys"))),
                Jsonb(_strlist(body.get("character_filter"))),
                Jsonb(_strlist(body.get("scene_filter"))),
                int(body.get("token_budget") or 600),
                int(body.get("sticky_turns") or 0),
                int(body.get("cooldown_turns") or 0),
                float(body["probability"]) if body.get("probability") is not None else 100.0,
                str(body.get("insertion_position") or "worldbook"),
                # 复制世界书条目时会带 first_revealed_chapter;此前 INSERT 漏列,
                # 复制出来的条目防剧透章节被重置成 0。
                int(body.get("first_revealed_chapter") or 0),
            ),
        ).fetchone()
        after = dict(new_row)

        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind="worldbook_add",
            message=f"新增 worldbook: {title}",
            payload={"table": "worldbook_entries", "op": "add", "after": after, "ids": {"entry_id": int(after["id"])}},
        )
        db.commit()

    # L-4: worldbook 改动后清 constant 层缓存(本 worker 即时;其余 worker 300s TTL 自愈)。
    try:
        from gm_serving.context_inject import invalidate_constant_cache
        invalidate_constant_cache(script_id)
    except Exception:
        pass
    return json_response({"ok": True, "entry": after, "commit_id": commit_id})


@router.post("/api/scripts/{script_id}/worldbook/{entry_id}/unlock-manual")
async def api_worldbook_unlock_manual(
    request: Request, script_id: int, entry_id: int, user=Depends(require_user)
):
    """取消世界书条目的手编标记（字段级精确解锁 / 整条解锁）。仅 owner。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    fields = body.get("fields") if isinstance(body.get("fields"), list) else None
    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)
        before = db.execute(
            "SELECT id, metadata FROM worldbook_entries WHERE id=%s AND script_id=%s",
            (entry_id, script_id),
        ).fetchone()
        if not before:
            return json_response({"ok": False, "error": "worldbook entry 不存在"}, status_code=404)
        from ...knowledge._manual import unlock_manual_fields
        new_meta = unlock_manual_fields(
            before.get("metadata"), fields, default_source="extracted",
        )
        db.execute(
            "UPDATE worldbook_entries SET metadata=%s, updated_at=now() "
            "WHERE id=%s AND script_id=%s",
            (Jsonb(new_meta), entry_id, script_id),
        )
        try:
            _write_commit(
                db, script_id=script_id, user_id=user["id"],
                kind="worldbook_unlock_manual",
                message=f"取消 worldbook 手编标记 #{entry_id}",
                payload={"table": "worldbook_entries", "op": "unlock_manual",
                         "ids": {"entry_id": entry_id}, "fields": fields or []},
            )
        except Exception:
            pass
        db.commit()
    return json_response({"ok": True, "entry": {"id": entry_id, "metadata": new_meta}})


@router.delete("/api/scripts/{script_id}/worldbook/{entry_id}")
async def api_worldbook_delete(
    script_id: int, entry_id: int, user=Depends(require_user)
):
    """删除 worldbook entry（物理删除），写 commit kind=worldbook_delete。

    历史上这里是「软删除」(UPDATE enabled=false),但世界书列表不按 enabled 过滤、且
    enabled 同时被「停用/启用」开关复用 —— 导致「删除」和「停用」语义冲突:删完前端本地
    移除了行,reload 后该条又以「停用」态出现(用户反馈「管理不方便」的一部分)。改为物理
    删除:删除=真没了,停用=enabled 开关切换,两者彻底分离。commit 仍记 before 供审计。
    注:DELETE 用 `where id=` 的 targeted 形式(provenance 守卫豁免,见 test_editor_provenance_guards)。
    """
    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        before_row = db.execute(
            "SELECT id, title, content, priority, enabled, metadata FROM worldbook_entries WHERE id = %s AND script_id = %s",
            (entry_id, script_id),
        ).fetchone()
        if not before_row:
            return json_response({"ok": False, "error": "worldbook entry 不存在"}, status_code=404)

        before = dict(before_row)
        db.execute(
            "DELETE FROM worldbook_entries WHERE id=%s AND script_id=%s",
            (entry_id, script_id),
        )

        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind="worldbook_delete",
            message=f"删除 worldbook: {before.get('title', entry_id)}",
            payload={"table": "worldbook_entries", "op": "delete", "before": before, "ids": {"entry_id": entry_id}},
        )
        db.commit()

    # L-4: worldbook 改动后清 constant 层缓存(本 worker 即时;其余 worker 300s TTL 自愈)。
    try:
        from gm_serving.context_inject import invalidate_constant_cache
        invalidate_constant_cache(script_id)
    except Exception:
        pass
    return json_response({"ok": True, "deleted": True, "commit_id": commit_id})


# 批量动作 → (中文标签, commit kind 后缀)。set_priority 需附带 priority。
_WB_BATCH_ACTIONS = {
    "delete": "删除",
    "enable": "启用",
    "disable": "停用",
    "set_priority": "设置优先级",
}


@router.post("/api/scripts/{script_id}/worldbook/batch")
async def api_worldbook_batch(
    request: Request, script_id: int, user=Depends(require_user)
):
    """批量操作 worldbook entries:delete(物理删除)/ enable / disable / set_priority。

    body: {entry_ids: [int], action: 'delete'|'enable'|'disable'|'set_priority', priority?: int}

    单事务 + 单 commit(kind=worldbook_bulk_<action>),避免逐条 PUT 撑爆 script_commits
    版本历史。SQL 用 `id = ANY(%s) AND script_id=%s`:① 双重校验防 IDOR(只动本剧本的条目);
    ② targeted 形式豁免 provenance 守卫(用户主动选删,非全量重建)。一次 invalidate_constant_cache。
    """
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "body 必须是合法 JSON"}, status_code=400)

    action = str(body.get("action") or "").strip()
    if action not in _WB_BATCH_ACTIONS:
        return json_response({"ok": False, "error": f"不支持的 action: {action}"}, status_code=400)

    raw_ids = body.get("entry_ids") or body.get("ids") or []
    if not isinstance(raw_ids, list):
        return json_response({"ok": False, "error": "entry_ids 必须是数组"}, status_code=400)
    try:
        ids = [int(x) for x in raw_ids if x is not None]
    except (TypeError, ValueError):
        return json_response({"ok": False, "error": "entry_ids 含非法 id"}, status_code=400)
    ids = list(dict.fromkeys(ids))  # 去重保序
    if not ids:
        return json_response({"ok": False, "error": "entry_ids 不能为空"}, status_code=400)
    MAX_BATCH = 1000
    if len(ids) > MAX_BATCH:
        return json_response({"ok": False, "error": f"单次批量上限 {MAX_BATCH} 条"}, status_code=400)

    priority = None
    if action == "set_priority":
        try:
            priority = int(body.get("priority"))
        except (TypeError, ValueError):
            return json_response({"ok": False, "error": "set_priority 需要整数 priority"}, status_code=400)
        priority = max(0, min(1000, priority))  # clamp 到合理区间

    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        if action == "delete":
            rows = db.execute(
                "DELETE FROM worldbook_entries WHERE id = ANY(%s) AND script_id=%s RETURNING id",
                (ids, script_id),
            ).fetchall()
        elif action in ("enable", "disable"):
            rows = db.execute(
                "UPDATE worldbook_entries SET enabled=%s, updated_at=now() "
                "WHERE id = ANY(%s) AND script_id=%s RETURNING id",
                (action == "enable", ids, script_id),
            ).fetchall()
        else:  # set_priority
            # 批量改优先级 = 用户对"重要度"的手编：同时把 priority 写进
            # metadata.manual_fields，避免下一次 canon 重建把优先级刷回去。
            # enable/disable 不标手编（只是显示开关，不是内容编辑）。
            rows = db.execute(
                "UPDATE worldbook_entries SET priority=%s, updated_at=now(), "
                "metadata = coalesce(metadata,'{}'::jsonb) "
                "  || jsonb_build_object('source','editor') "
                "  || jsonb_build_object('manual_fields', ("
                "       SELECT jsonb_agg(DISTINCT v) "
                "       FROM jsonb_array_elements_text("
                "         coalesce(metadata->'manual_fields','[]'::jsonb) || '\"priority\"'::jsonb"
                "       ) AS t(v))) "
                "WHERE id = ANY(%s) AND script_id=%s RETURNING id",
                (priority, ids, script_id),
            ).fetchall()
        affected = len(rows or [])

        payload: dict[str, Any] = {
            "table": "worldbook_entries", "op": action,
            "ids": ids, "requested": len(ids), "count": affected,
        }
        if priority is not None:
            payload["priority"] = priority
        commit_id = _write_commit(
            db,
            script_id=script_id,
            user_id=user["id"],
            kind=f"worldbook_bulk_{action}",
            message=f"批量{_WB_BATCH_ACTIONS[action]} worldbook × {affected}",
            payload=payload,
        )
        db.commit()

    try:
        from gm_serving.context_inject import invalidate_constant_cache
        invalidate_constant_cache(script_id)
    except Exception:
        pass
    return json_response({"ok": True, "action": action, "affected": affected, "commit_id": commit_id})
