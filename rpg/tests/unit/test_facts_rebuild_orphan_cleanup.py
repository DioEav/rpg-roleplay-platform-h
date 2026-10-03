"""源码级不变量:章节事实重建必须清理孤儿行。

背景:用户合并章节后 scripts.chapter_count=1486,但 chapter_facts 仍 1487 条 ——
merge_chapters 只改章节表(其 docstring 明示派生数据需重新提取),而
rebuild_facts_from_db 只按现有章 upsert、不删指向已删除章的旧行 →
孤儿行永久残留,状态卡 done(1487) > total(1486)。
"""
from __future__ import annotations

import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]  # rpg/
SRC = (PROJECT / "platform_app" / "import_pipeline" / "rebuild_modules.py").read_text(encoding="utf-8")


class FactsRebuildOrphanCleanup(unittest.TestCase):
    def test_orphan_delete_present(self):
        # 重建后必须删除 chapter_index 已不存在于 script_chapters 的孤儿 facts 行
        self.assertIn("delete from chapter_facts cf", SRC)
        self.assertIn("not exists (select 1 from script_chapters sc", SRC)
        self.assertIn("sc.chapter_index = cf.chapter", SRC)

    def test_after_count_reflects_post_delete(self):
        # after_count 必须取清理后的真实计数,而不是 upsert 计数(否则孤儿行继续虚增)
        self.assertIn("after_count = int(after_row[\"c\"]) if after_row else 0", SRC)
        self.assertIn('"after_count": after_count', SRC)


if __name__ == "__main__":
    unittest.main()
