"""全书检索端点:正则执行超时护栏(不依赖 Postgres)。

编辑器 Cmd/Ctrl+Shift+F 的正则模式接受用户任意输入。标准库 re 无超时,像 (a+)+$
这样的灾难性回溯会把 worker 永久卡住;这里锁住三条不变量:

  1. regex 模式走 regex 模块的 finditer(timeout=...),超时 → 400 可行动提示;
  2. regex 依赖缺失时正则模式直接 400,绝不退回无超时的 re;
  3. 普通(非正则)检索仍把用户输入当字面量,不受影响。
"""
from __future__ import annotations

import asyncio
import json

import platform_app.api.script_edit.search as search_mod


class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _DB:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        return _Cur(self.rows)


def _run(monkeypatch, rows, **kwargs):
    monkeypatch.setattr(search_mod, "connect", lambda: _DB(rows))
    monkeypatch.setattr(search_mod, "script_owned", lambda *_a, **_k: {"id": 1})
    resp = asyncio.run(search_mod.api_script_search(
        script_id=1, user={"id": 7}, **kwargs,
    ))
    return resp, json.loads(resp.body)


def test_catastrophic_regex_times_out_with_400(monkeypatch):
    # (a|aa)+$ 在 regex 引擎里是真正的指数回溯;40 个 a + 失败尾字符足以稳定超时。
    rows = [{"chapter_index": 1, "title": "一", "content": "a" * 40 + "!"}]
    resp, body = _run(monkeypatch, rows, q="(a|aa)+$", regex=True)
    assert resp.status_code == 400
    assert body["ok"] is False
    assert "超时" in body["error"]


def test_regex_disabled_when_dependency_missing(monkeypatch):
    monkeypatch.setattr(search_mod, "_regex_mod", None)
    resp, body = _run(monkeypatch, [], q="a+", regex=True)
    assert resp.status_code == 400
    assert "未安装" in body["error"]


def test_literal_search_still_works(monkeypatch):
    rows = [{"chapter_index": 2, "title": "二", "content": "重力控制再次出现"}]
    resp, body = _run(monkeypatch, rows, q="重力控制", regex=False)
    assert resp.status_code == 200
    assert body["total"] == 1
    assert body["results"][0]["chapter_index"] == 2
    assert body["results"][0]["offset"] == 0


def test_normal_regex_still_works(monkeypatch):
    rows = [{"chapter_index": 1, "title": "一", "content": "abc 123"}]
    resp, body = _run(monkeypatch, rows, q=r"\d+", regex=True)
    assert resp.status_code == 200
    assert body["total"] == 1
    assert body["results"][0]["snippet"].find("123") >= 0
