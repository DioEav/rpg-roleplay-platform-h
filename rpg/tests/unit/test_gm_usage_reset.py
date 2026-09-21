"""test_gm_usage_reset.py — 新一轮 provider 调用前必须清掉上一轮的 last_usage。

背景:`last_usage` 只在 backend.__init__ 里初始化,而 backend 是长生命周期的(app.py 按用户
缓存 GameMaster);openai_compat._capture_usage 还会在本次拿不到 finish_reason 时**主动把旧值
续写回去**。于是上一轮的 `content_filter` 会留到这一轮 —— 而这一轮若是因传输层原因返回空,
消费者(persist 空回复分支 / _build_usage_payload 告警 / _stop_reason_notice)就会把旧原因
当成这一轮的,给玩家一个指错方向的建议(「去调内容尺度」)。
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from agents.gm.master import GameMaster  # noqa: E402


class _Cur:
    def __init__(self, prefs):
        self._prefs = prefs

    def fetchone(self):
        return {"preferences": self._prefs}


class _DB:
    def __init__(self, prefs):
        self._prefs = prefs

    def execute(self, sql, params=None):
        return _Cur(self._prefs)


class _CM:
    def __init__(self, prefs):
        self._db = _DB(prefs)

    def __enter__(self):
        return self._db

    def __exit__(self, *a):
        return False


def _patch_prefs(monkeypatch, prefs):
    import platform_app.db as dbmod

    monkeypatch.setattr(dbmod, "connect", lambda: _CM(prefs))
    monkeypatch.setattr(dbmod, "init_db", lambda: None)


def _bare_gm(monkeypatch, backend):
    """只够跑 narrative 入口的 GameMaster(__init__ 需要凭证与 catalog,故绕开)。"""
    _patch_prefs(monkeypatch, {})
    gm = GameMaster.__new__(GameMaster)
    gm.user_id = 1
    gm._active_state = None
    gm._world_section_for_active_content = lambda: ""
    gm._active_script_id = lambda: None
    gm._turn_message = lambda *a, **k: "hi"
    gm._backend = backend
    return gm


class _StubBackend:
    """记录"被调用那一刻"的 last_usage,用来证明 reset 发生在调用之前。"""

    def __init__(self):
        self.last_usage = {"finish_reason": "content_filter", "input_tokens": 999}
        self.seen_at_call = None

    def stream(self, system, messages, max_tokens):
        self.seen_at_call = dict(self.last_usage)
        yield "x"

    def call(self, system, messages, max_tokens):
        self.seen_at_call = dict(self.last_usage)
        return "x"


class _State:
    def history_messages(self):
        return []


def test_reset_helper_clears_last_usage():
    b = _StubBackend()
    gm = GameMaster.__new__(GameMaster)
    gm._backend = b
    gm._reset_backend_usage()
    assert b.last_usage == {}


def test_respond_stream_resets_before_calling_the_backend(monkeypatch):
    b = _StubBackend()
    gm = _bare_gm(monkeypatch, b)
    list(gm.respond_stream("go", "", _State()))
    assert b.seen_at_call == {}, "调用前必须清掉上一轮的 finish_reason / tokens"


def test_respond_resets_before_calling_the_backend(monkeypatch):
    b = _StubBackend()
    gm = _bare_gm(monkeypatch, b)
    gm.respond("go", "", _State())
    assert b.seen_at_call == {}


def test_opening_resets_before_calling_the_backend(monkeypatch):
    b = _StubBackend()
    gm = _bare_gm(monkeypatch, b)
    gm.generate_opening(_State(), "")
    assert b.seen_at_call == {}


def test_missing_backend_is_silent_not_crashing(monkeypatch):
    """清理是锦上添花,绝不该把回合弄挂。"""
    gm = GameMaster.__new__(GameMaster)
    gm._backend = None
    gm._reset_backend_usage()  # 不抛
