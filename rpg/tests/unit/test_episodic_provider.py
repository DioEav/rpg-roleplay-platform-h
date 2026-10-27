"""EpisodicRecallProvider(酒馆/自由/模组的长程召回)单测。

用户实锤缺口:「修的是游戏模式,酒馆没得到修复?」→ 属实。novel 走 retrieve_context
注入;tavern/freeform/module 此前完全无长程召回。本 provider 补齐,语料=kb_events
优先、state 全量 history 兜底(酒馆跳过史官,75 档仅 4 档有事件=兜底是主路径)。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from context_providers.base import Demand, ProviderServices  # noqa: E402
from context_providers.episodic_recall import EpisodicRecallProvider  # noqa: E402
from context_providers.registry import DEFAULT_FREEFORM_MANIFEST  # noqa: E402
from kb.episodic import _excerpt_around_match, score_history_messages  # noqa: E402


class _FakeState:
    def __init__(self, history):
        self.data = {"history": history}


def _mk_history():
    """构造 20 轮(40条)历史:第 3 轮埋一个独特事实(菲奥娜的银怀表),远超 6 轮窗口。"""
    h = []
    for i in range(1, 21):
        if i == 3:
            h.append({"role": "user", "content": "我把祖传的银怀表交给菲奥娜保管,叮嘱她别打开表盖"})
            h.append({"role": "assistant", "content": "菲奥娜接过银怀表,郑重放进围裙内袋,答应绝不打开表盖。"})
        else:
            h.append({"role": "user", "content": f"第{i}轮玩家闲聊内容,无关紧要的日常对话。"})
            h.append({"role": "assistant", "content": f"第{i}轮GM回应,继续推进眼前的场景。"})
    return h


def _collect(query, history, flag_on=True, monkeypatch=None):
    prov = EpisodicRecallProvider()
    if monkeypatch is not None:
        import core.feature_flags as ff
        monkeypatch.setattr(ff, "feature_enabled", lambda key, uid=None: flag_on)
        # provider 内部是 from core.feature_flags import feature_enabled(call时导入),patch 模块函数即可生效
    services = ProviderServices(user_id=None, save_id=None)  # save_id=None → 跳过 kb_events 直走 history
    demand = Demand(player_intent=query, retrieval_query=query)
    return prov.collect(_FakeState(history), DEFAULT_FREEFORM_MANIFEST, demand, services)


def test_recalls_out_of_window_fact(monkeypatch):
    """第 3 轮的银怀表(窗口外 17 轮)应被召回并带回合归属。"""
    c = _collect("我想起交给菲奥娜的银怀表", _mk_history(), monkeypatch=monkeypatch)
    assert c.applied and c.layers, c.warnings
    text = c.layers[0]["content"]
    assert "银怀表" in text and "第3回合" in text
    assert c.debug["source"] == "history"  # merged 池里只有 history 语料时


def test_dormant_on_generic_input(monkeypatch):
    c = _collect("我们继续往前走吧", _mk_history(), monkeypatch=monkeypatch)
    assert not c.applied


def test_low_signal_continue_skips_without_retrieval(monkeypatch):
    """默认开后，纯「继续」不应触发 DB/history 召回（低信号闸）。"""
    c = _collect("继续", _mk_history(), monkeypatch=monkeypatch)
    assert not c.applied
    c2 = _collect("嗯", _mk_history(), monkeypatch=monkeypatch)
    assert not c2.applied


def test_dedupes_against_memory_recalled_texts(monkeypatch):
    """memory 层已召回的相关事实/笔记，episodic 不应再注入同文片段。"""
    import core.feature_flags as ff
    monkeypatch.setattr(ff, "feature_enabled", lambda key, uid=None: True)
    state = _FakeState(_mk_history())
    state._memory_recalled_texts = {"交给菲奥娜保管"}
    state._memory_recalled_turn = 0  # _FakeState.data.turn 默认 0
    services = ProviderServices(user_id=None, save_id=None)
    demand = Demand(player_intent="我想起交给菲奥娜的银怀表",
                    retrieval_query="我想起交给菲奥娜的银怀表")
    c = EpisodicRecallProvider().collect(state, DEFAULT_FREEFORM_MANIFEST, demand, services)
    assert c.applied
    assert c.debug["deduped_against_memory"] >= 1
    # 被 memory 层召回的那段原文不应再出现在相关往事里
    assert "交给菲奥娜保管" not in c.layers[0]["content"]


def test_dedupes_against_memory_injected_texts(monkeypatch):
    """最近 facts/summaries/篇章 等实际注入正文也应参与跨层去重。"""
    import core.feature_flags as ff
    monkeypatch.setattr(ff, "feature_enabled", lambda key, uid=None: True)
    state = _FakeState(_mk_history())
    state._memory_injected_texts = {"我把祖传的银怀表交给菲奥娜保管,叮嘱她别打开表盖"}
    state._memory_recalled_turn = 0
    services = ProviderServices(user_id=None, save_id=None)
    demand = Demand(player_intent="我想起交给菲奥娜的银怀表",
                    retrieval_query="我想起交给菲奥娜的银怀表")
    c = EpisodicRecallProvider().collect(state, DEFAULT_FREEFORM_MANIFEST, demand, services)
    assert c.debug.get("deduped_against_memory", 0) >= 1
    # 被 memory 层注入的精确原文不能再作为「相关往事」重复出现。
    assert "我把祖传的银怀表交给菲奥娜保管" not in (c.layers[0]["content"] if c.layers else "")


def test_low_signal_patterns_are_skipped():
    from context_providers.episodic_recall import _is_low_signal_query
    for q in ("继续推进剧情吧", "好的。", "嗯嗯！", "ok", "可以"):
        assert _is_low_signal_query(q), q
    assert not _is_low_signal_query("然后我去码头找菲奥娜")


def test_history_scan_is_capped(monkeypatch):
    import core.feature_flags as ff
    import kb.episodic as ep
    monkeypatch.setattr(ff, "feature_enabled", lambda key, uid=None: True)
    captured = {}

    def _fake_merged(save_id, commit, user_id, query, history, *, k=3, exclude_recent=12):
        captured["n"] = len(history)
        return []

    monkeypatch.setattr(ep, "retrieve_episodic_merged", _fake_merged)
    long_hist = [{"role": "user", "content": f"第{i}轮玩家在码头调查银怀表"} for i in range(2000)]
    c = _collect("银怀表在码头吗", long_hist, monkeypatch=monkeypatch)
    assert not c.applied
    assert captured["n"] == 1500


def test_query_embedding_cache_avoids_repeated_calls(monkeypatch):
    import kb.episodic as ep
    import platform_app.knowledge.embedding as emb

    calls = {"n": 0}

    def _fake_embed(text, user_id=None):
        calls["n"] += 1
        return [0.1, 0.2]

    monkeypatch.setattr(emb, "embed_query", _fake_embed)
    ep._QUERY_EMBED_CACHE.clear()
    assert ep._cached_embed_query("菲奥娜的银怀表", 1) == [0.1, 0.2]
    assert ep._cached_embed_query("菲奥娜的银怀表", 1) == [0.1, 0.2]
    assert calls["n"] == 1
    # 不同 user/query 不串缓存
    ep._cached_embed_query("银怀表", 2)
    assert calls["n"] == 2


def test_episodic_uses_memory_token_factor(monkeypatch):
    import core.feature_flags as ff
    from context_engine._utils import estimate_tokens_with_factor

    monkeypatch.setattr(ff, "feature_enabled", lambda key, uid=None: True)
    state = _FakeState(_mk_history())
    state._memory_token_factor = 2.0
    services = ProviderServices(user_id=None, save_id=None)
    demand = Demand(player_intent="我想起交给菲奥娜的银怀表",
                    retrieval_query="我想起交给菲奥娜的银怀表")
    c = EpisodicRecallProvider().collect(state, DEFAULT_FREEFORM_MANIFEST, demand, services)
    assert c.applied
    text = c.layers[0]["content"]
    assert c.tokens_estimate == estimate_tokens_with_factor(text, 2.0)
    assert c.debug["token_estimate_factor"] == 2.0


def test_flag_off_skips(monkeypatch):
    c = _collect("我想起交给菲奥娜的银怀表", _mk_history(), flag_on=False, monkeypatch=monkeypatch)
    assert not c.applied


def test_recent_window_excluded():
    """独特事实只出现在最近 12 条内 → 不召回(近因窗口已原文注入,不重复)。"""
    h = [{"role": "user", "content": f"第{i}轮无关闲聊内容而已"} for i in range(30)]
    h.append({"role": "user", "content": "我把祖传的银怀表交给菲奥娜保管"})
    hits = score_history_messages("菲奥娜的银怀表", h, exclude_recent=12, k=3)
    assert hits == []


def test_excerpt_windows_long_message():
    long_text = "废话" * 200 + "菲奥娜收下了银怀表" + "废话" * 200
    ex = _excerpt_around_match(long_text, "菲奥娜的银怀表")
    assert "菲奥娜" in ex and len(ex) <= 250 and ex.startswith("…") and ex.endswith("…")


def test_registered_in_non_novel_packs():
    from context_providers.registry import (
        DEFAULT_FREEFORM_MANIFEST as F,
    )
    from context_providers.registry import (
        DEFAULT_MODULE_MANIFEST as M,
    )
    from context_providers.registry import (
        DEFAULT_TAVERN_MANIFEST as T,
    )
    for pack in (F, M, T):
        assert "episodic_recall" in pack["context_providers"], pack["id"]


def test_novel_pack_wires_episodic_recall():
    """本次记忆修复: 剧本模式也挂玩家全程历史召回。

    novel_retrieval 查的是原著 canon；episodic_recall 查的是玩家自己的 kb_events/
    history，两者正交，不是双注入。feature flag 默认开、可在设置里关。
    """
    import context_providers.registry as reg
    novel = next(v for v in vars(reg).values()
                 if isinstance(v, dict) and v.get("kind") == "novel_adaptation")
    assert "episodic_recall" in novel["context_providers"]


def test_merged_strong_history_beats_weak_kb_event():
    """酒馆 e2e 实锤回归:一条弱相关 kb 事件(闲聊天气)绝不能压掉 history 里的强命中
    (煎鱼烧厨房=真答案)。合并同池排序后强者在前。"""
    from kb.episodic import merge_and_rank
    kb = [{"id": 1, "summary": "角色与芙兰朵露在会面室闲聊天气,角色表达了对雨天的偏好",
           "story_time": "", "location": "会面室", "participants": []}]
    hist = [{"role": "user", "content": f"第{i}轮无关闲聊而已"} for i in range(6)]
    hist.insert(2, {"role": "user", "content": "我最近在学做菜,昨天试着煎了鱼,差点把厨房烧了,哈哈。"})
    hist += [{"role": "user", "content": f"近因第{i}条"} for i in range(12)]  # 近因窗口垫底
    hits = merge_and_rank("还记得我说过我在学做菜吗?那次闹了什么笑话?", kb, hist, k=3)
    assert hits, "应召回煎鱼事件"
    assert hits[0]["kind"] == "history" and "煎了鱼" in hits[0]["text"]


def test_merged_vector_hit_never_shortcircuits_history(monkeypatch):
    """酒馆e2e二次实锤回归:向量命中(被后处理补嵌入的孤立事件)绝不独占返回,
    history 强命中必须同池在场。"""
    import kb.episodic as epi
    monkeypatch.setattr(epi, "_retrieve_vector", lambda *a, **k: [
        {"summary": "角色与芙兰朵露在会面室闲聊天气", "story_time": "", "location": "会面室",
         "participants": [], "score": 0.61}])
    monkeypatch.setattr(epi, "_fetch_keyword_corpus", lambda *a, **k: [])
    hist = [{"role": "user", "content": f"第{i}轮无关闲聊而已"} for i in range(6)]
    hist.insert(2, {"role": "user", "content": "我最近在学做菜,昨天试着煎了鱼,差点把厨房烧了,哈哈。"})
    hist += [{"role": "user", "content": f"近因第{i}条"} for i in range(12)]
    hits = epi.retrieve_episodic_merged(351, 3459, 1, "还记得我说过我在学做菜吗?", hist, k=3)
    kinds = [(h["kind"], h["text"][:12]) for h in hits]
    assert any(h["kind"] == "history" and "煎了鱼" in h["text"] for h in hits), kinds
    assert any(h["kind"] == "event" for h in hits), kinds  # 向量视角仍在场


def test_skips_deleted_fact_tombstones(monkeypatch):
    """删除 tombstone（文本 + hash）必须同时拦住 episodic 冷归档召回。

    KB 的 afactc 是永久事件行；如果 episodic 不看 facts_deleted，玩家删掉的
    事实会从「相关往事」重新回到 prompt。
    """
    import hashlib

    import core.feature_flags as ff
    monkeypatch.setattr(ff, "feature_enabled", lambda key, uid=None: True)
    import kb.episodic as ep

    deleted_text = "张三把钥匙藏在码头"
    deleted_hash_text = "李四欠王五一袋金币"
    live_text = "酒馆老板说明天有集市"
    monkeypatch.setattr(ep, "retrieve_episodic_merged", lambda *a, **k: [
        {"kind": "event", "text": deleted_text, "score": 9, "meta": ""},
        {"kind": "event", "text": deleted_hash_text, "score": 8, "meta": ""},
        {"kind": "event", "text": live_text, "score": 7, "meta": ""},
    ])

    s = _FakeState(_mk_history())
    s.data["memory"] = {
        "facts_deleted": [deleted_text],
        "facts_deleted_hashes": [
            hashlib.sha1(deleted_hash_text.encode("utf-8")).hexdigest()[:16]
        ],
    }
    c = EpisodicRecallProvider().collect(
        s, DEFAULT_FREEFORM_MANIFEST,
        Demand(player_intent="钥匙和金币在哪里", retrieval_query="钥匙和金币在哪里"),
        ProviderServices(user_id=None, save_id=None),
    )
    assert c.applied and c.layers, c.warnings
    text = c.layers[0]["content"]
    assert live_text in text
    assert deleted_text not in text
    assert deleted_hash_text not in text
    assert c.debug["tombstoned_deleted_facts"] == 2
