"""platform_app.api.script_edit.versioning —— commit 历史 + 章节/世界书/角色卡撤销与恢复 + checkout。

commits log、章节 undoable/undo/history/restore、通用 undo-edit(worldbook/character_cards)、
checkout(stub)。纯机械搬家,行为零变化。
"""
from __future__ import annotations

from fastapi import Depends, Request
from psycopg.types.json import Jsonb

from ...db import connect
from ...perms import script_owned
from .._deps import json_response, require_user, value_error_response
from ._shared import _require_owner, _write_commit, router

# 快照护栏:超长正文不存 before.content(与写入侧 platform_app/api/scripts/chapters.py 同口径,
# 避免 commit jsonb 爆炸)。
_MAX_COMMIT_SNAPSHOT_CHARS = 100_000


def _content_hash(text) -> str:
    """正文指纹(与 platform_app/api/scripts/chapters._content_hash 同口径)。"""
    import hashlib
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()[:16]


def _chapter_snapshot(db, script_id: int, chapter_index: int) -> dict | None:
    """抓一章当前 title/content/volume_title,压成 commit payload.before 的形状。

    撤销/恢复落库【前】调用 → 该条 chapter_revert 自带快照,故「撤销/恢复」本身也能被
    「恢复到此前」退回(修复「点错了无法退回」)。失败返回 None(记录照写,只是不可逆)。
    """
    try:
        row = db.execute(
            "select id, title, content, volume_title from script_chapters "
            "where script_id = %s and chapter_index = %s",
            (script_id, int(chapter_index)),
        ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    content = str((row or {}).get("content") or "")
    return {
        "title": row.get("title"),
        "content": content if len(content) <= _MAX_COMMIT_SNAPSHOT_CHARS else None,
        "volume_title": row.get("volume_title"),
        # 快照对应的稳定行 id:撤销/恢复时作为 update_chapter.base_chapter_id 回传,
        # 把「读当前章 → 写回旧文」之间可能发生的重排挡在原子 UPDATE 条件里。
        "chapter_id": row.get("id"),
    }


# ─── commits log ─────────────────────────────────────────────────────────────

@router.get("/api/scripts/{script_id}/commits")
async def api_list_commits(
    script_id: int,
    limit: int = 30,
    cursor: int | None = None,
    user=Depends(require_user),
):
    """列出 script 的 commit 历史（最新优先），支持 cursor 翻页（按 id 递减）。

    next_cursor=本页最后一条的 id，前端回传即取更早的一页（抽屉「加载更多」用）。
    另返回 chapter_index / has_snapshot：抽屉据此判断该条能否用章节级「恢复到此前」回退
    （剧本级 checkout 回放仍未实现，章节记录是最常见且已有精确回退的一类）。"""
    limit = max(1, min(int(limit), 200))
    with connect() as db:
        owned = db.execute(
            "SELECT 1 FROM scripts WHERE id = %s AND owner_id = %s",
            (script_id, user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)

        where_cursor = ""
        params: list = [script_id]
        if cursor:
            where_cursor = " AND c.id < %s"
            params.append(int(cursor))
        params.append(limit + 1)  # 多取一条:判断是否还有更早的页
        rows = db.execute(
            f"""
            SELECT c.id, c.parent_commit_id, c.kind, c.message,
                   c.is_checkpoint, c.created_at,
                   c.payload->'ids'->>'chapter_index' AS chapter_index,
                   (c.payload->'before'->>'content' IS NOT NULL) AS has_snapshot,
                   u.username AS author_username, u.display_name AS author_display_name
            FROM script_commits c
            LEFT JOIN users u ON u.id = c.author_user_id
            WHERE c.script_id = %s{where_cursor}
            ORDER BY c.id DESC
            LIMIT %s
            """,
            tuple(params),
        ).fetchall()

    items = [dict(r) for r in rows[:limit]]
    next_cursor = int(items[-1]["id"]) if (len(rows) > limit and items) else None
    return json_response({
        "ok": True,
        "commits": items,
        "count": len(items),
        "next_cursor": next_cursor,
    })


@router.delete("/api/scripts/{script_id}/commits/{commit_id}")
async def api_delete_commit(script_id: int, commit_id: int, user=Depends(require_user)):
    """删除一条历史记录(仅 owner)。只删审计记录,不动正文。

    指针维护(必须):scripts.head_commit_id 无外键约束 —— 删掉它指向的记录会留下悬空 id,
    下次 _write_commit 拿它当 parent 插入时撞 parent_commit_id 的外键 → 之后所有记录都写不进去。
    故:被删记录若是 head → head 回退到它的 parent(可能置 NULL)。
    parent_commit_id 自身是 on delete set null,删中间记录不会报错(其直接子记录的 parent 变 NULL)。"""
    uid = int(user["id"])
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        row = db.execute(
            "SELECT parent_commit_id FROM script_commits WHERE id=%s AND script_id=%s",
            (commit_id, script_id),
        ).fetchone()
        if not row:
            return json_response({"ok": False, "error": "找不到该记录"}, status_code=404)
        parent_id = row["parent_commit_id"]
        # 防御:parent 若已不存在(外键本会置 NULL,双重保险)则回退到 NULL,
        # 绝不把悬空 id 写进 head —— 那会让下一次记录写入撞外键失败。
        if parent_id is not None:
            alive = db.execute("SELECT 1 FROM script_commits WHERE id=%s", (parent_id,)).fetchone()
            if not alive:
                parent_id = None
        head = db.execute("SELECT head_commit_id FROM scripts WHERE id=%s", (script_id,)).fetchone()
        if head and head["head_commit_id"] is not None and int(head["head_commit_id"]) == int(commit_id):
            # CAS(where head_commit_id=被删记录):并发写入把 head 推进到新记录后本更新影响 0 行
            # → 不把 head 倒退回去(否则新记录成孤儿、fork 记错来源版本)。
            # 刻意不动 scripts.updated_at:删历史记录不该让 KB 提取面板判定内容已变(stale)。
            db.execute(
                "UPDATE scripts SET head_commit_id=%s WHERE id=%s AND head_commit_id=%s",
                (int(parent_id) if parent_id is not None else None, script_id, int(commit_id)),
            )
        db.execute("DELETE FROM script_commits WHERE id=%s AND script_id=%s", (commit_id, script_id))
        db.commit()
    return json_response({"ok": True, "deleted": commit_id})


@router.get("/api/scripts/{script_id}/chapters/{chapter_index}/undoable")
async def api_chapter_undoable(script_id: int, chapter_index: int, user=Depends(require_user)):
    """本章是否有可撤销的 AI 改动(给前端决定是否显示「撤销」)。"""
    with connect() as db:
        if not script_owned(db, script_id, int(user["id"])):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        # 新记录带稳定 chapter_id:只把属于当前 index 对应行的记录算作可撤销,
        # 旧记录(NULL)保持兼容。
        current = db.execute(
            "SELECT id FROM script_chapters WHERE script_id=%s AND chapter_index=%s",
            (script_id, int(chapter_index)),
        ).fetchone()
        row = db.execute(
            """SELECT id, message FROM script_commits
               WHERE script_id=%s AND kind='chapter_edit'
                 AND coalesce((payload->>'undoable')::boolean, false) IS TRUE
                 AND coalesce((payload->>'undone')::boolean, false) IS FALSE
                 AND coalesce(payload->'ids'->>'chapter_index','') = %s
                 AND (payload->'ids'->>'chapter_id' IS NULL
                      OR payload->'ids'->>'chapter_id' = %s)
               ORDER BY id DESC LIMIT 1""",
            (script_id, str(chapter_index), str(current["id"]) if current else None),
        ).fetchone()
    return json_response({"ok": True, "undoable": bool(row),
                          "commit_id": int(row["id"]) if row else None})


@router.post("/api/scripts/{script_id}/chapters/{chapter_index}/undo")
async def api_undo_chapter_edit(script_id: int, chapter_index: int, user=Depends(require_user)):
    """撤销本章最近一次可撤销的改动:把正文恢复到那次改动之前(commit.payload.before)。

    确定性、作者主动触发(非 agent 工具,不指望 LLM)。恢复后标记该 commit 已撤销 + 写一条
    chapter_revert,故可连续往前逐次撤销。手动编辑走 CodeMirror 自带撤销,这里专治「AI 改了库
    才发现不对」—— 与落库前的「改动预览」一前一后构成写作搭档的安全网。

    可逆:撤销前抓当前正文写进本条 chapter_revert 的快照,故「撤销」本身也能被「恢复到此前」退回。"""
    uid = int(user["id"])
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        # 与 /undoable 同一身份过滤:新记录只认当前 index 指向的那一行;旧记录(NULL)兼容。
        current = db.execute(
            "SELECT id FROM script_chapters WHERE script_id=%s AND chapter_index=%s",
            (script_id, int(chapter_index)),
        ).fetchone()
        row = db.execute(
            """SELECT id, payload FROM script_commits
               WHERE script_id=%s AND kind='chapter_edit'
                 AND coalesce((payload->>'undoable')::boolean, false) IS TRUE
                 AND coalesce((payload->>'undone')::boolean, false) IS FALSE
                 AND coalesce(payload->'ids'->>'chapter_index','') = %s
                 AND (payload->'ids'->>'chapter_id' IS NULL
                      OR payload->'ids'->>'chapter_id' = %s)
               ORDER BY id DESC LIMIT 1""",
            (script_id, str(chapter_index), str(current["id"]) if current else None),
        ).fetchone()
        if not row:
            return json_response({"ok": False, "error": "本章没有可撤销的 AI 改动"}, status_code=404)
        before = ((row["payload"] or {}).get("before") or {})
        commit_id = int(row["id"])
        # 撤销前抓当前正文 → 写进本条 revert 的快照,让「撤销」本身可逆。
        prior = _chapter_snapshot(db, script_id, chapter_index)
        # 撤销护栏(新记录才有 after_*):AI 改动之后作者又手动保存过 → 当前内容已不是
        # AI 写完的样子,此时恢复 before 会静默覆盖那些手动修改。拒绝并引导去版本历史。
        payload = row["payload"] or {}
        # 身份护栏(新记录才有 ids.chapter_id):记录写入时属于另一章 = index 已被重排,
        # 不能把它的 before 应用到当前章。放在内容护栏之前,避免用错章的哈希做判断。
        commit_cid = (payload.get("ids") or {}).get("chapter_id")
        if commit_cid is not None and prior is not None:
            try:
                commit_cid = int(commit_cid)
            except (TypeError, ValueError):
                commit_cid = None
            if commit_cid is not None and commit_cid != int(prior.get("chapter_id")):
                return json_response({
                    "ok": False,
                    "structure_changed": True,
                    "error": "该撤销记录属于另一章(章节已被重排),已取消撤销;请关闭标签后重新打开",
                }, status_code=409)
        after_hash = payload.get("after_hash")
        if after_hash:
            if not prior:
                return json_response({"ok": False, "error": "章节不存在"}, status_code=404)
            mismatch = _content_hash(prior.get("content")) != after_hash
            if not mismatch and payload.get("after_title") is not None:
                mismatch = str(prior.get("title") or "") != str(payload.get("after_title") or "")
            if not mismatch and payload.get("after_volume_title") is not None:
                mismatch = str(prior.get("volume_title") or "") != str(payload.get("after_volume_title") or "")
            if mismatch:
                return json_response({
                    "ok": False,
                    "conflict": True,
                    "error": "章节在 AI 改动后又被编辑过,已取消撤销以避免覆盖手动修改。可在「版本历史」里选择要恢复的版本。",
                }, status_code=409)
    # 恢复改前全文(走现成 update_chapter,自带 owner 校验 + word_count 同步)
    from platform_app.script_import import ChapterStructureChanged, update_chapter
    bc = before.get("content")
    try:
        update_chapter(
            uid, script_id, int(chapter_index),
            title=(str(before["title"]) if before.get("title") is not None else None),
            content=(str(bc) if bc is not None else None),
            volume_title=(str(before["volume_title"]) if before.get("volume_title") is not None else None),
            # 身份锁:prior 是本次撤销前读到的当前章快照。若从读取到写库之间章节被
            # 重排/删除,update_chapter 的原子 WHERE 会拒绝,避免撤销内容落到另一章。
            base_chapter_id=(prior or {}).get("chapter_id"),
        )
    except ChapterStructureChanged as conflict:
        return json_response(
            {"ok": False, "structure_changed": True,
             "error": "章节结构已变化:当前章节序号已指向另一章,已取消撤销;请关闭标签后重新打开",
             "server_chapter": conflict.server_chapter},
            status_code=409)
    except ValueError as exc:
        # 章节已被删除等 → 400 而非 500(既有代码未捕获,此处加固)。
        return value_error_response(exc)
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        db.execute(
            "UPDATE script_commits SET payload = jsonb_set(payload, '{undone}', 'true') WHERE id=%s",
            (commit_id,),
        )
        _write_commit(
            db, script_id=script_id, user_id=uid, kind="chapter_revert",
            message=f"撤销章节 #{chapter_index} 的改动",
            payload={"table": "script_chapters", "op": "revert",
                     "ids": {
                         "chapter_index": int(chapter_index),
                         "chapter_id": (prior or {}).get("chapter_id"),
                     },
                     "reverted_commit_id": commit_id,
                     "before": prior},
        )
        db.commit()
    return json_response({"ok": True, "chapter_index": int(chapter_index),
                          "reverted_commit_id": commit_id})


# 通用撤销:把世界书条目 / NPC 角色卡 恢复到最近一次 AI 改动之前(与章节撤销同款安全网,确定性、
# 作者主动触发)。依赖各写工具落 commit 时存了 payload.before + undoable。
_UNDO_SPEC = {
    "worldbook_entries": ("worldbook_edit", "entry_id"),
    "character_cards": ("card_edit", "card_id"),
}


@router.post("/api/scripts/{script_id}/undo-edit")
async def api_undo_edit(request: Request, script_id: int, user=Depends(require_user)):
    """撤销某世界书条目 / 角色卡最近一次可撤销的 AI 改动。body: {table, entity_id}。"""
    try:
        body = await request.json()
    except Exception:
        return json_response({"ok": False, "error": "body 必须是合法 JSON"}, status_code=400)
    table = str(body.get("table") or "")
    if table not in _UNDO_SPEC:
        return json_response({"ok": False, "error": "不支持的 table"}, status_code=400)
    try:
        entity_id = int(body.get("entity_id"))
    except (TypeError, ValueError):
        return json_response({"ok": False, "error": "entity_id 必填且为整数"}, status_code=400)
    kind, id_key = _UNDO_SPEC[table]
    uid = int(user["id"])
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        row = db.execute(
            """SELECT id, payload FROM script_commits
               WHERE script_id=%s AND kind=%s
                 AND coalesce((payload->>'undoable')::boolean, false) IS TRUE
                 AND coalesce((payload->>'undone')::boolean, false) IS FALSE
                 AND coalesce(payload->'ids'->>%s,'') = %s
               ORDER BY id DESC LIMIT 1""",
            (script_id, kind, id_key, str(entity_id)),
        ).fetchone()
        if not row:
            return json_response({"ok": False, "error": "没有可撤销的 AI 改动"}, status_code=404)
        before = ((row["payload"] or {}).get("before") or {})
        commit_id = int(row["id"])
        if not before:
            return json_response({"ok": False, "error": "该改动未存改前快照,无法撤销"}, status_code=409)

        if table == "worldbook_entries":
            sets, params = [], []
            for c in ("title", "content", "priority", "token_budget", "sticky_turns",
                      "cooldown_turns", "probability", "enabled", "insertion_position"):
                if c in before:
                    sets.append(f"{c}=%s")
                    params.append(before[c])
            for c in ("keys", "regex_keys", "character_filter", "scene_filter"):
                if c in before:
                    sets.append(f"{c}=%s")
                    params.append(Jsonb(before[c] or []))
            if sets:
                sets.append("updated_at=now()")
                params.extend([entity_id, script_id])
                db.execute(f"update worldbook_entries set {', '.join(sets)} "
                           f"where id=%s and script_id=%s", tuple(params))
        elif table == "character_cards":
            from platform_app.knowledge.character_cards import upsert_character_card
            upsert_character_card(uid, script_id, {**before, "id": entity_id})

        db.execute("UPDATE script_commits SET payload = jsonb_set(payload, '{undone}', 'true') WHERE id=%s",
                   (commit_id,))
        _write_commit(db, script_id=script_id, user_id=uid, kind=f"{kind}_revert",
                      message=f"撤销 {table} #{entity_id} 的改动",
                      payload={"table": table, "op": "revert", "ids": {id_key: entity_id},
                               "reverted_commit_id": commit_id})
        db.commit()
    return json_response({"ok": True, "table": table, "entity_id": entity_id,
                          "reverted_commit_id": commit_id})


# ─── checkout（stub）─────────────────────────────────────────────────────────

@router.post("/api/scripts/{script_id}/checkout/{commit_id}")
async def api_checkout_commit(
    script_id: int, commit_id: int, user=Depends(require_user)
):
    """回滚到指定 commit（TODO：回放 payload chain 还原历史状态）。

    当前实现为 stub，仅校验权限 + 返回 501。
    """
    with connect() as db:
        try:
            _require_owner(db, script_id, user["id"])
        except ValueError as exc:
            return value_error_response(exc, status_code=403)

        # 校验 commit 存在且属于该 script
        c = db.execute(
            "SELECT id, kind, created_at FROM script_commits WHERE id=%s AND script_id=%s",
            (commit_id, script_id),
        ).fetchone()
        if not c:
            return json_response({"ok": False, "error": "commit 不存在"}, status_code=404)

    return json_response(
        {
            "ok": False,
            "error": "checkout 尚未实现（TODO：回放 payload chain 还原历史状态）",
            "commit": dict(c),
        },
        status_code=501,
    )


@router.get("/api/scripts/{script_id}/chapters/{chapter_index}/history")
async def api_chapter_history(script_id: int, chapter_index: int, user=Depends(require_user)):
    """某章的 AI 改动历史(版本列表):每条 = commit_id + 时间 + 摘要 + 是否含改前快照(可恢复)。
    仅 owner(云端多用户隔离)。配合 restore 实现「版本浏览 + 回滚」。"""
    uid = int(user["id"])
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        # 当前 chapter_index 指向的稳定行 id。历史记录按 index 归属,但删除/拆分/合并/
        # 重切后 index 可能指向另一章:列表要过滤掉「明确记录了另一章 id」的旧记录,
        # 恢复时前端再把它带回做二次身份校验。
        current = db.execute(
            "SELECT id FROM script_chapters WHERE script_id=%s AND chapter_index=%s",
            (script_id, int(chapter_index)),
        ).fetchone()
        current_id = int(current["id"]) if current else None
        rows = db.execute(
            """SELECT id, kind, message, created_at,
                      coalesce((payload->>'undone')::boolean, false) AS undone,
                      -- has_before 收紧为「有正文快照」:超长正文不存 content(写入侧护栏)时,
                      -- 只有 title/volume_title 的记录点了恢复不会动正文 → 前端不该给按钮(假成功)。
                      (payload->'before'->>'content' IS NOT NULL) AS has_before,
                      -- source: 'editor'=编辑器手动保存(含合并的连续编辑),其余为 AI 改动。
                      -- save_count: 该条合并了几次保存(编辑器按编辑会话粒度合并;AI 恒 1)。
                      -- AI 旧记录无这两个字段 → 默认 'ai'/1,向后兼容。
                      coalesce(payload->>'source', 'ai') AS source,
                      coalesce((payload->>'save_count')::int, 1) AS save_count
               FROM script_commits
               WHERE script_id=%s AND kind IN ('chapter_edit','chapter_revert','chapter_add')
                 AND coalesce(payload->'ids'->>'chapter_index','') = %s
                 -- 新记录带稳定 chapter_id:与当前行不一致 = index 已被重排给另一章,
                 -- 不再展示(否则恢复旧快照会污染新章)。旧记录无该键(NULL)仍保留。
                 AND (payload->'ids'->>'chapter_id' IS NULL
                      OR payload->'ids'->>'chapter_id' = %s)
               ORDER BY id DESC LIMIT 100""",
            (script_id, str(chapter_index),
             str(current_id) if current_id is not None else None),
        ).fetchall()
    return json_response({"ok": True, "chapter_index": int(chapter_index),
                          "chapter_id": current_id,
                          "versions": [dict(r) for r in rows]})


@router.post("/api/scripts/{script_id}/chapters/{chapter_index}/restore")
async def api_chapter_restore(request: Request, script_id: int, chapter_index: int, user=Depends(require_user)):
    """把某章恢复到指定 commit 的【改前快照】(版本回滚)。body: {commit_id, base_chapter_id?}。仅 owner。
    与撤销同款安全网,但可回到历史任意一次改动之前,不止最近一次。

    base_chapter_id(可选,身份锁):前端从 /history 拿到的当前 chapter id。外部删除/拆分/
    合并/重切后 index 可能已指向另一章,与传入 id 不符时 409 structure_changed,拒绝把
    旧章快照写进另一章。不传=老前端,保持原行为。

    可逆:恢复前抓当前正文写进本条 chapter_revert 的快照,故「恢复」本身也能被再次
    「恢复到此前」退回(修复「点错了无法退回」)。目标可为 chapter_edit 或带快照的
    chapter_revert(revert 链);旧的、无快照的记录仍以 409 拒绝。"""
    uid = int(user["id"])
    try:
        body = await request.json()
        commit_id = int(body.get("commit_id"))
        raw_base_id = body.get("base_chapter_id")
        base_chapter_id = int(raw_base_id) if raw_base_id is not None else None
    except Exception:
        return json_response({"ok": False, "error": "commit_id 必填且为整数;base_chapter_id 若传须为整数"}, status_code=400)
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        row = db.execute(
            # 目标记录必须属于路径里的这一章:否则(commit id 可枚举,或历史因章号重排挂错)
            # 会把别的章的 before 写进本章。
            "SELECT payload FROM script_commits WHERE id=%s AND script_id=%s "
            "AND kind IN ('chapter_edit','chapter_revert') "
            "AND coalesce(payload->'ids'->>'chapter_index','') = %s",
            (commit_id, script_id, str(int(chapter_index))),
        ).fetchone()
        if not row:
            return json_response({"ok": False, "error": "找不到该版本"}, status_code=404)
        # 身份校验必须在挑选 before/写库之前:index 指向的行如果已经换了一章,
        # 这条历史记录就不再属于当前章节。
        current = db.execute(
            "SELECT id FROM script_chapters WHERE script_id=%s AND chapter_index=%s",
            (script_id, int(chapter_index)),
        ).fetchone()
        if not current:
            return json_response({"ok": False, "error": "章节不存在"}, status_code=404)
        current_id = int(current["id"])
        if base_chapter_id is not None and current_id != base_chapter_id:
            return json_response(
                {"ok": False, "structure_changed": True,
                 "error": "章节结构已变化:当前章节序号已指向另一章,已取消恢复;请关闭标签后重新打开",
                 "chapter_id": current_id},
                status_code=409)
        # 记录自身也带稳定 id(新记录才有):它在写入时属于另一章说明 index 已被重排
        # 给当前章,不能把旧章快照恢复进来。旧记录(NULL)保持兼容,由 base_chapter_id
        # 与当前行身份兜底。
        commit_cid = ((row.get("payload") or {}).get("ids") or {}).get("chapter_id")
        if commit_cid is not None:
            try:
                commit_cid = int(commit_cid)
            except (TypeError, ValueError):
                commit_cid = None
            if commit_cid is not None and commit_cid != current_id:
                return json_response(
                    {"ok": False, "structure_changed": True,
                     "error": "该历史版本属于另一章(章节已被重排),已取消恢复;请关闭标签后重新打开",
                     "chapter_id": current_id},
                    status_code=409)
        before = ((row["payload"] or {}).get("before") or {})
        if not before:
            return json_response({"ok": False, "error": "该版本未存改前快照,无法恢复"}, status_code=409)
        if before.get("content") is None:
            # 超长正文护栏(写入侧不存 content)→ 拒绝而非"只恢复标题":用户以为正文回退了、
            # 实际没动,是假成功。前端 /history 的 has_before 同步收紧,不会给按钮。
            return json_response(
                {"ok": False, "error": "该版本未存正文快照(正文过长未保存),无法恢复正文"}, status_code=409)
        # 恢复前抓当前正文 → 写进本条 revert 的快照,让「恢复」本身可逆。
        prior = _chapter_snapshot(db, script_id, chapter_index)
    from platform_app.script_import import ChapterStructureChanged, update_chapter
    bc = before.get("content")
    try:
        # 身份锁无条件传入(即使用户/老前端没带 base_chapter_id):读到 current_id
        # 后到真正写库之间仍可能被并发重排,update_chapter 会在同一条 UPDATE 的
        # WHERE 里复核 id,保证恢复快照不会落到另一章。
        update_chapter(
            uid, script_id, int(chapter_index),
            title=(str(before["title"]) if before.get("title") is not None else None),
            content=(str(bc) if bc is not None else None),
            volume_title=(str(before["volume_title"]) if before.get("volume_title") is not None else None),
            base_chapter_id=current_id,
        )
    except ChapterStructureChanged as conflict:
        return json_response(
            {"ok": False, "structure_changed": True,
             "error": "章节结构已变化:当前章节序号已指向另一章,已取消恢复;请关闭标签后重新打开",
             "server_chapter": conflict.server_chapter},
            status_code=409)
    except ValueError as exc:
        # 章节已被删除等 → 400 而非 500(既有代码未捕获,此处加固)。
        return value_error_response(exc)
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        _write_commit(db, script_id=script_id, user_id=uid, kind="chapter_revert",
                      message=f"恢复章节 #{chapter_index} 到版本 #{commit_id} 之前",
                      payload={"table": "script_chapters", "op": "revert",
                               "ids": {
                                   "chapter_index": int(chapter_index),
                                   "chapter_id": current_id,
                               },
                               "reverted_commit_id": commit_id,
                               "before": prior})
        db.commit()
    return json_response({"ok": True, "chapter_index": int(chapter_index), "restored_from": commit_id})


