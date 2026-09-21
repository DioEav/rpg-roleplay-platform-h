"""test_boot_endpoints_sync.py — 启动路径端点必须是同步 def(线程池并行),不许退回 async。

背景(2026-09,实测打点):六个启动端点全是 `async def`,却把重活(目录装配+两遍全目录深拷贝、
workspace 聚合、DB 查询)直接写在协程里 —— 同步阻塞卡死唯一的单 worker 事件循环,浏览器并行
发的请求在服务端被迫串行。实测 [data-loader] boot: platform 组 22645ms | state 9298ms | 总
22645ms —— 总时长恰好等于六段阻塞之和。

改为同步 `def` 后 FastAPI 自动进 AnyIO 线程池(默认 40 线程)真正并行。本文件用
inspect.iscoroutinefunction 锁死这 6 个处理器保持同步 —— 谁改回 async def,谁就是
把启动恢复成串行(且没有任何报错,只会"变慢",必须用测试拦住)。

不在此名单的:/api/chat、/api/state_events 等流式/异步处理器必须保持 async,勿加。
"""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

import pytest  # noqa: E402

from platform_app.api import auth as auth_routes  # noqa: E402
from platform_app.api import library as library_routes  # noqa: E402
from platform_app.api import platform as platform_routes  # noqa: E402
from platform_app.api import saves as saves_routes  # noqa: E402
from platform_app.api.scripts import listing as scripts_listing  # noqa: E402
from routes import core as core_routes  # noqa: E402

# (模块, 处理器名, 端点) —— 全部是启动路径上的重活
BOOT_ENDPOINTS = [
    (core_routes, "api_state", "/api/state"),
    (platform_routes, "api_platform", "/api/platform"),
    (scripts_listing, "api_scripts", "/api/scripts"),
    (saves_routes, "api_saves", "/api/saves"),
    (library_routes, "api_library_list", "/api/library"),
    (auth_routes, "api_me", "/api/auth/me"),
]


@pytest.mark.parametrize("module,func_name,endpoint", BOOT_ENDPOINTS)
def test_boot_endpoints_are_sync_threadpool_handlers(module, func_name, endpoint):
    """启动端点必须是同步 def:FastAPI 对同步处理器进线程池,事件循环不被阻塞。"""
    func = getattr(module, func_name)
    assert not inspect.iscoroutinefunction(func), (
        f"{endpoint} 的处理器被改回了 async def —— 协程里的同步 DB/深拷贝会阻塞事件循环,"
        f"六路启动请求被迫串行(实测总 22.6s)。如确需 async,请先把体内阻塞工作挪进 "
        f"asyncio.to_thread,并更新本测试。"
    )


def test_streaming_endpoints_stay_async():
    """反向锚:真正的流式处理器必须保持 async —— 防止有人'顺手统一'成 def 破坏 SSE。"""
    import asyncio

    from routes import core as core_routes

    state_events = getattr(core_routes, "api_state_events", None)
    if state_events is None:
        pytest.skip("routes.core 无 api_state_events(结构变更后请更新本测试)")
    assert asyncio.iscoroutinefunction(state_events), (
        "/api/state_events 是流式端点,必须保持 async def"
    )
