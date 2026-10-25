"""编辑器 P0:章节保存乐观锁(AI 写库与未保存改动互相静默覆盖)。
update_chapter 带 base_updated_at 与服务版本不一致→ChapterConflict→端点 409+服务端版本,
前端转三方合并。不带=覆盖语义不变(AI 工具/老客户端)。

后半部分用 FakeDB 验证「预检 + UPDATE 原子条件」的真实行为(不依赖 Postgres):
身份漂移、SELECT 与 UPDATE 之间被并发重排/改写、以及无基线时的旧覆盖语义。
"""
import datetime as dt
from pathlib import Path

import pytest

from platform_app.script_import import chapters as chapters_mod
from platform_app.script_import.chapters import (
    ChapterConflict,
    ChapterStructureChanged,
    update_chapter,
)

ROOT = Path(__file__).resolve().parents[2]
# script_import.py 已包化为 script_import/ 子包(纯机械搬家);按新住址读整包源码做结构断言。
_SI_DIR = ROOT / "platform_app" / "script_import"
SI = "\n".join(p.read_text(encoding="utf-8") for p in sorted(_SI_DIR.glob("*.py")))
# scripts.py 已包化为 scripts/ 子包(纯机械搬家);按新住址读整包源码做结构断言。
_API_DIR = ROOT / "platform_app" / "api" / "scripts"
API = "\n".join(p.read_text(encoding="utf-8") for p in sorted(_API_DIR.glob("*.py")))


def test_update_chapter_optimistic_lock():
    i = SI.find("def update_chapter(")
    body = SI[i:SI.find("\ndef ", i + 1)]
    assert "base_updated_at" in body
    assert "ChapterConflict" in body, "不一致必须抛冲突而非落库"
    # 时间戳统一解析成 UTC datetime 后按微秒比较(与其它实体一致),避免秒级截断
    # 让同一秒内的并发保存互相覆盖,也避免 'T'/空格/'Z' 格式差异造成假冲突。
    assert "_parse_base_ts" in body
    assert "updated_at = %s" in body
    # 身份锁与时间戳锁共用同一次当前行查询:任一基线传入都要先读服务端再判。
    assert "if base_ts is not None or want_id is not None:" in body
    assert "base_chapter_id" in body
    assert "ChapterStructureChanged" in body, "chapter_index 指向另一行必须拒绝写入"
    # 预检只是快速失败;两个保存并发时都读同一基线,必须把条件写进 UPDATE 才是真锁。
    assert 'where.append("id = %s")' in body, "UPDATE 必须原子复核稳定 id,防 SELECT 后被重排"
    assert 'where.append("updated_at = %s")' in body, "UPDATE 必须原子复核 updated_at,防并发保存互相覆盖"


def test_endpoint_returns_409_with_server_version():
    i = API.find("async def api_chapter_update(")
    body = API[i:i + 2400]
    assert "ChapterConflict" in body
    assert "409" in body
    assert "server_chapter" in body, "409 必须携带服务端当前版本供前端合并"
    assert 'body.get("base_updated_at")' in body
    # 身份冲突单独走 structure_changed,不能返回可合并的普通 409。
    assert 'body.get("base_chapter_id")' in body
    assert "structure_changed" in body


# ── 真实行为(不依赖 Postgres)─────────────────────────────────────────────

class _Cur:
    def __init__(self, rows=None):
        self._rows = rows or []

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeDB:
    """按 SQL 形状返回数据;chapter_selects 是按调用顺序消费的预检/复查结果。"""

    def __init__(self, *, chapter_selects=None, update_row=None):
        self.chapter_selects = list(chapter_selects or [])
        self.update_row = update_row
        self.chapter_select_calls = 0
        self.updates: list[tuple[str, tuple | None]] = []
        self.word_count_queries = 0

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def commit(self):
        pass

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split())
        low = s.lower()
        if low.startswith("select id, public_id, chapter_index"):
            self.chapter_select_calls += 1
            rows = [self.chapter_selects.pop(0)] if self.chapter_selects else []
            return _Cur(rows)
        if low.startswith("update script_chapters set"):
            self.updates.append((s, params))
            return _Cur([self.update_row] if self.update_row else [])
        if low.startswith("select coalesce(sum(word_count)"):
            self.word_count_queries += 1
            return _Cur([{"n": 12}])
        return _Cur([])


def _row(row_id: int = 11, updated_at: str = "2026-10-25 01:02:03+00:00") -> dict:
    return {
        "id": row_id, "public_id": "pub", "chapter_index": 1, "title": "旧标题",
        "volume_title": "", "word_count": 3, "content": "旧正文",
        "created_at": "2026-10-24 00:00:00+00:00", "updated_at": updated_at,
    }


def _call(monkeypatch, db, **kwargs):
    monkeypatch.setattr(chapters_mod, "init_db", lambda: None)
    monkeypatch.setattr(chapters_mod, "connect", lambda: db)
    monkeypatch.setattr(chapters_mod, "script_owned", lambda *_a, **_k: {"id": 1})
    return update_chapter(7, 1, 1, **kwargs)


def test_identity_mismatch_rejected_before_update(monkeypatch):
    db = _FakeDB(chapter_selects=[_row(row_id=22)])
    with pytest.raises(ChapterStructureChanged):
        _call(monkeypatch, db, content="新正文", base_chapter_id=11)
    assert db.updates == [], "身份不符时绝不能执行 UPDATE"


def test_atomic_identity_race_after_select(monkeypatch):
    # 预检看到 id=11;UPDATE 因并发重排 0 行;复查已变成 id=22。
    db = _FakeDB(chapter_selects=[_row(row_id=11), _row(row_id=22)], update_row=None)
    with pytest.raises(ChapterStructureChanged):
        _call(monkeypatch, db, content="新正文", base_chapter_id=11)
    assert len(db.updates) == 1
    sql, params = db.updates[0]
    assert " and id = %s" in sql, "身份条件必须和 UPDATE 在同一条语句里"
    assert params[-1] == 11, "稳定 id 作为 WHERE 参数传入"


def test_atomic_timestamp_race_after_select(monkeypatch):
    # 预检时 updated_at 与基线一致;UPDATE 0 行;复查发现被并发改写。
    base = "2026-10-25T01:02:03+00:00"
    db = _FakeDB(
        chapter_selects=[
            _row(updated_at="2026-10-25 01:02:03+00:00"),
            _row(updated_at="2026-10-25 02:00:00+00:00"),
        ],
        update_row=None,
    )
    with pytest.raises(ChapterConflict):
        _call(monkeypatch, db, content="新正文", base_updated_at=base)
    sql, params = db.updates[0]
    assert "updated_at = %s" in sql, "版本条件必须和 UPDATE 在同一条语句里"
    assert params[-1] == dt.datetime(2026, 10, 25, 1, 2, 3, tzinfo=dt.UTC), "按微秒精度比较基线"


def test_success_applies_atomic_conditions(monkeypatch):
    db = _FakeDB(
        chapter_selects=[_row(row_id=11)],
        update_row=_row(row_id=11),
    )
    res = _call(
        monkeypatch, db,
        content="新正文", base_chapter_id=11,
        base_updated_at="2026-10-25T01:02:03+00:00",
    )
    assert res["ok"] is True
    sql, params = db.updates[0]
    assert " and id = %s" in sql and "updated_at = %s" in sql
    assert params[-2:] == (11, dt.datetime(2026, 10, 25, 1, 2, 3, tzinfo=dt.UTC))
    assert db.word_count_queries == 1, "成功后仍要同步 scripts.word_count"


def test_no_baseline_keeps_overwrite_semantics(monkeypatch):
    db = _FakeDB(chapter_selects=[], update_row=_row(row_id=11))
    res = _call(monkeypatch, db, content="新正文")
    assert res["ok"] is True
    sql, _ = db.updates[0]
    assert " and id = %s" not in sql and "updated_at = %s" not in sql
    assert db.chapter_select_calls == 0, "不带基线时不做预检(老客户端/AI 工具路径不变)"


def test_invalid_base_chapter_id_rejected(monkeypatch):
    db = _FakeDB(chapter_selects=[_row(row_id=11)])
    with pytest.raises(ValueError, match="base_chapter_id"):
        _call(monkeypatch, db, content="新正文", base_chapter_id="第1章")
    assert db.updates == []
