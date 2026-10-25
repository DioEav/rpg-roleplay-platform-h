"""非章节实体乐观锁回归(世界书 / 时间线锚点 / canon / 角色卡)。

背景:章节早已支持 base_updated_at,其余实体此前是无条件覆盖写 —— 编辑器里未保存
的旧内容会把 AI 工具/另一标签刚写的新内容静默盖掉。本文件锁住四条不变量:

  1. 带基线且服务端版本已变 → 409 + server_* 快照,不写 commit、不落库;
  2. 带基线且版本一致 → 正常更新;
  3. 不带基线(旧客户端/AI 工具) → 保持原来的覆盖语义,行为不变;
  4. 角色卡用 row_version 而不是时间戳(整数版本 +1,比秒级时间更稳)。

全部用 FakeDB,不依赖真实 Postgres,避免集成测试环境抖动。
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json

import platform_app.api.script_edit.anchors as anchors_api
import platform_app.api.script_edit.canon as canon_api
import platform_app.api.script_edit.worldbook as worldbook_api
import platform_app.knowledge.character_cards as character_cards
from platform_app.api.script_edit._shared import _parse_baseline_ts

TS = dt.datetime(2026, 10, 25, 1, 2, 3, 456789, tzinfo=dt.UTC)
TS2 = dt.datetime(2026, 10, 25, 2, 0, 0, tzinfo=dt.UTC)
BASE_ISO = TS.isoformat()


class _Cur:
    def __init__(self, rows=None, rowcount: int = 0):
        self._rows = rows or []
        self.rowcount = rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _FakeDB:
    """按 SQL 形状返回固定行;before/after 由「第几次查该表」区分。"""

    def __init__(self, table: str, before: dict, after: dict, update_rowcount: int = 0):
        self.table = table
        self.before = before
        self.after = after
        self.update_rowcount = update_rowcount
        self.executed: list[tuple[str, object]] = []
        self._select_count = 0
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def commit(self):
        self.committed = True

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split())
        low = s.lower()
        self.executed.append((s, params))
        # owner 检查
        if low.startswith("select * from scripts"):
            return _Cur([{"id": 1, "owner_id": 1}])
        if low.startswith("select id from books"):
            return _Cur([{"id": 5}])
        # 角色卡的归属/重名预检:1 表示存在/无冲突,不参与 before/after 计数
        if low.startswith("select 1 from character_cards"):
            return _Cur([{"x": 1}] if "id <> %s" not in low else [])
        if low.startswith(f"update {self.table}"):
            return _Cur(rowcount=self.update_rowcount)
        if f"from {self.table}" in low:
            self._select_count += 1
            return _Cur([self.before if self._select_count == 1 else self.after])
        return _Cur([])


class _Req:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


def _body(resp) -> dict:
    return json.loads(resp.body)


def _update_sql(db: _FakeDB) -> tuple[str, object]:
    return next(x for x in db.executed if x[0].lower().startswith(f"update {db.table}"))


# ── 基线解析 ────────────────────────────────────────────────────────────────

def test_parse_baseline_ts_accepts_t_space_and_z():
    assert _parse_baseline_ts(None) is None
    assert _parse_baseline_ts("") is None
    assert _parse_baseline_ts(BASE_ISO) == TS
    assert _parse_baseline_ts(BASE_ISO.replace("T", " ").replace("+00:00", "Z")) == TS


def test_parse_baseline_ts_rejects_garbage():
    try:
        _parse_baseline_ts("not-a-date")
    except ValueError as exc:
        assert "base_updated_at" in str(exc)
    else:
        raise AssertionError("非法时间戳必须抛 ValueError(端点据此回 400)")


# ── 世界书 ──────────────────────────────────────────────────────────────────

def _wb_row(content: str, ts: dt.datetime) -> dict:
    return {"id": 7, "title": "t", "content": content, "updated_at": ts}


def test_worldbook_conflict_returns_409_without_commit(monkeypatch):
    db = _FakeDB("worldbook_entries", _wb_row("old", TS), _wb_row("server-new", TS2))
    commits = []
    monkeypatch.setattr(worldbook_api, "connect", lambda: db)
    monkeypatch.setattr(worldbook_api, "_write_commit", lambda *a, **k: commits.append(k) or 99)

    resp = asyncio.run(worldbook_api.api_worldbook_update(
        _Req({"content": "local", "base_updated_at": BASE_ISO}), 1, 7, user={"id": 1},
    ))
    body = _body(resp)

    assert resp.status_code == 409
    assert body["conflict"] is True
    assert body["server_entry"]["content"] == "server-new"
    upd_sql, upd_params = _update_sql(db)
    # 版本条件必须与 UPDATE 同语句(atomic compare-and-set),不是先查后写
    assert "AND updated_at=%s" in upd_sql
    assert upd_params[-1] == TS
    assert commits == [] and db.committed is False


def test_worldbook_without_baseline_keeps_overwrite_semantics(monkeypatch):
    db = _FakeDB("worldbook_entries", _wb_row("old", TS), _wb_row("new", TS2))
    monkeypatch.setattr(worldbook_api, "connect", lambda: db)
    monkeypatch.setattr(worldbook_api, "_write_commit", lambda *a, **k: 99)

    resp = asyncio.run(worldbook_api.api_worldbook_update(
        _Req({"content": "local"}), 1, 7, user={"id": 1},
    ))

    assert resp.status_code == 200
    upd_sql, _ = _update_sql(db)
    assert "AND updated_at" not in upd_sql
    assert db.committed is True


# ── 时间线锚点 ──────────────────────────────────────────────────────────────

def test_anchor_conflict_returns_409(monkeypatch):
    before = {"id": 8, "story_time_label": "x", "sample_summary": "old", "updated_at": TS}
    after = {"id": 8, "story_time_label": "x", "sample_summary": "server-new", "updated_at": TS2}
    db = _FakeDB("script_timeline_anchors", before, after)
    monkeypatch.setattr(anchors_api, "connect", lambda: db)
    monkeypatch.setattr(anchors_api, "_write_commit", lambda *a, **k: 99)

    resp = asyncio.run(anchors_api.api_anchor_update(
        _Req({"summary": "local", "base_updated_at": BASE_ISO}), 1, 8, user={"id": 1},
    ))
    body = _body(resp)

    assert resp.status_code == 409
    assert body["server_anchor"]["sample_summary"] == "server-new"
    assert "AND updated_at=%s" in _update_sql(db)[0]


# ── canon ───────────────────────────────────────────────────────────────────

def test_canon_conflict_returns_409_and_bumps_version(monkeypatch):
    before = {"id": 9, "logical_key": "k", "summary": "old", "created_at": TS, "updated_at": TS}
    after = {"id": 9, "logical_key": "k", "summary": "server-new", "created_at": TS, "updated_at": TS2}
    db = _FakeDB("kb_canon_entities", before, after)
    monkeypatch.setattr(canon_api, "connect", lambda: db)
    monkeypatch.setattr(canon_api, "_write_commit", lambda *a, **k: 99)

    resp = asyncio.run(canon_api.api_canon_update(
        _Req({"summary": "local", "base_updated_at": BASE_ISO}), 1, "k", user={"id": 1},
    ))
    body = _body(resp)

    assert resp.status_code == 409
    assert body["server_entity"]["summary"] == "server-new"
    upd_sql, _ = _update_sql(db)
    # canon 迁移 110 才补 updated_at:每次编辑必须自己推进版本
    assert "updated_at=now()" in upd_sql
    assert "AND updated_at=%s" in upd_sql


# ── 角色卡 ──────────────────────────────────────────────────────────────────

def _card_row(version: int) -> dict:
    return {
        "id": 3, "script_id": 1, "name": "A", "full_name": "", "aliases": [],
        "identity": "", "background": "", "appearance": "", "personality": "",
        "speech_style": "", "current_status": "", "secrets": "", "sample_dialogue": [],
        "tags": [], "first_revealed_chapter": 0, "importance": 1, "token_budget": 450,
        "priority": 100, "enabled": True, "metadata": {}, "card_type": "npc",
        "source": "platform", "scope": "script", "slug": "", "avatar_path": "",
        "row_version": version, "created_at": TS, "updated_at": TS, "public_id": None,
        "user_id": 1, "book_id": 5, "is_default": False,
    }


def _fake_cards(monkeypatch, row: dict) -> _FakeDB:
    db = _FakeDB("character_cards", row, row)
    monkeypatch.setattr(character_cards, "init_db", lambda: None)
    monkeypatch.setattr(character_cards, "connect", lambda: db)
    return db


def test_card_version_conflict_raises_with_server_dto(monkeypatch):
    _fake_cards(monkeypatch, _card_row(version=5))

    try:
        character_cards.upsert_character_card(
            1, 1, {"id": 3, "name": "A", "base_row_version": 4},
        )
    except character_cards.CharacterCardConflict as exc:
        assert exc.server_card["row_version"] == 5
    else:
        raise AssertionError("row_version 不匹配必须抛 CharacterCardConflict")


def test_card_without_baseline_keeps_overwrite_semantics(monkeypatch):
    db = _fake_cards(monkeypatch, _card_row(version=5))

    character_cards.upsert_character_card(1, 1, {"id": 3, "name": "A"})

    upd_sql, upd_params = _update_sql(db)
    assert "base_row_version" not in upd_sql
    assert "base_row_version" not in upd_params


def test_card_invalid_baseline_is_actionable_valueerror(monkeypatch):
    _fake_cards(monkeypatch, _card_row(version=5))

    try:
        character_cards.upsert_character_card(
            1, 1, {"id": 3, "name": "A", "base_row_version": "abc"},
        )
    except ValueError as exc:
        assert "base_row_version" in str(exc)
    else:
        raise AssertionError("非法 base_row_version 必须抛 ValueError")


def test_card_endpoint_maps_conflict_to_409(monkeypatch):
    """端点必须把 CharacterCardConflict 转成 409 + server_card(与章节 409 同构)。"""
    import platform_app.api.scripts.cards as cards_api

    def _boom(*args, **kwargs):
        raise character_cards.CharacterCardConflict({"id": 3, "row_version": 5})

    monkeypatch.setattr(cards_api.knowledge, "upsert_character_card", _boom)

    resp = asyncio.run(cards_api.api_script_upsert_character_card(
        _Req({"id": 3, "name": "A", "base_row_version": 4}), 1, user={"id": 1},
    ))
    body = _body(resp)

    assert resp.status_code == 409
    assert body["conflict"] is True
    assert body["server_card"]["row_version"] == 5
