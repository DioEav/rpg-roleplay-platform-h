"""test_rebuild_fix_guards — 2026-10 模块矩阵修复的回归守卫。

覆盖本轮修复中「行为变化」最容易被后续重构破坏的几条:
  1. 同一剧本单飞 + 同 kind 任务参数校验(不能再静默复用错模式);
  2. 零 LLM 角色卡重做默认保护已有 identity/别名(手编不被覆盖);
  3. 源码级不变量:
     · world_key 只补空 in_world_time,不覆盖 facts_refine 的精炼结果;
     · canon 零 LLM 重聚类包含 item 实体;
     · worldbook_enrich 默认跳过 editor 手编条目;
     · embeddings 重做等后台嵌入真正结束才收尾。
"""
from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from extract.resolve import CanonEntity, _canon_overwritten_fields
from platform_app.api.script_edit.worldbook import _wb_changed_fields
from platform_app.import_pipeline import rebuild_modules as rm
from platform_app.import_pipeline import rebuild_scheduler as sched
from platform_app.import_pipeline import rebuild_worker as rw
from platform_app.knowledge._manual import (
    CANON_MANUAL_FIELDS,
    CARD_MANUAL_FIELDS,
    WORLDBOOK_LLM_WRITTEN_FIELDS,
    WORLDBOOK_MANUAL_FIELDS,
    WORLDBOOK_REBUILD_WRITTEN_FIELDS,
    clear_canon_force_marks,
    clear_character_card_force_marks,
    clear_overwritten_manual_fields,
    clear_worldbook_force_marks,
    is_legacy_editor,
    protected_canon_fields,
    protected_card_fields,
    unlock_manual_fields,
)
from platform_app.knowledge.character_cards import _diff_card_manual_fields

PROJECT = Path(__file__).resolve().parents[2]  # rpg/


def _fake_connect_cm(db: MagicMock):
    cm = MagicMock()
    cm.__enter__.return_value = db
    cm.__exit__.return_value = False
    return cm


class ScheduleSingleFlight(unittest.TestCase):
    def _run(self, existing, module="chunks", body=None):
        db = MagicMock()
        db.execute.return_value.fetchone.return_value = existing
        with patch.object(sched, "init_db"), \
             patch.object(sched, "connect", return_value=_fake_connect_cm(db)), \
             patch.object(sched, "script_owned", return_value={"id": 7}), \
             patch.object(sched, "_run_module_rebuild") as runner:
            out = sched.schedule_module_rebuild(1, 7, module, body=body or {})
        return out, runner

    def test_other_module_running_returns_script_busy(self):
        out, runner = self._run({
            "job_id": "j1", "kind": "rebuild_facts",
            "budget_estimate": {"options": {}},
        })
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "script_busy")
        self.assertEqual(out["job_id"], "j1")
        runner.assert_not_called()

    def test_same_kind_with_different_options_is_rejected(self):
        # 先点「零 LLM cards」再点「LLM 丰富」的经典场景:不能静默复用旧任务。
        out, runner = self._run({
            "job_id": "j1", "kind": "rebuild_chunks",
            "budget_estimate": {"options": {"chapter_max": 3}},
        }, module="chunks", body={})
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "options_mismatch")
        runner.assert_not_called()

    def test_same_kind_same_options_reuses_job(self):
        out, runner = self._run({
            "job_id": "j1", "kind": "rebuild_chunks",
            "budget_estimate": {"options": {}},
        }, module="chunks", body={})
        self.assertTrue(out["ok"])
        self.assertTrue(out["reused"])
        runner.assert_not_called()

    def test_no_active_job_dispatches_new_worker(self):
        out, runner = self._run(None, module="chunks", body={})
        self.assertTrue(out["ok"])
        self.assertFalse(out["reused"])
        self.assertTrue(out["job_id"].startswith("rb_chunks_7_"))
        runner.assert_called_once()


class CardsPreserveExisting(unittest.TestCase):
    CANON_ROW = {
        "name": "阿甲", "aliases": ["甲"], "summary": "canon身份",
        "importance": 5, "first_revealed_chapter": 1,
    }
    # 字段级手编：只有 identity/aliases 被标记；重建只保护这两个字段，
    # 其它字段仍可用 canon 值刷新。
    EXISTING_ROW = {
        "name": "阿甲",
        "metadata": {"source": "editor", "manual_fields": ["identity", "aliases"]},
    }
    EXISTING_LEGACY_ROW = {
        "name": "阿甲",
        "metadata": {"source": "editor"},  # 旧数据：无 manual_fields → 整行兜底
    }

    def _run(self, preserve_existing: bool, existing_row=None):
        db = MagicMock()
        existing_row = existing_row if existing_row is not None else self.EXISTING_ROW

        def _execute(sql, params=None):
            s = " ".join(str(sql).split()).lower()
            m = MagicMock()
            if "from character_cards" in s and "select count(*)" in s:
                m.fetchone.return_value = {"c": 1}
            elif "from kb_canon_entities" in s:
                m.fetchall.return_value = [dict(self.CANON_ROW)]
            elif "from character_cards" in s and "select name, metadata" in s:
                m.fetchall.return_value = [dict(existing_row)]
            else:
                m.fetchone.return_value = {"c": 0}
                m.fetchall.return_value = []
            return m

        db.execute.side_effect = _execute
        with patch.object(rm, "connect", return_value=_fake_connect_cm(db)), \
             patch.object(rm, "script_owned", return_value={"id": 1, "title": "t"}), \
             patch("platform_app.knowledge._ensure_book", return_value={"id": 2}), \
             patch("platform_app.knowledge._sync._sync_character_cards",
                   return_value=1) as sync:
            out = rm.rebuild_cards_from_canon(1, 7, preserve_existing=preserve_existing)
        chars = sync.call_args[0][3]
        return out, chars

    def test_preserve_blanks_identity_and_aliases(self):
        out, chars = self._run(True)
        self.assertTrue(out["ok"])
        self.assertEqual(chars["阿甲"]["identity"], "")
        self.assertEqual(chars["阿甲"]["aliases"], [])

    def test_no_preserve_keeps_canon_values(self):
        out, chars = self._run(False)
        self.assertTrue(out["ok"])
        self.assertEqual(chars["阿甲"]["identity"], "canon身份")
        self.assertEqual(chars["阿甲"]["aliases"], ["甲"])

    def test_field_level_only_protects_marked_fields(self):
        # 只手编了 identity → identity 保护（置空保留旧值），aliases 仍可刷新。
        existing = {
            "name": "阿甲",
            "metadata": {"source": "editor", "manual_fields": ["identity"]},
        }
        out, chars = self._run(True, existing)
        self.assertTrue(out["ok"])
        self.assertEqual(chars["阿甲"]["identity"], "")
        self.assertEqual(chars["阿甲"]["aliases"], ["甲"])

    def test_legacy_editor_without_manual_fields_protects_whole_card(self):
        out, chars = self._run(True, self.EXISTING_LEGACY_ROW)
        self.assertTrue(out["ok"])
        self.assertEqual(chars["阿甲"]["identity"], "")
        self.assertEqual(chars["阿甲"]["aliases"], [])


class ManualFieldSemantics(unittest.TestCase):
    """2026-10 手编语义：字段级 + 旧数据整行兜底。"""

    def test_new_marker_protects_only_listed_fields(self):
        self.assertEqual(protected_card_fields({"manual_fields": ["identity"]}), {"identity"})
        self.assertEqual(protected_canon_fields({"manual_fields": ["summary"]}), {"summary"})

    def test_legacy_editor_without_marker_protects_whole_row(self):
        self.assertEqual(protected_card_fields({"source": "editor"}), set(CARD_MANUAL_FIELDS))
        self.assertEqual(protected_canon_fields({"source": "editor"}), set(CANON_MANUAL_FIELDS))

    def test_system_rows_are_not_protected(self):
        self.assertEqual(protected_card_fields({"source": "extracted"}), set())
        self.assertEqual(protected_canon_fields({}), set())

    def test_is_legacy_editor(self):
        self.assertTrue(is_legacy_editor({"source": "editor"}))
        self.assertFalse(is_legacy_editor({"source": "editor", "manual_fields": []}))
        self.assertFalse(is_legacy_editor({"source": "extracted"}))

    def test_card_diff_marks_modified_and_created_fields(self):
        # 修改：只有 identity 变了 → 只锁 identity
        manual = _diff_card_manual_fields(
            {"identity": "新身份", "aliases": ["甲"], "background": ""},
            {"identity": "旧身份", "aliases": ["甲"], "background": ""},
        )
        self.assertEqual(manual, {"identity"})
        # 新建：非空字段都是手编
        manual = _diff_card_manual_fields({"identity": "身份", "aliases": []}, None)
        self.assertEqual(manual, {"identity"})
        # 新建空卡：没有手编字段
        self.assertEqual(_diff_card_manual_fields({"identity": ""}, None), set())

    def test_unlock_manual_fields_precise_and_row(self):
        # 精确解锁 identity：aliases 仍手编，source 保持 editor
        out = unlock_manual_fields(
            {"source": "editor", "manual_fields": ["identity", "aliases"]},
            ["identity"], default_source="extracted",
        )
        self.assertEqual(out.get("manual_fields"), ["aliases"])
        self.assertEqual(out.get("source"), "editor")
        # 解锁全部：manual_fields 删除，source 改为 default
        out = unlock_manual_fields(
            {"source": "editor", "manual_fields": ["identity"]},
            None, default_source="platform",
        )
        self.assertNotIn("manual_fields", out)
        self.assertEqual(out.get("source"), "platform")
        # 旧数据（无 manual_fields）：任何解锁请求都按整行取消
        out = unlock_manual_fields(
            {"source": "editor"}, ["identity"], default_source="extracted",
        )
        self.assertNotIn("manual_fields", out)
        self.assertEqual(out.get("source"), "extracted")
        # JSONB 历史脏数据（list/string/null）不能抛异常
        for bad in (None, ["x"], "broken-json"):
            out = unlock_manual_fields(bad, ["identity"], default_source="platform")
            self.assertEqual(out.get("source"), "platform")


class _RowCur:
    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class _CleanDB:
    """只服务清理助手：select metadata 返回旧行，update 记录参数。"""

    def __init__(self, meta):
        self.meta = meta
        self.updates: list[tuple[str, tuple]] = []

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split()).lower()
        if s.startswith("select metadata"):
            return _RowCur({"metadata": self.meta})
        self.updates.append((s, params))
        return _RowCur()


def _jsonb_obj(v):
    return getattr(v, "obj", v)


class ForceClearsOnlyWrittenFields(unittest.TestCase):
    """2026-10 用户确认语义：强制覆盖只清本次实际写到字段的标记。"""

    def test_cards_only_written_field_marker_removed(self):
        out = clear_overwritten_manual_fields(
            {"source": "editor", "manual_fields": ["identity", "personality"]},
            {"identity"}, universe=CARD_MANUAL_FIELDS,
        )
        self.assertEqual(out["manual_fields"], ["personality"])
        self.assertEqual(out["source"], "editor")

    def test_cards_all_written_removes_markers_and_source(self):
        out = clear_overwritten_manual_fields(
            {"source": "editor", "manual_fields": ["identity"]},
            {"identity"}, universe=CARD_MANUAL_FIELDS,
        )
        self.assertNotIn("manual_fields", out)
        self.assertNotIn("source", out)  # cards default_source=None

    def test_worldbook_keeps_unwritten_tags_and_title(self):
        out = clear_overwritten_manual_fields(
            {"source": "editor", "manual_fields": ["content", "tags", "title"]},
            WORLDBOOK_REBUILD_WRITTEN_FIELDS,
            universe=WORLDBOOK_MANUAL_FIELDS, default_source="extracted",
        )
        self.assertEqual(out["manual_fields"], ["tags", "title"])
        self.assertEqual(out["source"], "editor")

    def test_worldbook_llm_does_not_clear_insertion_position(self):
        out = clear_overwritten_manual_fields(
            {"source": "editor", "manual_fields": ["content", "insertion_position"]},
            WORLDBOOK_LLM_WRITTEN_FIELDS,
            universe=WORLDBOOK_MANUAL_FIELDS, default_source="llm_pipeline",
        )
        self.assertEqual(out["manual_fields"], ["insertion_position"])
        self.assertEqual(out["source"], "editor")

    def test_legacy_editor_converts_to_remaining_explicit_fields(self):
        # 旧数据没有 manual_fields：按全字段兜底，减去本次覆盖字段后显式化，
        # 避免 source='editor' + 空 manual_fields 又退化成整行保护。
        out = clear_overwritten_manual_fields(
            {"source": "editor"}, {"identity", "aliases"},
            universe=CARD_MANUAL_FIELDS,
        )
        self.assertIn("personality", out["manual_fields"])
        self.assertNotIn("identity", out["manual_fields"])
        self.assertNotIn("aliases", out["manual_fields"])
        self.assertEqual(out["source"], "editor")

    def test_legacy_all_written_clears_source(self):
        out = clear_overwritten_manual_fields(
            {"source": "editor"}, set(CARD_MANUAL_FIELDS),
            universe=CARD_MANUAL_FIELDS,
        )
        self.assertNotIn("manual_fields", out)
        self.assertNotIn("source", out)

    def test_no_markers_is_noop(self):
        meta = {"source": "extracted", "foo": "bar"}
        out = clear_overwritten_manual_fields(
            meta, {"content"}, universe=WORLDBOOK_MANUAL_FIELDS,
            default_source="extracted",
        )
        self.assertEqual(out, meta)

    def test_worldbook_db_helper_preserves_tags(self):
        db = _CleanDB({"source": "editor", "manual_fields": ["content", "tags"]})
        clear_worldbook_force_marks(
            db, 1, ["T"], written_fields=WORLDBOOK_REBUILD_WRITTEN_FIELDS,
            default_source="extracted",
        )
        self.assertEqual(len(db.updates), 1)
        new_meta = _jsonb_obj(db.updates[0][1][0])
        self.assertEqual(new_meta["manual_fields"], ["tags"])
        self.assertEqual(new_meta["source"], "editor")

    def test_card_db_helper_only_removes_written(self):
        db = _CleanDB({"source": "editor", "manual_fields": ["identity", "personality"]})
        clear_character_card_force_marks(db, 1, "阿甲", db.meta, {"identity"})
        self.assertEqual(len(db.updates), 1)
        new_meta = _jsonb_obj(db.updates[0][1][0])
        self.assertEqual(new_meta["manual_fields"], ["personality"])

    def test_canon_db_helper_keeps_unwritten_field(self):
        db = _CleanDB({"source": "editor", "manual_fields": ["summary", "identity"]})
        clear_canon_force_marks(db, 1, "lk", db.meta, {"summary"})
        self.assertEqual(len(db.updates), 1)
        new_attrs = _jsonb_obj(db.updates[0][1][0])
        self.assertEqual(new_attrs["manual_fields"], ["identity"])
        self.assertEqual(new_attrs["source"], "editor")


class CanonForceWrittenFields(unittest.TestCase):
    """canon 全量 force 的“实际覆盖字段”判定。"""

    def test_empty_conditional_fields_stay_protected(self):
        c = CanonEntity(logical_key="k", name="甲", type="character")
        fields = _canon_overwritten_fields(c)
        # 无条件列写到了
        self.assertIn("summary", fields)
        # 本次抽到空值 → SQL 保留旧值，不算覆盖
        self.assertNotIn("identity", fields)
        self.assertNotIn("full_name", fields)
        # attrs/metadata 不传，upsert 只是原值合并，也不算覆盖
        self.assertNotIn("attrs", fields)
        self.assertNotIn("metadata", fields)

    def test_nonempty_conditional_fields_cleared(self):
        c = CanonEntity(
            logical_key="k", name="甲", type="character",
            full_name="全名", identity="身份", background="背景",
        )
        fields = _canon_overwritten_fields(c)
        self.assertIn("full_name", fields)
        self.assertIn("identity", fields)
        self.assertIn("background", fields)


class ForceWiring(unittest.TestCase):
    """force 必须从 UI/worker 一路传到真正写库的那一层。"""

    def test_cards_llm_force_passed_to_extraction(self):
        with patch("platform_app.knowledge.llm_extract.run_llm_extraction",
                   return_value={"ok": True}) as m, \
             patch.object(rm, "rebuild_cards_from_canon", return_value={"ok": True}):
            rm.rebuild_cards_with_llm(1, 7, force_overwrite_manual=True)
        self.assertTrue(m.call_args.kwargs.get("force_overwrite_manual"))

    def test_worker_llm_force_maps_from_preserve_existing(self):
        with patch.object(rw, "rebuild_cards_with_llm", return_value={"ok": True}) as m, \
             patch.object(rw, "_resolve_extractor_llm", return_value=("a", "m")):
            rw._rebuild_cards(
                MagicMock(), 1, 7,
                {"mode": "llm", "force_overwrite_manual": True},
            )
        self.assertTrue(m.call_args.kwargs.get("force_overwrite_manual"))
        self.assertFalse(m.call_args.kwargs.get("preserve_existing"))

    def test_worldbook_enrich_force_clears_only_content(self):
        src = (PROJECT / "extract" / "worldbook_enrich.py").read_text(encoding="utf-8")
        self.assertIn("WORLDBOOK_ENRICH_WRITTEN_FIELDS", src)
        self.assertIn("clear_overwritten_manual_fields", src)

    def test_worldbook_rebuilds_use_post_write_cleanup(self):
        res = (PROJECT / "extract" / "resolve.py").read_text(encoding="utf-8")
        stages = (PROJECT / "platform_app" / "import_pipeline" / "stages_llm.py").read_text(
            encoding="utf-8")
        self.assertIn("clear_worldbook_force_marks", res)
        self.assertIn("clear_worldbook_force_marks", stages)
        # 不能再在 SQL 里一次性剥光 manual_fields（那会连 tags/title 一起清掉）
        self.assertNotIn("excluded.metadata ||", res)
        self.assertNotIn("excluded.metadata ||", stages)


class WorldbookManualDiff(unittest.TestCase):
    """2026-10:世界书编辑器整包提交，手编标记必须只记录真正变化的字段。"""

    BEFORE = {
        "title": "T", "content": "old", "priority": 50, "enabled": True,
        "keys": ["a"], "regex_keys": [], "character_filter": [], "scene_filter": [],
        "insertion_position": "worldbook", "probability": 100.0,
        "metadata": {"tags": ["x"]},
    }

    def test_only_changed_content_is_marked(self):
        body = {
            "title": "T", "content": "new", "priority": 50, "enabled": True,
            "keys": ["a"], "tags": ["x"],
        }
        self.assertEqual(_wb_changed_fields(body, self.BEFORE), {"content"})

    def test_unchanged_full_payload_marks_nothing(self):
        body = {
            "title": "T", "content": "old", "priority": 50, "enabled": True,
            "keys": ["a"], "tags": ["x"],
        }
        self.assertEqual(_wb_changed_fields(body, self.BEFORE), set())

    def test_tags_and_priority_are_marked_when_changed(self):
        body = {
            "title": "T", "content": "old", "priority": 80, "enabled": True,
            "keys": ["a"], "tags": ["x", "y"],
        }
        self.assertEqual(_wb_changed_fields(body, self.BEFORE), {"priority", "tags"})


class CardsLlmDefaults(unittest.TestCase):
    """2026-10:LLM 丰富重建也默认保护手编(此前默认覆盖)。"""

    def test_llm_defaults_to_preserve_existing(self):
        with patch.object(rw, "rebuild_cards_with_llm", return_value={"ok": True}) as m, \
             patch.object(rw, "_resolve_extractor_llm", return_value=("a", "m")):
            rw._rebuild_cards(MagicMock(), 1, 7, {"mode": "llm"})
        self.assertTrue(m.call_args.kwargs.get("preserve_existing"))

    def test_zero_llm_defaults_to_preserve_existing(self):
        with patch.object(rw, "rebuild_cards_from_canon", return_value={"ok": True}) as m:
            rw._rebuild_cards(MagicMock(), 1, 7, {})
        self.assertTrue(m.call_args.kwargs.get("preserve_existing"))

    def test_explicit_false_disables_protection(self):
        with patch.object(rw, "rebuild_cards_with_llm", return_value={"ok": True}) as m, \
             patch.object(rw, "_resolve_extractor_llm", return_value=("a", "m")):
            rw._rebuild_cards(MagicMock(), 1, 7, {
                "mode": "llm", "preserve_existing": False,
            })
        self.assertFalse(m.call_args.kwargs.get("preserve_existing"))

    def test_force_overwrite_manual_disables_protection(self):
        # 弹窗「强制覆盖手编字段」走 force_overwrite_manual（与旧 preserve_existing 兼容）
        with patch.object(rw, "rebuild_cards_from_canon", return_value={"ok": True}) as m:
            rw._rebuild_cards(MagicMock(), 1, 7, {"force_overwrite_manual": True})
        self.assertFalse(m.call_args.kwargs.get("preserve_existing"))
        with patch.object(rw, "rebuild_cards_from_canon", return_value={"ok": True}) as m:
            rw._rebuild_cards(MagicMock(), 1, 7, {"force_overwrite_manual": False})
        self.assertTrue(m.call_args.kwargs.get("preserve_existing"))


class SourceInvariants(unittest.TestCase):
    def test_world_key_preserves_refined_in_world_time(self):
        src = (PROJECT / "extract" / "world_key_backfill.py").read_text(encoding="utf-8")
        self.assertIn("case when coalesce(in_world_time,'') = ''", src)
        self.assertNotIn(
            '"update chapter_facts set worldline_key=%s, in_world_time=%s "', src,
            "world_key 又变回无条件覆盖 in_world_time(会冲掉 facts_refine 的精炼结果)",
        )

    def test_canon_resolve_includes_items(self):
        src = (PROJECT / "extract" / "rebuild.py").read_text(encoding="utf-8")
        self.assertIn('("item", fr.get("items") or [])', src)

    def test_worldbook_enrich_skips_editor_by_default(self):
        src = (PROJECT / "extract" / "worldbook_enrich.py").read_text(encoding="utf-8")
        self.assertIn("include_editor", src)
        self.assertIn("WORLDBOOK_CONTENT_GUARD_SQL", src)

    def test_embeddings_waits_for_background_embedding(self):
        src = (PROJECT / "platform_app" / "import_pipeline" / "rebuild_worker.py").read_text(
            encoding="utf-8")
        self.assertIn('if not _embed.embed_status(script_id).get("running")', src)
        self.assertIn("time.sleep(3)", src)
        self.assertIn("before_counts = _selected_counts()", src)

    def test_canon_full_extraction_uses_field_level_manual_guard(self):
        """全量 LLM 重抽：手编字段保留、非手编字段仍可刷新（不再整行跳过）。"""
        src = (PROJECT / "extract" / "resolve.py").read_text(encoding="utf-8")
        self.assertIn("manual_by_key", src)
        self.assertIn("protected_canon_fields", src)
        self.assertIn("manual_fields=manual", src)
        self.assertIn("manual_protected_entities", src)
        # 全字段手编才整行跳过（避免只推进 updated_at 打乱编辑器基线）
        self.assertIn("set(CANON_MANUAL_FIELDS) <= manual", src)

    def test_canon_card_sync_is_field_level(self):
        """canon → cards 同步：只保护手编字段，未手编字段仍可用新抽取值刷新。"""
        src = (PROJECT / "extract" / "resolve.py").read_text(encoding="utf-8")
        self.assertIn("protected_card_fields", src)
        self.assertIn('new_full_name = "" if "full_name" in protected', src)
        self.assertIn('new_identity = "" if "identity" in protected', src)
        self.assertIn("jsonb_array_length(coalesce(excluded.aliases,'[]'::jsonb)) > 0", src)

    def test_worldbook_editor_and_rebuild_use_manual_fields(self):
        """世界书：编辑器写入 manual_fields；重建/enrich 按字段保护。"""
        wb_api = (PROJECT / "platform_app" / "api" / "script_edit" / "worldbook.py").read_text(
            encoding="utf-8")
        self.assertIn('"manual_fields": sorted(_manual)', wb_api)
        self.assertIn("WORLDBOOK_MANUAL_FIELDS", wb_api)
        enrich = (PROJECT / "extract" / "worldbook_enrich.py").read_text(encoding="utf-8")
        self.assertIn("WORLDBOOK_CONTENT_GUARD_SQL", enrich)
        stages = (PROJECT / "platform_app" / "import_pipeline" / "stages_llm.py").read_text(
            encoding="utf-8")
        self.assertIn("metadata->'manual_fields'", stages)
        self.assertIn("_wb_guard", stages)
        self.assertIn("force_overwrite_manual", stages)

    def test_anchor_update_marks_editor(self):
        src = (PROJECT / "tools_dsl" / "command_tools_script_write" / "anchors.py").read_text(
            encoding="utf-8")
        self.assertIn("sets.append(\"source='editor'\")", src)

    def test_force_overwrite_wired_through_extraction(self):
        """强制覆盖手编字段必须从 worker 一路传到 resolve_and_write / worldbook / anchors。"""
        arc = (PROJECT / "extract" / "arc_pipeline.py").read_text(encoding="utf-8")
        self.assertIn("force_overwrite_manual", arc)
        self.assertIn("preserve_manual=not force_overwrite_manual", arc)
        llm = (PROJECT / "platform_app" / "knowledge" / "llm_extract.py").read_text(
            encoding="utf-8")
        self.assertIn("force_overwrite_manual", llm)
        res = (PROJECT / "extract" / "resolve.py").read_text(encoding="utf-8")
        self.assertIn("preserve_manual", res)
        rebuild = (PROJECT / "extract" / "rebuild.py").read_text(encoding="utf-8")
        self.assertIn("include_editor", rebuild)
        self.assertIn("preserve_manual", rebuild)

    def test_unlock_manual_routes_registered(self):
        from platform_app.api import script_edit
        from platform_app.api.scripts import cards as cards_api
        paths = {r.path for r in script_edit.router.routes}
        for p in (
            "/api/scripts/{script_id}/canon-entities/{logical_key}/unlock-manual",
            "/api/scripts/{script_id}/worldbook/{entry_id}/unlock-manual",
            "/api/scripts/{script_id}/anchors/{anchor_id}/unlock-manual",
        ):
            self.assertIn(p, paths)
        self.assertIn(
            "/api/scripts/{script_id}/character-cards/{card_id}/unlock-manual",
            {r.path for r in cards_api.router.routes},
        )


if __name__ == "__main__":
    unittest.main()
