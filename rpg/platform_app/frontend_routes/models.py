"""platform_app.frontend_routes.models —— MODELS 补充路由(可见性 & 校验)。

原单文件「MODELS supplements」段逐端点搬运,零行为变化:
/api/models/visibility(admin 全局)/ /api/me/models/visibility(每用户 overlay)/
/api/models/validate(凭据探测)。
"""
from __future__ import annotations

from fastapi import Request

from ..api import json_response, require_user
from ..api._deps import is_admin
from ._shared import _bad, router


# ------------------------------------------------------------
#  MODELS supplements (visibility & validate)
# ------------------------------------------------------------
@router.post("/api/models/visibility")
async def api_models_visibility(request: Request):
    """Toggle visibility flags for individual models.

    Writes through upsert_model so DB + JSON catalog stay in sync.
    Previously wrote only to model_entries.enabled, which diverged from the
    catalog JSON on restart when DB was unavailable.
    """
    # 全局模型目录写操作:与同级 /api/models/* 一致,须管理员(CWE-862)。
    user = require_user(request)
    if not is_admin(user):
        return _bad("需要管理员权限", status=403)
    body = await request.json() or {}
    api_id = body.get("api_id") or body.get("api")
    model_real_name = body.get("model") or body.get("real_name")
    visible = body.get("visible")
    if not api_id or model_real_name is None or visible is None:
        return _bad("缺少参数")
    from model_registry import find_api, load_model_catalog, upsert_model
    catalog = load_model_catalog()
    api = find_api(catalog, api_id)
    if not api:
        return _bad(f"未知 API: {api_id}")
    # locate model by real_name or id
    model_entry = next(
        (m for m in api.get("models", []) if m.get("real_name") == model_real_name or m.get("id") == model_real_name),
        None,
    )
    if not model_entry:
        return _bad(f"模型不存在: {model_real_name}")
    # upsert_model merges into catalog and calls save_model_catalog (writes DB + JSON)
    upsert_model(api_id, {**model_entry, "enabled": bool(visible)})
    return json_response({"ok": True})


@router.post("/api/me/models/visibility")
async def api_me_models_visibility(request: Request):
    """每用户:隐藏/显示自己【同步来的】单个模型(user_model_entries.enabled)。

    与上面 /api/models/visibility(admin、写全局 model_entries)不同 —— 这个任何用户都能调,
    只动自己的 overlay。用户「启用某 provider(如 openrouter)但只想留几个模型」靠这个,
    且 set 后下次 remote/sync 不会被重置(见 user_models.replace_synced_models 的 prev 保留)。
    body: {api_id, model(=model_id 或 real_name), visible: bool}
    """
    user = require_user(request)
    body = await request.json() or {}
    api_id = body.get("api_id") or body.get("api")
    model = body.get("model") or body.get("real_name") or body.get("model_id")
    visible = body.get("visible")
    if not api_id or model is None or visible is None:
        return _bad("缺少参数")
    from platform_app.user_models import set_overlay_model_enabled
    n = set_overlay_model_enabled(user["id"], api_id, model, bool(visible))
    if not n:
        return _bad("该模型不在你的同步清单里(只能隐藏你自己同步来的模型)", status=404)
    return json_response({"ok": True, "updated": n})


@router.post("/api/me/models/model")
async def api_me_models_model(request: Request):
    """每用户:往**自己的** overlay 里加/改一个手填模型(user_model_entries, source='manual')。

    与 /api/models/model(admin-only,写全局 catalog、写进去所有人可见)彻底分开 —— 用户
    自己的模型只属于他自己。这是「provider 没有 /models 接口」时的唯一途径:火山方舟
    Agent Plan 订阅套餐地址 /models 恒 404,模型 ID 只能手填。
    (前科:v1.76.0 的「添加模型」按钮误接了 admin 端点,普通用户直接撞「需要管理员权限」,
     且一旦成功会把私人模型写进全局目录。已整条回滚重写。)

    body: {api_id, real_name(必填), display_name?, capabilities?}
    """
    user = require_user(request)
    body = await request.json() or {}
    api_id = body.get("api_id") or body.get("api")
    real = (body.get("real_name") or body.get("model") or body.get("model_id") or "").strip()
    if not api_id or not real:
        return _bad("缺少参数:api_id 与 real_name 必填")
    from platform_app.user_models import upsert_manual_model
    saved = upsert_manual_model(user["id"], api_id, {
        "id": real,
        "real_name": real,
        "display_name": (body.get("display_name") or body.get("display") or real).strip() or real,
        "capabilities": body.get("capabilities") or ["text", "streaming"],
        "enabled": True,
    })
    if not saved:
        return _bad("参数不合法(api_id / real_name 无法规范化)")
    return json_response({"ok": True, "model": saved})


@router.get("/api/me/models/model/config")
async def api_me_models_model_config_get(request: Request):
    """读取当前用户对某模型的标签/思考覆盖，供编辑弹窗回填。

    返回 raw override（如果存在）和最终 effective spec。`/api/models` 下发的
    public spec 不含 effort_values / params_by_level，编辑器必须走本接口才能
    完整回填自定义映射。
    """
    user = require_user(request)
    import model_reasoning
    from model_aliases import normalize_api_id

    try:
        api_id = normalize_api_id(
            request.query_params.get("api_id") or request.query_params.get("api") or "")
    except Exception:
        return _bad("api_id 格式不合法")
    real_name = str(
        request.query_params.get("real_name")
        or request.query_params.get("model")
        or request.query_params.get("model_id")
        or "").strip()
    if not api_id or not real_name:
        return _bad("缺少参数:api_id 与 real_name 必填")

    # 从用户 catalog 取 model_meta（自建中转/同步模型也包含）。
    model_meta = None
    api_meta = None
    try:
        from model_registry import find_api, load_catalog_for_user
        catalog = load_catalog_for_user(user["id"])
        api_meta = find_api(catalog, api_id)
        if api_meta:
            model_meta = next(
                (m for m in (api_meta.get("models") or [])
                 if (m.get("real_name") or m.get("id")) == real_name
                 or m.get("id") == real_name),
                None,
            )
            real_name = str((model_meta or {}).get("real_name") or real_name)
    except Exception:
        pass

    try:
        reasoning_overrides = model_reasoning.load_reasoning_overrides(user["id"])
        tag_overrides = model_reasoning.load_model_tag_overrides(user["id"])
    except Exception:
        reasoning_overrides = {}
        tag_overrides = {}
    key = f"{api_id}:{real_name}"
    raw_override = (reasoning_overrides.get(key)
                    or reasoning_overrides.get(real_name))
    raw_tag = (tag_overrides.get(key) or tag_overrides.get(real_name)) or {}
    if not isinstance(raw_tag, dict):
        raw_tag = {}

    # effective spec：与 /api/models / backend 使用同一套解析（含用户标签覆盖）。
    try:
        spec, _level = model_reasoning.resolve_spec_for_call(
            user["id"], api_id, real_name,
            model_dict=model_meta, api_dict=api_meta,
        )
    except Exception:
        spec = model_reasoning.spec_for_model(
            api_id, real_name, model_dict=model_meta, api_dict=api_meta)
    mode = "custom" if spec.get("source") == "user" else "auto"
    return json_response({
        "ok": True,
        "scope": "user",
        "api_id": api_id,
        "real_name": real_name,
        "mode": mode,
        "override": raw_override if mode == "custom" else None,
        "capabilities": raw_tag.get("capabilities")
        if isinstance(raw_tag.get("capabilities"), list) else None,
        "ui_tags": raw_tag.get("ui_tags")
        if isinstance(raw_tag.get("ui_tags"), list) else None,
        "effective": model_reasoning.public_spec(spec),
    })


@router.post("/api/me/models/model/config")
async def api_me_models_model_config_post(request: Request):
    """保存当前用户对某模型的能力标签/思考配置。

    body:
      {api_id, real_name, capabilities?: [str], reasoning?: dict|null}
    reasoning=null 表示删除思考覆盖、回退自动识别。
    """
    user = require_user(request)
    import model_reasoning
    from model_aliases import normalize_api_id

    body = await request.json() or {}
    try:
        api_id = normalize_api_id(
            body.get("api_id") or body.get("api") or "")
    except Exception:
        return _bad("api_id 格式不合法")
    real_name = str(
        body.get("real_name") or body.get("model") or body.get("model_id") or "").strip()
    if not api_id or not real_name:
        return _bad("缺少参数:api_id 与 real_name 必填")

    # 只允许编辑当前用户 catalog 中真实存在的模型；同时把 catalog id 归一到 real_name。
    try:
        from model_registry import find_api, load_catalog_for_user
        catalog = load_catalog_for_user(user["id"])
        api_meta = find_api(catalog, api_id)
        if not api_meta:
            return _bad(f"未知 API: {api_id}", status=404)
        model_meta = next(
            (m for m in (api_meta.get("models") or [])
             if (m.get("real_name") or m.get("id")) == real_name
             or m.get("id") == real_name),
            None,
        )
        if not model_meta:
            return _bad(f"模型不存在: {real_name}", status=404)
        real_name = str(model_meta.get("real_name") or real_name)
    except Exception as exc:
        return _bad(f"模型目录读取失败: {exc}", status=500)

    capabilities = body.get("capabilities", "__missing__")
    if capabilities != "__missing__":
        if not isinstance(capabilities, list) or any(not isinstance(c, str) for c in capabilities):
            return _bad("capabilities 必须是字符串数组")
        capabilities = list(dict.fromkeys(c.strip() for c in capabilities if c.strip()))

    reasoning_marker = body.get("reasoning", "__missing__")
    normalized_reasoning = None
    if reasoning_marker != "__missing__":
        # 原生 backend 只能使用各自的原生方言；否则 spec 保存成功但后端不会按它发。
        if isinstance(reasoning_marker, dict) and reasoning_marker.get("dialect"):
            kind = str((api_meta or {}).get("kind") or api_id)
            native_allowed = {
                "anthropic": "anthropic_budget",
                "vertex_ai": "gemini_budget",
            }.get(kind)
            if native_allowed and reasoning_marker.get("dialect") != native_allowed:
                return _bad(
                    f"{kind} 只支持 {native_allowed} 方言", status=400)
        normalized_reasoning, errors = model_reasoning.validate_custom_reasoning_spec(
            reasoning_marker)
        if errors:
            return _bad("思考配置不合法: " + "; ".join(errors), status=400)

    key = f"{api_id}:{real_name}"
    try:
        from psycopg.types.json import Jsonb

        from platform_app.db import connect as _connect
        with _connect() as db:
            row = db.execute(
                "select preferences from user_preferences where user_id = %s",
                (user["id"],),
            ).fetchone()
            prefs = dict(row["preferences"]) if row and row.get("preferences") else {}

            if capabilities != "__missing__":
                tags = prefs.get("model_tag_overrides")
                if not isinstance(tags, dict):
                    tags = {}
                prev = tags.get(key) if isinstance(tags.get(key), dict) else {}
                tags[key] = {**prev, "capabilities": capabilities}
                prefs["model_tag_overrides"] = tags

            if reasoning_marker != "__missing__":
                overrides = prefs.get("reasoning_model_overrides")
                if not isinstance(overrides, dict):
                    overrides = {}
                if normalized_reasoning is None:
                    overrides.pop(key, None)
                else:
                    overrides[key] = normalized_reasoning
                prefs["reasoning_model_overrides"] = overrides

            if row:
                db.execute(
                    "update user_preferences set preferences = %s, updated_at = now() "
                    "where user_id = %s",
                    (Jsonb(prefs), user["id"]),
                )
            else:
                db.execute(
                    "insert into user_preferences (user_id, preferences) values (%s, %s)",
                    (user["id"], Jsonb(prefs)),
                )
        try:
            from core.request_cache import invalidate_user_prefs_cache
            invalidate_user_prefs_cache(int(user["id"]))
        except Exception:
            pass
    except Exception as exc:
        return _bad(f"保存失败: {exc}", status=500)

    return json_response({
        "ok": True,
        "scope": "user",
        "api_id": api_id,
        "real_name": real_name,
        "mode": "custom" if (
            isinstance(normalized_reasoning, dict)
            and normalized_reasoning.get("enabled") is not False
        ) else "auto",
        "capabilities": capabilities if capabilities != "__missing__" else None,
        "reasoning": model_reasoning.public_spec(normalized_reasoning)
        if isinstance(normalized_reasoning, dict) else None,
    })


@router.post("/api/me/models/model/delete")
async def api_me_models_model_delete(request: Request):
    """每用户:从自己的 overlay 删掉一个模型。手填的删了就没了;同步来的下次同步会回来。"""
    user = require_user(request)
    body = await request.json() or {}
    api_id = body.get("api_id") or body.get("api")
    model = body.get("real_name") or body.get("model") or body.get("model_id")
    if not api_id or not model:
        return _bad("缺少参数")
    from platform_app.user_models import delete_overlay_model
    n = delete_overlay_model(user["id"], api_id, str(model))
    if not n:
        return _bad("该模型不在你的清单里", status=404)
    return json_response({"ok": True, "deleted": n})


@router.post("/api/models/validate")
async def api_models_validate(request: Request):
    """Lightweight credentials probe — defers to model_probe.list_remote_models."""
    user = require_user(request)
    body = await request.json() or {}
    api_id = body.get("api_id") or body.get("api_slug") or body.get("api") or ""
    try:
        from model_probe import list_remote_models, probe_availability
        if body.get("model"):
            out = probe_availability(
                api_id=api_id,
                model_real_name=body.get("model"),
                user_id=user["id"],
                timeout_sec=int(body.get("timeout", 8)),
            )
        else:
            out = list_remote_models(api_id=api_id, force_refresh=True, user_id=user["id"])
        return json_response({"ok": True, **(out if isinstance(out, dict) else {"result": out})})
    except Exception as e:
        return json_response({"ok": False, "error": str(e)}, status_code=400)
