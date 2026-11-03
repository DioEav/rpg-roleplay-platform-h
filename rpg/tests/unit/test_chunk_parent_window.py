"""test_chunk_parent_window — 阶段 2 同章父窗口回归。

约束:
  · 父窗口只从命中块所在章取,绝不跨章(ch10 不会带出 ch500);
  · 同 scene_index 的相邻块优先;场景太短才扩到同章相邻块;
  · 父窗口 ≤ max_chars;多个命中落在同一窗口时去重;
  · 旧块没有 scene metadata 时,退化为同章前后扩。
"""
from __future__ import annotations

from platform_app.knowledge._search import _expand_chunk_windows


class _Cur:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class _FakeDB:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params=None):
        return _Cur(self.rows)


def _row(i, ch, ci, content, scene=None):
    meta = {} if scene is None else {"scene_index": scene, "chapter_title": f"第{ch}章"}
    return {
        "id": i, "chapter_index": ch, "chunk_index": ci,
        "content": content, "metadata": meta,
    }


def _hit(row, score=1.0):
    return {**row, "score": score}


CH1 = [
    _row(11, 1, 0, "甲" * 300, scene=0),
    _row(12, 1, 1, "乙" * 300, scene=0),
    _row(13, 1, 2, "丙" * 300, scene=1),
]
CH2 = [
    _row(21, 2, 0, "丁" * 300, scene=0),
    _row(22, 2, 1, "戊" * 300, scene=0),
]


def test_window_never_crosses_chapter():
    db = _FakeDB(CH1 + CH2)
    out = _expand_chunk_windows(db, 7, [_hit(CH1[2])], min_chars=100, max_chars=5000)
    assert len(out) == 1
    assert all(i in (11, 12, 13) for i in out[0]["window_chunk_ids"])
    assert "丁" not in out[0]["window_content"]


def test_same_scene_preferred_over_chapter_fallback():
    db = _FakeDB(CH1)
    out = _expand_chunk_windows(db, 7, [_hit(CH1[1])], min_chars=10, max_chars=5000)
    assert out[0]["window_chunk_ids"] == (11, 12), "同场景块应优先,不扩到 scene=1"


def test_expand_to_min_within_same_chapter():
    rows = [
        _row(11, 1, 0, "甲" * 100, scene=0),
        _row(12, 1, 1, "乙" * 100, scene=0),
        _row(13, 1, 2, "丙" * 300, scene=1),
        _row(14, 1, 3, "丁" * 300, scene=1),
    ] + CH2
    db = _FakeDB(rows)
    out = _expand_chunk_windows(db, 7, [_hit(rows[1])], min_chars=700, max_chars=5000)
    ids = out[0]["window_chunk_ids"]
    assert 11 in ids and 12 in ids and 13 in ids
    assert 21 not in ids and 22 not in ids


def test_window_respects_max_chars():
    rows = [_row(10 + i, 1, i, "字" * 1000, scene=0) for i in range(5)]
    db = _FakeDB(rows)
    out = _expand_chunk_windows(db, 7, [_hit(rows[2])], min_chars=100, max_chars=1600)
    assert len(out[0]["window_content"]) <= 1600
    assert 12 in out[0]["window_chunk_ids"]


def test_overlapping_hits_deduped_by_window_ids():
    db = _FakeDB(CH1)
    out = _expand_chunk_windows(
        db, 7, [_hit(CH1[0]), _hit(CH1[1])], min_chars=10, max_chars=5000,
    )
    assert len(out) == 1, "两个命中落在同一场景窗口时应只返回一个父窗口"


def test_old_chunks_without_scene_still_expand_within_chapter():
    rows = [
        _row(11, 1, 0, "甲" * 200, scene=None),
        _row(12, 1, 1, "乙" * 200, scene=None),
        _row(13, 1, 2, "丙" * 200, scene=None),
    ] + CH2
    db = _FakeDB(rows)
    out = _expand_chunk_windows(db, 7, [_hit(rows[1])], min_chars=700, max_chars=5000)
    ids = out[0]["window_chunk_ids"]
    assert ids == (11, 12, 13)
    assert 21 not in ids
