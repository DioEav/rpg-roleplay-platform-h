"""邮箱验证码暴破防护:同 email 失败达上限后锁定窗口,验证通过后解锁。

6 位码(10^6)+ 10min 窗口原无尝试上限可被穷举。本测试覆盖进程内 fallback 路径
(测试环境无 REDIS_URL → redis_bus.get_sync_client() 返 None)。
"""
import unittest
from unittest import mock

from platform_app import auth


class VerifyBruteforceGuard(unittest.TestCase):
    def setUp(self):
        self.email = "victim@example.com"
        # 本次修复：全量测试里其他用例可能已初始化 Redis client，并残留
        # verify:victim@example.com 的锁；本测试覆盖的是进程内 fallback 路径，
        # 必须显式把 redis 客户端 patch 成 None，否则 test_not_locked_initially
        # 会受到测试顺序污染。
        self._redis_patch = mock.patch("redis_bus.get_sync_client", return_value=None)
        self._redis_patch.start()
        # 清理进程内状态,避免测试间污染
        with auth._FAIL_LOCK:
            auth._VERIFY_FAIL_BUCKETS.pop(self.email, None)
            auth._VERIFY_LOCKED_UNTIL.pop(self.email, None)

    def tearDown(self):
        with auth._FAIL_LOCK:
            auth._VERIFY_FAIL_BUCKETS.pop(self.email, None)
            auth._VERIFY_LOCKED_UNTIL.pop(self.email, None)
        self._redis_patch.stop()

    def test_not_locked_initially(self):
        self.assertFalse(auth._verify_locked(self.email))

    def test_locks_after_max_fails(self):
        for _ in range(auth._VERIFY_MAX_FAILS - 1):
            auth._record_verify_fail(self.email)
        self.assertFalse(auth._verify_locked(self.email), "未到上限不应锁定")
        auth._record_verify_fail(self.email)  # 第 MAX 次
        self.assertTrue(auth._verify_locked(self.email), "达上限应锁定该 email")

    def test_success_clears_lock(self):
        for _ in range(auth._VERIFY_MAX_FAILS):
            auth._record_verify_fail(self.email)
        self.assertTrue(auth._verify_locked(self.email))
        auth._clear_verify_fail(self.email)
        self.assertFalse(auth._verify_locked(self.email), "验证成功应解锁")

    def test_window_limits_attempts(self):
        # 暴破空间从 10^6 降到每窗口 _VERIFY_MAX_FAILS 次猜测
        self.assertLessEqual(auth._VERIFY_MAX_FAILS, 20, "尝试上限应足够小以阻止暴破")
        self.assertEqual(auth._VERIFY_WINDOW_SEC, 600, "窗口应与验证码有效期一致")


if __name__ == "__main__":
    unittest.main()
