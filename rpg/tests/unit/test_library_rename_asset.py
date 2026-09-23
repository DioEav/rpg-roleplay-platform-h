"""
test_library_rename_asset.py
============================

文件库「重命名」端点与 registry 函数的行为契约:

  · POST /api/library/asset/{id}/rename {"name": "..."}
    — trim 后 1..100 字符,否则 400 invalid_name;
    — owner 校验失败(行不属于该用户) → 404 not_found;
    — 成功 → {ok, asset} 且 asset.name 为新值。

  · registry rename_asset — SQL 必须带 user_id 守卫(防越权改他人行),
    且只 UPDATE name 列(文件本体/存储键/引用不得被触碰)。

mock 风格与 test_library_delete_probe_and_size.py 一致:patch 模块属性,不需要真库。
"""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import MagicMock, patch

from platform_app.api import library as library_api
from platform_app import assets_registry as reg
from platform_app import library as lib

USER = {"id": 7}
ROW = {
    "id": 55, "user_id": 7, "kind": "ai_image", "name": "新名字",
    "storage_key": "ai_images/abc.png", "url": "/api/storage/ai_images/abc.png",
    "source": "image_gen", "ref_kind": None, "ref_id": None,
    "mime": "image/png", "size": 1024, "meta": {}, "created_at": None,
}


def _fake_db(fetchone_result=None):
    db = MagicMock()
    db.__enter__.return_value = db
    db.execute.return_value.fetchone.return_value = fetchone_result
    return db


class RenameEndpoint(unittest.TestCase):

    def _call(self, body: dict, *, user=USER, rename_result=ROW):
        # 端点里是 `await request.json()` —— 需要真协程,MagicMock 的返回值不可 await。
        # user 是 Depends 默认值(定义时已求值成 Depends 对象),直接调用必须显式传入。
        request = MagicMock()
        async def _json():
            return body
        request.json = _json
        with patch.object(library_api, "_library") as lib_mock:
            lib_mock.rename_asset.return_value = rename_result
            resp = asyncio.run(library_api.api_library_rename_asset(55, request, user))
        return resp, lib_mock

    def test_valid_name_renames_and_returns_asset(self):
        resp, lib_mock = self._call({"name": "  夏日海滩  "})
        body = json.loads(resp.body)
        self.assertTrue(body["ok"])
        self.assertEqual(body["asset"]["name"], "新名字")
        # trim 后传给 library 层
        lib_mock.rename_asset.assert_called_once_with(7, 55, "夏日海滩")

    def test_empty_name_returns_400_and_touches_nothing(self):
        for raw in ("", "   "):
            resp, lib_mock = self._call({"name": raw})
            self.assertEqual(resp.status_code, 400, f"{raw!r} 应 400")
            self.assertEqual(json.loads(resp.body)["error"], "invalid_name")
            lib_mock.rename_asset.assert_not_called()

    def test_overlong_name_returns_400(self):
        resp, lib_mock = self._call({"name": "x" * 101})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(json.loads(resp.body)["error"], "invalid_name")
        lib_mock.rename_asset.assert_not_called()

    def test_not_owner_returns_404(self):
        resp, _ = self._call({"name": "ok"}, rename_result=None)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(json.loads(resp.body)["error"], "not_found")

    def test_missing_body_treated_as_empty_name(self):
        # request.json() 抛异常(坏 body)→ 端点兜底成 {} → invalid_name
        async def _boom():
            raise ValueError("no body")
        request = MagicMock()
        request.json = _boom
        with patch.object(library_api, "_library") as lib_mock:
            resp = asyncio.run(library_api.api_library_rename_asset(55, request, USER))
        self.assertEqual(resp.status_code, 400)
        lib_mock.rename_asset.assert_not_called()


class RenameRegistrySql(unittest.TestCase):
    """registry 层:owner 守卫 + 只动 name 列。"""

    def test_update_sql_has_owner_guard_and_only_name_column(self):
        db = _fake_db(fetchone_result=dict(ROW))
        with patch.object(reg, "init_db"), \
             patch.object(reg, "connect", return_value=db):
            result = reg.rename_asset(7, 55, "新名字")
        self.assertIsNotNone(result)
        sql = str(db.execute.call_args[0][0]).lower()
        params = db.execute.call_args[0][1]
        self.assertIn("update user_assets set name", sql, "只 UPDATE name 列")
        self.assertIn("user_id = %s", sql, "必须带 owner 守卫")
        # 不得触碰其他列
        for forbidden in ("storage_key =", "url =", "size =", "ref_kind ="):
            self.assertNotIn(forbidden, sql, f"重命名不得改 {forbidden}")
        self.assertEqual(params, ("新名字", 55, 7))

    def test_row_not_owned_returns_none(self):
        db = _fake_db(fetchone_result=None)  # WHERE 没命中 → fetchone None
        with patch.object(reg, "init_db"), \
             patch.object(reg, "connect", return_value=db):
            result = reg.rename_asset(7, 999, "x")
        self.assertIsNone(result)

    def test_library_wrapper_delegates(self):
        with patch.object(reg, "rename_asset", return_value=ROW) as m:
            out = lib.rename_asset(7, 55, "n")
        m.assert_called_once_with(7, 55, "n")
        self.assertEqual(out["name"], "新名字")


class MigrationPresent(unittest.TestCase):
    """迁移 104 必须在册且 append-only(版本单调由既有全局测试再兜一层)。"""

    def test_migration_104_adds_name_column(self):
        from platform_app.db import migrations as mig
        entry = next((m for m in mig.MIGRATIONS if m[0] == 104), None)
        self.assertIsNotNone(entry, "缺少迁移 104")
        self.assertEqual(entry[1], "user_assets_display_name")
        joined = " ".join(entry[2]).lower()
        self.assertIn("alter table user_assets add column if not exists name", joined)

    def test_versions_stay_monotonic_with_104(self):
        from platform_app.db import migrations as mig
        versions = [m[0] for m in mig.MIGRATIONS]
        self.assertEqual(versions, sorted(versions), "MIGRATIONS 必须单调递增")
        self.assertEqual(len(versions), len(set(versions)), "版本号不能重复")


if __name__ == "__main__":
    unittest.main()
