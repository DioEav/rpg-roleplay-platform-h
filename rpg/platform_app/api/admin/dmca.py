"""platform_app.api.admin.dmca —— 3.1 DMCA 下架队列 + 3.2 DMCA Strike 管理端点。纯机械搬家,行为零变化。

依赖表 dmca_takedowns / dmca_strikes(v37 迁移创建)。
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from ...db import connect
from ...dmca import DMCA_STRIKE_THRESHOLD, increment_strike, queue_account_termination
from .._card_dto import _iso
from .._deps import _client_ip, json_response
from ._shared import _require_admin, _write_audit, router


@router.get("/api/admin/dmca/takedowns")
async def admin_dmca_list(
    status: str = "open",
    limit: int = 50,
    admin=Depends(_require_admin),
):
    limit = max(1, min(200, limit))
    with connect() as db:
        rows = db.execute(
            """
            select id, complainant_name, complainant_email, infringing_url,
                   original_work_desc, status, notes,
                   counter_received_at, restore_after,
                   created_at, actioned_at, actioned_by
            from dmca_takedowns
            where (%s = 'all' or status = %s)
            order by created_at desc
            limit %s
            """,
            (status, status, limit),
        ).fetchall()
    return json_response({"takedowns": [dict(r) for r in rows]})


@router.post("/api/admin/dmca/takedowns")
async def admin_dmca_create(
    request: Request,
    admin=Depends(_require_admin),
):
    body = await request.json()
    ip = _client_ip(request)

    required = ("complainant_name", "complainant_email", "infringing_url")
    for f in required:
        if not body.get(f):
            raise HTTPException(status_code=400, detail=f"缺少必填字段: {f}")

    with connect() as db:
        row = db.execute(
            """
            insert into dmca_takedowns
              (complainant_name, complainant_email, infringing_url,
               original_work_desc, status, created_by, created_at)
            values (%s, %s, %s, %s, 'open', %s, now())
            returning id
            """,
            (
                body["complainant_name"],
                body["complainant_email"],
                body["infringing_url"],
                body.get("original_work_desc", ""),
                admin.get("id"),
            ),
        ).fetchone()
        takedown_id = row["id"] if row else None
        _write_audit(db, admin, "dmca.takedown.create",
                     target_type="dmca_takedown", target_id=str(takedown_id),
                     details=body, ip=ip)

    return json_response({"ok": True, "id": takedown_id})


@router.post("/api/admin/dmca/takedowns/{takedown_id}/action")
async def admin_dmca_action(
    request: Request,
    takedown_id: int,
    admin=Depends(_require_admin),
):
    body = await request.json()
    ip = _client_ip(request)
    action = body.get("action")
    reason = body.get("reason", "")

    if action not in ("takedown", "restore", "reject"):
        raise HTTPException(status_code=400, detail="action 须为 takedown|restore|reject")

    status_map = {"takedown": "closed", "restore": "restored", "reject": "rejected"}
    new_status = status_map[action]

    with connect() as db:
        result = db.execute(
            """
            update dmca_takedowns
            set status = %s, notes = coalesce(notes,'') || %s,
                actioned_at = now(), actioned_by = %s
            where id = %s
            returning id
            """,
            (new_status, f"\n[{action}] {reason}", admin.get("id"), takedown_id),
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="下架记录不存在")
        _write_audit(db, admin, f"dmca.takedown.{action}",
                     target_type="dmca_takedown", target_id=str(takedown_id),
                     details={"reason": reason, "new_status": new_status}, ip=ip)

    return json_response({"ok": True, "status": new_status})


@router.post("/api/admin/dmca/takedowns/{takedown_id}/counter")
async def admin_dmca_counter(
    request: Request,
    takedown_id: int,
    admin=Depends(_require_admin),
):
    """录入反通知，自动计算 10 天后可恢复时间。"""
    body = await request.json()
    ip = _client_ip(request)

    with connect() as db:
        result = db.execute(
            """
            update dmca_takedowns
            set counter_received_at = now(),
                restore_after = now() + interval '10 days',
                notes = coalesce(notes,'') || %s,
                status = 'counter_received'
            where id = %s
            returning id, restore_after
            """,
            (f"\n[counter-notice] {body.get('notes', '')}", takedown_id),
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="下架记录不存在")
        _write_audit(db, admin, "dmca.takedown.counter_notice",
                     target_type="dmca_takedown", target_id=str(takedown_id),
                     details=body, ip=ip)

    return json_response({"ok": True, "restore_after": _iso(result["restore_after"])})


@router.get("/api/admin/dmca/strikes")
async def admin_dmca_strikes_list(
    admin=Depends(_require_admin),
):
    with connect() as db:
        # dmca_strikes 是「每用户一行」的聚合表(strike_count + 最近一次信息),不是逐条日志。
        # 原查询按逐条日志取 ds.id/ds.reason/ds.created_at → 列不存在 500。改读聚合列。
        rows = db.execute(
            """
            select ds.user_id, u.username, ds.strike_count,
                   ds.last_strike_at, ds.last_strike_reason, ds.terminated_at
            from dmca_strikes ds
            join users u on u.id = ds.user_id
            where ds.strike_count > 0
            order by ds.last_strike_at desc nulls last
            limit 200
            """,
        ).fetchall()

        # 逐条 strike 历史从审计日志还原(每次 +Strike / 自动终止都留有 audit 行)。
        audit_rows = db.execute(
            """
            select target_id, action, details, created_at
            from admin_audit_log
            where target_type = 'user'
              and action in ('dmca.strike.increment', 'dmca.auto_terminate')
            order by created_at desc
            limit 2000
            """
        ).fetchall()
    history: dict = {}
    for a in audit_rows:
        history.setdefault(a["target_id"], []).append({
            "reason": (a.get("details") or {}).get("reason", ""),
            "created_at": _iso(a.get("created_at")),
            "terminate": a["action"] == "dmca.auto_terminate",
        })

    users = [{
        "user_id": r["user_id"],
        "username": r["username"],
        "strike_count": r["strike_count"],
        "last_strike_at": _iso(r.get("last_strike_at")),
        "last_strike_reason": r.get("last_strike_reason") or "",
        "terminated_at": _iso(r.get("terminated_at")),
        "strikes": history.get(str(r["user_id"]), []),
    } for r in rows]
    return json_response({"users": users, "threshold": DMCA_STRIKE_THRESHOLD})


@router.post("/api/admin/dmca/strikes/{user_id}/increment")
async def admin_dmca_strike_increment(
    request: Request,
    user_id: int,
    admin=Depends(_require_admin),
):
    body = await request.json()
    ip = _client_ip(request)
    reason = body.get("reason", "")
    if not reason:
        raise HTTPException(status_code=400, detail="reason 不能为空")

    with connect() as db:
        result = increment_strike(db, user_id, reason)

        _write_audit(db, admin, "dmca.strike.increment",
                     target_type="user", target_id=str(user_id),
                     details={"reason": reason, "strike_count": result["strike_count"]}, ip=ip)

        if result["terminate"]:
            terminate_reason = (
                f"DMCA 累犯 {result['strike_count']} 次，已达终止阈值。最近原因: {reason}"
            )
            queue_account_termination(db, user_id, terminate_reason)
            _write_audit(db, admin, "dmca.auto_terminate",
                         target_type="user", target_id=str(user_id),
                         details={"strike_count": result["strike_count"], "reason": terminate_reason},
                         ip=ip)

    return json_response(result)
