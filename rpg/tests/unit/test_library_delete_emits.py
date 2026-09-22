"""
test_library_delete_emits.py
============================

文件库删除图片资产后,必须广播 `image/deleted` SSE 事件。

用户上报:在文件库删除 AI 生图后,**聊天界面上的图没有被移除,只是显示不出内容** ——
聊天气泡里的缩略图指向 `/api/storage/ai_images/<file>`,删除把文件删了、但没有任何通知,
聊天的 `<img>` 404,留下一个空图位。修法:delete_asset_with_refs 删除成功后 emit
`(user_id, "image", "deleted", {image_id, url, storage_key})`,前端 useSaveImages 按 url
尾段匹配移除。

本文件 mock 掉 assets_registry 的三个依赖与 state_event_bus.emit,不需要真库:
  · 删除成功 → emit 恰好一次,负载带 url / storage_key / image_id(=asset_id);
  · not_found(没删成)→ 不 emit;
  · 通知失败(emit 抛异常)→ 不影响删除结果返回。
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from platform_app import library as lib

ASSET = {
    "id": 55,
    "kind": "ai_image",
    "url": "/api/storage/ai_images/abc.png",
    "storage_key": "ai_images/abc.png",
}


def _fake_db():
    """能记录 execute 的假连接:with connect() as db → 同一个 mock(便于断言)。"""
    db = MagicMock()
    db.__enter__.return_value = db
    return db


class DeleteEmitsImageDeleted(unittest.TestCase):

    def _run(self, *, find_result, delete_result, db=None):
        emitted = []
        db = db or _fake_db()
        # _reg 是 delete_asset_with_refs 函数内的 local import(`from . import assets_registry`),
        # 所以直接 patch assets_registry 模块的属性;ai_images 清理走 platform_app.db.connect。
        with patch("platform_app.assets_registry.find_asset_references", return_value=find_result), \
             patch("platform_app.assets_registry.delete_asset", return_value=delete_result), \
             patch.object(lib, "nullify_references"), \
             patch("platform_app.db.connect", return_value=db), \
             patch("state_event_bus.emit", side_effect=lambda *a: emitted.append(a)):
            result = lib.delete_asset_with_refs(7, 55, confirm=True)
        return result, emitted

    def _assert_ai_images_purged(self, db):
        """删除成功必须同步清掉 ai_images 里的同图行(根治刷新后死图被历史接口拉回)。"""
        purges = [c for c in db.execute.call_args_list if "delete from ai_images" in str(c[0][0])]
        self.assertEqual(len(purges), 1, "应恰好一条 ai_images 清理语句")
        sql, params = purges[0][0]
        self.assertIn("user_id = %s", sql, "必须限本用户")
        self.assertEqual(params[0], 7)
        self.assertEqual(params[1], ASSET["url"], "精确 url 匹配(两表存同一字符串)")
        self.assertEqual(params[2], "%/abc.png", "文件名尾段兜底(覆盖相对/绝对写法差异)")

    def test_successful_delete_emits_image_deleted(self):
        db = _fake_db()
        result, emitted = self._run(
            find_result={"ok": True, "references": [], "asset": dict(ASSET)},
            delete_result={"ok": True, "deleted": True, "storage_key": "ai_images/abc.png"},
            db=db,
        )
        self.assertTrue(result["ok"] and result["deleted"])
        self._assert_ai_images_purged(db)
        self.assertEqual(len(emitted), 1, "删除成功必须广播一次 image/deleted")
        user_id, topic, op, payload = emitted[0]
        self.assertEqual((user_id, topic, op), (7, "image", "deleted"))
        self.assertEqual(payload["image_id"], 55)
        self.assertEqual(payload["url"], ASSET["url"])
        self.assertEqual(payload["storage_key"], "ai_images/abc.png")

    def test_not_found_does_not_emit(self):
        result, emitted = self._run(
            find_result={"ok": False, "error": "not_found"},
            delete_result={"ok": False, "error": "not_found"},
        )
        self.assertEqual(result, {"ok": False, "error": "not_found"})
        self.assertEqual(emitted, [], "没删成就不许广播")

    def test_not_found_does_not_purge_ai_images(self):
        """没删成就不能动 ai_images —— 否则一次误调用会清掉别人的图。"""
        db = _fake_db()
        result, _ = self._run(
            find_result={"ok": False, "error": "not_found"},
            delete_result={"ok": False, "error": "not_found"},
            db=db,
        )
        self.assertEqual(
            [c for c in db.execute.call_args_list if "delete from ai_images" in str(c[0][0])],
            [], "not_found 路径不得触发 ai_images 清理",
        )

    def test_purge_failure_does_not_break_delete(self):
        """ai_images 清理是尽力而为:DB 异常时删除结果必须照常返回(聊天侧有 onError 兜底)。"""
        broken_db = _fake_db()
        broken_db.execute.side_effect = RuntimeError("db down")
        result, _ = self._run(
            find_result={"ok": True, "references": [], "asset": dict(ASSET)},
            delete_result={"ok": True, "deleted": True, "storage_key": "ai_images/abc.png"},
            db=broken_db,
        )
        self.assertTrue(result["ok"] and result["deleted"])

    def test_emit_failure_does_not_break_delete(self):
        """通知是锦上添花:emit 抛异常时删除结果必须照常返回,不能把删除"回滚"成失败。"""
        with patch("platform_app.assets_registry.find_asset_references", return_value={"ok": True, "references": [], "asset": dict(ASSET)}), \
             patch("platform_app.assets_registry.delete_asset", return_value={"ok": True, "deleted": True, "storage_key": ASSET["storage_key"]}), \
             patch("platform_app.db.connect", return_value=MagicMock()), \
             patch("state_event_bus.emit", side_effect=RuntimeError("redis down")):
            result = lib.delete_asset_with_refs(7, 55, confirm=True)
        self.assertTrue(result["ok"] and result["deleted"])


if __name__ == "__main__":
    unittest.main()
