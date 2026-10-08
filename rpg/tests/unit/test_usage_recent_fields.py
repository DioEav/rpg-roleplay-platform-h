"""aggregate_usage recent_turns 字段完整性回归(2026-10 修复)。

bug:recent 查询 SELECT 漏了 cached_input_tokens/save_id/context_run_id →
    前端「最近请求」的「缓存 in」恒 "—"、时间列存档跳转失效、CSV 两列恒空。
修:SELECT + 响应构造补齐三列。本测试用假 DB 钉死响应字段必须存在。
"""
import sys
from pathlib import Path

sys_path = str(Path(__file__).resolve().parents[2])
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

import platform_app.usage as usage_mod  # noqa: E402


class _FakeDb:
    """按调用顺序吐结果:total / by_model / by_scenario / recent_total / recent。"""

    def __init__(self, results):
        self._results = list(results)
        self.sqls = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sqls.append(" ".join(sql.split()))
        return self

    def fetchone(self):
        return self._results.pop(0)

    def fetchall(self):
        return self._results.pop(0)


def test_recent_turns_includes_cached_and_save_ids(monkeypatch):
    recent_row = {
        "created_at": "2026-10-07 12:00:00",
        "api_id": "openai",
        "model_real_name": "gpt-test",
        "input_tokens": 1000,
        "output_tokens": 200,
        "cost_usd": 0.0025,
        "context_used": 950,
        "context_max": 128000,
        "scenario": "chat",
        "cached_input_tokens": 700,
        "save_id": 42,
        "context_run_id": 7,
    }
    db = _FakeDb([
        {"input_tokens": 1000, "output_tokens": 200, "cached_input_tokens": 700,
         "total_tokens": 1200, "cost_usd": 0.0025, "turns": 1},  # total
        [],                                                       # by_model
        [],                                                       # by_scenario
        {"n": 1},                                                 # recent_total
        [recent_row],                                             # recent
    ])
    monkeypatch.setattr(usage_mod, "init_db", lambda: None)
    monkeypatch.setattr(usage_mod, "connect", lambda: db)

    data = usage_mod.aggregate_usage(user_id=1, days=7)
    row = data["recent_turns"][0]
    # 修复的三列必须出现在响应里
    assert row["cached_input_tokens"] == 700
    assert row["save_id"] == 42
    assert row["context_run_id"] == 7
    # 原有字段不回归
    assert row["context_used"] == 950
    assert row["context_max"] == 128000
    assert row["scenario"] == "chat"
    # SELECT 语句本身也必须带上三列(防再次漏列)
    assert any("cached_input_tokens, save_id, context_run_id" in s for s in db.sqls)


def test_recent_turns_handles_null_save_id(monkeypatch):
    """子代理行 save_id 为 NULL → 原样透传 None(前端已有 || 兜底)。"""
    recent_row = {
        "created_at": "2026-10-07 12:00:00",
        "api_id": "openai", "model_real_name": "gpt-test",
        "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.0001,
        "context_used": 0, "context_max": 0, "scenario": "tool",
        "cached_input_tokens": 0, "save_id": None, "context_run_id": None,
    }
    db = _FakeDb([
        {"input_tokens": 10, "output_tokens": 5, "cached_input_tokens": 0,
         "total_tokens": 15, "cost_usd": 0.0001, "turns": 1},
        [], [], {"n": 1}, [recent_row],
    ])
    monkeypatch.setattr(usage_mod, "init_db", lambda: None)
    monkeypatch.setattr(usage_mod, "connect", lambda: db)

    row = usage_mod.aggregate_usage(user_id=1, days=7)["recent_turns"][0]
    assert row["save_id"] is None
    assert row["cached_input_tokens"] == 0
