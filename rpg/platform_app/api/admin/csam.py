"""platform_app.api.admin.csam —— 3.3 CSAM 举报管理端点。纯机械搬家,行为零变化。

依赖表 csam_reports(v37 迁移创建)。
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from ...db import connect
from .._deps import _client_ip, json_response
from ._shared import _require_admin, _write_audit, router


@router.get("/api/admin/csam/reports")
async def admin_csam_list(
    status: str = "pending",
    limit: int = 50,
    admin=Depends(_require_admin),
):
    limit = max(1, min(200, limit))
    with connect() as db:
        rows = db.execute(
            """
            select r.id, r.reporter_id, r.reported_user_id,
                   r.content_url, r.description, r.status,
                   r.decision, r.decision_notes, r.cybertip_report_id,
                   r.created_at, r.decided_at, r.decided_by,
                   u.username as reported_username
            from csam_reports r
            left join users u on u.id = r.reported_user_id
            where (%s = 'all' or r.status = %s)
            order by r.created_at desc
            limit %s
            """,
            (status, status, limit),
        ).fetchall()
    return json_response({"reports": [dict(r) for r in rows]})


@router.post("/api/admin/csam/reports")
async def admin_csam_create(
    request: Request,
    admin=Depends(_require_admin),
):
    """管理员代录举报：受理渠道(邮箱/表单/外部转达)进来的 CSAM 举报落库排队。

    reporter_id 置空 —— 举报人是站外方;reported_username 解析不到用户直接 400,防手误产生孤儿记录。
    """
    body = await request.json()
    ip = _client_ip(request)

    description = (body.get("description") or "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="description 不能为空")
    content_url = (body.get("content_url") or "").strip()
    reported_username = (body.get("reported_username") or "").strip()

    with connect() as db:
        reported_user_id = None
        if reported_username:
            u = db.execute(
                "select id from users where username = %s",
                (reported_username,),
            ).fetchone()
            if not u:
                raise HTTPException(status_code=400, detail=f"用户不存在: {reported_username}")
            reported_user_id = u["id"]

        row = db.execute(
            """
            insert into csam_reports
              (reporter_id, reported_user_id, content_url, description, status, created_at)
            values (null, %s, %s, %s, 'pending', now())
            returning id
            """,
            (reported_user_id, content_url, description),
        ).fetchone()
        report_id = row["id"] if row else None
        _write_audit(db, admin, "csam.report.create",
                     target_type="csam_report", target_id=str(report_id),
                     details={"reported_username": reported_username,
                              "content_url": content_url}, ip=ip)

    return json_response({"ok": True, "id": report_id})


@router.post("/api/admin/csam/reports/{report_id}/decision")
async def admin_csam_decision(
    request: Request,
    report_id: int,
    admin=Depends(_require_admin),
):
    body = await request.json()
    ip = _client_ip(request)
    decision = body.get("decision")
    notes = body.get("notes", "")
    cybertip_report_id = (body.get("cybertip_report_id") or "").strip()

    if decision not in ("founded", "unfounded", "escalate"):
        raise HTTPException(status_code=400, detail="decision 须为 founded|unfounded|escalate")

    with connect() as db:
        result = db.execute(
            """
            update csam_reports
            set decision = %s, decision_notes = %s, status = 'decided',
                cybertip_report_id = coalesce(nullif(%s, ''), cybertip_report_id),
                decided_at = now(), decided_by = %s
            where id = %s
            returning id, reported_user_id
            """,
            (decision, notes, cybertip_report_id, admin.get("id"), report_id),
        ).fetchone()
        if not result:
            raise HTTPException(status_code=404, detail="举报记录不存在")

        _write_audit(db, admin, f"csam.decision.{decision}",
                     target_type="csam_report", target_id=str(report_id),
                     details={"decision": decision, "notes": notes,
                              "cybertip_report_id": cybertip_report_id}, ip=ip)

    return json_response({"ok": True, "decision": decision})
