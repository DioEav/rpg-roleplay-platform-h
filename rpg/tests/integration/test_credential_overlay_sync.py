"""OSS issue #22 回归：换/删 APIKey 后游戏控制台模型列表不刷新。

根因：per-user 模型 overlay(user_model_entries)不随凭据变化清理 —
  · delete_credential 删了 key 却不清 overlay → 旧 key 同步来的模型残留；
  · set_credential 换 key 后若新 key 的 /models 列不出(失败/空)，旧 overlay 留着。

这里用真实 DB 验证两条修复路径 + happy-path 不回归。
"""
from __future__ import annotations

import os
import unittest

os.environ.setdefault("RPG_DEPLOYMENT_MODE", "local")  # 本地模式 → 加密走文件 fallback


class TestCredentialOverlaySync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            row = db.execute(
                """
                insert into users(username, display_name, password_hash, email)
                values (%s, %s, %s, %s)
                returning id
                """,
                ("overlay_sync_uat", "Overlay UAT", "x", "overlay_sync_uat@example.com"),
            ).fetchone()
            cls.uid = int(row["id"])

    @classmethod
    def tearDownClass(cls):
        from platform_app.db import connect
        with connect() as db:
            db.execute("delete from user_model_entries where user_id = %s", (cls.uid,))
            db.execute("delete from user_api_credentials where user_id = %s", (cls.uid,))
            db.execute("delete from users where id = %s", (cls.uid,))

    def setUp(self):
        # 每个用例前清干净 overlay + 凭据
        from platform_app.db import connect
        with connect() as db:
            db.execute("delete from user_model_entries where user_id = %s", (self.uid,))
            db.execute("delete from user_api_credentials where user_id = %s", (self.uid,))

    def _seed_overlay(self):
        """模拟「旧 key 拉取远程模型」写进 overlay 的状态。"""
        from platform_app.user_models import load_overlay, replace_synced_models
        replace_synced_models(self.uid, "deepseek", [
            {"id": "old-model-a", "real_name": "old-model-a", "display_name": "Old A"},
            {"id": "old-model-b", "real_name": "old-model-b", "display_name": "Old B"},
        ])
        overlay = load_overlay(self.uid)
        self.assertIn("deepseek", overlay)
        self.assertEqual(len(overlay["deepseek"]), 2)

    def test_delete_credential_clears_overlay(self):
        from platform_app import user_credentials
        from platform_app.user_models import load_overlay
        self._seed_overlay()
        user_credentials.delete_credential(self.uid, "deepseek")
        overlay = load_overlay(self.uid)
        self.assertNotIn(
            "deepseek", overlay,
            "删 key 后该 provider 的 overlay 应被清空，否则旧模型残留在模型列表",
        )

    def test_set_credential_clears_overlay_when_sync_fails(self):
        """换新 key 但新 key /models 列不出(ok=False)→ 必须清掉旧 overlay。"""
        import model_probe
        from platform_app import user_credentials
        from platform_app.user_models import load_overlay
        self._seed_overlay()
        orig = model_probe.list_remote_models
        model_probe.list_remote_models = lambda *a, **k: {"ok": False, "error": "no /models"}
        try:
            user_credentials.set_credential(self.uid, "deepseek", "sk-new-key-xyz")
        finally:
            model_probe.list_remote_models = orig
        overlay = load_overlay(self.uid)
        self.assertNotIn(
            "deepseek", overlay,
            "换 key 后新 key 列不出模型时，旧 key 的 overlay 应被清空(回退全局菜单)",
        )

    def test_set_credential_replaces_overlay_on_successful_sync(self):
        """happy path 不回归：新 key 能列出模型 → overlay 被新清单替换。"""
        import model_probe
        from platform_app import user_credentials
        from platform_app.user_models import load_overlay
        self._seed_overlay()
        orig = model_probe.list_remote_models
        model_probe.list_remote_models = lambda *a, **k: {
            "ok": True,
            "models": [{"id": "new-model-z", "real_name": "new-model-z", "display_name": "New Z"}],
        }
        try:
            user_credentials.set_credential(self.uid, "deepseek", "sk-new-key-xyz")
        finally:
            model_probe.list_remote_models = orig
        overlay = load_overlay(self.uid)
        self.assertIn("deepseek", overlay)
        names = {m.get("real_name") or m.get("id") for m in overlay["deepseek"]}
        self.assertEqual(names, {"new-model-z"}, "应只剩新 key 同步来的模型，旧模型被移除")

    # ── 深审新发现的两层(此前 10 次修复从未覆盖)─────────────────────────────
    def test_set_credential_forces_refresh_on_autosync(self):
        """换 key 自动同步必须 force_refresh=True。

        否则会命中改 key 前「校验连接/拉取模型」刚写满的旧 key 60s 缓存,
        把旧 key 的模型写进 overlay → 「换 key 后列表不刷新」(issue #22 后端根因)。
        """
        import model_probe
        from platform_app import user_credentials
        captured = {}
        orig = model_probe.list_remote_models

        def _spy(api_id, *a, **k):
            captured["force_refresh"] = k.get("force_refresh")
            return {"ok": True, "models": [{"id": "m1", "real_name": "m1"}]}

        model_probe.list_remote_models = _spy
        try:
            user_credentials.set_credential(self.uid, "deepseek", "sk-new-key-xyz")
        finally:
            model_probe.list_remote_models = orig
        self.assertIs(
            captured.get("force_refresh"), True,
            "set_credential 自动同步必须强制刷新,绝不能读旧 key 的缓存",
        )

    def test_set_credential_invalidates_stale_list_cache(self):
        """换 key 后旧 key 的 _LIST_CACHE 条目必须被清,否则 /api/models/remote 60s 内仍返旧。"""
        import model_probe
        from platform_app import user_credentials
        ck = f"{self.uid}::deepseek"
        model_probe._LIST_CACHE[ck] = (9e18, [{"id": "old", "real_name": "old"}])
        orig = model_probe.list_remote_models
        model_probe.list_remote_models = lambda *a, **k: {
            "ok": True, "models": [{"id": "new", "real_name": "new"}],
        }
        try:
            user_credentials.set_credential(self.uid, "deepseek", "sk-new-key-xyz")
        finally:
            model_probe.list_remote_models = orig
        self.assertNotIn(
            ck, model_probe._LIST_CACHE,
            "换 key 后旧 key 的远程模型缓存必须被失效",
        )

    def test_delete_credential_invalidates_list_cache(self):
        """删 key 后 _LIST_CACHE 条目必须被清,否则删后「拉取远程模型」仍返已删 key 清单。"""
        import model_probe
        from platform_app import user_credentials
        ck = f"{self.uid}::deepseek"
        model_probe._LIST_CACHE[ck] = (9e18, [{"id": "old", "real_name": "old"}])
        user_credentials.delete_credential(self.uid, "deepseek")
        self.assertNotIn(ck, model_probe._LIST_CACHE, "删 key 后远程模型缓存必须被失效")


class TestApiFormatRoundTrip(unittest.TestCase):
    """api_format 在凭据/目录/overlay 三层往返，且 keep_key 编辑不会丢格式。"""

    @classmethod
    def setUpClass(cls):
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            db.execute("delete from users where username = %s", ("api_format_uat",))
            row = db.execute(
                """
                insert into users(username, display_name, password_hash, email)
                values (%s, %s, %s, %s) returning id
                """,
                ("api_format_uat", "API Format UAT", "x", "api_format_uat@example.com"),
            ).fetchone()
            cls.uid = int(row["id"])

    @classmethod
    def tearDownClass(cls):
        from platform_app.db import connect
        with connect() as db:
            db.execute("delete from user_model_entries where user_id = %s", (cls.uid,))
            db.execute("delete from user_api_credentials where user_id = %s", (cls.uid,))
            db.execute("delete from users where id = %s", (cls.uid,))

    def setUp(self):
        from platform_app.db import connect
        with connect() as db:
            db.execute("delete from user_model_entries where user_id = %s", (self.uid,))
            db.execute("delete from user_api_credentials where user_id = %s", (self.uid,))

    def _set(self, **kw):
        import model_probe
        from platform_app import user_credentials
        orig = model_probe.list_remote_models
        model_probe.list_remote_models = lambda *a, **k: {
            "ok": True, "models": [{"id": "m1", "real_name": "m1"}],
        }
        try:
            return user_credentials.set_credential(
                self.uid, "myrelay", kw.pop("key", "sk-test"),
                base_url_override="https://relay.example/v1",
                allow_base_url=True,
                **kw,
            )
        finally:
            model_probe.list_remote_models = orig

    def test_format_round_trip_and_keep_key_semantics(self):
        from platform_app import user_credentials
        from model_registry import apply_user_overlay, resolve_api_format

        self._set(api_format="responses")
        cred = user_credentials.get_credential(self.uid, "myrelay")
        self.assertEqual(cred["api_format"], "responses")
        self.assertEqual(
            user_credentials.list_credentials(self.uid)["items"][0]["api_format"],
            "responses",
        )
        # 凭据覆盖优先于目录默认
        self.assertEqual(
            resolve_api_format("myrelay", self.uid,
                               catalog_api={"api_format": "chat_completions"}),
            "responses",
        )
        # keep_key 编辑但未提供 api_format → 保留原值
        self._set(key="", preserve_key_if_empty=True)
        self.assertEqual(
            user_credentials.get_credential(self.uid, "myrelay")["api_format"],
            "responses",
        )
        # 显式空串 → 清除覆盖（继承目录默认）
        self._set(key="", preserve_key_if_empty=True, api_format="")
        self.assertEqual(
            user_credentials.get_credential(self.uid, "myrelay")["api_format"], "",
        )
        # 自建中转站 overlay 行携带凭据格式
        self._set(api_format="responses")
        catalog = apply_user_overlay({"apis": []}, self.uid)
        api = next(a for a in catalog["apis"] if a["id"] == "myrelay")
        self.assertEqual(api["api_format"], "responses")
        self.assertEqual(api["kind"], "openai_compat")


if __name__ == "__main__":
    unittest.main()
