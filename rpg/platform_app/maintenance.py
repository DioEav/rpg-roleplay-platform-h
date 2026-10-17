"""platform_app.maintenance —— 维护模式 gate(读 admin.maintenance_config + 503 中间件)。

配置由 platform_app.api.admin.maintenance 写入;本模块是唯一消费方:
  - get_maintenance_state():5s 进程级 TTL 缓存读取(中间件每请求都要判,不能每请求打 DB);
  - invalidate_maintenance_cache():admin 保存后调用,变更立即生效;
  - maintenance_middleware():仅拦 /api(静态页放行,前端靠横幅说明),豁免
    /api/admin、/api/auth、/api/health、/api/maintenance/status 与 OPTIONS;
    维护开启时 admin 放行(防自锁),其余 503 + 公告。

注册位置:core.startup.configure_app 中必须注册在 api_contract_middleware **之前**
(Starlette 后注册先执行 → api_contract 先跑,完成 /api/v1→/api 规范化与 request_id)。
"""
from __future__ import annotations

import json
import threading
import time

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from .api._deps import json_response
from .db import connect

_CFG_KEY = "admin.maintenance_config"
_TTL_SEC = 5.0

_CACHE_LOCK = threading.Lock()
_CACHE: dict | None = None
_CACHE_AT: float = 0.0

# 维护期间仍可访问的 API 前缀:管理台(admin 得以关闭维护)、
# 登录/登出/me/schema(管理员要能登录)、健康探测、公开状态端点。
_EXEMPT_PREFIXES = ("/api/admin", "/api/auth", "/api/health", "/api/maintenance/status")


def _read_state_from_db() -> dict:
    """直读 app_config;表/行缺失或异常一律视为关闭(与 _registration_mode 同风格)。"""
    try:
        with connect() as db:
            row = db.execute(
                "select value from app_config where key = %s", (_CFG_KEY,)
            ).fetchone()
        cfg = (row.get("value") if row else None) or {}
        if isinstance(cfg, str):
            cfg = json.loads(cfg)
        return {
            "maintenance_mode": bool(cfg.get("maintenance_mode")),
            "announcement": str(cfg.get("announcement") or ""),
            "maintenance_since": cfg.get("maintenance_since"),
        }
    except Exception:
        return {"maintenance_mode": False, "announcement": "", "maintenance_since": None}


def get_maintenance_state() -> dict:
    """带 TTL 缓存读取维护状态;返回 {maintenance_mode, announcement, maintenance_since}。"""
    global _CACHE, _CACHE_AT
    now = time.monotonic()
    with _CACHE_LOCK:
        if _CACHE is not None and now - _CACHE_AT < _TTL_SEC:
            return _CACHE
    state = _read_state_from_db()
    with _CACHE_LOCK:
        _CACHE = state
        _CACHE_AT = time.monotonic()
    return state


def invalidate_maintenance_cache() -> None:
    """admin 保存维护配置后调用,让变更跳过 TTL 立即生效。"""
    global _CACHE
    with _CACHE_LOCK:
        _CACHE = None
        _CACHE_AT = 0.0


def _is_exempt(path: str, method: str) -> bool:
    if method == "OPTIONS":  # CORS 预检不拦,否则浏览器只看到 CORS 失败
        return True
    return path.startswith(_EXEMPT_PREFIXES)


async def maintenance_middleware(request: Request, call_next):
    path = request.scope.get("path") or ""
    if not path.startswith("/api") or _is_exempt(path, request.method):
        return await call_next(request)

    state = await run_in_threadpool(get_maintenance_state)
    if not state["maintenance_mode"]:
        return await call_next(request)

    # admin 放行(防自锁:管理台豁免 + 会话校验,管理员可进后台关闭维护)
    from . import auth as _auth
    from .api._deps import SESSION_COOKIE, is_admin

    try:
        user = await run_in_threadpool(
            _auth.user_from_token, request.cookies.get(SESSION_COOKIE)
        )
    except Exception:
        user = None
    if is_admin(user or {}):
        return await call_next(request)

    announcement = state["announcement"].strip()
    error = f"平台维护中：{announcement}" if announcement else "平台维护中，请稍后再试"
    return json_response(
        {
            "ok": False,
            "error": error,
            "error_key": "maintenance.active",
            "maintenance": True,
            "announcement": announcement,
        },
        status_code=503,
        headers={"Cache-Control": "no-store"},
    )
