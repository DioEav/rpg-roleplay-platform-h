"""自部署反馈写本地库(2026-10 改动)——不再转发到外部中央服务器。

旧行为:LOCAL_MODES 下 POST /api/feedback 被转发到 RPG_CENTRAL_URL(作者服务器),
反馈数据离开自部署者本机。改后:所有部署模式一律写本地库,由自部署者自己的
admin 经 #admin-feedback 审阅。本测试钉住:提交落库 + 无 forwarded 字段 +
转发函数不复存在。
"""
import asyncio
import json
import os
from pathlib import Path

import pytest

sys_path = str(Path(__file__).resolve().parents[2])
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

import platform_app.api.feedback as feedback_mod  # noqa: E402


class _FakeRequest:
    def __init__(self, payload):
        self._p = payload
        self.headers = {"user-agent": "pytest"}
        self.client = None  # _client_ip → ""

    async def json(self):
        return self._p


class _FakeDb:
    def __init__(self):
        self.sqls = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sqls.append(" ".join(sql.split()))
        return self

    def fetchone(self):
        return {"id": 123}


class _FakeRequestFactory:
    pass


@pytest.fixture
def _local_env(monkeypatch):
    """本地部署模式(旧行为下会走转发分支的场景)+ 掐掉真实 DB 与外部预审。"""
    monkeypatch.setenv("RPG_DEPLOYMENT_MODE", "local")
    db = _FakeDb()
    monkeypatch.setattr(feedback_mod, "connect", lambda: db)
    monkeypatch.setattr(feedback_mod, "_client_ip", lambda req: "127.0.0.1")
    monkeypatch.setattr(feedback_mod, "_capture_feedback_env", lambda user, env=None: {"stub": True})

    class _V:
        action = "pass"
        categories = []
        scores = {}

    async def _fake_moderate(_text):
        return _V()

    monkeypatch.setattr(feedback_mod, "moderate_feedback", _fake_moderate)
    return db


def _submit(title_email=None):
    payload = {
        "free_text": "GM 忘了我的固定记忆",
        "excerpts": [],
        "consent_token": "a" * 64,
        "app_version": "test",
    }
    if title_email:
        payload["contact_email"] = title_email
    return asyncio.run(feedback_mod.submit_feedback(_FakeRequest(payload), {"id": 1}))


def test_local_mode_writes_local_db(_local_env):
    resp = _submit()
    body = json.loads(resp.body)
    # 落库:feedback + consent_log 两条 insert 都进了本地库
    assert any("insert into feedback" in s for s in _local_env.sqls)
    assert any("insert into feedback_consent_log" in s for s in _local_env.sqls)
    assert body["ok"] is True
    assert body["feedback_id"] == 123
    # 旧转发路径的响应字段必须不存在
    assert "forwarded" not in body
    assert "linked" not in body


def test_forward_function_is_gone():
    """转发实现必须已删除(防止有人把它接回来)。"""
    assert not hasattr(feedback_mod, "_forward_feedback_to_central")


def test_consent_token_still_validated(_local_env):
    """写本地库不放松校验:错 consent_token 依旧 400。"""
    from fastapi import HTTPException

    req = _FakeRequest({"free_text": "x", "excerpts": [], "consent_token": "nothex"})
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(feedback_mod.submit_feedback(req, {"id": 1}))
    assert "consent_token" in str(exc_info.value.detail)
