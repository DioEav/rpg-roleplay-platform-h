"""回归:_stage_worldbook(世界书 LLM 路径)的接收与叠加语义。

生产实证(吞噬星空×mimo):模型返回**单对象**而非数组(「RR病毒与大涅槃」,内容合格)
→ 旧版 `if not isinstance(entries, list): entries = []` 整份丢弃 → 恒 0 条、假性失败。
修复后语义:
  · 带 name 的 dict 自动包成数组收下;
  · 写入只**新增**不覆盖:editor(手编)与 extracted(canon 路径)同名时跳过;
  · 跑之前自清理上一轮 llm_pipeline 条目(重生成语义)。
"""
from __future__ import annotations

import platform_app.import_pipeline.stages_llm as SL
from platform_app.import_pipeline.stages_llm import _stage_worldbook

SINGLE_OBJECT = (
    '{"name":"RR病毒与大涅槃","keys":["RR病毒","大涅槃","进化"],'
    '"content":"RR病毒出现后迅速传播至全球,幸存人类开启新进化,史称大涅槃时期。","priority":95}'
)
ARRAY_OF_TWO = (
    '[{"name":"RR病毒与大涅槃","keys":["RR病毒"],"content":"大涅槃时期。","priority":95},'
    '{"name":"精神念师","keys":["念师"],"content":"灵魂力的职业化应用。","priority":80}]'
)


class _FakeCur:
    def __init__(self, rowcount=1, row=None):
        self.rowcount = rowcount
        self._row = row

    def fetchone(self):
        return self._row


class _Row:
    def __init__(self, data):
        self._d = data

    def fetchone(self):
        return self._d

    def fetchall(self):
        return self._d or []


class _FakeDB:
    """覆盖 _stage_worldbook 用到的查询 + insert(upsert) + force 标记清理。"""

    def __init__(self, fact_rows, insert_rowcount=1, metadata=None):
        self.executed: list[str] = []
        self.calls: list[tuple[str, tuple | None]] = []
        self._fact_rows = fact_rows
        self._insert_rowcount = insert_rowcount
        self._metadata = metadata

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        s = " ".join(str(sql).split())
        self.executed.append(s)
        self.calls.append((s, params))
        if "insert into worldbook_entries" in sql:
            return _FakeCur(self._insert_rowcount)
        if "from books" in sql:
            return _Row({"id": 5})
        if "from chapter_facts" in sql:
            return _Row(self._fact_rows)
        if "select metadata from worldbook_entries" in s:
            return _FakeCur(0, {"metadata": self._metadata})
        if "纪元" in sql:
            return _Row(None)  # 无 era 条目 → 无纪元锁
        return _FakeCur(0)


_FACTS = [{
    "chapter": 1, "summary": "罗峰获得金角巨兽分身,加入极限武馆。",
    "locations": [{"name": "雾岛", "count": 3}],
    "factions": [{"name": "极限武馆", "count": 5}],
    "concepts": [{"name": "精神念师", "count": 4}],
}]


class _DummyCtl:
    def __init__(self):
        self.updates = []

    def update(self, **kw):
        self.updates.append(kw)

    def add_usage(self, *a, **k):
        pass


def _install(monkeypatch, raw_response, insert_rowcount=1, metadata=None):
    db = _FakeDB(_FACTS, insert_rowcount=insert_rowcount, metadata=metadata)
    # stages_llm 顶部 `from ..db import connect` 已把名字绑进模块命名空间,
    # 必须patch绑定名(SL.connect),patch 源模块 platform_app.db.connect 不生效。
    monkeypatch.setattr(SL, "connect", lambda: db)
    monkeypatch.setattr(SL, "_resolve_extractor_llm", lambda uid: ("fake_api", "fake_model"))

    import agents._harness as H

    monkeypatch.setattr(
        H, "call_agent_json_guarded",
        lambda *a, **k: (raw_response, {"input_tokens": 100, "output_tokens": 50}),
    )
    return db


def test_single_object_response_accepted(monkeypatch):
    """模型返回单对象(生产实测形态)→ 包一层收下,不再整份丢弃。"""
    db = _install(monkeypatch, SINGLE_OBJECT)
    n = _stage_worldbook(_DummyCtl(), 1, 1)
    assert n == 1
    # 自清理上一轮 llm_pipeline 的 delete 必须先于写入发生
    deletes = [s for s in db.executed if s.startswith("delete from worldbook_entries")]
    assert deletes and "llm_pipeline" in deletes[0]
    assert db.executed.index(deletes[0]) < next(
        i for i, s in enumerate(db.executed) if "insert into worldbook_entries" in s
    )
    # upsert 保护 extracted（不覆盖 canon 产物）；editor 行改为字段级 manual guard
    upsert = next(s for s in db.executed if "insert into worldbook_entries" in s)
    assert "<> 'extracted'" in upsert
    assert "metadata->'manual_fields'" in upsert


def test_array_response_accepted(monkeypatch):
    _install(monkeypatch, ARRAY_OF_TWO)
    assert _stage_worldbook(_DummyCtl(), 1, 1) == 2


def test_force_clears_only_written_fields(monkeypatch):
    """force 后只清 content/keys/priority；tags 等本次没写的标记必须保留。"""
    db = _install(
        monkeypatch, SINGLE_OBJECT,
        metadata={"source": "editor", "manual_fields": ["content", "tags"]},
    )
    assert _stage_worldbook(_DummyCtl(), 1, 1, force_overwrite_manual=True) == 1
    updates = [
        params for sql, params in db.calls
        if sql.startswith("update worldbook_entries set metadata")
    ]
    assert updates, "force 重建后没有执行手编标记清理"
    new_meta = getattr(updates[-1][0], "obj", updates[-1][0])
    assert new_meta["manual_fields"] == ["tags"]
    assert new_meta["source"] == "editor"


def test_title_collision_with_protected_source_skipped(monkeypatch):
    """同名命中 editor/extracted → rowcount=0 跳过,不计入 written。"""
    _install(monkeypatch, ARRAY_OF_TWO, insert_rowcount=0)
    assert _stage_worldbook(_DummyCtl(), 1, 1) == 0


def test_garbage_response_returns_zero_without_raise(monkeypatch):
    _install(monkeypatch, "模型这次没有输出 JSON,抱歉。")
    assert _stage_worldbook(_DummyCtl(), 1, 1) == 0
