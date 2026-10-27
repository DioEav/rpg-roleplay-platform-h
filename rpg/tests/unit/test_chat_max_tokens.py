from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

os.environ.setdefault("RPG_REQUIRE_AUTH", "0")

import app  # noqa: E402


def _user() -> dict:
    return {"id": 123, "username": "tester"}


def test_chat_max_tokens_defaults_to_byok_story_budget():
    with mock.patch.object(app, "_get_user_preferences_cached", return_value={}):
        assert app._chat_max_tokens(_user()) == app.CHAT_MAX_TOKENS_DEFAULT
        assert app.CHAT_MAX_TOKENS_DEFAULT == 4096


def test_chat_max_tokens_reads_scoped_preference():
    with mock.patch.object(app, "_get_user_preferences_cached", return_value={"settings.max_tokens": "12000"}):
        assert app._chat_max_tokens(_user()) == 12000


def test_chat_max_tokens_reads_legacy_key_above_min():
    # legacy key 仍被读取；高于 MIN 时原样生效。
    with mock.patch.object(app, "_get_user_preferences_cached", return_value={"max_tokens": 12000}):
        assert app._chat_max_tokens(_user()) == 12000


def test_chat_max_tokens_clamps_legacy_key_below_current_min():
    # 旧档 2048 低于当前 CHAT_MAX_TOKENS_MIN(4096) → 按新下限夹紧，但 key 仍被读取。
    with mock.patch.object(app, "_get_user_preferences_cached", return_value={"max_tokens": 2048}):
        assert app._chat_max_tokens(_user()) == app.CHAT_MAX_TOKENS_MIN


def test_chat_max_tokens_clamps_only_extreme_values():
    with mock.patch.object(app, "_get_user_preferences_cached", return_value={"settings.max_tokens": 999999}):
        assert app._chat_max_tokens(_user()) == app.CHAT_MAX_TOKENS_MAX

    with mock.patch.object(app, "_get_user_preferences_cached", return_value={"settings.max_tokens": 16}):
        assert app._chat_max_tokens(_user()) == app.CHAT_MAX_TOKENS_MIN
