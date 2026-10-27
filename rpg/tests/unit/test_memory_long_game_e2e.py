"""长局记忆 e2e（本次记忆修复）。

不调 LLM、不依赖 DB：用 GameState + MemoryAssembler + memory_maintenance 模拟
300 回合的真实增长，验证本次修复的几个关键闭环：

  1. 事实持续增长 → 自动归档 → summaries/archived_facts，facts 桶保持精简；
  2. 归档事实仍能通过 query_memory(scope="archived") 主动找回；
  3. notes/abilities/resources 不再被 recall_depth 砍到只剩最近 8 条；
  4. legacy 桶与 memory.items 在长局后仍严格对账（active 数量一致）；
  5. 状态可 JSON 序列化，不因 summary_pending 队列/历史条目无界膨胀。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from chat_pipeline.memory_maintenance import run_memory_maintenance
from context_providers.base import Demand
from context_providers.memory_assembler import MemoryAssembler
from schemas.memory import MemorySettings
from state import GameState


def _build_long_game() -> GameState:
    s = GameState({
        "turn": 0,
        "player": {"name": "林岚", "current_location": "旧港码头"},
        "relationships": {"张三": "信任"},
        "memory": {
            "notes": [f"玩家手记{i}" for i in range(20)],
            "abilities": [f"能力{i}" for i in range(20)],
            "resources": [f"资源{i}" for i in range(20)],
        },
    })
    for turn in range(1, 301):
        s.data["turn"] = turn
        s.data["player"]["current_location"] = "旧港码头" if turn % 2 else "北境雪原"
        s.add_memory(
            "facts",
            f"第{turn}回合：在旧港码头发现了编号{turn}的线索，并记录在案",
            origin="gm:json",
        )
        # 每 10 回合跑一次回合后维护（与生产 chat_pipeline 的 cadence 一致）。
        if turn % 10 == 0:
            run_memory_maintenance(s, user_id=None, save_id=None)
    return s


def test_long_game_memory_lifecycle_stays_consistent():
    s = _build_long_game()
    mem = s.data["memory"]

    # 1) 归档生效：facts 桶保持精简，summary/archived_facts 有内容。
    assert len(mem["facts"]) <= 60, f"facts 桶没有归档，长度={len(mem['facts'])}"
    assert len(mem["archived_facts"]) >= 200
    assert len(mem["summaries"]) >= 10
    # 队列有上限，不会因 300 回合无 LLM 精修而无限增长。
    pending = mem.get("summary_pending") or {}
    queue = pending.get("queue") or []
    assert len(queue) <= 20

    # 2) 早期归档事实仍能主动查回（旧实现只扫 items[-200:] 且看不到归档）。
    from tools_dsl.command_tools_queries import _t_query_memory
    hits = json.loads(_t_query_memory(
        s, {"query": "编号1的线索", "scope": "archived", "limit": 10}))
    assert any("编号1的线索" in str(h.get("text")) for h in hits)

    # 3) 持久桶不被 recall_depth 砍到 8 条。
    text, lines, dbg = MemoryAssembler(
        s, MemorySettings(), demand=Demand(player_intent="我检查一下手记和能力")
    ).build()
    assert len([ln for ln in lines if ln.startswith("笔记：")]) == 20
    assert len([ln for ln in lines if ln.startswith("能力：")]) == 20
    assert len([ln for ln in lines if ln.startswith("资源：")]) == 20

    # 4) legacy ↔ items 对账：每个桶的 active item 数量与桶长度一致。
    out = s.reconcile_memory_items()
    assert out["backfilled"] == 0 and out["orphaned"] == 0
    for bucket in ("facts", "notes", "pinned", "abilities", "resources"):
        bucket_len = len(mem.get(bucket) or [])
        active_items = [
            it for it in mem["items"]
            if isinstance(it, dict)
            and it.get("legacy_bucket") == bucket
            and (it.get("status") or "active") == "active"
            and not it.get("archived")
        ]
        assert len(active_items) == bucket_len, (bucket, len(active_items), bucket_len)

    # 5) 状态可序列化且没有指数级膨胀。
    raw = json.dumps(s.data, ensure_ascii=False)
    assert len(raw) < 3_000_000, f"长局 state 过大：{len(raw)} bytes"
