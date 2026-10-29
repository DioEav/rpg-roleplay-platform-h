"""platform_app.frontend_routes.saves —— SAVES 补充路由(/api/saves/{save_id}/*)。

原单文件「SAVES supplements」段逐端点搬运,零行为变化:
删除 / 改名 / 激活(切 runtime + 清 ui 缓存)/ 导出为 JSON。
"""
from __future__ import annotations

import io
import json
from datetime import datetime

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from ..api import json_response, require_user
from ..db import connect, init_db
from ..perms import owns_save
from ._shared import _bad, router


# ------------------------------------------------------------
#  SAVES supplements
# ------------------------------------------------------------
@router.post("/api/saves/{save_id}/delete")
async def api_save_delete(save_id: int, request: Request):
    user = require_user(request)
    init_db()
    with connect() as db:
        if not owns_save(db, save_id, user["id"]):
            return _bad("无权操作该存档", 403)
        db.execute("delete from game_saves where id = %s and user_id = %s", (save_id, user["id"]))
    return json_response({"ok": True})


@router.post("/api/saves/{save_id}/rename")
async def api_save_rename(save_id: int, request: Request):
    user = require_user(request)
    body = await request.json()
    title = (body.get("title") or "").strip()
    if not title:
        return _bad("标题不能为空")
    init_db()
    with connect() as db:
        if not owns_save(db, save_id, user["id"]):
            return _bad("无权操作该存档", 403)
        db.execute(
            "update game_saves set title = %s, updated_at = now() where id = %s",
            (title, save_id),
        )
    return json_response({"ok": True, "title": title})


@router.post("/api/saves/{save_id}/activate")
async def api_save_activate(save_id: int, request: Request):
    """task 30：之前只 select 1 验证归属就返 ok=True，既不写 user_runtime，
    也不清 ui._state_by_user 缓存 → 用户点完「继续」跳到 Game Console，
    GET /api/state 拿到的是上一个 active save 的 player/world。

    现在：调用 branches.activate_save → runtime.activate_state_snapshot
    把 user_runtime 切到目标 save 的 active commit；并清掉 ui 进程内 state 缓存，
    下一次 _ensure_loaded 会从 user_runtime 重新加载新 save 的 state。"""
    user = require_user(request)
    from .. import branches as _branches
    try:
        result = _branches.activate_save(user["id"], save_id)
    except ValueError as exc:
        return _bad(str(exc), 403)
    # 清 ui 模块内的 per-user state 缓存（跨模块耦合：ui 在主进程内长期持有 cache，
    # activate 必须告诉它丢掉旧 save 的 state，否则 GET /api/state 仍读旧档）。
    try:
        import app as _ui
        _ui._invalidate_user_cache(user)
    except Exception:
        pass
    # 广播 saves 变更:平台页可能正开着存档目录(另一个标签),不通知就要手动刷新
    # 才能看到「最后游玩」排序/当前档标记更新。与 api/saves.py 的 branch 激活路径一致。
    try:
        from ..api.saves import _emit_saves_changed
        _emit_saves_changed(user["id"], "activate", (result or {}).get("active_save_id"))
    except Exception:
        pass
    return json_response(result)


@router.get("/api/saves/{save_id}/export")
async def api_save_export(save_id: int, request: Request):
    user = require_user(request)
    init_db()
    with connect() as db:
        # 归属判定收敛到 perms.owns_save;不属返 404(沿用原契约,不暴露存在性)。
        if not owns_save(db, save_id, user["id"]):
            raise HTTPException(404)
        row = db.execute(
            "select id, title, state_snapshot, created_at, updated_at from game_saves where id = %s",
            (save_id,),
        ).fetchone()
    if not row:
        raise HTTPException(404)
    payload = {
        "id": row["id"],
        "title": row["title"],
        "exported_at": datetime.now().isoformat(),
        "state": row["state_snapshot"],
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    safe_title = (row["title"] or f"save-{save_id}").replace("/", "_")
    return StreamingResponse(
        io.BytesIO(body.encode("utf-8")),
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_title}.json"'},
    )
