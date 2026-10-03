"""源码级不变量:「阶段划分」(story_phase) 重做模块的注册与执行链。

背景:导入 full_pipeline 里的 _stage_story_phase_llm 只在导入时跑一次 —— 导入管线
失败/老剧本永远没有阶段数据(时间线全挤「未分阶段」桶,phase_digests 空表,
出生点分组退化为机械均分)。本文件锁死补跑模块的接线完整性。
"""
from __future__ import annotations

import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]  # rpg/


class StoryPhaseModuleWiring(unittest.TestCase):
    def setUp(self):
        pkg = PROJECT / "platform_app" / "import_pipeline"
        self.pipeline = "\n".join(p.read_text(encoding="utf-8") for p in sorted(pkg.glob("*.py")))
        self.listing = (PROJECT / "platform_app" / "api" / "scripts" / "listing.py").read_text(encoding="utf-8")
        self.tasks = (PROJECT / "platform_app" / "api" / "me" / "tasks.py").read_text(encoding="utf-8")

    def test_registered_with_llm(self):
        self.assertIn('"story_phase"', self.pipeline)
        self.assertIn('("rebuild_story_phase",  "阶段划分",   True)', self.pipeline)

    def test_worker_dispatched_and_implemented(self):
        self.assertIn('elif module == "story_phase":', self.pipeline)
        self.assertIn("def _rebuild_story_phase(", self.pipeline)
        # 三段执行:LLM 划分 → phase_digests 聚合 → 锚点回填
        self.assertIn("_stage_story_phase_llm(ctl, user_id, script_id)", self.pipeline)
        self.assertIn("_stage_phase_digests(script_id)", self.pipeline)
        self.assertIn("update script_timeline_anchors a", self.pipeline)
        # 只更新 story_phase 字段,不整表重建锚点(保护用户手编)
        self.assertIn("set story_phase = m.phase", self.pipeline)
        self.assertNotIn("delete from script_timeline_anchors", self.pipeline)

    def test_worker_guards_empty_facts(self):
        self.assertIn('chapter_facts 为空,请先重做「章节事实」再划分阶段', self.pipeline)

    def test_estimate_and_prereq_wired(self):
        self.assertIn("def _estimate_tokens_story_phase(", self.pipeline)
        self.assertIn('est_in, est_out = _estimate_tokens_story_phase()', self.pipeline)
        # affects 声明三张表;前置阻断与 facts_refine 同款
        self.assertIn('"story_phase": ["chapter_facts", "phase_digests", "script_timeline_anchors"]', self.pipeline)
        self.assertIn('if module == "story_phase":', self.pipeline)

    def test_status_and_task_label_wired(self):
        self.assertIn('"rebuild_story_phase": ["story_phase"]', self.listing)
        self.assertIn('"rebuild_story_phase": "阶段划分"', self.tasks)

    def test_full_extraction_credits_covered_modules(self):
        # 全量提取必须计入其覆盖的模块最近任务,否则那些卡在全量提取后仍误报「需要重建」
        self.assertIn('"llm_extract": ["canon", "cards", "anchors", "worldbook"]', self.listing)
        self.assertIn('"full_pipeline": ["chunks", "chapter-facts", "canon", "cards",', self.listing)

    def test_frontend_card_registered(self):
        panel = (PROJECT.parent / "frontend" / "src" / "pages" / "script-modules-panel.jsx").read_text(encoding="utf-8")
        card = (PROJECT.parent / "frontend" / "src" / "components" / "ModuleStatusCard.jsx").read_text(encoding="utf-8")
        self.assertIn("id: 'story_phase'", panel)
        self.assertIn("story_phase:   { source: 'llm' }", card)


if __name__ == "__main__":
    unittest.main()


class AdaptivePhaseSampling(unittest.TestCase):
    """自适应采样密度:每 10 章 1 点,clamp(50,300),短书全量,字符预算抽稀。"""

    def _rows(self, n, summary_chars=150):
        return [{"chapter": i, "title": f"第{i}章",
                 "summary": "节" * summary_chars} for i in range(1, n + 1)]

    def test_short_book_full_coverage(self):
        from platform_app.import_pipeline.stages_llm import _sample_phase_rows
        for n in (3, 30, 50):
            s = _sample_phase_rows(self._rows(n))
            self.assertEqual(len(s), n, f"{n} 章书应全量覆盖")
            self.assertEqual([r["chapter"] for r in s], list(range(1, n + 1)))

    def test_mid_book_every_10_chapters(self):
        from platform_app.import_pipeline.stages_llm import _sample_phase_rows
        s = _sample_phase_rows(self._rows(1487))
        self.assertLessEqual(len(s), 151)      # 步长点 + 尾部保证
        self.assertGreaterEqual(len(s), 130)   # ~137 点(≈11 章/点)
        self.assertEqual(s[0]["chapter"], 1)   # 张满全书:首尾都在
        self.assertEqual(s[-1]["chapter"], 1487)  # 尾部保证(结局判断必须看到结尾)

    def test_mega_book_capped_at_300(self):
        from platform_app.import_pipeline.stages_llm import _sample_phase_rows
        s = _sample_phase_rows(self._rows(12000))
        self.assertLessEqual(len(s), 301)      # 步长点 + 尾部保证
        self.assertEqual(s[0]["chapter"], 1)
        self.assertEqual(s[-1]["chapter"], 12000)

    def test_char_budget_thins_uniformly(self):
        from platform_app.import_pipeline.stages_llm import (
            _PHASE_SAMPLE_CHAR_BUDGET, _sample_phase_rows)
        # 300 点 × 500 字摘要 = 15 万字 >> 6 万预算 → 抽稀但不低于 50 点
        s = _sample_phase_rows(self._rows(6000, summary_chars=500))
        self.assertLessEqual(len(s), 300)
        self.assertGreaterEqual(len(s), 50)
        total_chars = sum(len(r["summary"]) + 20 for r in s)
        self.assertLessEqual(total_chars, _PHASE_SAMPLE_CHAR_BUDGET)
        # 抽稀保分布:首尾仍在
        self.assertEqual(s[0]["chapter"], 1)
        self.assertEqual(s[-1]["chapter"], 6000)

    def test_empty_rows(self):
        from platform_app.import_pipeline.stages_llm import _sample_phase_rows
        self.assertEqual(_sample_phase_rows([]), [])
