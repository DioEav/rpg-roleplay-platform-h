"""回归:GET /canon-entities 必须真正支持 type 过滤。

生产实证:编辑器「知识库人物」的类型筛选按钮一直传 ?type=item,但端点没接这个
参数 —— 被静默忽略,选任何类型都返回全量实体(importance 排序前排全是人物),
标题计数恒等于总数。
"""
from __future__ import annotations

import asyncio
import json

import platform_app.api.scripts.worldbook_canon as wc

_USER = {"id": 1}


class _FakeCur:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


class _FakeDB:
    def __init__(self, entity_rows):
        self.executed = []  # (sql, params)
        self._entity_rows = entity_rows

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.executed.append((" ".join(str(sql).split()), params))
        if "count(*)" in sql:
            return _FakeCur([{"c": len(self._entity_rows)}])
        if "from kb_canon_entities" in sql:
            return _FakeCur(self._entity_rows)
        return _FakeCur([{"1": 1}])  # 权限检查 select 1


_ENTITY = [{
    "id": 3, "logical_key": "k1", "name": "金角巨兽", "full_name": None,
    "type": "character", "entity_subtype": None, "parent_logical_key": None,
    "summary": None, "identity": None, "background": None, "aliases": [],
    "attrs": {}, "first_revealed_chapter": 1, "public_knowledge": None,
    "importance": 30, "created_at": None,
}]


def _run(monkeypatch, rows, **kwargs):
    db = _FakeDB(rows)
    monkeypatch.setattr(wc, "connect", lambda: db)
    resp = asyncio.run(wc.api_script_canon_entities(1, **kwargs, user=_USER))
    body = json.loads(resp.body)
    return db, body


def _items_sql(db):
    """取列表数据查询(count(*) 总数查询不算)。"""
    return next(
        (s, p) for s, p in db.executed if "from kb_canon_entities" in s and "order by" in s
    )


def test_type_filter_param_reaches_sql(monkeypatch):
    db, body = _run(monkeypatch, _ENTITY, type="item")
    canon_sql, canon_params = _items_sql(db)
    assert "type = %s" in canon_sql
    assert canon_params.count("item") == 1
    assert body["ok"] is True
    # 分页响应带真实总数(计数器数据源)
    assert body["total"] == 1
    assert body["page"] == 1
    assert body["page_size"] == 200


def test_no_type_returns_all(monkeypatch):
    db, body = _run(monkeypatch, _ENTITY, type=None)
    canon_sql, canon_params = _items_sql(db)
    # 不传 type → SQL 不含类型过滤片段
    assert "and type = %s" not in canon_sql
    assert "item" not in [str(p) for p in canon_params]
    assert body["ok"] is True
    assert body["items"][0]["name"] == "金角巨兽"


def test_search_q_reaches_sql(monkeypatch):
    db, body = _run(monkeypatch, _ENTITY, q="金角")
    canon_sql, canon_params = _items_sql(db)
    assert "ilike" in canon_sql
    assert any("%金角%" in str(p) for p in canon_params)
    assert body["ok"] is True


def test_order_asc(monkeypatch):
    db, _ = _run(monkeypatch, _ENTITY, order="asc")
    canon_sql, _ = _items_sql(db)
    assert "importance asc" in canon_sql
