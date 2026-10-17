"""test_maintenance_gate.py — 维护模式 503 gate 集成测试。

覆盖:公开 status 端点、admin 开启/关闭、非管理员(含未登录)503 且携带公告、
admin 放行(防自锁)、豁免前缀(/api/auth/me、/api/health)、关闭后恢复。

注意:必须用三个独立 TestClient(匿名/普通用户/管理员)—— TestClient 的 cookie
jar 会保留登录 Set-Cookie,共用实例会让「未登录」请求实际带着 admin 会话。
"""
from __future__ import annotations

import unittest

from tests.helpers import (
    cleanup_test_users,
    login_user,
    make_client,
    register_user,
)

ANNOUNCE = "每周例行维护，预计 30 分钟"


def _promote_admin(username: str) -> None:
    """把指定用户提升为 admin(与 test_critical_paths 同款)。"""
    from platform_app.db import connect
    with connect() as db:
        db.execute("update users set role = 'admin' where username = %s", (username,))


class MaintenanceGateFlow(unittest.TestCase):
    """开启 → 非管理员被拦/管理员放行 → 关闭恢复 的完整链路。"""

    @classmethod
    def setUpClass(cls):
        cleanup_test_users()
        cls.anon = make_client()      # 无 cookie:模拟未登录访客
        cls.user_client = make_client()   # 普通用户
        cls.admin_client = make_client()  # 管理员

        cls.user = register_user(cls.user_client)
        assert cls.user["status"] == 200, cls.user["body"]

        cls.admin = register_user(cls.admin_client)
        _promote_admin(cls.admin["username"])
        cls.admin_login = login_user(cls.admin_client, cls.admin["username"], cls.admin["password"])
        assert cls.admin_login["status"] == 200, cls.admin_login["body"]

    @classmethod
    def tearDownClass(cls):
        cleanup_test_users()

    def _toggle(self, on: bool) -> None:
        resp = self.admin_client.post(
            "/api/v1/admin/maintenance",
            json={"maintenance_mode": on, "announcement": ANNOUNCE if on else ""},
        )
        self.assertEqual(resp.status_code, 200, resp.text)

    def test_01_status_disabled_by_default(self):
        resp = self.anon.get("/api/v1/maintenance/status")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body.get("ok"))
        self.assertFalse(body.get("enabled"))

    def test_02_gate_blocks_non_admin_and_carries_announcement(self):
        self._toggle(True)

        # status 端点立即反映变更(保存时已失效 TTL 缓存)
        st = self.anon.get("/api/v1/maintenance/status").json()
        self.assertTrue(st["enabled"])
        self.assertEqual(st["announcement"], ANNOUNCE)
        self.assertTrue(st["since"])

        # 未登录 → 503,body 带 maintenance 标记与公告文本
        r = self.anon.get("/api/v1/models")
        self.assertEqual(r.status_code, 503, r.text)
        body = r.json()
        self.assertTrue(body["maintenance"])
        self.assertEqual(body["announcement"], ANNOUNCE)
        self.assertEqual(body["error_key"], "maintenance.active")
        self.assertIn("维护", body["error"])

        # 已登录普通用户 → 同样 503
        r2 = self.user_client.get("/api/v1/models")
        self.assertEqual(r2.status_code, 503)

        # admin → 放行(防自锁)
        r3 = self.admin_client.get("/api/v1/models")
        self.assertEqual(r3.status_code, 200, r3.text)

        # 豁免前缀:auth(登录/登出/me)与健康探测不受影响
        self.assertEqual(self.anon.get("/api/v1/auth/me").status_code, 200)
        self.assertEqual(self.anon.get("/api/health").status_code, 200)

        self._toggle(False)

    def test_03_toggle_off_recovers(self):
        self._toggle(True)
        self.assertEqual(self.user_client.get("/api/v1/models").status_code, 503)
        self._toggle(False)
        r = self.user_client.get("/api/v1/models")
        self.assertEqual(r.status_code, 200, r.text)


if __name__ == "__main__":
    unittest.main()
