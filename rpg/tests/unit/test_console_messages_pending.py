"""刷新/切回对话后，待确认项必须随历史返回。

后端把 pending_confirmations 持久化在对话状态里（Redis/PG），但 messages 端点此前
只回文本/工具历史；前端刷新后只剩一个没有按钮的工具块，待确认永远悬空。
本测试锁住两条返回路径（ui_turns / 旧对话兜底）都带 pending_confirmations，
以及对话列表按 script_id 过滤（编辑器不混入其它剧本/游戏的上下文）。
"""
from __future__ import annotations

import asyncio
import json

import console_assistant
import console_assistant.conversations as convmod
import routes.console_assistant as route


def _call(monkeypatch, conv):
    monkeypatch.setattr(convmod, "_get_or_create_conversation", lambda _uid, cid: (cid, conv))
    resp = asyncio.run(route.api_console_assistant_conversation_messages(
        "cid-test", api_user={"id": 7},
    ))
    return json.loads(resp.body)


def test_messages_include_pending_confirmations(monkeypatch):
    conv = {
        "ui_turns": [
            {"role": "user", "text": "改一下第 1 章", "tools": []},
            {"role": "assistant", "text": "", "tools": [
                {"call_id": "c1", "tool": "update_script_chapter", "status": "running"},
            ]},
        ],
        "pending_confirmations": {
            "c1": {
                "call_id": "c1",
                "tool": "update_script_chapter",
                "args": {"chapter_index": 1, "base_chapter_id": 11},
                "preview": {"kind": "chapter", "chapter_id": 11},
            },
        },
    }
    body = _call(monkeypatch, conv)
    assert body["ok"] is True
    assert body["messages"][1]["tools"][0]["call_id"] == "c1"
    assert body["pending_confirmations"][0]["call_id"] == "c1"
    assert body["pending_confirmations"][0]["preview"]["chapter_id"] == 11


def test_conversation_list_filters_by_script(monkeypatch):
    rows = [
        {"id": "a", "script_id": 7, "last_used": "2026-01-01"},
        {"id": "b", "script_id": 8, "last_used": "2026-01-02"},
        {"id": "c", "script_id": None, "last_used": "2026-01-03"},
    ]
    monkeypatch.setattr(console_assistant, "list_conversations", lambda _uid: list(rows))
    monkeypatch.setattr(convmod, "list_conversations_pg", lambda _uid: [])
    resp = asyncio.run(route.api_console_assistant_conversations(
        script_id=7, api_user={"id": 1},
    ))
    body = json.loads(resp.body)
    assert [it["id"] for it in body["items"]] == ["a"]

    # 不传 script_id(游戏控制台)= 不过滤,行为不变。
    resp2 = asyncio.run(route.api_console_assistant_conversations(api_user={"id": 1}))
    assert len(json.loads(resp2.body)["items"]) == 3


def test_messages_return_script_owner(monkeypatch):
    conv = {
        "messages": [{"role": "user", "content": "hi"}],
        "pending_confirmations": {},
        "script_id": 7,
    }
    body = _call(monkeypatch, conv)
    assert body["script_id"] == 7



def test_legacy_history_also_includes_pending(monkeypatch):
    conv = {
        "messages": [{"role": "user", "content": "旧对话"}],
        "pending_confirmations": {
            "c2": {"call_id": "c2", "tool": "resplit_script", "args": {"script_id": 3}},
        },
    }
    body = _call(monkeypatch, conv)
    assert body["pending_confirmations"][0]["call_id"] == "c2"
    assert body["messages"][0]["text"] == "旧对话"
