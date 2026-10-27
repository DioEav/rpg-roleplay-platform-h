"""context_providers.memory_assembler — 记忆读取装配器（本次记忆修复 Phase 2）。

把 MemoryProvider 里原本一段顺序 `if/for` 的注入逻辑抽成显式的 section 装配：

  pinned → 主线/目标 → notes → recent facts → recalled facts → summaries
  → abilities → resources

每个 section 有固定的预算权重和最低 token；装填时先按权重分配、再按剩余预算补装，
单条装不下只跳过该条（不 break 后续 section）。这样不会出现「pinned 一长，facts/
abilities 全被饿死」，也方便后续把 recalled facts / 实体召回独立演进。

召回策略（无 embedding 依赖）：
  · 最近 facts：按写入顺序取最近 max(24, recall_depth×8)（硬上限 64）作为候选，
    实际注入条数由 section 预算决定（本次记忆修复：不再直接截到 recall_depth）。
  · 相关 facts：对 demand.retrieval_query / player_intent 做 CJK 2-3 gram 打分，
    叠加「查询里出现的已知角色名」实体加分与当前地点/场景加分；top-k 去重后
    作为「相关记忆：」注入。
  · 只召回 active、未归档、且不在最近 facts 里的条目，避免重复。
  · 跨 section 再做一次归一化文本去重（pinned→objective→notes→facts→recalled
    →summaries→arc→abilities→resources，保留优先级最高的一处）。

注意：本模块只负责「把已有记忆装进 prompt」，不写 state、不调 LLM、不做归档。
归档/摘要生命周期在 chat_pipeline.memory_maintenance + context_providers.memory 里。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from context_engine._utils import estimate_tokens_with_factor

# 查询侧停用 gram：高频功能词/叙事套话，任何事实里都常见，不携带区分信息。
_STOP_GRAMS = frozenset((
    "一个", "什么", "没有", "知道", "现在", "已经", "自己", "他们", "我们", "你们",
    "这个", "那个", "时候", "可以", "不是", "就是", "但是", "然后", "开始", "继续",
    "出现", "看到", "听到", "感到", "觉得", "地方", "东西", "事情", "这里", "那里",
    "怎么", "为什", "么样", "一下", "一起", "之前", "之后", "还是", "或者", "如果",
    "告诉", "打算", "准备", "想起", "回想",
))
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")
_RECALL_SCORE_FLOOR = 3
_RECALL_TOP_K = 3
_SENTINEL_NAMES = frozenset({"unknown", "未知", "_player", "player", "你"})
# 纯推进/确认类输入不触发查询召回：否则长局里每句“继续”都会把同一批地点记忆
# 重新拉进 prompt，既浪费 token 又让 GM 反复提旧事。
_LOW_SIGNAL_QUERIES = frozenset((
    "继续", "继续吧", "继续推进", "好", "好的", "嗯", "嗯嗯", "行", "可以",
    "走吧", "然后呢", "接着来", "往下", "下一个", "ok", "okay", "yes",
))


def _is_low_signal_query(query: str) -> bool:
    q = (query or "").strip().strip("。！？!?…，,. ")
    return len(q) < 2 or q.lower() in _LOW_SIGNAL_QUERIES

# ── 候选窗口（本次记忆修复）──────────────────────────────────────────────
# 旧实现把每个桶先截到 recall_depth 条再交给预算装填。结果：token_budget 是
# 1600，但 100 条短事实只注入 8 条，96/1600 token，94% 预算闲置。
# 现在「候选窗口」只决定最多看多少条，「能注入几条」完全由 section 预算决定：
#   · facts 是叙事流水：候选 = max(24, depth×8)，硬上限 64；
#   · summaries 是压缩历史：候选 = max(12, depth×4)，硬上限 50；
#   · notes/abilities/resources 是玩家手写/角色持久状态：候选 = max(40, depth×12)，
#     硬上限 100 —— 不能再被 recall_depth=8 砍到只剩最近 8 条。
# 这些是候选池，不是注入量；预算不足时仍按 section 权重+最新优先裁剪。
_FACTS_CANDIDATE_MIN = 24
_FACTS_CANDIDATE_MAX = 64
_SUMMARIES_CANDIDATE_MIN = 12
_SUMMARIES_CANDIDATE_MAX = 50
_PERSISTENT_CANDIDATE_MIN = 40
_PERSISTENT_CANDIDATE_MAX = 100

# 跨 section 文本去重（本次优化）：同一句话可能同时出现在 pinned/notes/facts/
# summaries/arc；按归一化文本只保留优先级最高的一处。只做精确归一化匹配，
# 不做语义相似，避免误删不同事实。
_DEDUPE_PUNCT_RE = re.compile(
    r"[\s，。；：、！？,.!?;:\"'“”‘’（）()【】\[\]《》<>·…—\-]+"
)


def _dedupe_key(text: str) -> str:
    return _DEDUPE_PUNCT_RE.sub("", str(text or "")).strip().lower()


def _importance_of(item: dict) -> int:
    """读取条目重要性（本轮优化）。0 是合法最低分，不能用 `or 40` 抬高。"""
    try:
        value = item.get("importance")
        return int(value) if value is not None else 40
    except (TypeError, ValueError, AttributeError):
        return 40

# 输出行前缀 → 去重时剥掉，只比较正文。供跨层去重（episodic）使用。
_LINE_PREFIXES = (
    "固定记忆：", "主线：", "当前目标：", "笔记：", "事实：",
    "相关记忆：", "相关笔记：", "概要：", "篇章：", "能力：", "资源：",
)


def _strip_line_prefix(line: str) -> str:
    for prefix in _LINE_PREFIXES:
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return line.strip()


def _estimate_memory_tokens(text: str, factor: float) -> int:
    """记忆层 token 估算（本次记忆修复）；与 episodic 共用同一系数入口。"""
    return estimate_tokens_with_factor(text, factor)


def _query_grams(text: str) -> set[str]:
    grams: set[str] = set()
    # 玩家输入可能很长；召回只取前 400 字，避免每回合生成上千 gram。
    for run in _CJK_RUN.findall((text or "")[:400]):
        for n in (2, 3):
            for i in range(len(run) - n + 1):
                g = run[i:i + n]
                if g not in _STOP_GRAMS:
                    grams.add(g)
    return grams


def _score_text(text: str, grams: set[str]) -> int:
    if not text or not grams:
        return 0
    hit = [g for g in grams if g in text]
    if not hit:
        return 0
    # 三字 gram 内嵌的二字 gram 不重复计分
    hit.sort(key=len, reverse=True)
    kept: list[str] = []
    for g in hit:
        if not any(g in k for k in kept):
            kept.append(g)
    return sum(len(g) for g in kept)


def _known_entity_names(state: Any) -> set[str]:
    data = getattr(state, "data", state) or {}
    names: set[str] = set()
    for name in (data.get("relationships") or {}):
        n = str(name or "").strip()
        if len(n) >= 2 and n not in _SENTINEL_NAMES:
            names.add(n)
    for ent in (data.get("active_entities") or []):
        if isinstance(ent, dict):
            n = str(ent.get("name") or ent.get("id") or "").strip()
            if len(n) >= 2 and n not in _SENTINEL_NAMES:
                names.add(n)
    pn = str((data.get("player") or {}).get("name") or "").strip()
    if len(pn) >= 2 and pn not in _SENTINEL_NAMES:
        names.add(pn)
    return names


def _query_entities(state: Any, query: str) -> list[str]:
    q = str(query or "")
    if not q:
        return []
    hits = [n for n in _known_entity_names(state) if n in q]
    hits.sort(key=len, reverse=True)
    return hits[:8]


def _current_scene_keys(state: Any, demand: Any = None) -> set[str]:
    """当前场景/地点键：用于“我回到这里看看”这类无明确人名的查询召回。

    同时收玩家可见地点名（current_location）和场景 ID（scene.location_id），
    因为写入时两者都可能被记录；旧档没有 location 时退化为文本包含判断。
    """
    data = getattr(state, "data", state) or {}
    keys: set[str] = set()
    try:
        player = data.get("player") or {}
        scene = data.get("scene") or {}
        for raw in (
            player.get("current_location"),
            scene.get("location_id"),
            scene.get("module_id"),
            getattr(demand, "target_location", "") if demand is not None else "",
        ):
            key = str(raw or "").strip()
            if len(key) >= 2:
                keys.add(key)
    except Exception:
        pass
    return keys


@dataclass
class MemorySection:
    id: str
    lines: list[str] = field(default_factory=list)
    weight: float = 0.0
    min_tokens: int = 0
    # 选择顺序：True=从尾部（最新/最近写入）优先装填，False=从头部（评分最高/
    # 固定顺序）优先。展示顺序始终按 lines 原顺序，避免最新事实排在旧事实前面
    # 让 GM 误判时间线。
    newest_first: bool = True


class MemoryAssembler:
    """把 state.memory 装成一段带预算的记忆文本。"""

    def __init__(self, state: Any, settings: Any, demand: Any = None):
        self.state = state
        self.settings = settings
        self.demand = demand
        data = getattr(state, "data", state) or {}
        self.mem: dict = (data.get("memory") or {}) if isinstance(data, dict) else {}

    def _query_text(self) -> str:
        d = self.demand
        return str(
            getattr(d, "retrieval_query", "")
            or getattr(d, "player_intent", "")
            or ""
        ).strip()

    def _recent_items(self, bucket: str, limit: int) -> list[str]:
        if limit <= 0:
            return []  # list[-0:] 会退化成整个列表，必须显式挡掉
        return [str(x) for x in (self.mem.get(bucket) or [])[-limit:] if str(x).strip()]

    def _recalled_items(self, recent: dict[str, list[str]]) -> list[tuple[str, str]]:
        """按查询关键词/已知实体召回 facts/notes（不含最近窗口、不含归档）。

        返回 [(bucket, text)]；bucket 用于渲染「相关记忆：」/「相关笔记：」前缀。
        只召回 active、未归档、且不在最近窗口里的条目。
        """
        query = self._query_text()
        if not query or _is_low_signal_query(query):
            return []
        grams = _query_grams(query)
        entities = _query_entities(self.state, query)
        # 本回合玩家显式点名的实体（curator Demand）也参与实体加分；与查询文本里
        # 出现的已知角色名合并去重。
        if self.demand is not None:
            for ent in (getattr(self.demand, "target_entities", None) or []):
                name = str(ent or "").strip()
                if len(name) >= 2 and name not in entities:
                    entities.append(name)
        scene_keys = _current_scene_keys(self.state, self.demand)
        if not grams and not entities and not scene_keys:
            return []
        items = self.mem.get("items") or []
        # 本轮优化：候选值 = (相关度, 重要性, turn)。重要性只在相关度同分时
        # 参与排序；它不能压过相关度 —— 否则「玩家刚问钥匙」时一条高分的旧
        # 誓言会挤掉真正匹配的钥匙事实。
        candidates: dict[tuple[str, str], tuple[int, int, int]] = {}
        # 最近窗口集合只建一次：items 可能有上千条，逐条构造 set 是纯浪费。
        recent_sets = {b: set(v or []) for b, v in recent.items()}
        if isinstance(items, list) and items:
            # 本次记忆修复：优先用 active recall 索引缩小候选集；索引不可用/无候选
            # 时回退全量扫描，保证行为不因索引缺失而漏召回。
            scan_items = items
            try:
                from .memory_index import get_memory_index
                _idx = get_memory_index(self.state, self.mem)
                if _idx is not None:
                    _cand = _idx.candidates(grams, entities, scene_keys)
                    if _cand:
                        scan_items = [
                            items[i] for i in sorted(_cand) if 0 <= i < len(items)
                        ]
            except Exception:
                scan_items = items
            for it in scan_items:
                if not isinstance(it, dict):
                    continue
                bucket = str(it.get("legacy_bucket") or "")
                if bucket not in ("facts", "notes"):
                    continue
                if (it.get("status") or "active") != "active" or it.get("archived"):
                    continue
                text = str(it.get("text") or "").strip()
                if not text or text in recent_sets.get(bucket, set()):
                    continue
                score = _score_text(text, grams)
                it_chars = [str(c) for c in (it.get("characters") or [])]
                for ent in entities:
                    if ent in it_chars or ent in text:
                        score += len(ent) * 2
                # 场景/地点加分（本次记忆修复）：玩家回到旧地点、说“这里”时，
                # 没有明确人名/物名也能召回该地点发生过的旧事实。
                it_loc = str(it.get("location") or "").strip()
                it_scene = str(it.get("scene_id") or "").strip()
                for key in scene_keys:
                    if (key in text or (it_loc and (key in it_loc or it_loc in key))
                            or (it_scene and key in it_scene)):
                        score += max(4, len(key) * 2)
                if score >= _RECALL_SCORE_FLOOR:
                    candidates[(bucket, text)] = (
                        score, _importance_of(it), int(it.get("turn") or 0))
            else:
                # 旧存档 items 为空：只能纯文本打分（没有 turn/characters 元数据）。
                for bucket in ("facts", "notes"):
                    recent_set = set(recent.get(bucket) or [])
                    for text in self.mem.get(bucket) or []:
                        text = str(text or "").strip()
                        if not text or text in recent_set:
                            continue
                        score = _score_text(text, grams)
                        for ent in entities:
                            if ent in text:
                                score += len(ent) * 2
                        for key in scene_keys:
                            if key in text:
                                score += max(4, len(key) * 2)
                        if score >= _RECALL_SCORE_FLOOR:
                            candidates[(bucket, text)] = (score, 40, 0)

        ranked = sorted(
            candidates.items(),
            # 相关度 > 重要性 > 新旧。重要性只做同分 tie-break。
            key=lambda kv: (
                -kv[1][0], -kv[1][1], -kv[1][2], kv[0][0], kv[0][1]),
        )
        return [key for key, _ in ranked[:_RECALL_TOP_K]]

    def _candidate_limit(self, base: int, *, minimum: int, maximum: int,
                         factor: int) -> int:
        """候选条数：尊重 recall_depth，但保证一个下限；最终由 section 预算裁剪。"""
        return max(0, min(maximum, max(minimum, base * factor)))

    def build(self) -> tuple[str, list[str], dict[str, Any]]:
        ms = self.settings
        depth = max(0, int(getattr(ms, "recall_depth", 0) or 0))
        budget = max(1, int(getattr(ms, "token_budget", 0) or 0))
        token_factor = max(0.5, min(3.0, float(getattr(ms, "token_estimate_factor", 1.0) or 1.0)))
        world_on = bool(getattr(ms, "bucket_world_enabled", True))
        pinned_on = bool(getattr(ms, "bucket_pinned_enabled", True))
        char_on = bool(getattr(ms, "bucket_character_enabled", True))

        # 候选窗口 vs 注入窗口（本次记忆修复）：候选只负责“最多看多少条”，
        # 真正注入多少条由 section 权重、min_tokens 和剩余预算决定。
        facts_n = self._candidate_limit(
            depth, minimum=_FACTS_CANDIDATE_MIN, maximum=_FACTS_CANDIDATE_MAX, factor=8)
        summaries_n = self._candidate_limit(
            depth, minimum=_SUMMARIES_CANDIDATE_MIN,
            maximum=_SUMMARIES_CANDIDATE_MAX, factor=4)
        persistent_n = self._candidate_limit(
            depth, minimum=_PERSISTENT_CANDIDATE_MIN,
            maximum=_PERSISTENT_CANDIDATE_MAX, factor=12)

        pinned = self._recent_items("pinned", int(getattr(ms, "pinned_max", 0) or 0)) if pinned_on else []
        notes = self._recent_items("notes", persistent_n) if world_on else []
        facts = self._recent_items("facts", facts_n) if world_on else []
        summaries = self._recent_items("summaries", summaries_n) if world_on else []
        # 归档空窗兜底（本轮审查修复）：年龄/压力归档每回合都会把条目移出 facts，
        # 但摘要按 summary_window 批量 flush，最长会有 N 个回合「条目已不在 facts、
        # 也还没进 summaries」的注入空窗。buffer 里的原文先以「概要：」行补位，
        # flush 后 buffer 清空、由正式摘要接替。buffer 本身有 20 条/500 条硬上限。
        _pending_summary_texts: list[str] = []
        if world_on:
            for _entry in (self.mem.get("summary_archive_buffer") or []):
                if not isinstance(_entry, dict):
                    continue
                _t = str(_entry.get("text") or "").strip()
                if _t:
                    _pending_summary_texts.append(_t)
            if _pending_summary_texts:
                # buffer 比已生成摘要新，放在尾部：summaries section 是 newest_first，
                # 预算紧张时先装这些“刚归档、尚未成摘要”的条目。
                summaries = summaries + _pending_summary_texts
        arcs = (self.mem.get("arc_summaries") or []) if world_on else []
        arc_lines = [
            f"篇章：{a.get('text')}"
            for a in arcs[-10:]
            if isinstance(a, dict) and str(a.get("text") or "").strip()
        ]
        abilities = self._recent_items("abilities", persistent_n) if char_on else []
        resources = self._recent_items("resources", persistent_n) if char_on else []
        recalled = (self._recalled_items({"facts": facts, "notes": notes})
                    if world_on else [])

        priority_lines: list[str] = []
        if pinned or notes:
            priority_lines.append(
                "【记忆优先级:带「笔记：」「固定记忆：」的是玩家手写、权威且最新;"
                "与「事实：」冲突时一律以笔记/固定记忆为准,数值/状态以玩家手记为最新。】"
            )

        sections: list[MemorySection] = []
        if pinned:
            sections.append(MemorySection("pinned", [f"固定记忆：{x}" for x in pinned], 0.28, 60))
        if world_on:
            obj_lines: list[str] = []
            if self.mem.get("main_quest"):
                obj_lines.append(f"主线：{self.mem['main_quest']}")
            if self.mem.get("current_objective"):
                obj_lines.append(f"当前目标：{self.mem['current_objective']}")
            if obj_lines:
                # 主线在前、当前目标在后，按固定顺序装填，不按“最新优先”。
                sections.append(MemorySection("objective", obj_lines, 0.04, 0, newest_first=False))
            if notes:
                sections.append(MemorySection("notes", [f"笔记：{x}" for x in notes], 0.14, 40))
            if facts:
                sections.append(MemorySection("facts", [f"事实：{x}" for x in facts], 0.24, 60))
            if recalled:
                _recall_lines = [
                    f"{'相关笔记' if bucket == 'notes' else '相关记忆'}：{text}"
                    for bucket, text in recalled
                ]
                # recalled 已按相关度排序，装填也从最相关的开始（不按写入时间）。
                sections.append(MemorySection("recalled", _recall_lines, 0.05, 0, newest_first=False))
            if summaries:
                sections.append(MemorySection("summaries", [f"概要：{x}" for x in summaries], 0.08, 0))
            if arc_lines:
                sections.append(MemorySection("arc", arc_lines, 0.05, 0))
        if char_on:
            if abilities:
                sections.append(MemorySection("abilities", [f"能力：{x}" for x in abilities], 0.06, 0))
            if resources:
                sections.append(MemorySection("resources", [f"资源：{x}" for x in resources], 0.06, 0))

        # ── 跨 section 文本去重（本次优化）──────────────────────────────
        # section 顺序即优先级：pinned → objective → notes → facts → recalled
        # → summaries → arc → abilities → resources。同一归一化文本只保留第一次。
        _seen_text_keys: set[str] = set()
        _deduped_sections: list[MemorySection] = []
        _deduped_count = 0
        for sec in sections:
            _kept: list[str] = []
            for line in sec.lines:
                key = _dedupe_key(_strip_line_prefix(line))
                if len(key) >= 2 and key in _seen_text_keys:
                    _deduped_count += 1
                    continue
                if key:
                    _seen_text_keys.add(key)
                _kept.append(line)
            if _kept:
                sec.lines = _kept
                _deduped_sections.append(sec)
        sections = _deduped_sections

        # ── 预算装填 ─────────────────────────────────────────────────────
        remaining = max(0, budget - sum(_estimate_memory_tokens(line, token_factor) for line in priority_lines))
        chosen: dict[str, set[int]] = {sec.id: set() for sec in sections}
        section_tokens: dict[str, int] = {sec.id: 0 for sec in sections}
        dropped: dict[str, int] = {sec.id: 0 for sec in sections}

        def _take(sec: MemorySection, allowance: int) -> None:
            nonlocal remaining
            used = 0
            budget_left = min(allowance, remaining)
            # 选择顺序与展示顺序分离：facts/notes/abilities 等“后来的更重要”，
            # 预算紧张时从尾部装填；recalled 按相关度、objective 按固定顺序从头装。
            order = (range(len(sec.lines) - 1, -1, -1) if sec.newest_first
                     else range(len(sec.lines)))
            for i in order:
                line = sec.lines[i]
                cost = _estimate_memory_tokens(line, token_factor)
                if cost > budget_left - used:
                    dropped[sec.id] += 1
                    continue
                chosen[sec.id].add(i)
                used += cost
            section_tokens[sec.id] = used
            remaining -= used

        for sec in sections:
            allowance = int(budget * max(0.0, sec.weight))
            if sec.min_tokens:
                allowance = max(allowance, sec.min_tokens)
            _take(sec, allowance)

        # 第二轮：把各 section 没装下的条目按同样的优先级补进剩余预算。
        for sec in sections:
            if not remaining:
                break
            order = (range(len(sec.lines) - 1, -1, -1) if sec.newest_first
                     else range(len(sec.lines)))
            for i in order:
                if i in chosen[sec.id]:
                    continue
                cost = _estimate_memory_tokens(sec.lines[i], token_factor)
                if cost <= remaining:
                    chosen[sec.id].add(i)
                    section_tokens[sec.id] += cost
                    remaining -= cost
                    dropped[sec.id] = max(0, dropped[sec.id] - 1)

        lines: list[str] = list(priority_lines)
        for sec in sections:
            for i, line in enumerate(sec.lines):
                if i in chosen[sec.id]:
                    lines.append(line)

        text = "\n".join(lines) or "（暂无长期记忆）"
        token_used = sum(_estimate_memory_tokens(line, token_factor) for line in lines)
        # 跨层去重（本次记忆修复）：记录本轮实际注入的正文（剥掉「事实：」等前缀），
        # episodic_recall 用它跳过已经出现在记忆层里的同文片段 —— 不再只盯
        # 「相关记忆」top-3，最近事实/摘要/篇章也会参与去重。
        injected_texts: list[str] = []
        _seen_injected: set[str] = set()
        for sec in sections:
            for i in range(len(sec.lines)):
                if i not in chosen.get(sec.id, ()):
                    continue
                content = _strip_line_prefix(sec.lines[i])
                if len(content) < 4 or content in _seen_injected:
                    continue
                _seen_injected.add(content)
                injected_texts.append(content)
        debug = {
            "token_used": token_used,
            "token_budget": budget,
            "token_estimate_factor": token_factor,
            "remaining_tokens": max(0, budget - token_used),
            "sections": [
                {
                    "id": sec.id,
                    "tokens": section_tokens.get(sec.id, 0),
                    "selected": len(chosen.get(sec.id) or ()),
                    "available": len(sec.lines),
                    "dropped": dropped.get(sec.id, 0),
                }
                for sec in sections
            ],
            "recalled_count": len(recalled),
            "recalled_texts": [text for _, text in recalled][:8],
            # 已归档、尚未批量成摘要的原文条数（本轮优化）：这些条目暂以「概要：」
            # 行注入，避免归档与摘要批量之间出现注入空窗。
            "summary_buffer_count": len(_pending_summary_texts),
            # 跨 section 去重（本次优化）：被丢弃的重复行数。用于确认「事实/概要/
            # 篇章写了同一件事」时确实省下了 token，而不是候选不足。
            "deduped_across_sections": _deduped_count,
            "injected_texts": injected_texts[:200],
            "query": self._query_text()[:120],
            # 候选窗口 vs 实际注入：调试面板据此判断“是没候选，还是预算裁掉了”。
            "candidate_limits": {
                "facts": facts_n,
                "summaries": summaries_n,
                "persistent": persistent_n,
                "pinned": int(getattr(ms, "pinned_max", 0) or 0),
            },
        }
        return text, lines, debug
