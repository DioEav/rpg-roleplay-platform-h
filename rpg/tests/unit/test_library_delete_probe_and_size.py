"""
test_library_delete_probe_and_size.py
=====================================

文件库两个用户上报的修复:

1. 「有些 ai 生图点删除没有确认弹框」
   旧语义 confirm=False 对**无引用**资产是直接删 —— AI 生图多数无引用,
   startDelete 探测那一步就把图删了,弹框永远轮不到。修法:probe=True 只读探测,
   总是返回 needs_confirm + 引用列表,不碰 DB/文件。

2. 「AI 生图卡片大小显示 —」
   image_jobs 的 register_asset 曾漏传 size → user_assets.size=0 → fmtBytes(0)='—'。
   修法:list_assets 对 size=0 的行 stat 磁盘回填(带 `and size=0` 守卫持久化)。

均 mock 依赖,不需要真库。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from platform_app import library as lib


def _fake_db():
    db = MagicMock()
    db.__enter__.return_value = db
    return db


class ProbeMode(unittest.TestCase):
    """probe=True:只读探测,总是 needs_confirm,绝不删除。"""

    def _run(self, *, find_result):
        db = _fake_db()
        with patch("platform_app.assets_registry.find_asset_references", return_value=find_result), \
             patch("platform_app.assets_registry.delete_asset") as del_mock, \
             patch.object(lib, "nullify_references") as nullify_mock, \
             patch("platform_app.db.connect", return_value=db):
            result = lib.delete_asset_with_refs(7, 55, confirm=False, probe=True)
        return result, del_mock, nullify_mock, db

    def test_probe_unreferenced_asset_still_needs_confirm(self):
        """无引用 + probe → needs_confirm(核心回归:旧行为是直接删、不弹框)。"""
        asset = {"id": 55, "url": "/api/storage/ai_images/abc.png", "storage_key": "ai_images/abc.png"}
        result, del_mock, nullify_mock, db = self._run(
            find_result={"ok": True, "references": [], "asset": asset}
        )
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("needs_confirm"), "probe 必须总是要求确认")
        self.assertEqual(result.get("references"), [])
        self.assertEqual(result.get("asset"), asset, "确认框需要 asset 信息")
        del_mock.assert_not_called()
        nullify_mock.assert_not_called()
        db.execute.assert_not_called()

    def test_probe_referenced_asset_carries_references(self):
        """有引用 + probe → needs_confirm + 引用列表(确认框显示关联警告)。"""
        refs = [{"kind": "card", "id": 9, "name": "某角色"}]
        result, del_mock, _, _ = self._run(
            find_result={"ok": True, "references": refs, "asset": {"id": 55}}
        )
        self.assertTrue(result.get("needs_confirm"))
        self.assertEqual(result.get("references"), refs)
        del_mock.assert_not_called()

    def test_probe_not_found_returns_error_without_deleting(self):
        """非 owner / 不存在 → error:not_found,同样不删。"""
        result, del_mock, _, db = self._run(find_result={"ok": False, "error": "not_found"})
        self.assertEqual(result, {"ok": False, "error": "not_found"})
        del_mock.assert_not_called()
        db.execute.assert_not_called()

    def test_confirm_true_bypasses_probe_and_deletes(self):
        """probe 只在显式传入时生效;confirm=True 的真删路径不受影响。"""
        db = _fake_db()
        with patch("platform_app.assets_registry.find_asset_references",
                   return_value={"ok": True, "references": [], "asset": {"id": 55, "url": "u"}}), \
             patch("platform_app.assets_registry.delete_asset",
                   return_value={"ok": True, "deleted": True, "storage_key": "ai_images/abc.png"}), \
             patch.object(lib, "nullify_references"), \
             patch("platform_app.db.connect", return_value=db), \
             patch("state_event_bus.emit"):
            result = lib.delete_asset_with_refs(7, 55, confirm=True, probe=False)
        self.assertTrue(result.get("ok") and result.get("deleted"))


class BackfillSizes(unittest.TestCase):
    """list_assets 对 size=0 的行 stat 磁盘回填(修卡片显示 —)。"""

    def test_zero_size_item_backfilled_from_disk_and_persisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "img.png"
            f.write_bytes(b"x" * 2048)
            item = {"id": 1, "size": 0, "storage_key": "img.png"}
            reg = MagicMock()
            with patch("platform_app.storage.resolve_path", return_value=f):
                lib._backfill_sizes(7, [item], reg)
            self.assertEqual(item["size"], 2048)
            reg.update_asset_size.assert_called_once_with(7, 1, 2048)

    def test_nonzero_size_untouched_no_stat(self):
        item = {"id": 1, "size": 999, "storage_key": "img.png"}
        reg = MagicMock()
        with patch("platform_app.storage.resolve_path") as resolve_mock:
            lib._backfill_sizes(7, [item], reg)
        resolve_mock.assert_not_called()
        self.assertEqual(item["size"], 999)
        reg.update_asset_size.assert_not_called()

    def test_missing_file_keeps_zero_and_skips_persist(self):
        """物理文件已丢 → 保持 0(显示 —,即"未知",属实),不写库。"""
        item = {"id": 1, "size": 0, "storage_key": "ghost.png"}
        reg = MagicMock()
        with tempfile.TemporaryDirectory() as tmp:
            ghost = Path(tmp) / "ghost.png"
            with patch("platform_app.storage.resolve_path", return_value=ghost):
                lib._backfill_sizes(7, [item], reg)
        self.assertEqual(item["size"], 0)
        reg.update_asset_size.assert_not_called()

    def test_persist_failure_does_not_break_listing(self):
        """回填写库失败不影响本次展示(下次列表再 stat 一次)。"""
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "img.png"
            f.write_bytes(b"y" * 10)
            item = {"id": 1, "size": 0, "storage_key": "img.png"}
            reg = MagicMock()
            reg.update_asset_size.side_effect = RuntimeError("db down")
            with patch("platform_app.storage.resolve_path", return_value=f):
                lib._backfill_sizes(7, [item], reg)  # 不应抛
            self.assertEqual(item["size"], 10, "内存值照样回填,列表能显示")


if __name__ == "__main__":
    unittest.main()
