"""
tests/helpers.py — 集成测试公共工具

约定：
- 使用同一个真实数据库（DATABASE_URL），但用户名前缀 `integtest_` 隔离
- 每个 TestCase setUp/tearDown 清理本测试创建的用户和级联数据
- 不依赖外部 LLM，不触发 /api/chat
"""
from __future__ import annotations

import os
import random
import string
import sys
from pathlib import Path
from typing import Any

# 让测试能 import 顶层模块
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) != sys.path[0]:
    sys.path.insert(0, str(REPO_ROOT))

# 强制服务器鉴权模式，避免 local 模式的隐式登录干扰
os.environ.setdefault("RPG_REQUIRE_AUTH", "1")

# 与 app.py 同款:导入期即加载 .env(override=True)。否则任何在 make_client()
# (import app)之前碰 DB 的测试(如 setUpClass 里先 cleanup_test_users)都会拿不到
# DATABASE_URL,连接池回退到默认 postgresql:///rpg_platform → PoolTimeout。
from core.config import load_dotenv_once
load_dotenv_once()


def random_suffix(n: int = 8) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def integtest_username() -> str:
    return f"integtest_{random_suffix()}"


def make_client():
    """构造一个 FastAPI TestClient（lazy import 防止 conftest 阶段就加载 ui）"""
    from fastapi.testclient import TestClient

    import app  # noqa: F401 触发路由注册
    _ensure_registration_open()
    return TestClient(app.app)


def _ensure_registration_open():
    """复位 admin.registration_config(删除 → 默认 open)。

    closed/invite 模式现在会真实拦截注册(mode=closed 曾长期无消费方,测试库可能
    残留历史配置),不复位会让所有注册类集成测试连片失败。需要特定 mode 的集成
    测试在用例内自行写入并在结束时还原。
    """
    from platform_app.db import connect
    with connect() as db:
        db.execute("delete from app_config where key = 'admin.registration_config'")
        # 同理复位维护模式:开启时 503 gate 会拦掉所有非豁免 API,连片弄挂集成测试
        db.execute("delete from app_config where key = 'admin.maintenance_config'")
    # 中间件带 5s TTL 缓存,测试直接改库后必须失效,否则本进程内后续用例读到旧值
    try:
        from platform_app.maintenance import invalidate_maintenance_cache
        invalidate_maintenance_cache()
    except Exception:
        pass
    # 清掉 TestClient 固定 IP(testclient)的注册预算计数,否则反复本地跑测试
    # 会把 10 次/10min 的 reg:ip 预算用光,后续注册全部 400
    try:
        import redis_bus
        if redis_bus.get_sync_client() is not None:
            redis_bus.rate_reset("reg:ip:testclient")
    except Exception:
        pass


def cleanup_test_users() -> int:
    """删除所有 integtest_ 前缀用户（级联清掉 sessions/saves 等）。
    返回删除条数。生产环境如果用了正经测试 DB 也安全。
    """
    from platform_app.db import connect
    with connect() as db:
        row = db.execute(
            "delete from users where username like 'integtest_%' returning id"
        ).fetchall()
    return len(row)


def register_user(client, username: str | None = None, password: str = "Test12345!") -> dict[str, Any]:
    """注册并返回 (username, password, body)。"""
    uname = username or integtest_username()
    email = f"{uname}@example.test"
    code = "123456"
    from platform_app import auth as _auth

    old_generate_email_code = _auth.generate_email_code
    _auth.generate_email_code = lambda n_digits=6: code
    resp = client.post(
        "/api/v1/auth/register",
        json={
            "username": uname,
            "password": password,
            "display_name": "integ",
            "email": email,
            "birthday": "1990-01-01",
            "terms_accepted": True,
            "age_confirmed": True,
        },
    )
    _auth.generate_email_code = old_generate_email_code
    if resp.status_code == 200:
        body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        if body.get("pending_verify"):
            verify_resp = client.post(
                "/api/v1/auth/verify-email",
                json={"email": email, "code": code},
            )
            return {
                "username": uname,
                "password": password,
                "status": verify_resp.status_code,
                "body": verify_resp.json() if verify_resp.headers.get("content-type", "").startswith("application/json") else {},
                "cookies": dict(verify_resp.cookies),
            }
    return {
        "username": uname,
        "password": password,
        "status": resp.status_code,
        "body": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {},
        "cookies": dict(resp.cookies),
    }


def login_user(client, username: str, password: str = "Test12345!") -> dict[str, Any]:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    return {
        "status": resp.status_code,
        "body": resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {},
        "cookies": dict(resp.cookies),
    }
