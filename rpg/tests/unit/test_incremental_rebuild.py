"""test_incremental_rebuild — 阶段 4 增量重切/增量嵌入回归。

覆盖:
  · _incremental_chunk_plan 的安全回退:首次/版本变化/orphan/空章/结构变化/无基线;
  · 安全时只返回 updated_at 变化的章节;
  · worker 默认 incremental=true,显式 false 可全量;
  · embeddings incremental 不执行强制清空,只补 NULL。
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from platform_app.import_pipeline import rebuild_worker as rw
from platform_app.import_pipeline.rebuild_modules import _incremental_chunk_plan

PROJECT = Path(__file__).resolve().parents[2]  # rpg/


class _Cur:
    def __init__(self, one=None, rows=None):
        self._one, self._rows = one, rows or []

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._rows


class _DB:
    def __init__(self, *, total=10, version_mismatch=0, orphan=0, index_mismatch=0,
                 missing_rows=None, baseline="2026-11-01", changed=None):
        self.total = total
        self.version_mismatch = version_mismatch
        self.orphan = orphan
        self.index_mismatch = index_mismatch
        self.missing_rows = missing_rows or []
        self.baseline = baseline
        self.changed = changed or []

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split()).lower()
        if "max(created_at)" in s:
            return _Cur(one={"m": self.baseline})
        if "updated_at >" in s:
            return _Cur(rows=[{"chapter_index": i} for i in self.changed])
        if "chunking_version" in s:
            return _Cur(one={"c": self.version_mismatch})
        if "dc.chapter_index <> sc.chapter_index" in s:
            return _Cur(one={"c": self.index_mismatch})
        if "not exists (select 1 from script_chapters" in s:
            return _Cur(one={"c": self.orphan})
        if "not exists (select 1 from document_chunks" in s:
            return _Cur(rows=self.missing_rows)
        if "count(*) as c from document_chunks" in s:
            return _Cur(one={"c": self.total})
        return _Cur(one={"c": 0})


CHAPTERS = [
    {"id": 11, "chapter_index": 1, "title": "一", "content": "第一章正文"},
    {"id": 22, "chapter_index": 2, "title": "二", "content": "第二章正文"},
]


def test_safe_incremental_returns_only_changed_chapters():
    changed, reason = _incremental_chunk_plan(_DB(changed=[2]), 7, CHAPTERS)
    assert reason == ""
    assert [c["chapter_index"] for c in changed] == [2]


def test_no_changed_chapters_is_noop():
    changed, reason = _incremental_chunk_plan(_DB(changed=[]), 7, CHAPTERS)
    assert reason == ""
    assert changed == []


def test_first_run_falls_back_to_full():
    changed, reason = _incremental_chunk_plan(_DB(total=0), 7, CHAPTERS)
    assert reason == "no_existing_chunks"
    assert len(changed) == len(CHAPTERS)


def test_chunking_version_change_falls_back_to_full():
    changed, reason = _incremental_chunk_plan(_DB(version_mismatch=1), 7, CHAPTERS)
    assert reason == "chunking_version_changed"
    assert len(changed) == len(CHAPTERS)


def test_orphan_chunks_fall_back_to_full():
    changed, reason = _incremental_chunk_plan(_DB(orphan=1), 7, CHAPTERS)
    assert reason == "orphan_chunks"
    assert len(changed) == len(CHAPTERS)


def test_new_chapter_is_included_incremental_without_full_rebuild():
    """新增章节没有 chunks,但不是 orphan/结构漂移 → 只补这一章,不全量。"""
    changed, reason = _incremental_chunk_plan(
        _DB(missing_rows=[{"chapter_index": 2}], changed=[]), 7, CHAPTERS,
    )
    assert reason == ""
    assert [c["chapter_index"] for c in changed] == [2]


def test_chapter_structure_change_falls_back_to_full():
    changed, reason = _incremental_chunk_plan(_DB(index_mismatch=1), 7, CHAPTERS)
    assert reason == "chapter_structure_changed"


def test_no_baseline_falls_back_to_full():
    changed, reason = _incremental_chunk_plan(_DB(baseline=None), 7, CHAPTERS)
    assert reason == "no_baseline"


def test_worker_defaults_to_incremental_and_embeddings_skip_force_clear():
    """源码级锁:worker 默认 incremental=True;embeddings 的 force-clear 在 incremental 下跳过。"""
    src = (PROJECT / "platform_app" / "import_pipeline" / "rebuild_worker.py").read_text(
        encoding="utf-8")
    assert 'body.get("incremental", True)' in src
    assert "if not incremental:" in src
    assert '"incremental": incremental' in src
    assert "set embedding_vec=NULL" in src  # full 模式仍保留强制清空


class TestAutoEmbedAfterIncremental:
    """增量重切 → 自动补新块向量的接线/失败语义。"""

    def _rebuild(self, *, mode="incremental", new_chunks=2, emb=None):
        with patch.object(rw, "rebuild_chunks_from_db", return_value={
            "ok": True, "mode": mode, "new_chunks": new_chunks,
            "partial_failures": [],
        }), patch.object(rw, "_auto_embed_incremental",
                         return_value=emb or {"ok": True}) as mock_emb:
            out = rw._rebuild_chunks(MagicMock(), 1, 7, {})
        return out, mock_emb

    def test_incremental_triggers_auto_embed(self):
        out, mock_emb = self._rebuild()
        mock_emb.assert_called_once()
        assert out["extra"]["auto_embedding"]["ok"] is True

    def test_full_rebuild_does_not_auto_embed(self):
        _out, mock_emb = self._rebuild(mode="full")
        mock_emb.assert_not_called()

    def test_missing_credentials_does_not_mark_chunks_failed(self):
        out, _ = self._rebuild(emb={
            "ok": False, "needs_credentials": True, "error": "no key",
        })
        assert out.get("partial_failures") == []

    def test_provider_failure_marks_partial(self):
        out, _ = self._rebuild(emb={"ok": False, "error": "boom"})
        assert any(p.get("stage") == "auto_embedding" for p in out["partial_failures"])


class TestAutoEmbedWorker:
    def test_no_new_chunks_skips(self):
        out = rw._auto_embed_incremental(MagicMock(), 1, 7, 0)
        assert out["skipped"] == "no_new_chunks"

    def test_waits_until_chunks_done(self):
        ctl = MagicMock()
        ctl.is_cancelled.return_value = False
        states = iter([
            {"running": True, "chunks": {"done": 1, "total": 3}},
            {"running": True, "chunks": {"done": 3, "total": 3}},
        ])
        with patch("platform_app.knowledge.embedding.embed_script",
                   return_value={"ok": True}) as mock_start, \
             patch("platform_app.knowledge.embedding.embed_status",
                   side_effect=lambda _sid: next(states)), \
             patch.object(rw.time, "sleep", return_value=None):
            out = rw._auto_embed_incremental(ctl, 1, 7, 2)
        assert out["ok"] is True
        assert out["done"] == 3
        mock_start.assert_called_once_with(1, 7)

    def test_missing_credentials_surfaces_flag(self):
        ctl = MagicMock()
        with patch("platform_app.knowledge.embedding.embed_script",
                   return_value={"ok": False, "needs_credentials": True, "error": "no key"}):
            out = rw._auto_embed_incremental(ctl, 1, 7, 2)
        assert out["ok"] is False
        assert out["needs_credentials"] is True
