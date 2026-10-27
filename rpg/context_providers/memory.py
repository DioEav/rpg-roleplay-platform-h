"""
MemoryProvider — 通用记忆层。所有 manifest 都应该启用。
不区分小说/模组：facts / pinned / abilities / resources / notes 等等都是会话级数据。

A6 新增：消费 MemorySettings 配置
  - token_budget          : 每轮注入记忆的 token 预算（用 token_estimate_factor 估算）
  - token_estimate_factor : 估算系数（估算 token = 字符数//2 × 系数）
  - bucket_pinned_enabled : 跳过 pinned 桶
  - bucket_world_enabled  : 跳过 world 类（main_quest / objective / summaries / facts / notes）
  - bucket_character_enabled: 跳过 character 类（abilities / resources）
  - recall_depth          : 候选窗口基准（facts/摘要/persistent 按倍数扩大，最终由预算裁剪；
                            pinned 用 pinned_max 作为候选上限）
  - auto_archive_after_turns / facts_soft_limit: 由 chat_pipeline.memory_maintenance
    在回合结束后调用 _maybe_auto_archive() 触发归档（本次记忆修复：归档已移出读路径）。
  - summary_window        : 机械摘要的批量 flush 窗口（不再控制归档检查频率）。

注入顺序（预算装填即优先级，靠前者先占预算；实际由 MemoryAssembler 按 section 权重装填）：
  优先级提示 → 固定记忆(pinned) → 主线/目标 → 笔记(notes) → 事实(facts)
  → 相关记忆/相关笔记(查询召回) → 历史概要(summaries) → 篇章(arc) → 能力 → 资源。

本次记忆修复：记忆归属收敛:
  · MemoryProvider 是 facts / pinned / notes / abilities / resources / summaries /
    main_quest / current_objective 的**唯一注入源**。state.short_summary() 在 prompt
    路径用 include_memory=False 让位；_fact_groups_layer 只保留没有 legacy_bucket 的
    结构化补充项（canon_fact / user_constraint / 未挂桶的 runtime_fact），不再把
    同一批记忆列第三遍。
  · pinned 不再受 recall_depth 限制: 固定记忆是玩家显式钉的权威输入，候选上限用
    pinned_max（默认 20），由 token_budget 做最终裁剪。旧实现 pinned[-recall_depth:]
    让第 6 条以后的固定记忆永远进不了上下文（面板却显示 20 条）。
  · 每个桶用 continue 而不是 break: 一条装不下的长摘要只跳过它自己，不能把后面的
    facts / notes / abilities 全部饿死。旧默认 800 token 下，2 条 600 字摘要就能触发
    这个饿死链。
  · 未确认推测从本层移除: context_engine.layers._active_hypotheses_layer 已是唯一
    注入源（带 id 和 confirm/reject 指引），这里不再重复一份。
"""
from __future__ import annotations

from .base import ContextContribution, ContextProvider
from .registry import register_provider

# 单条归档摘要条目的长度上限（字符）。超出的后续事实用省略号收尾。
_SUMMARY_ENTRY_MAX_CHARS = 600
# 单条事实压缩进摘要时的截断长度（取首句/首逗号，再硬截到这个长度）。
_SUMMARY_FACT_MAX_CHARS = 50
# summaries 列表上限（每次归档扫描至多产生 1 条，防无限增长）。
_SUMMARIES_MAX_ENTRIES = 50
# 每次归档扫描把 newly_archived 切成多块，每块生成一条摘要（本次记忆修复）。
# 旧实现一次扫描只压一条 ≤600 字，200 条旧 facts 会被压成一段话；分块后每 20 条
# facts 一条摘要，summary_pending 用队列按回合逐个精修，细节保留更多。
_ARCHIVE_SUMMARY_CHUNK = 20
# archived_facts 索引上限：归档事实原文保留给远期召回（KB afact 事件），但 state
# 不能无界增长；保留最近 1000 条（约 50 次 20 条归档批次）。
_ARCHIVED_FACTS_MAX = 1000
# summary_pending 任务携带的原始全文上限（LLM 精修材料）：条数 × 单条截断。
_PENDING_MAX_FACTS = 40
_PENDING_FACT_MAX_CHARS = 250
# summary_pending.queue 上限：summary_llm 关闭/失败时队首不会出队，若归档持续排队会
# 无界增长（每条最多 40×250 字）。丢弃最旧任务只损失其 LLM 精修机会，机械摘要仍在。
_PENDING_QUEUE_MAX = 20


def _condense_fact(text: str) -> str:
    """把一条完整事实压缩成摘要片段：折叠空白 → 截到最早的句读 → 硬截断。

    句读集合含中文逗号(子句级压缩更狠),不含 ASCII 逗号(避开 "1,000" 这类数字)。
    """
    t = " ".join(str(text or "").split())
    if not t:
        return ""
    cut = len(t)
    for ch in ("。", "；", ";", "!", "?", "！", "？", "，"):
        idx = t.find(ch)
        if 0 < idx < cut:
            cut = idx
    t = t[:cut]
    if len(t) > _SUMMARY_FACT_MAX_CHARS:
        t = t[:_SUMMARY_FACT_MAX_CHARS]
    return t


def _importance_of(item: dict) -> int:
    """读取条目重要性（本轮优化），缺失/非法值按默认 40 处理。

    注意不能用 `value or 40`：0 是合法的最低分（最该被压掉），用 or 会把它
    错误抬成 40，导致压力归档排序把最不重要的条目留下来。
    """
    try:
        value = item.get("importance")
        return int(value) if value is not None else 40
    except (TypeError, ValueError, AttributeError):
        return 40


def _maybe_auto_archive(state, ms) -> None:
    """检查是否需要触发自动归档。

    规则（本轮审查修正文档）：归档检查由 maintenance **每回合**执行一次，命中任一
    条件就归档：
      · 年龄：事实年龄 >= auto_archive_after_turns；
      · 压力：active facts 数量 > facts_soft_limit，按「重要性最低 → 最旧」归档到上限。
    summary_window 只控制**机械摘要的批量 flush 粒度**（每 N 回合或 buffer 满 20 条），
    不再控制归档检查本身；已归档但尚未 flush 的原文由 MemoryAssembler 暂以
    「概要：」行注入，避免归档与摘要之间的注入空窗。

    真摘要压缩（两步式）：本扫描归档掉的 facts 不是一扔了之 —— 同步路径先压缩成
    一条「第X-Y轮：…」机械保底摘要追加进 memory.summaries（每条 ≤600 字符），
    并把原始全文记入 memory.summary_pending 任务；GM 回复返回后的收尾阶段
    （chat_pipeline.memory_summary）再调 LLM 生成连贯精细摘要**覆盖**保底。
    旧事实从「完整原文在场」降级为「摘要在场」，远期剧情不再因归档而对 GM
    彻底失忆。幂等：无新归档就不产生新摘要/新任务。

    无 DB 依赖，纯内存操作，state.save() 由调用方负责。
    """
    try:
        data = getattr(state, "data", state) or {}
        current_turn = int(data.get("turn", 0))
        if current_turn <= 0:
            return
        # 本次记忆修复：world 桶关闭时暂停 facts 归档。否则用户关闭 world 一段时间
        # 再打开，中间事实已经被压成摘要/移出 facts 桶，等于“关闭期间悄悄丢了记忆”。
        if not bool(getattr(ms, "bucket_world_enabled", True)):
            return
        if int(getattr(ms, "summary_window", 0) or 0) <= 0:
            return
        summary_window = max(1, int(ms.summary_window))
        items = (data.get("memory") or {}).get("items") or []

        def _is_archivable_fact(item: dict) -> bool:
            if not isinstance(item, dict):
                return False
            if item.get("archived"):
                return False
            # 只归档 active 事实：superseded/rejected 已经是无效历史，再归档/写摘要
            # 会让它们通过「概要」重新进入上下文。
            if (item.get("status") or "active") != "active":
                return False
            # 永不自动归档的桶 = 角色卡式【持久状态】+ 玩家权威手写输入:
            #   · notes(手记)/ pinned(固定记忆):玩家手写/显式固定的权威输入。
            #   · abilities(能力)/ resources(资源/物品/货币):角色卡式持久状态。
            if item.get("legacy_bucket") in ("notes", "pinned", "abilities", "resources"):
                return False
            # 只归档「事实」: legacy facts 桶，或没有 legacy_bucket 的结构化 runtime_fact。
            return (item.get("legacy_bucket") == "facts") or (
                item.get("legacy_bucket") is None and item.get("kind") == "runtime_fact")

        active_facts = [it for it in items if _is_archivable_fact(it)]
        # 年龄触发：>= 阈值（旧实现是 < cutoff，且只在整除窗口检查，实际会晚一个窗口）。
        auto_turns = max(1, int(getattr(ms, "auto_archive_after_turns", 50) or 50))
        age_due = any(
            int(it.get("turn") or 0) > 0
            and current_turn - int(it.get("turn") or 0) >= auto_turns
            for it in active_facts
        )
        # 压力触发：active facts 超过软上限时，无论年龄都归档最旧的一批。
        # 这是本次记忆修复的核心：高密度长局（每回合 2-3 条事实）不会出现
        # “最近候选只覆盖几十条、中间几十条既不在候选也没摘要”的断层。
        soft_limit = max(20, int(getattr(ms, "facts_soft_limit", 80) or 80))
        pressure = len(active_facts) > soft_limit

        selected: list[dict] = []
        if pressure:
            # 从低重要性开始归档，同分再从最旧开始；turn=0 的迁移/开场事实也参与，
            # 避免永久占位。
            # 本轮优化：旧实现只按 turn 排序，会把「第 10 回合的结盟誓言」和
            # 「第 9 回合的天气旁白」一起压掉。现在普通旁白（45~55）先出局，
            # 带人物+事件关键词的剧情事实（65~80）留到最后一档，长局里关键状态
            # 更不容易被摘要压缩掉。
            ordered = sorted(
                enumerate(active_facts),
                key=lambda pair: (
                    _importance_of(pair[1]),
                    int(pair[1].get("turn") or 0),
                    pair[0],
                ),
            )
            selected = [it for _, it in ordered[: max(0, len(active_facts) - soft_limit)]]
        elif age_due:
            cutoff_turn = current_turn - auto_turns
            selected = [
                it for it in active_facts
                if int(it.get("turn") or 0) > 0
                and int(it.get("turn") or 0) <= cutoff_turn
            ]

        # 摘要/保底文本按时间序叙述（本轮优化）：「选谁归档」按重要性排序，但一旦
        # 选中，写进 summary_archive_buffer 的顺序必须回到回合顺序。否则压力归档
        # 会把「第 40 轮」的低分事实排在「第 5 轮」前面，GM 读概要时会误判事件先后。
        # 归档集合不变，只调整叙述顺序。
        if len(selected) > 1:
            selected.sort(key=lambda it: (
                int(it.get("turn") or 0), str(it.get("text") or "")))

        changed = False
        newly_archived: list[dict] = []
        for item in selected:
            if item.get("archived"):
                continue
            item["archived"] = True
            changed = True
            newly_archived.append(item)
        # 同步到 legacy buckets：仅从 facts 移除已归档条目。**绝不碰 notes/pinned/abilities/resources**
        # (持久状态 + 玩家权威);且这里按文本 set 比对,若把它们纳入,一条与某归档事实文本恰好
        # 相同的能力/资源/手记会被误删(文本碰撞)。上面的豁免已保证这些桶的 item 不会被标 archived,
        # 此处仅剥 facts 是双保险。
        mem = data.get("memory") or {}
        if changed:
            # 只移除「本轮新归档」且属于 legacy facts 桶的文本；不要把历史上所有
            # archived 条目都拿来比对 —— 否则玩家重新添加一条同名事实时，会被旧
            # archived 条目的文本碰撞误删（facts 桶里有、items 里也 active，但注入消失）。
            #
            # active_fact_texts 只收「仍 active 的 legacy facts」，不要收 notes 等其它
            # 桶：否则一条与手记同文的旧事实会因碰撞而留在 facts 桶里继续被注入。
            active_fact_texts = {
                str(item.get("text") or "").strip()
                for item in items
                if isinstance(item, dict)
                and item.get("legacy_bucket") == "facts"
                and (item.get("status") or "active") == "active"
                and not item.get("archived")
            }
            archived_texts = {
                str(item.get("text") or "").strip()
                for item in newly_archived
                if item.get("legacy_bucket") == "facts"
            }
            archived_texts -= active_fact_texts
            # 本次记忆修复:归档事实原文先进入 archived_facts 索引，再从 facts 桶移除。
            # archived_facts 不参与 MemoryProvider 常规注入，但会被 KB import 写成
            # afact 事件，供后续 episodic/远期召回；facts 桶保持精简。
            # 仍 active 的同文事实（玩家重新添加）不进索引，否则同一文本会同时出现在
            # 「当前事实」和「远期归档」两处，KB 侧也会重复写 fact/afact 事件。
            try:
                _arch = mem.setdefault("archived_facts", [])
                if isinstance(_arch, list):
                    for item in newly_archived:
                        text = str(item.get("text") or "").strip()
                        if text and text not in active_fact_texts and text not in _arch:
                            _arch.append(text)
                    if len(_arch) > _ARCHIVED_FACTS_MAX:
                        del _arch[:-_ARCHIVED_FACTS_MAX]
            except Exception:
                pass
            for bucket in ("facts",):
                bucket_list = mem.get(bucket)
                if isinstance(bucket_list, list):
                    mem[bucket] = [t for t in bucket_list if t not in archived_texts]
            # 本次记忆修复：归档标记与摘要生成解耦。压力/年龄命中时每回合都可以
            # 归档（facts 桶立即变短），但摘要先进入 summary_archive_buffer，
            # 到 summary_window 或攒满一块时才生成，避免高密度局每回合产一条 3 条
            # 事实的碎片摘要。buffer 有硬上限，防止 window 很大时无界增长。
            buffer = mem.get("summary_archive_buffer")
            if not isinstance(buffer, list):
                buffer = []
                mem["summary_archive_buffer"] = buffer
            _buffered = {
                (str(x.get("text") or ""), int(x.get("turn") or 0))
                for x in buffer if isinstance(x, dict)
            }
            for item in newly_archived:
                key = (str(item.get("text") or ""), int(item.get("turn") or 0))
                if not key[0] or key in _buffered:
                    continue
                _buffered.add(key)
                buffer.append({
                    k: item.get(k) for k in (
                        "text", "turn", "characters", "location", "time_label",
                    ) if item.get(k) is not None
                })
            # 归档改变了 active/archived 集合，active recall 索引需要重建。
            try:
                _touch = getattr(state, "_touch_memory", None)
                if callable(_touch):
                    _touch()
                _bump = getattr(state, "_bump_memory_stat", None)
                if callable(_bump):
                    _bump("archived_total", len(newly_archived))
            except Exception:
                pass

        # 摘要生成：window 到点 / buffer 满一块 / buffer 超过硬上限时 flush。
        buffer = mem.get("summary_archive_buffer")
        if isinstance(buffer, list) and buffer:
            flush_due = (
                current_turn % summary_window == 0
                or len(buffer) >= _ARCHIVE_SUMMARY_CHUNK
                or len(buffer) > 500
            )
            if flush_due:
                chunks = [
                    buffer[i:i + _ARCHIVE_SUMMARY_CHUNK]
                    for i in range(0, len(buffer), _ARCHIVE_SUMMARY_CHUNK)
                ]
                mem["summary_archive_buffer"] = []
                for i, chunk in enumerate(chunks):
                    _append_scan_summary(
                        mem, chunk,
                        queue_pending=bool(mem.get("summary_pending")) or i > 0,
                    )
    except Exception:
        pass  # 归档失败不影响正常出牌


def _shift_pending_summary_indices(mem: dict, removed: int) -> None:
    """summaries 超上限裁掉最旧条目后，同步修正 pending/queue 的 index。

    多块摘要队列下，一个旧条目被裁掉会让所有后续 index 前移；不修正会覆盖错摘要。
    修正后 index<0 的任务由 refine_pending_summary 走「append 兜底」，不丢精修结果。
    """
    if removed <= 0:
        return
    cur = mem.get("summary_pending")
    if not isinstance(cur, dict) or not cur:
        return
    tasks = [cur]
    q = cur.get("queue")
    if isinstance(q, list):
        tasks.extend(t for t in q if isinstance(t, dict))
    for task in tasks:
        try:
            idx = int(task.get("index", -1))
        except (TypeError, ValueError):
            continue
        if idx >= 0:
            task["index"] = idx - removed if idx >= removed else -1


def _append_scan_summary(mem: dict, newly_archived: list[dict],
                         *, queue_pending: bool = False) -> int:
    """把本扫描归档的 facts 压缩成一条机械保底摘要追加进 mem["summaries"]。

    同时写 mem["summary_pending"] 任务（原始全文 + 轮次范围 + 摘要下标），供
    收尾阶段（chat_pipeline.memory_summary.refine_pending_summary）调 LLM 生成
    精细摘要**覆盖**这条保底 —— 两步式"真摘要压缩"：同步路径永不调 LLM。
    queue_pending=True 时把任务追加到现有 pending 的 queue（多块摘要按回合逐个精修），
    否则覆盖/创建队首任务。追加条目的下标；没有可写内容返回 -1。
    """
    fragments: list[str] = []
    raw_texts: list[str] = []
    turns: list[int] = []
    meta_chars: list[str] = []
    meta_locs: list[str] = []
    meta_times: list[str] = []
    for item in newly_archived:
        text = str(item.get("text") or "")
        if not text:
            continue
        # 本次记忆修复：机械摘要/LLM 输入带紧凑元数据（人物/地点/时间），
        # 远期摘要不再是一堆“没人名没地点”的裸事实。每条 raw text 带自己的
        # 前缀（给 LLM），机械摘要只在开头放一个合并后的元数据头（省字符）。
        _chars = [str(c).strip() for c in (item.get("characters") or []) if str(c).strip()]
        _loc = str(item.get("location") or "").strip()
        _time = str(item.get("time_label") or "").strip()
        _meta = [x for x in (
            "、".join(_chars[:3]), _loc, _time,
        ) if x]
        for c in _chars[:3]:
            if c not in meta_chars:
                meta_chars.append(c)
        if _loc and _loc not in meta_locs:
            meta_locs.append(_loc)
        if _time and _time not in meta_times:
            meta_times.append(_time)
        raw_texts.append((f"[{' · '.join(_meta)}] " if _meta else "") + text)
        condensed = _condense_fact(text)
        if condensed:
            fragments.append(condensed)
        try:
            turns.append(int(item.get("turn", 0)))
        except (TypeError, ValueError):
            pass
    if not fragments:
        return -1
    prefix = ""
    if turns:
        prefix = f"第{min(turns)}-{max(turns)}轮："
    meta_header: list[str] = []
    if meta_chars:
        meta_header.append("人物：" + "、".join(meta_chars[:4]))
    if meta_locs:
        meta_header.append("地点：" + "、".join(meta_locs[:2]))
    if meta_times:
        meta_header.append("时间：" + "、".join(meta_times[:2]))
    if meta_header:
        prefix += "[" + "；".join(meta_header) + "] "
    entry = prefix + "；".join(fragments)
    if len(entry) > _SUMMARY_ENTRY_MAX_CHARS:
        entry = entry[:_SUMMARY_ENTRY_MAX_CHARS].rstrip("；;，, ") + "……"
    summaries = mem.get("summaries")
    if not isinstance(summaries, list):
        summaries = []
        mem["summaries"] = summaries
    summaries.append(entry)
    idx = len(summaries) - 1
    if len(summaries) > _SUMMARIES_MAX_ENTRIES:
        removed = len(summaries) - _SUMMARIES_MAX_ENTRIES
        del summaries[:-_SUMMARIES_MAX_ENTRIES]
        _shift_pending_summary_indices(mem, removed)
        idx = len(summaries) - 1
    # pending 任务:原始全文(截断,给 LLM 足够细节) + 轮次范围 + 待覆盖的保底下标。
    # 多块摘要时，队首任务处理后由 memory_summary 从 queue 里提升下一个；机械摘要
    # 永远在场，精修是锦上添花。
    task = {
        "index": idx,
        "turn_range": [min(turns), max(turns)] if turns else None,
        "texts": [t[:_PENDING_FACT_MAX_CHARS] for t in raw_texts][:_PENDING_MAX_FACTS],
        "attempts": 0,
    }
    existing = mem.get("summary_pending")
    if queue_pending and isinstance(existing, dict) and existing:
        queue = existing.setdefault("queue", [])
        if isinstance(queue, list):
            queue.append(task)
            # 防无界增长：summary_llm 关闭或连续失败时队首长期不消费；丢弃最旧排队任务
            # 只影响精修，机械保底摘要已写入 summaries。
            if len(queue) > _PENDING_QUEUE_MAX:
                del queue[:-_PENDING_QUEUE_MAX]
    else:
        mem["summary_pending"] = task
    return idx


def _restore_persistent_buckets(state) -> None:
    """自愈:把此前被(旧)auto-archive 误归档的 abilities/resources 条目救回 legacy bucket + 取消 archived。
    v1.34.1 起 abilities/resources 豁免归档(角色卡式持久状态),但**历史存档里已被移出 bucket 的**不会自己
    回来 —— 老玩家丢掉的能力/资源要恢复。只动 archived 的(auto-archive 是唯一置 archived 的路径);玩家显式
    删除的条目 remove_memory 已从 items 移除,不会被复活;superseded 的跳过。幂等,MemoryProvider 每回合调。"""
    try:
        data = getattr(state, "data", state) or {}
        mem = data.get("memory")
        if not isinstance(mem, dict):
            return
        items = mem.get("items") or []
        changed = False
        for bucket in ("abilities", "resources"):
            bucket_list = mem.get(bucket)
            if not isinstance(bucket_list, list):
                continue
            for item in items:
                if not isinstance(item, dict) or item.get("legacy_bucket") != bucket:
                    continue
                if item.get("status") == "superseded":
                    continue
                if item.get("archived"):
                    item["archived"] = False  # 取消误归档
                    changed = True
                text = item.get("text")
                if text and text not in bucket_list:
                    bucket_list.append(text)  # 补回 bucket
                    changed = True
        if changed:
            try:
                _touch = getattr(state, "_touch_memory", None)
                if callable(_touch):
                    _touch()
            except Exception:
                pass
    except Exception:
        pass  # 自愈失败不影响正常出牌


class MemoryProvider(ContextProvider):
    id = "memory"

    def collect(self, state, manifest, demand, services) -> ContextContribution:
        # ── 读取 MemorySettings（全局 + 本存档 override）─────────────────────
        ms = None
        user_id = getattr(services, "user_id", None)
        try:
            from platform_app.settings import get_effective_memory_settings
            ms = get_effective_memory_settings(
                int(user_id) if user_id is not None else None,
                getattr(state, "data", None),
            )
        except Exception:
            ms = None
        if ms is None:
            from schemas.memory import MemorySettings
            ms = MemorySettings()  # 全默认
        # 记忆相关层统一 token 估算系数：episodic_recall 等后跑 provider 读取。
        try:
            state._memory_token_factor = float(
                getattr(ms, "token_estimate_factor", 1.0) or 1.0)
        except Exception:
            pass

        # 自愈 + 归档扫描都已移出读路径：由 chat_pipeline.memory_maintenance 在回合
        # 结束后统一执行。读 provider 只读 memory + 写 last_memory_injection（面板观测），
        # 不再隐式改存档。

        # ── 读取 memory 数据（MemoryAssembler，本次记忆修复 Phase 2）──────────
        # 预算装填/section 权重/查询召回都收进 MemoryAssembler；本 provider 只负责
        # 读配置、自愈、观测字段。未确认推测仍由 context_engine 的通用层单独注入。
        m = (getattr(state, "data", state) or {}).get("memory") or {}
        from .memory_assembler import MemoryAssembler
        text, lines, asm_debug = MemoryAssembler(state, ms, demand=demand).build()
        # 跨层去重（本次记忆修复）: 把本层实际召回的相关 facts/notes 挂到 state 瞬态属性，
        # 后跑的 episodic_recall（manifest 里排在 memory 之后）会跳过同文片段，避免
        # 「相关记忆：」和「相关往事」在同一 prompt 里重复同一条事实。
        try:
            state._memory_recalled_texts = set(asm_debug.get("recalled_texts") or [])
            # 跨层去重扩展（本次记忆修复）：不只「相关记忆」top-3，最近事实/笔记/
            # 摘要/篇章/能力/资源实际注入的正文都挂到 state 上，episodic 一并跳过。
            state._memory_injected_texts = set(asm_debug.get("injected_texts") or [])
            # 带回合戳：episodic 只信同一回合的 memory 注入结果，避免 provider 失败/被跳过时
            # 用到上一轮的陈旧去重集合。
            state._memory_recalled_turn = int((getattr(state, "data", {}) or {}).get("turn") or 0)
        except Exception:
            pass

        # 面板观测专用:把本轮记忆层实际注入的原文单独落字段(memory.last_memory_injection,
        # 随 status_payload 整体下发)。注意 last_retrieval 是小说检索层(novel_retrieval)
        # 的文本,与记忆层无关 —— 前端 ✓徽章/「注入 N 条」计数必须读本字段才有意义。
        try:
            m["last_memory_injection"] = text
        except Exception:
            pass  # m 为临时 dict(无 memory 键的极端构造)时写入丢失,无害
        layer = self.make_layer(
            "memory", "长期记忆", text,
            sticky=False, priority=60,
        )
        return ContextContribution(
            provider_id=self.id,
            kind="memory",
            priority=60,
            facts=lines[:3],
            layers=[layer],
            tokens_estimate=asm_debug.get("token_used", 0),
            debug={
                "items_count": len(m.get("items") or []),
                "summaries_count": len(m.get("summaries") or []),
                "archived_facts_count": len(m.get("archived_facts") or []),
                "token_used": asm_debug.get("token_used", 0),
                "token_budget": asm_debug.get("token_budget", ms.token_budget),
                "token_estimate_factor": asm_debug.get(
                    "token_estimate_factor", getattr(ms, "token_estimate_factor", 1.0)),
                "remaining_tokens": asm_debug.get("remaining_tokens", 0),
                "recall_depth": ms.recall_depth,
                "pinned_max": ms.pinned_max,
                "bucket_pinned": ms.bucket_pinned_enabled,
                "bucket_world": ms.bucket_world_enabled,
                "bucket_character": ms.bucket_character_enabled,
                # section 级明细（本次记忆修复）: 每个桶 selected/available/dropped/tokens，
                # 供上下文用量面板/调试定位「哪条被预算丢了」。
                "sections": asm_debug.get("sections", []),
                "recalled_count": asm_debug.get("recalled_count", 0),
                # 跨 section 去重计数（本轮优化）：本轮因「同一句话已在更高优先级
                # section 出现」而被丢弃的行数。面板据此解释实际注入数为何小于各桶之和。
                "deduped_across_sections": asm_debug.get("deduped_across_sections", 0),
                # 已归档但摘要尚未批量生成的条目数（本轮优化）：以「概要：」暂注入。
                "summary_buffer_count": asm_debug.get("summary_buffer_count", 0),
                "memory_query": asm_debug.get("query", ""),
                # 生命周期计数（本次记忆修复）：只读展示，不参与注入。
                "stats": dict(m.get("stats") or {}),
            },
        )


register_provider(MemoryProvider())
