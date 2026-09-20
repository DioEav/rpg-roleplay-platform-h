"""platform_app.api.scripts.chapters —— 章节 CRUD + 结构操作端点。

章节列表/详情/编辑、新建空白剧本、追加/合并/删除/拆分章、整本重切。
纯机械搬家,行为零变化。
"""
from __future__ import annotations

import os
import hashlib
from datetime import datetime, timezone

from fastapi import Depends, Request

from ... import script_import
from ...db import connect
from .._deps import json_response, require_user, value_error_response
from ._shared import router
from core.logging import get_logger

log = get_logger(__name__)

# ── 章节编辑审计:写/合并 script_commits(kind=chapter_edit)─────────────────────
# AI 改章节走 tools_dsl 的写工具(自带 commit);作者在编辑器里手改此前完全没有记录
# → 章节「改动历史」列表永远为空。此处补写入侧。
# 粒度 = 编辑会话:同一章连续保存(自动保存每 2.5s 空闲一次 + Ctrl+S 任意次)在
# _CHAPTER_COMMIT_MERGE_MINUTES 窗口内合并为一条(只递增 save_count,不新增);
# 停手超过窗口再编辑 → 开新记录,before 是这段编辑开始前的版本。
# 设 0 = 关闭合并(每次保存各记一条;测试用)。
_CHAPTER_COMMIT_MERGE_MINUTES = int(os.environ.get("RPG_CHAPTER_COMMIT_MERGE_MINUTES", "10"))
# 快照护栏:超长正文不存 before.content(避免 commit jsonb 爆炸;与 AI 路径同口径)。
_MAX_COMMIT_SNAPSHOT_CHARS = 100_000


def _fetch_chapter_prior(script_id: int, chapter_index: int) -> dict | None:
    """落库前抓本章当前 title/content/volume_title(即改动前的版本)。失败返回 None。"""
    try:
        with connect() as db:
            row = db.execute(
                "select title, content, volume_title from script_chapters "
                "where script_id = %s and chapter_index = %s",
                (script_id, chapter_index),
            ).fetchone()
        return dict(row) if row else None
    except Exception as exc:  # noqa: BLE001 — 降级:该条记录不带快照,不影响正文保存
        log.warning(f"[chapters] 抓改前快照失败(该条记录将不带快照): {exc}")
        return None


def _content_hash(text) -> str:
    """正文指纹(16 位十六进制)。用于合并前校验「中间没有别的写入」,防止串章。"""
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()[:16]


def _within_merge_window(last_saved_iso, minutes: int) -> bool:
    """上一条记录的 last_saved_at 是否仍在合并窗口内(滑动窗口)。解析失败视为不在窗口内。"""
    if not last_saved_iso:
        return False
    try:
        ts = datetime.fromisoformat(str(last_saved_iso))
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts).total_seconds() < minutes * 60


def _record_chapter_edit_commit(*, script_id: int, user_id: int, chapter_index: int,
                                body: dict, prior: dict | None,
                                after_content=None) -> None:
    """编辑器保存章节 → 写/合并 chapter_edit 记录(编辑会话粒度)。

    失败静默(log.warning),绝不影响正文保存主流程 —— 与 AI 路径同款护栏。
    payload 与 AI 路径(tools_dsl/command_tools_script_write/chapters.py)对齐,
    另加 source/save_count/last_saved_at/after_hash 四字段供合并判定与历史列表展示。

    after_content: 本次保存后的正文(端点从 update_chapter 结果取)。合并前用它比对该记录
    上次保存后的指纹 —— 结构操作(合并/拆分/删除/整本重切)不写 commit 却会重排 chapter_index,
    少了这道校验就会把别的章的 before 快照并进本章 → 「恢复到此前」把别的章正文写进来。
    """
    try:
        changed = [k for k in ("title", "content", "volume_title") if body.get(k) is not None]
        if not changed:
            return
        from platform_app.api.script_edit import _write_commit
        from platform_app.perms import script_owned

        before_content = str((prior or {}).get("content") or "")
        snapshot_ok = bool(prior) and len(before_content) <= _MAX_COMMIT_SNAPSHOT_CHARS
        # 拿不到 after 时退回 prior(等价于"不合并",安全方向;最多多几条记录,不会串章)。
        prior_hash = _content_hash(before_content)
        after_hash = _content_hash(after_content if after_content is not None else before_content)
        now_iso = datetime.now(timezone.utc).isoformat()
        with connect() as db:
            if not script_owned(db, script_id, user_id):
                return
            # 编辑会话合并:该章【最后一条】记录必须就是本人在窗口内的 editor 记录,且
            # 正文指纹连续(本次保存前的正文 == 它上次保存后的正文),才合并(只递增计数)。
            # 任何插进来的记录 —— AI 改写/新增、撤销/恢复、他人的编辑 —— 都打断会话;
            # 不走 commit 的正文写入(结构操作换章等)由 after_hash 兜住。
            if _CHAPTER_COMMIT_MERGE_MINUTES > 0:
                row = db.execute(
                    """select id, kind, author_user_id,
                              coalesce(payload->>'source', '') as source,
                              coalesce(payload->>'after_hash', '') as after_hash,
                              payload->>'last_saved_at' as last_saved
                       from script_commits
                       where script_id = %s
                         and coalesce(payload->'ids'->>'chapter_index', '') = %s
                       order by id desc limit 1""",
                    (script_id, str(chapter_index)),
                ).fetchone()
                if (row
                        and row["kind"] == "chapter_edit"
                        and row["source"] == "editor"
                        and int(row["author_user_id"] or 0) == int(user_id)
                        and row["after_hash"] == prior_hash
                        and _within_merge_window(row["last_saved"], _CHAPTER_COMMIT_MERGE_MINUTES)):
                    cur = db.execute(
                        """update script_commits set payload = jsonb_set(
                             jsonb_set(
                               jsonb_set(payload, '{save_count}',
                                         to_jsonb(coalesce((payload->>'save_count')::int, 1) + 1)),
                               '{last_saved_at}', to_jsonb(%s::text)),
                             '{after_hash}', to_jsonb(%s::text))
                           where id = %s""",
                        (now_iso, after_hash, int(row["id"])),
                    )
                    if cur.rowcount:
                        db.commit()
                        return
                    # 影响 0 行(记录刚被并发删除等)→ 回滚后落回新写,别让这次保存完全没审计。
                    db.rollback()
            _write_commit(
                db, script_id=script_id, user_id=user_id,
                kind="chapter_edit",
                message=f"手动编辑章节 #{chapter_index}",
                payload={
                    "table": "script_chapters", "op": "edit",
                    "ids": {"chapter_index": int(chapter_index)},
                    "fields": changed,
                    "before": {
                        "title": (prior or {}).get("title"),
                        "content": before_content if snapshot_ok else None,
                        "volume_title": (prior or {}).get("volume_title"),
                    } if prior else None,
                    # undoable 恒 False:该闸门只服务 /undo(AI 改动的「撤销」按钮),
                    # 手动编辑走编辑器自带 ⌘Z;/restore(恢复到此前)另走 before 非空闸。
                    "undoable": False,
                    "is_new": prior is None,
                    "source": "editor",
                    "save_count": 1,
                    "last_saved_at": now_iso,
                    "after_hash": after_hash,
                },
            )
            db.commit()
    except Exception as exc:  # noqa: BLE001 — 审计失败不影响正文保存
        log.warning(f"[chapters] 章节改动记录写入失败(正文已保存): {exc}")


@router.get("/api/scripts/{script_id}/chapters")
async def api_script_chapters(
    script_id: int,
    limit: int | None = None, cursor: str | None = None, q: str | None = None,
    user=Depends(require_user),
):
    """章节列表，支持 ?q=... 标题/内容全文 ILIKE 搜索。"""
    try:
        if q:
            # 全文搜索分支 — 权限与非搜索路径一致:owner ∪ subscriber
            with connect() as db:
                owned = db.execute(
                    """select 1 from scripts s where s.id = %s and (
                         s.owner_id = %s
                         or s.id in (select script_id from user_script_subscriptions where user_id = %s)
                       )""",
                    (script_id, user["id"], user["id"]),
                ).fetchone()
                if not owned:
                    return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
                rows = db.execute(
                    """
                    select id, chapter_index, title, volume_title, word_count,
                           substring(content for 200) as preview
                    from script_chapters
                    where script_id = %s and (title ilike %s or content ilike %s)
                    order by chapter_index limit %s
                    """,
                    (script_id, f"%{q}%", f"%{q}%", int(limit or 50)),
                ).fetchall()
            from ...db import expose as _expose
            return json_response({"ok": True, "items": [_expose(r) for r in rows], "query": q})
        return json_response({"ok": True, **script_import.list_chapters(user["id"], script_id, limit, cursor)})
    except ValueError as exc:
        return value_error_response(exc)


@router.get("/api/scripts/{script_id}/chapters/{chapter_index:int}")
async def api_chapter_detail(script_id: int, chapter_index: int, user=Depends(require_user)):
    """单章节完整 content(列表 API 只返 180 字符 preview,这里是 lazy fetch 真章节正文)。"""
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
            """
            select id, public_id, chapter_index, title, volume_title,
                   word_count, content, created_at, updated_at
            from script_chapters
            where script_id = %s and chapter_index = %s
            """,
            (script_id, chapter_index),
        ).fetchone()
    if not row:
        return json_response({"ok": False, "error": "章节不存在"}, status_code=404)
    from ...db import expose as _expose
    return json_response({"ok": True, "chapter": _expose(row)})


@router.post("/api/scripts/{script_id}/chapters/{chapter_index:int}")
async def api_chapter_update(request: Request, script_id: int, chapter_index: int, user=Depends(require_user)):
    """编辑单章 title/content/volume_title。

    body.base_updated_at(可选,乐观锁):与服务端 updated_at 不一致时 409+服务端当前版本,
    前端转三方合并(编辑器 P0:AI 写库与未保存改动互相静默覆盖)。不传=覆盖语义不变。

    落库成功后写一条 chapter_edit 审计(编辑会话粒度,见 _record_chapter_edit_commit);
    审计写入失败不影响本次保存。"""
    body = await request.json()
    # 改前快照必须在落库前抓:合并窗口内 before 始终是"这段编辑开始前"的版本。
    prior = _fetch_chapter_prior(script_id, chapter_index)
    try:
        result = script_import.update_chapter(
            user["id"], script_id, chapter_index,
            title=body.get("title"), content=body.get("content"),
            volume_title=body.get("volume_title"),
            base_updated_at=body.get("base_updated_at"),
        )
    except script_import.ChapterConflict as conflict:
        # 冲突时正文未落库 → 不写审计(用户会走三方合并后重新保存)。
        return json_response(
            {"ok": False, "conflict": True, "error": "章节已被他方更新",
             "server_chapter": conflict.server_chapter},
            status_code=409)
    except ValueError as exc:
        return value_error_response(exc)
    _record_chapter_edit_commit(
        script_id=script_id, user_id=int(user["id"]),
        chapter_index=chapter_index, body=body, prior=prior,
        # 保存后的正文 → 写进记录的 after_hash,供下次合并前校验"中间没有别的写入"(防串章)。
        after_content=((result or {}).get("chapter") or {}).get("content"),
    )
    return json_response(result)


@router.post("/api/scripts/blank")
async def api_create_blank_script(request: Request, user=Depends(require_user)):
    """作者优先:从零新建空白剧本(含第1章空章),供作者直接写、用选区提取边写边建 KB。返回 script_id。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return json_response(script_import.create_blank_script(user["id"], (body or {}).get("title") or ""))
    except ValueError as exc:
        return value_error_response(exc)


@router.post("/api/scripts/{script_id}/add-chapter")
async def api_add_chapter(request: Request, script_id: int, user=Depends(require_user)):
    """作者优先:给剧本追加一个空白新章(owner 闸)。返回 chapter_index。
    路径用 add-chapter 而非 chapters/new,避免与 /chapters/{chapter_index:int} 冲突。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return json_response(script_import.create_chapter(user["id"], script_id, (body or {}).get("title") or ""))
    except ValueError as exc:
        return value_error_response(exc)


@router.post("/api/scripts/{script_id}/chapters/merge")
async def api_chapter_merge(request: Request, script_id: int, user=Depends(require_user)):
    """合并 first_index 与其相邻下一章(second_index 显式指定,缺省取按序的下一章)。"""
    body = await request.json()
    try:
        _second = body.get("second_index")
        _keep = body.get("keep_title_index")
        return json_response(script_import.merge_chapters(
            user["id"], script_id, int(body.get("first_index") or 0),
            second_index=(int(_second) if _second is not None else None),
            keep_title_index=(int(_keep) if _keep is not None else None),
            separator=body.get("separator") or "\n\n",
        ))
    except ValueError as exc:
        return value_error_response(exc)


@router.post("/api/scripts/{script_id}/chapters/delete")
async def api_chapters_delete(request: Request, script_id: int, user=Depends(require_user)):
    """删除一批章节并整本重排(body: {indexes:[...]} 或 {chapter_index:n})。

    结构操作:RAG(按 chapter_index 的外键)与 merge/split 一致,需重新提取才能完全对齐。
    """
    body = await request.json()
    idxs = body.get("indexes")
    if idxs is None and body.get("chapter_index") is not None:
        idxs = [body.get("chapter_index")]
    try:
        return json_response(script_import.delete_chapters(
            user["id"], script_id, [int(i) for i in (idxs or [])],
        ))
    except (ValueError, TypeError) as exc:
        return json_response({"ok": False, "error": str(exc)}, status_code=400)


@router.post("/api/scripts/{script_id}/chapters/{chapter_index:int}/split")
async def api_chapter_split(request: Request, script_id: int, chapter_index: int, user=Depends(require_user)):
    """按字符位置 split_at 把一章拆成两章。"""
    body = await request.json()
    try:
        return json_response(script_import.split_chapter(
            user["id"], script_id, chapter_index,
            split_at=int(body.get("split_at") or 0),
            new_title=body.get("new_title") or "",
        ))
    except ValueError as exc:
        return value_error_response(exc)


@router.post("/api/scripts/{script_id}/resplit")
async def api_script_resplit(request: Request, script_id: int, user=Depends(require_user)):
    """用新规则重切已导入剧本。保留 script + 存档，只换章节。"""
    body = await request.json()
    try:
        return json_response(script_import.resplit_script(
            user["id"], script_id,
            split_rule=body.get("split_rule", "auto"),
            custom_pattern=body.get("custom_pattern", ""),
        ))
    except ValueError as exc:
        return value_error_response(exc)
