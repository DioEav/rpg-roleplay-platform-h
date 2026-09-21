"""
test_cron_cli_invocations.py
============================

`run_cron` 的两种文档化调用方式都必须能跑起来，且审计必须真的落库。

背景（用户实测）：从 `rpg/` 执行 `python -m scripts.run_cron all`，7 个 job 全部成功，但每个
都打一条 `failed to write admin_audit_log ... ModuleNotFoundError: No module named 'rpg'`
—— `_write_audit` 那句 `from rpg.platform_app...` 缺双导入兜底，异常被吞成一条 ERROR 日志，
**审计日志一条都不落库**；而从仓库根执行文档里那条 `python -m rpg.scripts.run_cron` 会更早死在
`main()` 的 `from platform_app.db import ...`（`rpg.*` 前缀与顶层导入需要不同的 cwd，而 cwd 只能
有一个，deploy/bare-metal 的 ExecStart 正是这么写的）。

修法：给脚本加 `rpg/` 的 sys.path 引导（与 run_postproc_worker.py 同款）+ 补齐那一处双导入。
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_RPG_DIR = Path(__file__).resolve().parents[2]     # rpg/
_REPO_ROOT = _RPG_DIR.parent
_RUN_CRON_PY = (_RPG_DIR / "scripts" / "run_cron.py").read_text(encoding="utf-8")


def _run_py(code_or_args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, *code_or_args],
        cwd=str(cwd), capture_output=True, text=True, timeout=60,
    )


def _audit_write_target() -> str:
    """照 run_cron 的双导入逻辑,选出它**实际会用**的那个模块路径再来 patch。

    必须这样做的原因:同一个文件在两种前缀下是**两个不同的模块对象**
    (`rpg.platform_app.api.admin._shared` ≠ `platform_app.api.admin._shared`,
    实测 `a is b → False`)。patch 错一个,写入函数的调用就落在未被 patch 的那个上
    —— 本测试最初就只在 cwd=rpg/ 下通过、从仓库根跑必挂(那里 `rpg.*` 分支赢)。
    """
    try:
        import rpg.platform_app.api.admin._shared  # noqa: F401
        return "rpg.platform_app.api.admin._shared._write_audit"
    except ModuleNotFoundError:
        return "platform_app.api.admin._shared._write_audit"


class AuditActuallyLands(unittest.TestCase):

    def test_write_audit_calls_admin_writer(self):
        """行为锁：从 rpg/ 调 _write_audit，必须真的调到 admin 的写入函数。

        旧代码在这条路径上抛 ModuleNotFoundError 被吞掉 → 审计静默不落库（用户实测 7 条
        failed to write admin_audit_log）。
        """
        import scripts.run_cron as run_cron

        with patch(_audit_write_target()) as writer:
            run_cron._write_audit(MagicMock(), "cron.test_thing", {"deleted": 1})

        writer.assert_called_once()
        # 位置参数只有 db;其余走关键字(action/details/actor/target_type/...)
        self.assertEqual(writer.call_args[1]["action"], "cron.test_thing")
        self.assertEqual(writer.call_args[1]["details"], {"deleted": 1})


class ImportsResolveInBothCwds(unittest.TestCase):
    """两种 cwd 下，脚本体内用到的两类导入都必须可解析。"""

    _CODE = (
        "import platform_app.db;"          # main() 要的顶层导入
        "import sys;"                      # 供下面的 __file__ 提示
        "print('imports ok')"
    )

    def test_from_rpg_dir(self):
        proc = _run_py(["-c", self._CODE], _RPG_DIR)
        self.assertNotIn("ModuleNotFoundError", proc.stderr)
        self.assertIn("imports ok", proc.stdout)

    def test_from_repo_root_via_module_prefix(self):
        """文档里那条生产写法:`python -m rpg.scripts.run_cron`(cwd=仓库根)。

        没有 sys.path 引导时它必崩:`rpg.*` 能导但 `platform_app.*` 不能(仓库根不在路径上
        的是 rpg/)。故先 import 模块(会执行引导),再 import main() 需要的顶层模块。
        """
        proc = _run_py(["-c", "import rpg.scripts.run_cron;" + self._CODE], _REPO_ROOT)
        self.assertNotIn("ModuleNotFoundError", proc.stderr, "文档里的生产写法必须能跑")
        self.assertIn("imports ok", proc.stdout)

    def test_cli_usage_from_both_cwds(self):
        """两条命令的入口都要能起得来(不带参数只打用法、不碰数据库)。"""
        for args, cwd in ((["scripts.run_cron"], _RPG_DIR), (["rpg.scripts.run_cron"], _REPO_ROOT)):
            with self.subTest(args=args, cwd=str(cwd)):
                proc = _run_py(["-m", *args], cwd)
                self.assertNotIn("ModuleNotFoundError", proc.stderr)
                self.assertIn("Usage:", proc.stderr)
                self.assertEqual(proc.returncode, 1)


class SourceLocks(unittest.TestCase):
    """守住修法本身,别被下一个人拆掉。"""

    def test_write_audit_has_dual_import_fallback(self):
        self.assertRegex(
            _RUN_CRON_PY,
            r"from rpg\.platform_app\.api\.admin\._shared import[\s\S]{0,200}?except ModuleNotFoundError:"
            r"[\s\S]{0,120}?from platform_app\.api\.admin\._shared import",
            "rpg.* 导入必须带 `except ModuleNotFoundError` 退回顶层写法",
        )

    def test_has_syspath_bootstrap(self):
        self.assertIn("sys.path.insert(0, str(_RPG_DIR))", _RUN_CRON_PY)


if __name__ == "__main__":
    unittest.main()
