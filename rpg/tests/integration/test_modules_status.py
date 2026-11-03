"""test_modules_status — GET /api/scripts/{id}/modules-status

回归锁:
  · 7 个主模块 + 4 个增强模块都在返回里(前端矩阵按 name 渲染);
  · 每个模块带 done/total/stale/last_job_id + 前端新增契约
    last_rebuilt_at / last_status / last_error / metadata / optional;
  · worldbook_enrich 的 done/total 是"已充实/可充实"真实进度(不是候选数);
  · 可选增强模块带 optional=True(健康徽标跳过)。

patch 目标必须是 **定义模块** platform_app.api.scripts.listing——handler 已随
拆包搬到 listing.py,继续 patch 门面 `api_scripts_mod.connect` 会 patch 不到,
测试会去连真实 Postgres(旧版就是这样超时失败的)。
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from platform_app.api import scripts as api_scripts_mod
from platform_app.api.scripts import listing as listing_mod


class ModulesStatusEndpointShape(unittest.TestCase):
    def test_endpoint_registered(self):
        # 路由必须在 router 里
        routes = [r.path for r in api_scripts_mod.router.routes]
        self.assertIn("/api/scripts/{script_id}/modules-status", routes)

    def test_endpoint_returns_all_modules_with_contract_fields(self):
        """直接 import handler 后用 mock connect 测返回结构。"""
        ctx = MagicMock()
        ctx.__enter__.return_value = ctx
        ctx.__exit__.return_value = False
        # 查询顺序必须与 handler 一致:
        # owner → chunks → facts → story_phase → facts_refine → world_key
        # → not_applicable → canon → cards → worldbook
        # → anchors → embeddings → enrich_total → enrich_done
        # (enrich 两个计数在 job 映射之后,才能跟随上次成功任务的 include_editor)
        ctx.execute.return_value.fetchone.side_effect = [
            {"chapter_count": 430, "updated_at": "2026-06-01", "chapters_updated_at": "2026-06-10"},  # owner
            {"c": 430},  # chunks
            {"c": 213},  # facts
            {"c": 213},  # story_phase
            {"c": 0},    # facts_refine
            {"c": 0},    # world_key
            None,        # world_key not_applicable 探测
            {"c": 0},    # canon
            {"c": 0},    # cards
            {"c": 5},    # worldbook
            {"c": 213},  # anchors
            {"c": 100},  # embeddings
            {"c": 5},    # worldbook_enrich 候选
            {"c": 2},    # worldbook_enrich 已充实
        ]
        ctx.execute.return_value.fetchall.return_value = []  # no jobs
        with patch.object(listing_mod, "connect", return_value=ctx):
            import asyncio
            res = asyncio.new_event_loop().run_until_complete(
                api_scripts_mod.api_script_modules_status(12, user={"id": 1})
            )
        import json as _json
        body = _json.loads(res.body)
        self.assertTrue(body.get("ok"))
        mods = body.get("modules") or []
        names = [m["module"] for m in mods]
        self.assertEqual(
            names,
            ["chunks", "chapter-facts", "story_phase", "facts_refine",
             "worldbook_enrich", "world_key", "canon", "cards",
             "worldbook", "anchors", "embeddings"],
        )
        by_name = {m["module"]: m for m in mods}
        # 前端新增契约字段必须全部存在(缺一个就会退回"未知/不显示时间/失败态丢失")
        for m in mods:
            for k in ("done", "total", "stale", "last_job_id", "last_rebuilt_at",
                      "last_status", "last_error", "optional"):
                self.assertIn(k, m, f"module {m['module']} 缺 {k}")
        # worldbook_enrich 不再把候选数当 done:2/5 才是真实进度,done>0 且 <total → partial
        self.assertEqual(by_name["worldbook_enrich"]["done"], 2)
        self.assertEqual(by_name["worldbook_enrich"]["total"], 5)
        self.assertEqual(by_name["worldbook_enrich"]["status"], "partial")
        self.assertTrue(by_name["worldbook_enrich"]["optional"])
        # 可选增强模块统一 optional=True;主模块 False
        for m in ("story_phase", "facts_refine", "worldbook_enrich", "world_key"):
            self.assertTrue(by_name[m]["optional"], m)
        for m in ("chunks", "chapter-facts", "canon", "cards", "worldbook", "anchors", "embeddings"):
            self.assertFalse(by_name[m]["optional"], m)
        # 主模块状态:chunks 430/430 ready;facts 213/430 partial
        self.assertEqual(by_name["chunks"]["status"], "ready")
        self.assertEqual(by_name["chapter-facts"]["status"], "partial")
        # 无 job 时时间/错误字段是空值而不是缺失
        self.assertIsNone(by_name["chunks"]["last_rebuilt_at"])
        self.assertEqual(by_name["chunks"]["last_error"], "")

    def _run_with_jobs(self, jobs, chapters_updated_at="2026-06-20", embeddings_done=100):
        ctx = MagicMock()
        ctx.__enter__.return_value = ctx
        ctx.__exit__.return_value = False
        ctx.execute.return_value.fetchone.side_effect = [
            {"chapter_count": 430, "updated_at": "2026-05-01",
             "chapters_updated_at": chapters_updated_at},           # owner
            {"c": 430},  # chunks
            {"c": 213},  # facts
            {"c": 213},  # story_phase
            {"c": 0},    # facts_refine
            {"c": 0},    # world_key
            None,        # not_applicable 探测
            {"c": 10},   # canon
            {"c": 5},    # cards
            {"c": 5},    # worldbook
            {"c": 213},  # anchors
            {"c": embeddings_done},  # embeddings
            {"c": 5},    # worldbook_enrich 候选
            {"c": 2},    # worldbook_enrich 已充实
        ]
        ctx.execute.return_value.fetchall.return_value = jobs
        with patch.object(listing_mod, "connect", return_value=ctx):
            import asyncio
            res = asyncio.new_event_loop().run_until_complete(
                api_scripts_mod.api_script_modules_status(12, user={"id": 1})
            )
        import json as _json
        body = _json.loads(res.body)
        return {m["module"]: m for m in (body.get("modules") or [])}

    def test_stale_propagates_along_dependency_graph(self):
        """编辑一章只点亮直接依赖章节的模块,不再让整个矩阵变红。

        旧实现:chapters_updated_at > 任意模块 last_job → 全部 stale(改个错别字 8 张卡全红)。
        新实现:chunks/chapter-facts 直接吃章节 → stale;canon 全量也读章节(保守) → stale;
        anchors/story_phase 的上游是 chapter-facts(其 job 仍是旧时间) → 不 stale;
        cards/worldbook/embeddings 的上游 job 也还是旧时间 → 不 stale。
        """
        jobs = [{
            "kind": "full_pipeline", "job_id": "j1", "status": "done",
            "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
            "error": "",
        }]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-06-20")
        self.assertEqual(by["chunks"]["status"], "stale")
        self.assertEqual(by["chapter-facts"]["status"], "stale")
        self.assertEqual(by["canon"]["status"], "stale")
        for name in ("anchors", "story_phase", "cards", "worldbook", "embeddings",
                     "facts_refine", "world_key", "worldbook_enrich"):
            self.assertNotEqual(by[name]["status"], "stale", f"{name} 不应被章节编辑点亮")
        # 最近重建时间来自 last job.finished_at(前端「x 分钟前」依赖它)
        self.assertEqual(by["chunks"]["last_rebuilt_at"], "2026-06-01 00:00:00")

    def test_last_failed_job_is_surfaced_and_truncated(self):
        """失败态常驻:last_status/last_error 必须透出(只留首行,防 traceback 泄漏)。"""
        jobs = [
            {"kind": "rebuild_cards", "job_id": "j2", "status": "failed",
             "finished_at": "2026-06-02 00:00:00", "created_at": "2026-06-02 00:00:00",
             "error": "boom\nTraceback (most recent call last): ..."},
            {"kind": "full_pipeline", "job_id": "j1", "status": "done",
             "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
             "error": ""},
        ]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-05-01")
        self.assertEqual(by["cards"]["last_status"], "failed")
        self.assertEqual(by["cards"]["last_error"], "boom")
        # last_rebuilt_at 取"最近一次成功重建"(full_pipeline 06-01),不是失败尝试的 06-02
        self.assertEqual(by["cards"]["last_rebuilt_at"], "2026-06-01 00:00:00")
        # 失败任务不改变数据计数派生:5 张卡仍在 → ready(失败态由前端额外提示)
        self.assertEqual(by["cards"]["status"], "ready")

    def test_failed_rebuild_does_not_hide_stale(self):
        """失败的重建不能把 stale 洗白。

        旧逻辑用"最近一次 job 的 finished_at"判 stale:chunks 明明已因章节编辑过期,
        用户点重做但失败 → 失败的 finished_at 比章节新 → 卡片反而显示"就绪"
        (只有几秒 toast 提过失败)。现在 stale 只看最近一次**成功**重建。
        """
        jobs = [
            {"kind": "rebuild_chunks", "job_id": "j2", "status": "failed",
             "finished_at": "2026-06-21 00:00:00", "created_at": "2026-06-21 00:00:00",
             "error": "provider down"},
            {"kind": "full_pipeline", "job_id": "j1", "status": "done",
             "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
             "error": ""},
        ]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-06-20")
        self.assertEqual(by["chunks"]["last_status"], "failed")
        self.assertEqual(by["chunks"]["last_error"], "provider down")
        self.assertEqual(by["chunks"]["last_rebuilt_at"], "2026-06-01 00:00:00")
        self.assertEqual(by["chunks"]["status"], "stale")

    def test_auto_embedded_chunks_do_not_leave_embeddings_stale(self):
        """增量重切自动补块向量后,embeddings 卡不应因 chunks 任务更新而假过期。

        场景:chunks 共 430 块且全部有向量(embed_done=430),chunks 增量任务 06-05
        成功;embeddings 卡上一次成功任务仍是 06-01。旧逻辑把 chunks 当上游 →
        stale,诱导用户再点一次全量 embedding。块齐全时视为 chunks 上游已同步。
        """
        jobs = [
            {"kind": "rebuild_chunks", "job_id": "j2", "status": "done",
             "finished_at": "2026-06-05 00:00:00", "created_at": "2026-06-05 00:00:00",
             "error": "", "budget_estimate": {"options": {"incremental": True}}},
            {"kind": "full_pipeline", "job_id": "j1", "status": "done",
             "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
             "error": ""},
        ]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-06-01", embeddings_done=430)
        self.assertFalse(by["embeddings"]["stale"])
        self.assertEqual(by["embeddings"]["status"], "ready")

    def test_incomplete_embeddings_still_stale_after_chunks_rebuild(self):
        """自动补向量没跑/没跑完(done<total)时,embeddings 仍应提示过期。"""
        jobs = [
            {"kind": "rebuild_chunks", "job_id": "j2", "status": "done",
             "finished_at": "2026-06-05 00:00:00", "created_at": "2026-06-05 00:00:00",
             "error": "", "budget_estimate": {"options": {"incremental": True}}},
            {"kind": "full_pipeline", "job_id": "j1", "status": "done",
             "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
             "error": ""},
        ]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-06-01", embeddings_done=100)
        self.assertTrue(by["embeddings"]["stale"])
        self.assertEqual(by["embeddings"]["status"], "stale")

    def test_full_canon_rebuild_counts_as_cards_worldbook_anchors_refresh(self):
        """rebuild_canon 全量跑的是 run_llm_extraction 全链路,会顺带刷新
        cards/timeline/worldbook —— 映射不全会让这些模块在数据已刷新后仍显示过期。"""
        jobs = [
            {"kind": "rebuild_canon", "job_id": "j2", "status": "done",
             "finished_at": "2026-06-05 00:00:00", "created_at": "2026-06-05 00:00:00",
             "error": "", "budget_estimate": {"options": {}}},
            {"kind": "full_pipeline", "job_id": "j1", "status": "done",
             "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
             "error": ""},
        ]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-06-01")
        for m in ("canon", "cards", "worldbook", "anchors"):
            self.assertEqual(by[m]["last_rebuilt_at"], "2026-06-05 00:00:00", m)

    def test_resolve_only_canon_does_not_mark_cards_fresh(self):
        """resolve_only 只写 canon,不能把 cards/worldbook 的时间也刷成新。"""
        jobs = [
            {"kind": "rebuild_canon", "job_id": "j2", "status": "done",
             "finished_at": "2026-06-05 00:00:00", "created_at": "2026-06-05 00:00:00",
             "error": "", "budget_estimate": {"options": {"source": "resolve_only"}}},
            {"kind": "full_pipeline", "job_id": "j1", "status": "done",
             "finished_at": "2026-06-01 00:00:00", "created_at": "2026-06-01 00:00:00",
             "error": ""},
        ]
        by = self._run_with_jobs(jobs, chapters_updated_at="2026-06-01")
        self.assertEqual(by["canon"]["last_rebuilt_at"], "2026-06-05 00:00:00")
        self.assertEqual(by["cards"]["last_rebuilt_at"], "2026-06-01 00:00:00")
        self.assertEqual(by["worldbook"]["last_rebuilt_at"], "2026-06-01 00:00:00")


if __name__ == "__main__":
    unittest.main()
