"""
test_image_generate_message_index.py
=====================================

`POST /api/images/generate` 必须接受并转发 `message_index`。

背景:UI 生图(点生成按钮)此前不写 ai_images.message_index → 该列恒 NULL → 前端只能靠
localStorage 索引映射 / __last 桶兜底,一删本地对话索引就漂移:**旧图爬到新对话的最新
消息上**(用户上报)。agent 工具路径(command_tools_image)早就在写 message_index,
UI 路径缺的只是端点这一段转发。

契约:
  · body 带非负整数 → 原样转发给 enqueue_image_generation(它负责写进 ai_images 行);
  · 缺失 / 非法("abc") / 负数 → 转发 None(不崩、不写脏值);
  · enqueue 返回的 image_id/status 原样带回。
"""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import MagicMock, patch

from platform_app.api.images import api_generate_image


def _fake_request(body: dict):
    req = MagicMock()

    async def _json():
        return body

    req.json = _json
    return req


class GenerateMessageIndexForwarding(unittest.TestCase):

    def _run(self, body: dict):
        captured = {}

        def _fake_enqueue(*args, **kwargs):
            captured.update(kwargs)
            return {"image_id": 7, "status": "pending"}

        with patch("platform_app.api.images.require_user", return_value={"id": 42}), \
             patch("platform_app.image_jobs.enqueue_image_generation", side_effect=_fake_enqueue):
            resp = asyncio.run(api_generate_image(_fake_request(body)))
        return captured, resp

    def test_valid_message_index_is_forwarded(self):
        captured, resp = self._run({"prompt": "一只猫", "save_id": "9", "message_index": 5})
        self.assertEqual(captured.get("message_index"), 5, "有效索引必须转发给 enqueue")
        self.assertEqual(captured.get("save_id"), "9")
        body = resp.body.decode() if isinstance(resp.body, (bytes, bytearray)) else str(resp.body)
        self.assertIn('"image_id":7', body.replace(" ", ""))

    def test_zero_index_is_valid(self):
        """第一条消息就是助手消息(存档开场)时索引为 0 —— 不能被 truthy 判断吞掉。"""
        captured, _ = self._run({"prompt": "开场图", "message_index": 0})
        self.assertEqual(captured.get("message_index"), 0)

    def test_missing_message_index_forwards_none(self):
        captured, _ = self._run({"prompt": "无索引"})
        self.assertIsNone(captured.get("message_index"))

    def test_invalid_message_index_forwards_none(self):
        """非法值不能把 400/500 抛给用户 —— 图该生成还是生成,只是没有绑定。"""
        for bad in ("abc", -3, 2.5, object()):
            captured, _ = self._run({"prompt": "非法", "message_index": bad})
            self.assertIsNone(captured.get("message_index"), f"{bad!r} 应转 None")


if __name__ == "__main__":
    unittest.main()
