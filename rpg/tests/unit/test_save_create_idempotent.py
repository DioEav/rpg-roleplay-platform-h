"""POST /api/saves 创建存档的三重修复回归:

1. 前端 180s 超时(本文件测不到 fetch,由 api-client 改动 + eslint/babel 验证兜底);
2. 后端 create_save 卸载到线程池(不再阻塞事件循环);
3. 幂等去重:窗口内同用户+剧本+标题重复创建 → 直接返回已建成存档(治
   "前端超时→重试→重复建档"),查重失败降级放行,绝不挡正常创建。
"""
import asyncio
import json
import threading
from pathlib import Path

import pytest

sys_path = str(Path(__file__).resolve().parents[2])
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

import platform_app.api.saves as saves_mod  # noqa: E402
import platform_app.workspace.creation as creation_mod  # noqa: E402


class _FakeRequest:
    def __init__(self, payload):
        self._p = payload

    async def json(self):
        return self._p


class _FakeDb:
    """execute 记录参数;fetchone 返回构造时给定的行(None=查无)。"""

    def __init__(self, row=None):
        self.row = row
        self.params = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, _sql, params=None):
        self.params = params
        return self

    def fetchone(self):
        return self.row


@pytest.fixture(autouse=True)
def _no_db(monkeypatch):
    """默认掐断真实 DB(权限校验的 connect + creation 查重的 connect 都要掐);
    vertex 预检解析到 openai(非 vertex)直接放行,不触 DB/app 导入。"""
    monkeypatch.setattr(creation_mod, "init_db", lambda: None)

    def _no_connect(*a, **k):
        raise AssertionError("本用例不应触真实 DB 连接(需在用例内自行 patch connect)")

    monkeypatch.setattr(saves_mod, "connect", _no_connect)
    monkeypatch.setattr(creation_mod, "connect", _no_connect)
    import core.llm_backend as llm_mod
    monkeypatch.setattr(llm_mod, "resolve_preferred_api", lambda uid, key: "openai")


def _route(user_id=1, payload=None):
    payload = payload or {"script_id": 5, "title": " 测试档 "}
    return saves_mod.api_create_save(_FakeRequest(payload), {"id": user_id})


def test_find_recent_duplicate_returns_row_dict(monkeypatch):
    row = {"id": 42, "title": "新存档", "user_id": 1, "script_id": 5}
    fake = _FakeDb(row)
    monkeypatch.setattr(creation_mod, "connect", lambda: fake)
    out = creation_mod.find_recent_duplicate(1, 5, "新存档")
    # 经 expose:与 create_save 返回形状一致(dict 且 public_id→uid 的转换同路)
    assert out == row
    assert fake.params[3] == creation_mod.IDEMPOTENT_CREATE_WINDOW_SEC


def test_find_recent_duplicate_none_when_absent(monkeypatch):
    monkeypatch.setattr(creation_mod, "connect", lambda: _FakeDb(None))
    assert creation_mod.find_recent_duplicate(1, 5, "新存档") is None


def test_find_recent_duplicate_normalizes_title_like_create_save(monkeypatch):
    fake = _FakeDb(None)
    monkeypatch.setattr(creation_mod, "connect", lambda: fake)
    # 空标题 → "新存档";带空白 → strip(与 create_save 入库规则一致)
    creation_mod.find_recent_duplicate(1, 5, "")
    assert fake.params[2] == "新存档"
    creation_mod.find_recent_duplicate(1, 5, "  测试档  ")
    assert fake.params[2] == "测试档"


class _FakeReadableDb:
    """权限校验用:execute 被调即返回真值行(fetchone 由 script_readable 桩消化)。"""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, *a, **k):
        return self

    def fetchone(self):
        return {"id": 5}


@pytest.fixture
def _readable_db(monkeypatch):
    monkeypatch.setattr(saves_mod, "connect", lambda: _FakeReadableDb())


def test_route_returns_recent_duplicate_without_creating(monkeypatch, _readable_db):
    """窗口内命中 → 返回已有档(deduplicated 标记),绝不调 create_save。"""
    dup = {"id": 42, "title": "测试档", "user_id": 1, "script_id": 5}
    monkeypatch.setattr(saves_mod.workspace, "find_recent_duplicate", lambda *a: dup)

    def _must_not_create(*a, **k):
        raise AssertionError("幂等命中后不应再调 create_save")

    monkeypatch.setattr(saves_mod.workspace, "create_save", _must_not_create)
    monkeypatch.setattr(saves_mod, "script_readable", lambda db, sid, uid: {"id": sid})

    resp = asyncio.run(_route())
    body = json.loads(resp.body)
    assert body["ok"] is True
    assert body["deduplicated"] is True
    assert body["save"]["id"] == 42


def test_find_recent_duplicate_exposes_uid(monkeypatch):
    """P2-1 形状一致性:行含 public_id 时经 expose 必须带上 uid(与 create_save 同路)。"""
    row = {"id": 42, "title": "新存档", "public_id": "sv-abc"}
    monkeypatch.setattr(creation_mod, "connect", lambda: _FakeDb(row))
    out = creation_mod.find_recent_duplicate(1, 5, "新存档")
    assert out["uid"] == "sv-abc"


def test_route_normalizes_null_title(monkeypatch, _readable_db):
    """客户端显式传 {"title": null} → 归一为 ""(存量隐患:create_save 内
    title.strip() 对 None 会 AttributeError)。查重与建档都拿 str。"""
    seen = {}
    monkeypatch.setattr(saves_mod.workspace, "find_recent_duplicate",
                        lambda uid, sid, title: seen.setdefault("title", title) or None)
    monkeypatch.setattr(saves_mod.workspace, "create_save",
                        lambda uid, sid, title, **kw: seen.setdefault("create_title", title) or {"id": 7})
    monkeypatch.setattr(saves_mod, "script_readable", lambda db, sid, uid: {"id": sid})

    resp = asyncio.run(_route(payload={"script_id": 5, "title": None}))
    body = json.loads(resp.body)
    assert body["ok"] is True
    assert seen["title"] == ""
    assert seen["create_title"] == ""


def test_route_miss_calls_create_save_off_event_loop(monkeypatch, _readable_db):
    """未命中 → 正常创建,且 create_save 在工作线程跑(不再阻塞事件循环)。"""
    monkeypatch.setattr(saves_mod.workspace, "find_recent_duplicate", lambda *a: None)
    calls = {}

    def fake_create(uid, sid, title, **kw):
        calls["args"] = (uid, sid, title)
        calls["thread"] = threading.current_thread().ident
        return {"id": 7, "title": title.strip()}

    monkeypatch.setattr(saves_mod.workspace, "create_save", fake_create)
    monkeypatch.setattr(saves_mod, "script_readable", lambda db, sid, uid: {"id": sid})

    resp = asyncio.run(_route())
    body = json.loads(resp.body)
    assert body["ok"] is True
    assert body["save"]["id"] == 7
    assert calls["args"] == (1, 5, " 测试档 ")
    assert calls["thread"] != threading.main_thread().ident, "create_save 应在 to_thread 工作线程执行"


def test_route_dedupe_failure_degrades_to_normal_create(monkeypatch, _readable_db):
    """查重自身抛异常 → 降级放行(宁可重复建档也不挡创建)。"""
    def _boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(saves_mod.workspace, "find_recent_duplicate", _boom)
    monkeypatch.setattr(saves_mod.workspace, "create_save", lambda *a, **k: {"id": 9})
    monkeypatch.setattr(saves_mod, "script_readable", lambda db, sid, uid: {"id": sid})

    resp = asyncio.run(_route())
    body = json.loads(resp.body)
    assert body["ok"] is True
    assert body["save"]["id"] == 9


def test_route_still_rejects_script_without_access(monkeypatch, _readable_db):
    """去重不得越过权限校验:无权访问的剧本,即使有"重名档"也 403。"""
    monkeypatch.setattr(saves_mod, "script_readable", lambda db, sid, uid: None)
    resp = asyncio.run(_route())
    assert resp.status_code == 403
