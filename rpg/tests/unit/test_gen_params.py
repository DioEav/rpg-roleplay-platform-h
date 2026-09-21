"""生成参数接线回归:键名命名空间 + seed/stop 解析 + 组装成请求字段。

背景(2026-09 实修):设置页写的是 **`settings.<key>`** 这种点号扁平键 —— 桌面
`useAutoSave(label, "settings")` 与移动 `usePrefSave('settings')` 都拼 `${scope}.${field}`,
而 /api/me/preference 是 JSONB 浅合并、点号原样落库。`_gen_params` 此前只查裸 `<key>`,
于是**整套采样参数静默失效**:界面保存正常、刷新回显正常,实际请求里一个参数都没有,
也不报错。本文件锁死这一层,免得再退回去。
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from agents.gm.backends import _gen_params  # noqa: E402
from agents.gm.backends import openai_compat  # noqa: E402


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
    """把库里的 preferences JSONB 换成给定 dict(走 _select_all_prefs 的真实读取路径)。"""
    import platform_app.db as dbmod

    monkeypatch.setattr(dbmod, "connect", lambda: _CM(prefs))
    monkeypatch.setattr(dbmod, "init_db", lambda: None)


# ── 键名命名空间(本次 bug 的根因) ───────────────────────────────────────────

def test_reads_scoped_key_written_by_the_ui(monkeypatch):
    """回归锁:前端实际写入的 settings.<key> 必须读到(修前这里返回 {})。"""
    _patch_prefs(monkeypatch, {"settings.temperature": 0.4, "settings.top_p": 0.85})
    assert _gen_params.resolve_gen_params(1) == {"temperature": 0.4, "top_p": 0.85}


def test_still_reads_legacy_bare_key(monkeypatch):
    _patch_prefs(monkeypatch, {"temperature": 0.4})
    assert _gen_params.resolve_gen_params(1) == {"temperature": 0.4}


def test_scoped_key_wins_when_both_present(monkeypatch):
    """与前端 lib/prefs.js::readScopedPref 同序:先 settings.<key>,再裸键。"""
    _patch_prefs(monkeypatch, {"settings.temperature": 0.1, "temperature": 1.9})
    assert _gen_params.resolve_gen_params(1)["temperature"] == 0.1


def test_zero_is_a_real_value_not_absent(monkeypatch):
    """0 是有效取值(最确定),不能被 truthy 判定当成"没设过"。"""
    _patch_prefs(monkeypatch, {"settings.temperature": 0})
    assert _gen_params.resolve_gen_params(1) == {"temperature": 0.0}


def test_clamps_out_of_range(monkeypatch):
    _patch_prefs(monkeypatch, {
        "settings.temperature": 9, "settings.top_p": -3,
        "settings.top_k": 40.7, "settings.frequency_penalty": 5,
    })
    out = _gen_params.resolve_gen_params(1)
    assert out["temperature"] == 2.0
    assert out["top_p"] == 0.0
    assert out["top_k"] == 40          # top_k 取整(int() 截断,非四舍五入 —— 既有语义)
    assert out["frequency_penalty"] == 2.0


def test_ignores_non_numeric_bool_none(monkeypatch):
    _patch_prefs(monkeypatch, {
        "settings.temperature": "warm", "settings.top_p": True, "settings.top_k": None,
    })
    assert _gen_params.resolve_gen_params(1) == {}


def test_empty_prefs_returns_empty(monkeypatch):
    _patch_prefs(monkeypatch, {})
    assert _gen_params.resolve_gen_params(1) == {}


def test_no_user_never_touches_db(monkeypatch):
    import platform_app.db as dbmod

    def _boom():
        raise AssertionError("user_id 为空时不该查库")

    monkeypatch.setattr(dbmod, "connect", _boom)
    assert _gen_params.resolve_gen_params(None) == {}


# ── seed: -1 是「每次随机」的哨兵,不能真发出去 ──────────────────────────────

def test_seed_minus_one_is_not_sent(monkeypatch):
    """界面默认 -1 = 每次随机;把 -1 发给 provider 会被当非法参数拒。"""
    _patch_prefs(monkeypatch, {"settings.seed": -1})
    assert "seed" not in _gen_params.resolve_gen_params(1)


def test_seed_zero_is_sent(monkeypatch):
    _patch_prefs(monkeypatch, {"settings.seed": 0})
    assert _gen_params.resolve_gen_params(1)["seed"] == 0


def test_seed_clamped_to_int32_range(monkeypatch):
    _patch_prefs(monkeypatch, {"settings.seed": 10 ** 12})
    assert _gen_params.resolve_gen_params(1)["seed"] == 2 ** 31 - 1


# ── stop:界面是 | 分隔的单字符串 ────────────────────────────────────────────

def test_stop_split_trim_and_drop_empty(monkeypatch):
    _patch_prefs(monkeypatch, {"settings.stop": " player: | | system: "})
    assert _gen_params.resolve_gen_params(1)["stop"] == ["player:", "system:"]


def test_stop_capped_at_four_sequences(monkeypatch):
    """OpenAI SDK 文档:stop = Up to 4 sequences。超出的截掉,免得被 400 拒。"""
    _patch_prefs(monkeypatch, {"settings.stop": "a|b|c|d|e|f"})
    assert _gen_params.resolve_gen_params(1)["stop"] == ["a", "b", "c", "d"]


def test_stop_accepts_list_shape(monkeypatch):
    _patch_prefs(monkeypatch, {"settings.stop": ["a", " b ", ""]})
    assert _gen_params.resolve_gen_params(1)["stop"] == ["a", "b"]


def test_empty_stop_is_not_sent(monkeypatch):
    _patch_prefs(monkeypatch, {"settings.stop": "||"})
    assert "stop" not in _gen_params.resolve_gen_params(1)


# ── 脏值健壮性:一个坏值不许把整组参数拖垮,也不许变成荒谬的取值 ──────────────

def test_non_finite_seed_does_not_kill_the_whole_set(monkeypatch):
    """inf 会让 int() 抛 OverflowError —— 不接住就整个函数抛出,三个 backend 的
    except Exception 一吞,**全部**采样参数一起失效(正是本模块在修的那类静默失败)。"""
    _patch_prefs(monkeypatch, {
        "settings.temperature": 0.3, "settings.top_p": 0.7, "settings.seed": float("inf"),
    })
    out = _gen_params.resolve_gen_params(1)
    assert out["temperature"] == 0.3 and out["top_p"] == 0.7
    assert "seed" not in out


def test_non_finite_numbers_are_ignored_not_clamped_to_extreme(monkeypatch):
    """min(2.0, nan) 在 Python 里返回 2.0 —— 不先挡掉,坏值会被静默夹成"最随机"那端。"""
    _patch_prefs(monkeypatch, {"settings.temperature": float("nan"), "settings.top_p": float("-inf")})
    assert _gen_params.resolve_gen_params(1) == {}


def test_dirty_stop_values_are_dropped(monkeypatch):
    """停用词一旦被误当成数字/对象发出去,后果是每轮回复在任意位置被截断。"""
    _patch_prefs(monkeypatch, {"settings.stop": 5})
    assert "stop" not in _gen_params.resolve_gen_params(1)
    _patch_prefs(monkeypatch, {"settings.stop": {"a": 1}})
    assert "stop" not in _gen_params.resolve_gen_params(1)
    _patch_prefs(monkeypatch, {"settings.stop": ["ok", 7, {"x": 1}, None]})
    assert _gen_params.resolve_gen_params(1)["stop"] == ["ok"]


# ── 组装:哪些进顶层、哪些进 extra_body ─────────────────────────────────────

def _backend_with_gen(monkeypatch, gen):
    monkeypatch.setattr(_gen_params, "resolve_gen_params", lambda uid: gen)
    b = openai_compat._OpenAICompatBackend.__new__(openai_compat._OpenAICompatBackend)
    b.user_id = 1
    return b


def test_seed_and_stop_go_to_top_level(monkeypatch):
    """seed/stop 是 OpenAI 标准顶层字段;top_k/repetition_penalty 不是,得塞 extra_body。"""
    b = _backend_with_gen(monkeypatch, {
        "temperature": 0.5, "top_p": 0.9, "seed": 7,
        "stop": ["player:"], "top_k": 40, "repetition_penalty": 1.15,
    })
    kw = b._sampling_kwargs(0.9)
    assert kw["seed"] == 7
    assert kw["stop"] == ["player:"]
    assert kw["top_p"] == 0.9
    assert kw["extra_body"] == {"top_k": 40, "repetition_penalty": 1.15}


def test_defaults_temperature_when_unset(monkeypatch):
    b = _backend_with_gen(monkeypatch, {})
    assert b._sampling_kwargs(0.9) == {"temperature": 0.9}


# ── 退参自愈:seed/stop 也必须在"可剥"名单里 ────────────────────────────────

def test_strip_sampling_also_drops_seed_and_stop():
    """o3/o4-mini 官方不支持 stop;被 400 拒时要能剥掉重试,否则整轮失败。"""
    kwargs = {"temperature": 0.9, "top_p": 0.9, "seed": 7, "stop": ["x"],
              "extra_body": {"top_k": 40}, "reasoning_effort": "high", "max_tokens": 800}
    openai_compat._strip_sampling(kwargs)
    assert kwargs == {"max_tokens": 800}


def test_optional_tuning_keys_covers_seed_and_stop():
    assert "seed" in openai_compat._OPTIONAL_TUNING_KEYS
    assert "stop" in openai_compat._OPTIONAL_TUNING_KEYS


# ── anthropic:stop 叫 stop_sequences,且**没有** seed 字段 ────────────────────

def test_anthropic_maps_stop_to_stop_sequences(monkeypatch):
    from agents.gm.backends import anthropic

    monkeypatch.setattr(_gen_params, "resolve_gen_params",
                        lambda uid: {"temperature": 0.5, "stop": ["player:", "system:"], "seed": 7})
    b = anthropic._AnthropicBackend.__new__(anthropic._AnthropicBackend)
    b.user_id = 1
    out = b._sampling_extra(has_thinking=False)
    assert out["stop_sequences"] == ["player:", "system:"]
    assert out["temperature"] == 0.5
    assert "seed" not in out          # Anthropic 的 messages.create 没有这个字段


def test_anthropic_skips_sampling_when_thinking_on(monkeypatch):
    from agents.gm.backends import anthropic

    monkeypatch.setattr(_gen_params, "resolve_gen_params",
                        lambda uid: {"temperature": 0.5, "stop": ["x"]})
    b = anthropic._AnthropicBackend.__new__(anthropic._AnthropicBackend)
    b.user_id = 1
    assert b._sampling_extra(has_thinking=True) == {}


# ── vertex:seed / stop_sequences / safety_settings ──────────────────────────

def test_vertex_config_carries_seed_stop_and_safety(monkeypatch):
    from agents.gm.backends import vertex
    from agents.gm import content_policy as cp

    monkeypatch.setattr(_gen_params, "resolve_gen_params",
                        lambda uid: {"temperature": 0.6, "seed": 7, "stop": ["x"]})
    monkeypatch.setattr(cp, "safety_settings_for_user", lambda uid: ["FAKE_SAFETY"])
    monkeypatch.setattr(vertex, "_SAFETY_REJECTED", set())

    cfg = vertex._user_gen_config(1, "gemini-3.5-flash")
    assert cfg["seed"] == 7
    assert cfg["stop_sequences"] == ["x"]
    assert cfg["temperature"] == 0.6
    assert cfg["safety_settings"] == ["FAKE_SAFETY"]


def test_vertex_omits_safety_after_it_was_rejected(monkeypatch):
    """该 (api_id, model, user) 已记忆"拒收 safety_settings" → 后续直接不再发,避免每轮都撞 400。

    键必须带 user_id(见 test_vertex_safety_settings.py):不然一个用户的 400 会让所有人
    都不再发,包括档位设在「禁止」的人。"""
    from agents.gm.backends import vertex
    from agents.gm import content_policy as cp

    monkeypatch.setattr(_gen_params, "resolve_gen_params", lambda uid: {})
    monkeypatch.setattr(cp, "safety_settings_for_user", lambda uid: ["FAKE_SAFETY"])
    monkeypatch.setattr(vertex, "_SAFETY_REJECTED", {("vertex_ai", "gemini-3.5-flash", 1)})

    cfg = vertex._user_gen_config(1, "gemini-3.5-flash")
    assert "safety_settings" not in cfg


def test_vertex_sends_nothing_when_user_unset(monkeypatch):
    from agents.gm.backends import vertex
    from agents.gm import content_policy as cp

    monkeypatch.setattr(_gen_params, "resolve_gen_params", lambda uid: {})
    monkeypatch.setattr(cp, "safety_settings_for_user", lambda uid: None)
    assert vertex._user_gen_config(1, "gemini-3.5-flash") == {}
