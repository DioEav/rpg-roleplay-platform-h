"""
test_image_delete_download_endpoints.py
=======================================

聊天图片「查看时下载 / 删除」的两个端点(交互对齐文件库):

  · GET  /api/images/{id}/download — owner 校验后 FileResponse(Content-Disposition: attachment);
  · POST /api/images/{id}/delete   — 删物理文件 + 同 url 的 user_assets 行 + ai_images 行,
                                     并广播 image/deleted(开着的聊天页实时移除缩略图)。

patch 缝说明:images.py 顶部 `from ..db import connect, init_db` 是**模块属性绑定**,
所以 DB 缝打在 `platform_app.api.images.connect/init_db` 上;storage / state_event_bus /
nullify_references 是函数内 lazy import,打回各自模块即可。
"""
from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import platform_app.api.images as images_api

USER = {"id": 7}
RECORD = {"id": 7, "user_id": 7, "url": "/api/storage/ai_images/abc.png",
          "status": "done", "kind": "game", "params": {}}


def _fake_db():
    db = MagicMock()
    db.__enter__.return_value = db
    return db


class DeleteEndpoint(unittest.TestCase):

    def _run(self, *, record):
        """跑删除端点,返回 (响应体, mock 句柄集)。"""
        emitted, del_file, nullify = [], MagicMock(), MagicMock()
        db = _fake_db()
        with patch.object(images_api, "get_image_record", return_value=record), \
             patch.object(images_api, "require_user", return_value=USER), \
             patch.object(images_api, "init_db"), \
             patch.object(images_api, "connect", return_value=db), \
             patch("platform_app.storage.delete_file", del_file), \
             patch("platform_app.storage.find_references", return_value=[]), \
             patch("platform_app.library.nullify_references", nullify), \
             patch("state_event_bus.emit", side_effect=lambda *a: emitted.append(a)):
            resp = asyncio.run(images_api.api_delete_image(7, MagicMock()))
        return resp, db, emitted, del_file, nullify

    def test_owner_delete_clears_file_rows_and_emits(self):
        import json
        resp, db, emitted, del_file, nullify = self._run(record=dict(RECORD))
        body = json.loads(resp.body)
        self.assertTrue(body["ok"] and body["deleted"])
        del_file.assert_called_once_with("ai_images/abc.png")
        sqls = [str(c[0][0]).lower() for c in db.execute.call_args_list]
        self.assertTrue(any("delete from user_assets" in s for s in sqls))
        self.assertTrue(any("delete from ai_images" in s and "user_id = %s" in s for s in sqls))
        self.assertEqual(len(emitted), 1, "删除成功必须广播一次 image/deleted")
        user_id, topic, op, payload = emitted[0]
        self.assertEqual((user_id, topic, op), (7, "image", "deleted"))
        self.assertEqual(payload["url"], RECORD["url"])

    def test_not_owner_returns_404_and_touches_nothing(self):
        other = dict(RECORD, user_id=99)
        resp, db, emitted, del_file, nullify = self._run(record=other)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(emitted, [])
        self.assertEqual(db.execute.call_count, 0, "非 owner 不得触发任何删除 SQL")
        del_file.assert_not_called()
        nullify.assert_not_called()


class DownloadEndpoint(unittest.TestCase):

    def test_owner_download_returns_attachment(self):
        tmp = Path(__file__).parent / "_tmp_dl.png"
        tmp.write_bytes(b"\x89PNG")
        try:
            record = dict(RECORD, url="/api/storage/ai_images/abc.png", mime="image/png")
            with patch.object(images_api, "get_image_record", return_value=record), \
                 patch.object(images_api, "require_user", return_value=USER), \
                 patch("platform_app.storage.resolve_path", return_value=tmp):
                resp = asyncio.run(images_api.api_download_image(7, MagicMock()))
            self.assertIn("attachment", resp.headers.get("content-disposition", ""))
            self.assertEqual(resp.media_type, "image/png")
        finally:
            tmp.unlink(missing_ok=True)

    def test_missing_file_returns_404(self):
        ghost = Path(__file__).parent / "_no_such_file.png"
        if ghost.exists():
            ghost.unlink()
        record = dict(RECORD, url="/api/storage/ai_images/ghost.png")
        with patch.object(images_api, "get_image_record", return_value=record), \
             patch.object(images_api, "require_user", return_value=USER), \
             patch("platform_app.storage.resolve_path", return_value=ghost):
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(images_api.api_download_image(7, MagicMock()))
        self.assertEqual(ctx.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
