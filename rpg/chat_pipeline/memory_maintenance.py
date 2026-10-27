"""chat_pipeline.memory_maintenance — 回合后记忆维护（本次记忆修复）。

背景：旧实现把 `_maybe_auto_archive` 放在 `MemoryProvider.collect` 里 —— 读上下文时
顺手改存档。问题有三:
  1. 归档时机取决于「这一轮有没有组装上下文」；provider 失败/跳过就不归档。
  2. 读路径有写副作用，难以测试、难以保证在 Phase 5 持久化前执行。
  3. 归档结果要到下一轮才生效，与「回合结束做维护」的心智模型不一致。

现在改为回合后统一维护:
  · 归档旧 facts → summaries（多块摘要 + summary_pending 队列）
  · 归档事实原文进入 memory.archived_facts（KB 侧对应 afact 事件，供远期召回）
  · world.known_events 统一裁到 KNOWN_EVENTS_MAX（JSON ops/史官路径也受控）

由 chat_pipeline.gm 在 GM 回合结束后调用（async 两个 return 前 / sync parity 路径），
调用方负责 Phase 5 持久化；任何异常静默，绝不破回合。
"""
from __future__ import annotations

from typing import Any

from core.logging import get_logger

log = get_logger(__name__)


def run_memory_maintenance(state: Any, user_id: int | None = None,
                           save_id: int | None = None) -> dict[str, int]:
    """执行一次回合后记忆维护。返回可观测计数（失败时返回已完成的计数）。"""
    out = {
        "archived": 0,
        "summaries": 0,
        "archived_facts": 0,
        "known_events_trimmed": 0,
        "arc_summaries": 0,
        "reconciled_backfilled": 0,
        "reconciled_orphaned": 0,
    }
    try:
        data = getattr(state, "data", None)
        if not isinstance(data, dict):
            return out
        mem = data.get("memory")
        if not isinstance(mem, dict):
            return out

        from platform_app.settings import get_effective_memory_settings
        from schemas.memory import MemorySettings

        ms = None
        try:
            ms = get_effective_memory_settings(user_id, data)
        except Exception:
            ms = None
        if ms is None:
            ms = MemorySettings()

        from context_providers.memory import (
            _maybe_auto_archive,
            _restore_persistent_buckets,
        )
        # 自愈也放在维护路径：把旧版 auto-archive 误归档的 abilities/resources 救回，
        # 读 provider 不再改 state。
        _before_archived = sum(
            1 for it in (mem.get("items") or [])
            if isinstance(it, dict) and it.get("archived")
        )
        _restore_persistent_buckets(state)
        # 本次记忆修复：先恢复持久桶，再对账 legacy ↔ items。顺序不能反 —— 如果先
        # 对账，历史上被误归档的 abilities/resources 还处于 archived，会被当成
        # “legacy 有、items 没有”重复补建一条 active item。
        try:
            _rec = state.reconcile_memory_items()
            out["reconciled_backfilled"] = int(_rec.get("backfilled") or 0)
            out["reconciled_orphaned"] = int(_rec.get("orphaned") or 0)
        except Exception as _rec_err:  # noqa: BLE001
            log.debug("[memory_maintenance] reconcile skipped: %s", _rec_err)
        _maybe_auto_archive(state, ms)
        _after_archived = sum(
            1 for it in (mem.get("items") or [])
            if isinstance(it, dict) and it.get("archived")
        )
        # archived = 本回合新归档数（不是累计数），避免日志/调用方误判为每轮都有新归档。
        out["archived"] = max(0, _after_archived - _before_archived)
        out["summaries"] = len(mem.get("summaries") or [])
        out["archived_facts"] = len(mem.get("archived_facts") or [])

        # known_events 统一上限（工具路径已 cap；这里兜 JSON ops/史官路径）。
        from state.core import KNOWN_EVENTS_MAX
        world = data.get("world")
        if isinstance(world, dict):
            events = world.get("known_events")
            if isinstance(events, list) and len(events) > KNOWN_EVENTS_MAX:
                removed = len(events) - KNOWN_EVENTS_MAX
                del events[:-KNOWN_EVENTS_MAX]
                out["known_events_trimmed"] = removed

        # 篇章级 arc rollup：每 10 回合最多查一次 save_phase_digests，确定性合成，
        # 不额外调 LLM。失败静默保留旧 arc。
        from chat_pipeline.arc_summary import refresh_arc_summaries
        refresh_arc_summaries(state, save_id)
        out["arc_summaries"] = len(mem.get("arc_summaries") or [])
    except Exception as exc:  # noqa: BLE001 —— 维护失败绝不破回合
        log.debug("[memory_maintenance] failed silently: %s", exc)
    return out
