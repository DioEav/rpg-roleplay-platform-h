"""
test_image_jobs_fail_paths.py
=============================

`handle_image_gen` 里两个「失败时必须写终态」的分支。

前端每 2s 轮询 `GET /api/images/{id}` 直到终态(done / failed / cancelled)。而这里有两处
失败会**不写终态**:

  ① 取消检查的 DB 查询报错时直接 `return`(原注释「跳过写回以防覆盖取消」);
  ② `update_image_record("done")` 失败只 `log.warning`。

两者都会让 `ai_images` 永久停在 `generating` —— 前端轮询没有任何出口,界面关掉之后还在照打
(用户报「后端一直在 GET /api/images/1」)。本文件锁死:两条路径都必须落到 `failed`。

注:`update_image_record` / `store_image` 是 `handle_image_gen` 在**函数内**从
`platform_app.api.images` 导入的,`_fail()` 也是同样方式,所以 patch 该模块属性即可同时覆盖两处。
"""
from __future__ import annotations

import asyncio
import unittest
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

import platform_app.image_jobs as ij

PAYLOAD = {
    "image_id": 7,
    "user_id": 3,
    "prompt": "a cat",
    "kind": "chat",
    "api_id": "openai",
    "model": "gpt-image-1",
    "extra": {},
}


def _fake_db_connect(status: str = "generating"):
    """可用的 connect():取消检查查询返回给定 status。"""
    cur = MagicMock()
    cur.fetchone.return_value = {"status": status}
    db = MagicMock()
    db.execute.return_value = cur
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=db)
    ctx.__exit__ = MagicMock(return_value=False)
    return MagicMock(return_value=ctx)


def _recorder(calls: list):
    """记录 `<status>:ok` / `<status>:raised`;只让 'done' 这一步失败。"""
    def _f(image_id, status, **kw):
        if status == "done":
            calls.append(f"{status}:raised")
            raise RuntimeError("simulated update failure")
        calls.append(f"{status}:ok")
        return None
    return _f


class ImageFailPaths(unittest.TestCase):

    def _run(self, *, db_connect, calls):
        with ExitStack() as stack:
            stack.enter_context(patch(
                "platform_app.api.images.update_image_record",
                MagicMock(side_effect=_recorder(calls)),
            ))
            stack.enter_context(patch(
                "platform_app.api.images.store_image",
                MagicMock(return_value="https://x/y.png"),
            ))
            stack.enter_context(patch(
                "platform_app.user_credentials.resolve_api_key",
                MagicMock(return_value={"key": "k", "base_url_override": ""}),
            ))
            stack.enter_context(patch(
                "agents.image_gen.dispatch.generate_image_bytes",
                MagicMock(return_value=[b"png"]),
            ))
            stack.enter_context(patch("platform_app.db.connect", db_connect))
            # 后续步骤也打桩:老代码「写 done 失败只 log」时会继续往下走(登记资产 / SSE),
            # 不打桩就会去连真库 → 测试挂死。打桩后本用例与具体代码路径无关。
            stack.enter_context(patch("platform_app.assets_registry.register_asset", MagicMock()))
            stack.enter_context(patch("platform_app.image_jobs._notify_image_ready", MagicMock()))
            asyncio.run(ij.handle_image_gen(dict(PAYLOAD)))

    def test_cancel_check_db_error_marks_failed(self):
        """取消检查查询报错 → 必须标 failed,不能默默 return 把记录留在 generating。"""
        calls: list = []
        self._run(db_connect=MagicMock(side_effect=RuntimeError("db down")), calls=calls)
        self.assertIn("generating:ok", calls)
        self.assertIn("failed:ok", calls,
                      "取消检查失败后记录会永久停在 generating,前端 2s 轮询没有出口")

    def test_done_update_failure_marks_failed(self):
        """写 done 失败 → 必须标 failed,而不是只记一条 warning。"""
        calls: list = []
        self._run(db_connect=_fake_db_connect("generating"), calls=calls)
        self.assertEqual(calls[0], "generating:ok")
        self.assertIn("failed:ok", calls,
                      "写 done 失败后记录会永久停在 generating,前端 2s 轮询没有出口")
        self.assertNotIn("done:ok", calls)

    def test_cancelled_still_wins(self):
        """取消仍然是粘性的:完成前被取消 → 丢弃结果,不写 done 也不改成 failed。"""
        calls: list = []
        self._run(db_connect=_fake_db_connect("cancelled"), calls=calls)
        self.assertEqual(calls, ["generating:ok"], "取消后不应再写任何终态")


if __name__ == "__main__":
    unittest.main()
