"""memory.py — 记忆管理路由。

包含：
  POST /api/memory/add    — 添加记忆条目
  POST /api/memory/remove — 删除记忆条目
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from platform_app.api._deps import json_response
from routes._deps_fastapi import get_current_user
from schemas._common import COMMON_ERROR_RESPONSES, StateResponse
from schemas.memory import (
    MemoryAddRequest,
    MemoryRemoveRequest,
    MemoryRestoreRequest,
    MemorySettingsOverrideRequest,
    MemoryUpdateRequest,
)

router = APIRouter()


@router.post("/api/memory/add", response_model=StateResponse, responses=COMMON_ERROR_RESPONSES)
async def api_memory_add(
    body: MemoryAddRequest,
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """task 87 Phase 6: 走 dispatcher 的 add_memory_* 工具系列。"""
    from app import (
        _ensure_loaded,
        _payload,
        _persist_runtime_checkpoint,
        _resolve_persist_target,
    )
    body_dict = body.model_dump(exclude_none=True)
    state = _ensure_loaded(api_user)
    bucket = body_dict.get("bucket", "notes")
    text = body_dict.get("text", "")

    # A6: pinned_max 校验 — 添加 pinned 条目时检查上限
    if bucket == "pinned" and api_user:
        from platform_app.settings import get_effective_memory_settings
        ms = get_effective_memory_settings(
            int(api_user.get("id", 0)), state.data)
        current_pinned = state.data.get("memory", {}).get("pinned", [])
        if len(current_pinned) >= ms.pinned_max:
            return json_response(
                {
                    "ok": False,
                    "error": f"固定记忆已达上限 {ms.pinned_max} 条，请先删除旧条目再添加",
                },
                status_code=400,
            )

    # bucket → 对应工具名
    bucket_tool = {
        "facts": "add_memory_fact",
        "resources": "add_memory_resource",
        "abilities": "add_memory_ability",
        "pinned": "pin_memory",
        "notes": "add_memory_note",
    }.get(bucket, "add_memory_note")
    from tools_dsl.ui_dispatch_helper import dispatch_ui_tool
    result = dispatch_ui_tool(
        tool_name=bucket_tool,
        args={"text": text},
        user_id=int(api_user.get("id")) if api_user else 0,
        save_id=_resolve_persist_target(api_user)[1] or 0,
        state=state,
    )
    if not result.ok:
        return json_response({"ok": False, "error": result.error}, status_code=400)
    state.save()
    _persist_runtime_checkpoint(state, api_user)
    return json_response({"ok": True, "state": _payload(api_user)})


@router.post("/api/memory/update", response_model=StateResponse, responses=COMMON_ERROR_RESPONSES)
async def api_memory_update(
    body: MemoryUpdateRequest,
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """就地编辑一条玩家记忆/笔记(原来只能删了重加 —— 群反馈 行者无疆「玩家日记直接编辑」)。
    只动玩家可手编的桶(notes/pinned/facts/resources/abilities),按 index 替换该条文本。"""
    from app import _ensure_loaded, _payload, _persist_runtime_checkpoint
    body_dict = body.model_dump(exclude_none=True)
    bucket = body_dict.get("bucket", "notes")
    index = body_dict.get("index")
    text = (body_dict.get("text") or "").strip()
    if index is None or not isinstance(index, int) or index < 0:
        return json_response({"ok": False, "error": "index 必须是非负整数"}, status_code=400)
    if not text:
        return json_response({"ok": False, "error": "内容不能为空"}, status_code=400)
    if bucket not in {"notes", "pinned", "facts", "resources", "abilities"}:
        return json_response({"ok": False, "error": "该记忆桶不支持编辑"}, status_code=400)
    state = _ensure_loaded(api_user)
    items = state.data.setdefault("memory", {}).setdefault(bucket, [])
    if index >= len(items):
        return json_response({"ok": False, "error": "条目不存在(可能已被修改,请刷新)"}, status_code=400)
    if not isinstance(items[index], str):
        return json_response({"ok": False, "error": "该条目不是可编辑的文本"}, status_code=400)
    # 同步 legacy bucket + 结构化 items(否则 GM 上下文只读 items、看到旧文本)。
    if not state.edit_memory(bucket, index, text):
        return json_response({"ok": False, "error": "编辑失败"}, status_code=400)
    state.save()
    _persist_runtime_checkpoint(state, api_user)
    return json_response({"ok": True, "state": _payload(api_user)})


@router.post("/api/memory/remove", response_model=StateResponse, responses=COMMON_ERROR_RESPONSES)
async def api_memory_remove(
    body: MemoryRemoveRequest,
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """task 87 Phase 6: destructive 走 dispatcher remove_memory_item 工具。"""
    from app import (
        _ensure_loaded,
        _payload,
        _persist_runtime_checkpoint,
        _resolve_persist_target,
    )
    body_dict = body.model_dump(exclude_none=True)
    index = body_dict.get("index")
    if index is None or (isinstance(index, int) and index < 0):
        return json_response({"ok": False, "error": "index 必须是非负整数"}, status_code=400)
    state = _ensure_loaded(api_user)
    from tools_dsl.ui_dispatch_helper import dispatch_ui_tool
    result = dispatch_ui_tool(
        tool_name="remove_memory_item",
        args={
            "bucket": body_dict.get("bucket", "notes"),
            "index": int(index),
        },
        user_id=int(api_user.get("id")) if api_user else 0,
        save_id=_resolve_persist_target(api_user)[1] or 0,
        state=state,
    )
    if not result.ok:
        return json_response({"ok": False, "error": result.error}, status_code=400)
    state.save()
    _persist_runtime_checkpoint(state, api_user)
    return json_response({"ok": True, "state": _payload(api_user)})


@router.post("/api/memory/restore", response_model=StateResponse, responses=COMMON_ERROR_RESPONSES)
async def api_memory_restore(
    body: MemoryRestoreRequest,
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """恢复一条已归档/已取代/孤立的事实（本次记忆修复）。

    记忆面板的「历史记忆」用它把旧条目重新放回 facts 桶并标 active；只允许
    legacy 桶的 runtime_fact（推测确认链不从面板恢复，避免把废案当事实）。
    """
    from app import _ensure_loaded, _payload, _persist_runtime_checkpoint

    state = _ensure_loaded(api_user)
    ok, info = state.restore_memory_item_ex(
        item_id=(body.id or "").strip() or None,
        bucket=(body.bucket or "").strip() or None,
        text=body.text,
        source="ui_restore",
        supersede_conflicts=bool(body.supersede_conflicts),
    )
    if not ok:
        if info.get("needs_confirmation"):
            # 200 而不是 4xx：前端需要拿到冲突列表并弹二次确认，不是错误。
            return json_response({
                "ok": False,
                "needs_confirmation": True,
                "target": info.get("target"),
                "conflicts": info.get("conflicts") or [],
            })
        return json_response(
            {"ok": False, "error": info.get("error") or "未找到可恢复的记忆"},
            status_code=400,
        )
    state.save()
    _persist_runtime_checkpoint(state, api_user)
    return json_response({
        "ok": True,
        "state": _payload(api_user),
        "restored": info.get("restored"),
        "superseded_conflicts": info.get("superseded_conflicts", 0),
    })


@router.get("/api/memory/history")
async def api_memory_history(
    query: str = "",
    status: str = "",
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """历史记忆分页（本次记忆修复）：热归档 + KB 冷归档统一返回。

    UI 的历史面板用它搜索/翻页；`has_more` 只表示“本页可能还有下一页”，
    冷数据总数不做全表 count（长局代价高）。返回结构是对象，和 GM 的
    query_memory 数组契约分开，互不影响。
    """
    from app import _ensure_loaded
    from tools_dsl.command_tools_queries import _t_query_memory

    state = _ensure_loaded(api_user)
    args: dict[str, Any] = {
        "query": query or "",
        "scope": "archived",
        "offset": int(offset),
        "limit": int(limit),
    }
    if status in {"active", "superseded", "orphaned", "rejected", "archived"}:
        args["status"] = status
    raw = _t_query_memory(state, args)
    try:
        items = json.loads(raw) if str(raw).lstrip().startswith("[") else []
    except Exception:
        items = []
    cold_total = 0
    try:
        sid = int((state.data or {}).get("_active_save_id") or 0)
        if sid:
            from kb.save_kb import count_archived_cold
            from platform_app.db import connect
            with connect() as db:
                row = db.execute(
                    "select active_commit_id from game_saves where id=%s", (sid,)
                ).fetchone()
            commit = int((row or {}).get("active_commit_id") or 0)
            cold_total = count_archived_cold(sid, commit)
    except Exception:
        cold_total = 0
    return json_response({
        "ok": True,
        "items": items,
        "offset": int(offset),
        "limit": int(limit),
        "has_more": len(items) >= int(limit),
        "cold_total": cold_total,
    })


@router.get("/api/memory/settings")
async def api_memory_settings_get(
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """读取全局记忆设置 + 本存档 override + 合并后的有效值（本次记忆修复）。

    前端 PanelMemory 用 effective 回显当前生效配置，用 overrides 判断哪些字段
    是本存档改过的；空 overrides = 全部跟随全局。
    """
    from app import _ensure_loaded
    from platform_app.settings import get_effective_memory_settings, get_memory_settings
    from schemas.memory import MemorySettings

    state = _ensure_loaded(api_user)
    uid = int(api_user.get("id") or 0) if api_user else 0
    overrides = dict(state.data.get("memory_settings") or {})
    global_ms = get_memory_settings(uid) if uid else MemorySettings()
    effective = get_effective_memory_settings(uid or None, state.data)
    return json_response({
        "ok": True,
        "global": global_ms.model_dump(),
        "overrides": overrides,
        "effective": effective.model_dump(),
    })


@router.post("/api/memory/settings")
async def api_memory_settings_set(
    body: MemorySettingsOverrideRequest,
    api_user: dict[str, Any] | None = Depends(get_current_user),
) -> JSONResponse:
    """写入/清空本存档记忆设置 override。

    settings 只保存显式改过的合法字段（逐字段校验）；unset 把指定字段恢复为跟随
    全局；reset=True 清空全部 override。非法值不再静默丢弃，而是在 errors 里回给
    前端（合法字段仍会保存，避免用户改 5 项只因 1 项非法就全丢）。
    持久化走 state.save + _persist_runtime_checkpoint（与固定记忆 out-of-turn 编辑同款），
    跨 worker 通过 snapshot_hash 失效生效。
    """
    from app import _ensure_loaded, _persist_runtime_checkpoint
    from platform_app.settings import (
        get_effective_memory_settings,
        validate_memory_settings_patch_with_errors,
    )
    from schemas.memory import MemorySettings

    state = _ensure_loaded(api_user)
    errors: dict[str, str] = {}
    if body.reset:
        state.data["memory_settings"] = {}
    else:
        current = dict(state.data.get("memory_settings") or {})
        # 逐字段恢复跟随全局：只允许删已知字段，未知 key 忽略（不把脏 key 写回去）。
        for key in (body.unset or []):
            if isinstance(key, str) and key in MemorySettings.model_fields:
                current.pop(key, None)
        clean, errors = validate_memory_settings_patch_with_errors(body.settings or {})
        current.update(clean)
        state.data["memory_settings"] = current
    state.save()
    _persist_runtime_checkpoint(state, api_user)
    uid = int(api_user.get("id") or 0) if api_user else 0
    effective = get_effective_memory_settings(uid or None, state.data)
    return json_response({
        "ok": True,
        "overrides": dict(state.data.get("memory_settings") or {}),
        "effective": effective.model_dump(),
        # 空 dict = 全部合法；非空时 UI 应提示具体字段，不能假装保存成功。
        "errors": errors,
    })
