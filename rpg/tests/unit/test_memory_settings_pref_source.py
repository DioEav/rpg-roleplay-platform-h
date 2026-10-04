"""get_memory_settings 读 user_preferences(前端真实写入表)—— 修复「界面调参从不生效」。

bug:前端 MemorySection 经 /api/me/preference 把 memory.* 写进 user_preferences.preferences,
    而 get_memory_settings 只查 settings 表(前端从无写入者)→ 注入管线与 pinned_max
    校验永远拿到 schema 默认,设置页 8 个参数全部无效。
修:主来源改读 user_preferences.preferences(扁平 dotted key "memory.*"),
    settings 表降级为历史兜底;逐字段校验,单个非法值只回落该字段,不整表清零。
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import platform_app.settings as settings_mod  # noqa: E402
from schemas.memory import MemorySettings  # noqa: E402


@pytest.fixture(autouse=True)
def _no_db(monkeypatch):
    """默认掐掉两个真实 DB 入口;单测内按需覆盖返回值。"""
    monkeypatch.setattr(settings_mod, "init_db", lambda: None)
    monkeypatch.setattr(settings_mod, "list_settings", lambda user_id: {})
    monkeypatch.setattr(settings_mod, "connect", None)  # 不允许走到 preferences 查询


def _patch_prefs(monkeypatch, prefs, row_value=None):
    """row_value=None → fetchone 返回带 preferences 的行;row_value 为
    (sentinel_missing,) 之类特殊值可模拟 fetchone 返回 None(无偏好行)。"""
    if row_value == "none":
        _row = None
    else:
        class _Row:
            def __getitem__(self, key):
                assert key == "preferences"
                return prefs

        _row = _Row()

    class _FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, _sql, _params):
            return self

        def fetchone(self):
            return _row

    monkeypatch.setattr(settings_mod, "connect", lambda: _FakeDb())


def test_reads_user_preferences_flat_memory_keys(monkeypatch):
    _patch_prefs(monkeypatch, {"memory.recall_depth": 12, "memory.token_budget": 1500})
    ms = settings_mod.get_memory_settings(1)
    assert ms.recall_depth == 12
    assert ms.token_budget == 1500
    # 未设置的键保持 schema 默认
    assert ms.pinned_max == MemorySettings().pinned_max
    assert ms.bucket_world_enabled is True


def test_user_preferences_overrides_legacy_settings_table(monkeypatch):
    monkeypatch.setattr(settings_mod, "list_settings", lambda user_id: {"memory.recall_depth": 3})
    # prefs 未设 recall_depth → 兜底用 settings 表旧值;pinned_max 只有 prefs 有 → 用 prefs
    _patch_prefs(monkeypatch, {"memory.pinned_max": 33})
    ms = settings_mod.get_memory_settings(1)
    assert ms.recall_depth == 3
    assert ms.pinned_max == 33


def test_user_preferences_wins_on_same_key_conflict(monkeypatch):
    # 两源同 key 冲突:前端真实写入的 user_preferences 必须胜出
    monkeypatch.setattr(settings_mod, "list_settings", lambda user_id: {"memory.recall_depth": 3, "memory.pinned_max": 10})
    _patch_prefs(monkeypatch, {"memory.recall_depth": 9})
    ms = settings_mod.get_memory_settings(1)
    assert ms.recall_depth == 9
    assert ms.pinned_max == 10


def test_no_preference_row_returns_defaults(monkeypatch):
    monkeypatch.setattr(settings_mod, "list_settings", lambda user_id: {})
    _patch_prefs(monkeypatch, {}, row_value="none")
    assert settings_mod.get_memory_settings(1) == MemorySettings()


def test_corrupt_preferences_json_does_not_crash(monkeypatch):
    # preferences JSONB 被写成非 dict(如 list)→ dict() 抛 TypeError 被吞 → 全默认
    monkeypatch.setattr(settings_mod, "list_settings", lambda user_id: {})
    _patch_prefs(monkeypatch, ["not", "a", "dict"])
    assert settings_mod.get_memory_settings(1) == MemorySettings()


def test_invalid_single_value_falls_back_per_field(monkeypatch):
    _patch_prefs(monkeypatch, {"memory.recall_depth": "not-a-number", "memory.token_budget": 1200})
    ms = settings_mod.get_memory_settings(1)
    # 非法值只回落该字段默认(5),不整表清零(token_budget 仍生效)
    assert ms.recall_depth == MemorySettings().recall_depth
    assert ms.token_budget == 1200


def test_out_of_range_value_falls_back_per_field(monkeypatch):
    _patch_prefs(monkeypatch, {"memory.summary_window": 9999})
    ms = settings_mod.get_memory_settings(1)
    assert ms.summary_window == MemorySettings().summary_window


def test_token_budget_upper_bound_is_5000(monkeypatch):
    """上限放开后 5000 必须被接受、5001 回落默认(防 UI/schema 单边改漏)。"""
    _patch_prefs(monkeypatch, {"memory.token_budget": 5000})
    assert settings_mod.get_memory_settings(1).token_budget == 5000
    _patch_prefs(monkeypatch, {"memory.token_budget": 5001})
    assert settings_mod.get_memory_settings(1).token_budget == MemorySettings().token_budget


def test_non_memory_and_unknown_keys_ignored(monkeypatch):
    _patch_prefs(monkeypatch, {
        "perm.default_mode": "full_access",      # 其它命名空间不碰
        "settings.召回深度": 7,                   # 更旧版中文 key 不碰
        "memory.mode": "aggressive",             # v1.77.0 已删除的字段不碰
        "memory.recall_depth": 9,
    })
    ms = settings_mod.get_memory_settings(1)
    assert ms.recall_depth == 9
    assert ms == MemorySettings(recall_depth=9)


def test_bool_coercion_for_bucket_switches(monkeypatch):
    _patch_prefs(monkeypatch, {"memory.bucket_world_enabled": False, "memory.bucket_pinned_enabled": False})
    ms = settings_mod.get_memory_settings(1)
    assert ms.bucket_world_enabled is False
    assert ms.bucket_pinned_enabled is False
    assert ms.bucket_character_enabled is True


def test_db_failure_returns_all_defaults(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(settings_mod, "list_settings", _boom)
    monkeypatch.setattr(settings_mod, "connect", _boom)
    ms = settings_mod.get_memory_settings(1)
    assert ms == MemorySettings()
