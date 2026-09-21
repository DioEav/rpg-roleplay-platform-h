"""
test_postproc_health.py
=======================

「后处理 worker 没在跑」必须**可见**。

背景：image_gen / acceptance_verifier / black_swan 只入队到 `chat_postproc_tasks`，由**独立
进程** `rpg/scripts/run_postproc_worker.py` 消费。这个进程不属于后端（dev.sh / docker-compose /
k8s / 桌面端都没有起它），任务于是永远停在 pending —— 界面一直「生成中」，而全程没有任何报错，
用户只能对着一动不动的弹窗猜。本文件锁住自检的三条契约：

  · 有「到点超时仍未被消费」的任务 → ok=False，并给出条数 / 最老时长 / 分类;
  · 队列干净 → ok=True（不许把健康状态误报成故障）;
  · 查询出错 → ok=True + checked=False（数据库不通已由 /api/health 的 db 字段负责报，自检不叠加误报）;
  · 文案里必须带启动命令与条数（否则运维看完仍不知道该做什么）;
  · 接线：启动查一次、运行期周期复检、且复检任务挂进 shutdown 清理。
"""
from __future__ import annotations

import asyncio
import json
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

from platform_app.postproc_health import (
    STALE_PENDING_MINUTES,
    check_postproc_worker,
    describe_postproc_health,
)

_STARTUP_PY = (
    Path(__file__).resolve().parents[2] / "core" / "startup.py"
).read_text(encoding="utf-8")
_CORE_ROUTES_PY = (
    Path(__file__).resolve().parents[2] / "routes" / "core.py"
).read_text(encoding="utf-8")


def _fake_db(rows=None, raises=None):
    if raises is not None:
        return MagicMock(side_effect=raises)
    cur = MagicMock()
    cur.fetchall.return_value = rows or []
    db = MagicMock()
    db.execute.return_value = cur
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=db)
    ctx.__exit__ = MagicMock(return_value=False)
    connect = MagicMock(return_value=ctx)
    connect.db = db  # 便于断言实际发出的 SQL
    return connect


class CheckPostprocWorker(unittest.TestCase):

    def test_stale_pending_means_no_consumer(self):
        rows = [
            {"task_kind": "image_gen", "n": 3, "oldest_age_s": 754},
            {"task_kind": "acceptance_verifier", "n": 9, "oldest_age_s": 3600},
        ]
        with patch("platform_app.db.connect", _fake_db(rows)):
            h = check_postproc_worker()
        self.assertFalse(h["ok"])
        self.assertEqual(h["stale_pending"], 12)
        self.assertEqual(h["oldest_minutes"], 60)
        self.assertEqual(h["by_kind"], {"image_gen": 3, "acceptance_verifier": 9})
        self.assertIn("run_postproc_worker", h["hint"])

    def test_healthy_queue_is_not_a_fault(self):
        with patch("platform_app.db.connect", _fake_db([])):
            h = check_postproc_worker()
        self.assertTrue(h["ok"])
        self.assertTrue(h["checked"])
        self.assertEqual(h["stale_pending"], 0)

    def test_db_error_never_reports_fault(self):
        """自检本身出错 ≠ worker 没跑;不能叠加误报(也不许把 /api/health 带崩)。"""
        with patch("platform_app.db.connect", _fake_db(raises=RuntimeError("db down"))):
            h = check_postproc_worker()
        self.assertTrue(h["ok"])
        self.assertFalse(h["checked"])
        self.assertIn("db down", h["error"])

    def test_query_only_counts_due_pending_rows(self):
        """判定谓词必须是「pending 且到点超过阈值」——别把退避中的重试也算进来。"""
        conn = _fake_db([])
        with patch("platform_app.db.connect", conn):
            check_postproc_worker()
        sql, params = conn.db.execute.call_args[0]
        sql = str(sql)
        self.assertIn("status = 'pending'", sql)
        self.assertIn("make_interval(mins => %s)", sql)
        self.assertEqual(params, (STALE_PENDING_MINUTES,), "阈值必须走参数,别写死在 SQL 字面量里")

    def test_message_is_actionable(self):
        msg = describe_postproc_health({
            "ok": False, "stale_pending": 3, "oldest_minutes": 42,
            "by_kind": {"image_gen": 3},
        })
        self.assertIn("3 条", msg)
        self.assertIn("42 分钟", msg)
        self.assertIn("image_gen", msg)          # 点出「生图一直生成中」的因果
        self.assertIn("scripts.run_postproc_worker", msg)
        self.assertIn("5432", msg)              # 直连 Postgres,不能走 PgBouncer


class HealthEndpointExposesIt(unittest.TestCase):

    def test_health_reports_postproc_field_without_flipping_ok(self):
        """队列积压不是后端病了(重启后端也修不好)→ 只报告,不改 ok(存活探针会照它重启)。"""
        import routes.core as core_routes

        with ExitStack() as stack:
            stack.enter_context(patch("platform_app.db.connect", _fake_db([])))
            stack.enter_context(patch(
                "platform_app.postproc_health.check_postproc_worker",
                MagicMock(return_value={"ok": False, "checked": True, "stale_pending": 4}),
            ))
            resp = asyncio.run(core_routes.api_health())

        body = json.loads(resp.body)
        self.assertTrue(body["ok"], "队列积压不得把存活探针判死")
        self.assertEqual(body["postproc_worker"]["stale_pending"], 4)
        self.assertFalse(body["postproc_worker"]["ok"])

    def test_health_survives_selfcheck_exception(self):
        import routes.core as core_routes

        with ExitStack() as stack:
            stack.enter_context(patch("platform_app.db.connect", _fake_db([])))
            stack.enter_context(patch(
                "platform_app.postproc_health.check_postproc_worker",
                MagicMock(side_effect=RuntimeError("boom")),
            ))
            resp = asyncio.run(core_routes.api_health())

        body = json.loads(resp.body)
        self.assertTrue(body["ok"])
        self.assertFalse(body["postproc_worker"]["checked"])


class StartupWiring(unittest.TestCase):
    """自检必须真的被挂上去,否则等于没写。"""

    def test_runs_at_startup_and_periodically(self):
        self.assertIn('_check_postproc_once("startup")', _STARTUP_PY)
        self.assertIn("check_postproc_worker", _STARTUP_PY)
        self.assertIn("await _aio.sleep(600)", _STARTUP_PY)   # 周期复检

    def test_watch_task_is_cancelled_on_shutdown(self):
        self.assertIn("_postproc_watch_task", _STARTUP_PY)
        self.assertRegex(
            _STARTUP_PY,
            r"_bg_tasks = \[t for t in \([^)]*_postproc_watch_task[^)]*\)",
            "复检任务必须进 shutdown 取消列表,否则停机时会挂着",
        )

    def test_threshold_is_ten_minutes(self):
        self.assertEqual(STALE_PENDING_MINUTES, 10)


if __name__ == "__main__":
    unittest.main()
