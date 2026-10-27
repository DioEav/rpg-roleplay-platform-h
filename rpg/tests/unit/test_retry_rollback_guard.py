"""重试回滚 off-by-one 防线守卫(群反馈 行者无疆 2026-07-15)。

病灶:安全过滤/生成失败的轮次不落库,restoreFailedDraft 把本轮玩家气泡从前端历史移除;
「重试」从历史找最后一条玩家输入定位 rollback 点 → 找到的是【上一个好回合】,
rollbackToMessage 会【成功】把好回合滚进 trash——每次失败重试多吃一轮,
玩家被迫去分支树手动找最新回合(268 档 trash refs 连环实锤)。

防线(entries/game-console.jsx):
  ① restoreFailedDraft 置 runRef.current.lastRunFailedUnpersisted = true;
  ② startRunReal 开跑清位(onRetry 在 startRun 之前消费);
  ③ onRetry 在 rollbackToMessage 前双判据:失败标记 || 定位文本 != 重发文本 → 跳过 rollback。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
GC = (_ROOT / "frontend" / "src" / "entries" / "game-console.jsx").read_text(encoding="utf-8")


class RetryRollbackOffByOneGuard(unittest.TestCase):
    def test_failed_draft_sets_unpersisted_flag(self):
        m = re.search(
            r"const restoreFailedDraft = \([^)]*\) => \{(.{0,6000}?)\n    \};",
            GC, re.S,
        )
        self.assertIsNotNone(m, "restoreFailedDraft 函数体应存在")
        self.assertIn("lastRunFailedUnpersisted = true", m.group(1),
            "restoreFailedDraft 必须置失败轮未落库标记(off-by-one 防线①)")

    def test_run_start_clears_flag(self):
        self.assertIn("runRef.current.lastRunFailedUnpersisted = false", GC,
            "startRunReal 开跑必须清位(防线②)")
        # 清位必须发生在置位判定之前的开跑区(粗定位:清位语句先于 restoreFailedDraft 定义)
        self.assertLess(GC.index("lastRunFailedUnpersisted = false"),
                        GC.index("const restoreFailedDraft"),
            "清位应在 startRunReal 开跑区,早于 restoreFailedDraft 定义")

    def test_retry_guards_rollback(self):
        # onRetry 的 rollback 调用点之前必须消费失败标记 + 文本一致性双判据
        idx = GC.index("rollbackToMessage(saveId, pIdx)")
        window = GC[max(0, idx - 1200):idx]
        self.assertIn("lastRunFailedUnpersisted === true", window,
            "onRetry 必须在 rollback 前读失败标记(防线③)")
        self.assertIn("_pContent === t2", window,
            "onRetry 必须校验定位到的历史输入与重发文本一致才允许 rollback(防线③)")
