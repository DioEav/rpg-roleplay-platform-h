"""chat_pipeline.arc_summary — 篇章级 arc rollup（本次记忆修复 Phase 3）。

背景：save_phase_digests 每 30 轮一个 phase，runtime_phase_digests 只注入最近 4 个，
history_messages 前情提要只补 6 个更早 phase；300+ 轮后更早的 phase 会从两条路同时
消失。这里在 phase 之上再做一层**确定性** rollup（不额外调 LLM）：

  · 每 ARC_GROUP_PHASES 个 phase 合成一条 arc 摘要；
  · 输入是已经由 phase_digest_agent 生成好的 summary/key_events/key_npcs/key_locations；
  · 输出存 memory.arc_summaries（最多 10 条），由 MemoryAssembler 以「篇章：」注入。

为什么不做 LLM arc：
  · phase digest 本身已经是一次 LLM 压缩，再做一次 LLM 收益递减；
  · 默认开 episodic_recall 后每回合成本已增加，arc 保持零 LLM 调用；
  · 确定性 rollup 不会编造材料里没有的东西，符合记忆系统「宁漏勿误」的基调。
"""
from __future__ import annotations

from typing import Any

from core.logging import get_logger

log = get_logger(__name__)

ARC_GROUP_PHASES = 5          # 每 5 个 phase 一条 arc
ARC_MAX_ENTRIES = 10          # state 里最多保留 10 条 arc
ARC_ENTRY_MAX_CHARS = 600     # 单条 arc 上限
ARC_REFRESH_EVERY_TURNS = 10  # 每 10 回合最多查一次 save_phase_digests


def _clip(text: Any, n: int) -> str:
    t = " ".join(str(text or "").split())
    return t[:n]


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def build_arc_entries(phases: list[dict], *, group_size: int = ARC_GROUP_PHASES,
                      max_entries: int = ARC_MAX_ENTRIES) -> list[dict]:
    """把 closed phase digests 按 group_size 分组合成 arc 条目（纯函数）。"""
    closed: list[dict] = []
    for p in phases or []:
        if not isinstance(p, dict):
            continue
        if (p.get("status") or "") != "closed":
            continue
        if not str(p.get("summary") or "").strip():
            continue
        # 规范化字段，避免单条脏数据（phase_index 非数字/list 字段是 dict）让整个
        # rollup 抛异常、导致所有 arc 都更新不了。
        cp = dict(p)
        cp["phase_index"] = _as_int(p.get("phase_index"), 0)
        cp["turn_start"] = _as_int(p.get("turn_start"), 0)
        cp["turn_end"] = _as_int(p.get("turn_end"), 0)
        closed.append(cp)
    if not closed:
        return []

    groups: dict[int, list[dict]] = {}
    for p in closed:
        idx = int(p.get("phase_index") or 0) // max(1, int(group_size))
        groups.setdefault(idx, []).append(p)

    entries: list[dict] = []
    for gidx in sorted(groups):
        ps = sorted(groups[gidx], key=lambda x: int(x.get("phase_index") or 0))
        phase_start = int(ps[0].get("phase_index") or 0)
        phase_end = int(ps[-1].get("phase_index") or 0)
        turn_start = min(int(p.get("turn_start") or 0) for p in ps)
        turn_end = max(int(p.get("turn_end") or 0) for p in ps)

        seen_npc: set[str] = set()
        seen_loc: set[str] = set()
        seen_emotion: list[str] = []
        # 本次记忆修复：按 phase 生成独立 chunk，再“从最新往旧”装填。
        # 旧实现按 phase 升序拼完再截 600 字，最新 phase 反而最先被截掉，
        # NPC/地点列表因为放在最后也经常整段消失。
        phase_chunks: list[str] = []
        for p in ps:
            chunk_parts: list[str] = []
            summary = _clip(p.get("summary"), 160)
            if summary:
                chunk_parts.append(summary)
            for ev in _as_list(p.get("key_events"))[:2]:
                if not isinstance(ev, dict):
                    continue
                desc = _clip(ev.get("summary") or ev.get("desc"), 70)
                if desc:
                    chunk_parts.append(f"t{ev.get('turn', '?')}:{desc}")
            # 玩家的显式选择是剧本游戏最重要的长期记忆之一；phase digest 已经
            # 产出 key_decisions，arc 不能只收事件而漏掉“玩家做过什么决定”。
            for dec in _as_list(p.get("key_decisions"))[:3]:
                if isinstance(dec, dict):
                    choice = _clip(dec.get("choice"), 50)
                    consequence = _clip(dec.get("consequence"), 50)
                    if choice:
                        chunk_parts.append(
                            f"选择:{choice}" + (f"→{consequence}" if consequence else ""))
                else:
                    choice = _clip(dec, 70)
                    if choice:
                        chunk_parts.append(f"选择:{choice}")
            if chunk_parts:
                phase_chunks.append("；".join(chunk_parts))
            for npc in _as_list(p.get("key_npcs"))[:3]:
                name = _clip(npc.get("name") if isinstance(npc, dict) else npc, 40)
                if name and name not in seen_npc:
                    seen_npc.add(name)
            for loc in _as_list(p.get("key_locations"))[:3]:
                name = _clip(loc, 40)
                if name and name not in seen_loc:
                    seen_loc.add(name)
            # 心境链（本次记忆修复）：phase digest 已经产出 emotion_arc，arc 也保留
            # 一两段，帮助 GM 回顾更早的情绪走向。
            emo = _clip(p.get("emotion_arc"), 80)
            if emo and emo not in seen_emotion:
                seen_emotion.append(emo)

        tail_parts: list[str] = []
        if seen_npc:
            tail_parts.append("人物：" + "、".join(sorted(seen_npc)))
        if seen_loc:
            tail_parts.append("地点：" + "、".join(sorted(seen_loc)))
        if seen_emotion:
            tail_parts.append("心境：" + " → ".join(seen_emotion[-2:]))
        tail = "；".join(tail_parts)
        prefix = f"第{phase_start + 1}-{phase_end + 1}阶段（turn {turn_start}-{turn_end}）："
        # 给前缀和 NPC/地点尾巴预留空间；正文从最新 chunk 往回装，装不下的旧 phase
        # 才被舍弃。选中的 chunk 仍按时间正序展示，避免 GM 误判事件先后。
        body_budget = max(80, ARC_ENTRY_MAX_CHARS - len(prefix) - len(tail) - 5)
        chosen: list[str] = []
        used = 0
        for chunk in reversed(phase_chunks):
            remaining = body_budget - used
            if remaining <= 0:
                break
            if len(chunk) > remaining:
                if not chosen:
                    chosen.append(chunk[:remaining])
                break
            chosen.append(chunk)
            used += len(chunk) + 1
        body = "；".join(reversed(chosen))
        text = (prefix + body + (("；" + tail) if tail else ""))[:ARC_ENTRY_MAX_CHARS]
        entries.append({
            "arc_index": int(gidx),
            "phase_start": phase_start,
            "phase_end": phase_end,
            "turn_start": turn_start,
            "turn_end": turn_end,
            "text": text,
        })
    return entries[-max(1, int(max_entries)):]


def refresh_arc_summaries(state: Any, save_id: int | None, *, force: bool = False) -> int:
    """按节流从 save_phase_digests 重建 memory.arc_summaries。返回是否有更新（0/1）。

    只在 turn 与上次刷新相差 ≥ ARC_REFRESH_EVERY_TURNS 时查 DB；首次（无缓存）
    立即刷新。任何 DB/异常静默，保留旧 arc，不影响回合。
    """
    try:
        data = getattr(state, "data", None)
        if not isinstance(data, dict):
            return 0
        mem = data.setdefault("memory", {})
        turn = int(data.get("turn") or 0)
        last = int(mem.get("arc_refresh_turn") or -1)
        # 用 last>=0 判断「是否刷新过」而不是 arc_summaries 非空：没有 closed phase
        # 时 arc_summaries 是空列表，旧条件会每回合都查一次 DB。
        if not force and last >= 0 and turn - last < ARC_REFRESH_EVERY_TURNS:
            return 0
        sid = int(save_id or data.get("_active_save_id") or 0)
        if not sid:
            return 0
        from platform_app.db import connect

        with connect() as db:
            rows = db.execute(
                "select phase_index, turn_start, turn_end, summary, key_events, "
                "key_npcs, key_locations, status from save_phase_digests "
                "where save_id=%s and status='closed' and coalesce(summary,'')<>'' "
                "order by phase_index asc",
                (sid,),
            ).fetchall() or []
        # 本次记忆修复：runtime_phase_digests 只注入最近 RECENT_PHASE_WINDOW 个
        # phase 的详细摘要；arc 如果还汇总这些 phase，同一段历史会在 prompt 里
        # 出现两次。这里只把“最近窗口之前”的 closed phase 交给 arc；窗口内的
        # phase 由 runtime provider 负责。
        from state.phase_digest_policy import RECENT_PHASE_WINDOW
        phase_rows = [dict(r) for r in rows]
        if phase_rows:
            max_idx = max(int(r.get("phase_index") or 0) for r in phase_rows)
            boundary = max_idx - int(RECENT_PHASE_WINDOW) + 1
            phase_rows = [
                r for r in phase_rows
                if int(r.get("phase_index") or 0) < boundary
            ]
        entries = build_arc_entries(phase_rows)
        before = mem.get("arc_summaries") or []
        mem["arc_summaries"] = entries
        mem["arc_refresh_turn"] = turn
        return 0 if before == entries else 1
    except Exception as exc:  # noqa: BLE001 —— arc 失败不影响回合
        log.debug("[arc_summary] refresh skipped: %s", exc)
        # 失败也推进节流戳，避免 DB 故障时每回合都重试一次（下个窗口再试）。
        try:
            data = getattr(state, "data", None)
            if isinstance(data, dict) and isinstance(data.get("memory"), dict):
                data["memory"]["arc_refresh_turn"] = int(data.get("turn") or 0)
        except Exception:
            pass
        return 0
