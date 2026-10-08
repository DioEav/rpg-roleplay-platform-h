"""验收官与指令解析的「通用兜底 agent.*」回退链回归(2026-10 方案A)。

bug:设置页「通用兜底」承诺对所有未单独配置的模块生效,但验收官链只回退到
    extractor.*(跳过 agent.*),/set 解析链只回退到 first_user_model —— 通用兜底
    对这两处不生效。修:两链各插一级 agent.*(命名空间之后、既有回退之前),
    并提取成独立解析函数便于测链序。
"""
import sys
from pathlib import Path

sys_path = str(Path(__file__).resolve().parents[2])
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

import agents.acceptance_verifier as verifier_mod  # noqa: E402
import tools_dsl.set_parser as set_parser_mod  # noqa: E402


def _patch_verifier_chain(monkeypatch, *, verifier=None, extractor=None, agent=None,
                          default_api="vertex_ai", default_model="gemini-3.5-flash"):
    monkeypatch.setattr(verifier_mod, "_resolve_preferred_verifier_api",
                        (lambda uid: verifier[0]) if verifier else (lambda uid: None))
    monkeypatch.setattr(verifier_mod, "_resolve_preferred_verifier_model",
                        (lambda uid: verifier[1]) if verifier else (lambda uid: None))
    monkeypatch.setattr(verifier_mod, "_resolve_preferred_agent_api",
                        (lambda uid: agent[0]) if agent else (lambda uid: None))
    monkeypatch.setattr(verifier_mod, "_resolve_preferred_agent_model",
                        (lambda uid: agent[1]) if agent else (lambda uid: None))
    monkeypatch.setattr(verifier_mod, "_DEFAULT_FALLBACK_API", default_api)
    monkeypatch.setattr(verifier_mod, "_DEFAULT_FALLBACK_MODEL", default_model)
    import agents.extractor as ext
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_api",
                        (lambda uid: extractor[0]) if extractor else (lambda uid: None))
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_model",
                        (lambda uid: extractor[1]) if extractor else (lambda uid: None))


def test_verifier_agent_fallback_used_when_namespace_and_extractor_unset(monkeypatch):
    _patch_verifier_chain(monkeypatch, agent=("openai", "agent-model"))
    api, model = verifier_mod._resolve_verifier_backend(1, None, None, __import__("agents.extractor", fromlist=["x"]))
    assert api == "openai" and model == "agent-model"


def test_verifier_order_namespace_beats_extractor_beats_agent(monkeypatch):
    _patch_verifier_chain(monkeypatch,
                          verifier=("verifier-api", "verifier-model"),
                          extractor=("extractor-api", "extractor-model"),
                          agent=("agent-api", "agent-model"))
    api, model = verifier_mod._resolve_verifier_backend(1, None, None, __import__("agents.extractor", fromlist=["x"]))
    assert (api, model) == ("verifier-api", "verifier-model")


def test_verifier_extractor_beats_agent(monkeypatch):
    _patch_verifier_chain(monkeypatch,
                          extractor=("extractor-api", "extractor-model"),
                          agent=("agent-api", "agent-model"))
    api, model = verifier_mod._resolve_verifier_backend(1, None, None, __import__("agents.extractor", fromlist=["x"]))
    assert (api, model) == ("extractor-api", "extractor-model")


def test_verifier_override_beats_all(monkeypatch):
    _patch_verifier_chain(monkeypatch,
                          verifier=("verifier-api", "verifier-model"),
                          agent=("agent-api", "agent-model"))
    import agents.extractor as ext
    api, model = verifier_mod._resolve_verifier_backend(
        1, "override-api", "override-model", ext)
    assert (api, model) == ("override-api", "override-model")


def _patch_set_parser_chain(monkeypatch, *, set_parser=None, agent=None,
                            first_user=("first-api", "first-model"),
                            default_api="vertex_ai", default_model="gemini-3.5-flash"):
    monkeypatch.setattr(set_parser_mod, "_resolve_preferred_api",
                        (lambda uid: set_parser[0]) if set_parser else (lambda uid: None))
    monkeypatch.setattr(set_parser_mod, "_resolve_preferred_model",
                        (lambda uid: set_parser[1]) if set_parser else (lambda uid: None))
    monkeypatch.setattr(set_parser_mod, "_resolve_preferred_agent_api",
                        (lambda uid: agent[0]) if agent else (lambda uid: None))
    monkeypatch.setattr(set_parser_mod, "_resolve_preferred_agent_model",
                        (lambda uid: agent[1]) if agent else (lambda uid: None))
    import core.llm_backend as llm
    monkeypatch.setattr(llm, "first_user_model", lambda uid: first_user)
    monkeypatch.setattr(llm, "DEFAULT_FALLBACK_API", default_api)
    monkeypatch.setattr(llm, "DEFAULT_FALLBACK_MODEL", default_model)


def test_set_parser_agent_fallback_used(monkeypatch):
    _patch_set_parser_chain(monkeypatch, agent=("agent-api", "agent-model"),
                            first_user=(None, None))
    api, model = set_parser_mod._resolve_set_parser_backend(1)
    assert (api, model) == ("agent-api", "agent-model")


def test_set_parser_order_namespace_beats_agent_beats_first_user(monkeypatch):
    _patch_set_parser_chain(monkeypatch, set_parser=("sp-api", "sp-model"),
                            agent=("agent-api", "agent-model"),
                            first_user=("first-api", "first-model"))
    api, model = set_parser_mod._resolve_set_parser_backend(1)
    assert (api, model) == ("sp-api", "sp-model")

    _patch_set_parser_chain(monkeypatch, agent=("agent-api", "agent-model"),
                            first_user=("first-api", "first-model"))
    api, model = set_parser_mod._resolve_set_parser_backend(1)
    assert (api, model) == ("agent-api", "agent-model"), "agent.* 应先于 first_user_model"


def test_set_parser_override_beats_all(monkeypatch):
    _patch_set_parser_chain(monkeypatch, set_parser=("sp-api", "sp-model"),
                            agent=("agent-api", "agent-model"))
    api, model = set_parser_mod._resolve_set_parser_backend(1, "override-api", "override-model")
    assert (api, model) == ("override-api", "override-model")


# ── /set 主路径(command_agent)与 extractor 链的 agent.* 级(审查 P1/P2 补齐) ──

def test_command_agent_agent_helpers_route_to_agent_namespace(monkeypatch):
    """command_agent 的 agent 助手必须走 agent.* pref_key(base 是模块级绑定,patch base)。"""
    import agents.command_agent as cmd_mod
    import core.llm_backend as llm_mod
    got = {}
    monkeypatch.setattr(cmd_mod, "_resolve_preferred_api_base",
                        lambda uid, pref_key: got.setdefault(pref_key, "agent-api"))
    monkeypatch.setattr(cmd_mod, "_resolve_preferred_model_base",
                        lambda uid, pref_key: got.setdefault(pref_key, "agent-model"))
    assert cmd_mod._resolve_preferred_agent_api(1) == "agent-api"
    assert cmd_mod._resolve_preferred_agent_model(1) == "agent-model"
    assert got["agent.api_id"] == "agent-api"
    assert got["agent.model_real_name"] == "agent-model"


def test_command_agent_chain_references_agent_fallback():
    """接线断言(防删,防 v1.41.0 式错接):parse_set_command 链必须引用 agent 兜底助手。"""
    import inspect
    import agents.command_agent as cmd_mod
    src = inspect.getsource(cmd_mod.parse_set_command)
    assert "_resolve_preferred_agent_api(user_id)" in src
    assert "_resolve_preferred_agent_model(user_id)" in src


def test_extractor_chain_agent_fallback_used(monkeypatch):
    """extract_state_ops 链:extractor.* → agent.* → 固定默认(agent.* 补齐验证)。"""
    import agents.extractor as ext
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_api", lambda uid: None)
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_model", lambda uid: None)
    monkeypatch.setattr(ext, "_resolve_preferred_agent_api", lambda uid: "agent-api")
    monkeypatch.setattr(ext, "_resolve_preferred_agent_model", lambda uid: "agent-model")

    # extract_state_ops 空文本早退;用非空文本 + mock backend 捕获解析结果
    captured = {}
    monkeypatch.setattr(ext, "_call_extractor_backend",
                        lambda **kw: captured.update(api_id=kw["api_id"], model=kw["model"]) or ("[]", None))
    out = ext.extract_state_ops("主角拔剑。", {"player": {"name": "甲"}}, user_id=1)
    assert out == []
    assert captured == {"api_id": "agent-api", "model": "agent-model"}


def test_extractor_namespace_beats_agent(monkeypatch):
    import agents.extractor as ext
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_api", lambda uid: "extractor-api")
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_model", lambda uid: "extractor-model")
    monkeypatch.setattr(ext, "_resolve_preferred_agent_api",
                        lambda uid: (_ for _ in ()).throw(AssertionError("命名空间已设时不应触 agent.*")))
    monkeypatch.setattr(ext, "_resolve_preferred_agent_model",
                        lambda uid: (_ for _ in ()).throw(AssertionError("命名空间已设时不应触 agent.*")))
    captured = {}
    monkeypatch.setattr(ext, "_call_extractor_backend",
                        lambda **kw: captured.update(api_id=kw["api_id"], model=kw["model"]) or ("[]", None))
    ext.extract_state_ops("主角拔剑。", {"player": {"name": "甲"}}, user_id=1)
    assert captured == {"api_id": "extractor-api", "model": "extractor-model"}


def test_extractor_chain_includes_agent_fallback(monkeypatch):
    """extract_state_ops 链:extractor.* → agent.* → 固定默认(agent.* 补齐验证)。"""
    import agents.extractor as ext
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_api", lambda uid: None)
    monkeypatch.setattr(ext, "_resolve_preferred_extractor_model", lambda uid: None)
    monkeypatch.setattr(ext, "_resolve_preferred_agent_api", lambda uid: "agent-api")
    monkeypatch.setattr(ext, "_resolve_preferred_agent_model", lambda uid: "agent-model")

    # extract_state_ops 空文本早退;用非空文本 + mock backend 捕获解析结果
    captured = {}
    monkeypatch.setattr(ext, "_call_extractor_backend",
                        lambda **kw: captured.update(api_id=kw["api_id"], model=kw["model"]) or ("[]", None))
    out = ext.extract_state_ops("主角拔剑。", {"player": {"name": "甲"}}, user_id=1)
    assert out == []
    assert captured == {"api_id": "agent-api", "model": "agent-model"}
