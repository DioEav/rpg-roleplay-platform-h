"""episodic_recall.py — 永恒记忆·情景召回 context provider。

本次记忆修复后，novel/script、tavern、freeform、module 都挂载本 provider：
  · 原著改编/剧本模式此前没有玩家历史的召回通道（novel_retrieval 只查原著 canon）；
  · 酒馆/自由/模组此前也没有长程召回（用户实锤「修的是游戏模式，酒馆没得到修复」）。
两路正交：novel_retrieval 查原著，episodic_recall 查玩家自己创造的过去。

语料：kb_events（谱系 CTE，分支隔离）+ state.history，同池打分合并取 top-k。
  · kb_events 有嵌入时先走向量，否则/无命中走确定性关键词；
  · 酒馆跳过史官时 kb_events 很少，history 兜底是主路径；
  · 本轮 memory 层已注入的正文会跨层去重，避免同一事实在「事实/摘要/篇章」和
    「相关往事」里重复出现。

feature gate: episodic_recall（默认开，可在设置里关）；无命中=休眠零注入。
"""
from __future__ import annotations

import re

from .base import ContextContribution, ContextProvider
from .registry import register_provider

PRIORITY = 78  # 略低于 memory(60 之上为先出;此处按既有语义放在记忆层附近、近因窗口之前)

# 默认开（本次记忆修复）后，每回合都可能触发一次 kb_events/history 检索。
# 纯推进/确认类输入（"继续""好""嗯"）几乎不可能指向某个远期事件，直接跳过，
# 避免默认开给每一轮都加一次 DB 查询 + 全量 history 打分。
_LOW_SIGNAL_QUERIES = frozenset((
    "继续", "继续吧", "继续推进", "继续推进剧情", "好", "好的", "嗯", "嗯嗯", "行", "可以",
    "走吧", "然后呢", "接着", "接着来", "往下", "下一个", "开始吧", "ok", "okay", "yes",
))
# 纯确认/语气词（可带标点）：整句只有这些字符时也视为低信号。
_LOW_SIGNAL_ONLY_RE = re.compile(r"^[好嗯行可以okayesy\s,，.!！?？。…、]+$", re.IGNORECASE)
# history 扫描上限：酒馆没有 kb_events 时 history 是唯一语料，但长局 5000+ 条
# 每回合全量打分成本会线性上升。保留最近 1500 条（约 750 回合）足够覆盖
# “玩家还记得的往事”；更早的由 kb_events/摘要/arc 承担。
_HISTORY_SCAN_CAP = 1500


def _is_low_signal_query(query: str) -> bool:
    q = (query or "").strip().strip("。！？!?…，,. ")
    if len(q) < 2 or q.lower() in _LOW_SIGNAL_QUERIES:
        return True
    # “继续推进剧情吧”“接着往下”这类短指令：前缀是推进词且长度很短，视为低信号；
    # “继续去码头找菲奥娜”这种带明确目标的输入不跳过。
    if len(q) <= 8 and q.startswith(("继续", "接着", "往下", "下一个")):
        return True
    return bool(_LOW_SIGNAL_ONLY_RE.match(q))


class EpisodicRecallProvider(ContextProvider):
    id = "episodic_recall"

    def collect(self, state, manifest, demand, services) -> ContextContribution:
        from core.feature_flags import feature_enabled
        user_id = getattr(services, "user_id", None)
        if not feature_enabled("episodic_recall", user_id):
            return ContextContribution.skipped(self.id, "episodic_recall flag 关闭")

        query = (getattr(demand, "retrieval_query", "") or ""
                 ).strip() or (getattr(demand, "player_intent", "") or "").strip()
        if not query:
            return ContextContribution.skipped(self.id, "无查询文本")
        if _is_low_signal_query(query):
            return ContextContribution.skipped(self.id, "低信号输入，跳过召回")

        data = getattr(state, "data", None)
        if not isinstance(data, dict):
            return ContextContribution.skipped(self.id, "state.data 不可用")
        save_id = getattr(services, "save_id", None) or data.get("_active_save_id")

        # 合并同池打分:kb_events + 全量 history 单一排序(酒馆 e2e 实锤教训:两级
        # 短路会让一条弱相关 kb 事件压掉 history 里的真答案,模型只好编造)。
        # 本次记忆修复：history 只取最近 _HISTORY_SCAN_CAP 条，避免几千回合后每轮
        # 对全量历史做 gram 打分；更早的玩家历史由 kb_events/摘要/arc 承接。
        hist = list(data.get("history") or [])[-_HISTORY_SCAN_CAP:]
        commit = 0
        if save_id:
            # 同回合缓存 active_commit_id：context 组装一回合只构建一次，但 provider
            # 可能因重试/调试被调用多次；避免重复 DB 查询。
            _cur_turn = int(data.get("turn") or 0)
            _cache = getattr(state, "_episodic_commit_cache", None)
            if (isinstance(_cache, tuple) and len(_cache) == 3
                    and _cache[0] == save_id and _cache[1] == _cur_turn):
                commit = int(_cache[2] or 0)
            else:
                try:
                    from platform_app.db import connect
                    with connect() as db:
                        cm = db.execute(
                            "select active_commit_id from game_saves where id=%s",
                            (int(save_id),),
                        ).fetchone()
                    commit = int((cm or {}).get("active_commit_id") or 0)
                except Exception:
                    commit = 0
                try:
                    state._episodic_commit_cache = (save_id, _cur_turn, commit)
                except Exception:
                    pass
        from kb.episodic import retrieve_episodic_merged
        hits = retrieve_episodic_merged(
            int(save_id or 0), commit, user_id, query, hist, k=3, exclude_recent=12)
        # 跨层去重（本次记忆修复）: memory provider 先跑，会把本轮实际注入的正文
        # （最近事实/笔记/摘要/篇章/相关记忆）挂到 state；这里统一跳过同文片段。
        # 旧实现只对比「相关记忆」top-3，最近 facts / summaries 仍会和往事重复。
        _deduped = 0
        _cur_turn = int((getattr(state, "data", None) or {}).get("turn") or 0)
        _recalled = None
        if getattr(state, "_memory_recalled_turn", None) == _cur_turn:
            _recalled = (getattr(state, "_memory_injected_texts", None)
                         or getattr(state, "_memory_recalled_texts", None))
        if _recalled and hits:
            _kept = []
            for h in hits:
                ht = str(h.get("text") or "")
                if any(len(t) >= 6 and (t in ht or ht in t) for t in _recalled):
                    _deduped += 1
                    continue
                _kept.append(h)
            hits = _kept
        if not hits:
            return ContextContribution.skipped(
                self.id, "无召回(休眠)" if not _deduped else "与记忆层重复")
        lines: list[str] = []
        for i, h in enumerate(hits, 1):
            if h.get("kind") == "history":
                lines.append(f"{i}. [第{h['turn']}回合·{h['role']}] {h['text']}")
            else:
                meta = h.get("meta") or ""
                lines.append(f"{i}. {h['text']}" + (f"  ({meta})" if meta else ""))
        source = ",".join(sorted({h.get("kind") or "" for h in hits}))

        text = "\n".join(
            ["以下是按本回合输入从【全程游戏历史】召回的相关往事,当作已发生事实参考,勿复述成新发生:"]
            + lines
        )
        import logging
        logging.getLogger(__name__).info(
            "[episodic_recall] 注入 %d 条 (source=%s, save=%s)", len(lines), source, save_id)
        # 本次记忆修复：与 MemoryProvider 共用 token_estimate_factor，避免同一
        # 上下文里记忆层按 2.0 裁剪、往事层仍按 1.0 估算。
        _factor = float(getattr(state, "_memory_token_factor", 1.0) or 1.0)
        from context_engine._utils import estimate_tokens_with_factor
        layer = self.make_layer(
            "episodic_recall", "相关往事·全程历史召回", text,
            sticky=False, priority=PRIORITY,
        )
        return ContextContribution(
            provider_id=self.id,
            kind="episodic_recall",
            priority=PRIORITY,
            layers=[layer],
            tokens_estimate=estimate_tokens_with_factor(text, _factor),
            debug={"source": source, "hits": len(lines),
                   "deduped_against_memory": _deduped,
                   "token_estimate_factor": _factor},
        )


register_provider(EpisodicRecallProvider())
