"""Phase 1/2 记忆生命周期与装配器回归。

覆盖:
  1. 归档移出读路径：provider 不再归档，回合后 maintenance 才归档
  2. 多块归档摘要 + summary_pending 队列
  3. archived_facts 索引
  4. known_events JSON ops 路径统一上限
  5. relationship_meta
  6. 写入时确定性实体/时间标注
  7. MemoryAssembler 的 section 预算 + 查询相关事实召回
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from context_engine._constants import _LAYER_MIN_CHARS, layer_min_chars
from context_providers.base import Demand
from context_providers.memory import MemoryProvider, _maybe_auto_archive
from context_providers.memory_assembler import MemoryAssembler
from schemas.memory import MemorySettings
from state import GameState


class _Svc:
    user_id = None


def _collect(state):
    return MemoryProvider().collect(
        state, manifest=None, demand=None, services=_Svc()
    ).layers[0]["content"]


def test_provider_no_longer_archives_maintenance_does():
    s = GameState({"turn": 60, "memory": {
        "facts": ["旧事实"],
        "items": [{"id": "f1", "kind": "runtime_fact", "text": "旧事实",
                   "turn": 1, "status": "active", "legacy_bucket": "facts"}],
    }})
    # 读 provider 只读：不归档、不改 items
    _collect(s)
    assert "旧事实" in s.data["memory"]["facts"]
    assert not s.data["memory"]["items"][0].get("archived")

    from chat_pipeline.memory_maintenance import run_memory_maintenance
    dbg = run_memory_maintenance(s, None)
    assert dbg["archived"] >= 1
    assert "旧事实" not in s.data["memory"]["facts"]
    assert s.data["memory"]["items"][0].get("archived") is True
    assert "旧事实" in s.data["memory"]["archived_facts"]


def test_multi_chunk_archive_summary_and_queue():
    facts = [f"第{i}轮发生的事实，主角继续向北探索。" for i in range(45)]
    items = [{"id": f"f{i}", "kind": "runtime_fact", "text": t, "turn": i + 1,
              "status": "active", "legacy_bucket": "facts"}
             for i, t in enumerate(facts)]
    s = type("_S", (), {"data": {"turn": 100, "memory": {"facts": facts, "items": items}}})()
    from schemas.memory import MemorySettings
    _maybe_auto_archive(s, MemorySettings())
    mem = s.data["memory"]
    # 45 条 / 每块 20 → 3 条摘要
    assert len(mem["summaries"]) == 3
    pending = mem["summary_pending"]
    assert isinstance(pending, dict)
    assert pending["index"] == 0
    assert [t["index"] for t in (pending.get("queue") or [])] == [1, 2]
    # 队首处理后提升下一个
    from chat_pipeline.memory_summary import _promote_next_pending
    _promote_next_pending(mem)
    assert mem["summary_pending"]["index"] == 1
    assert [t["index"] for t in (mem["summary_pending"].get("queue") or [])] == [2]


def test_known_events_capped_via_json_ops():
    s = GameState.new()
    for i in range(105):
        s.apply_state_write_typed("world.known_events", f"事件{i}", source="gm", append=True)
    events = s.data["world"]["known_events"]
    assert len(events) == 100
    assert events[0] == "事件5"
    assert events[-1] == "事件104"


def test_relationship_meta_records_previous_and_turn():
    s = GameState.new()
    s.data["turn"] = 7
    s.update_relationship("张三", "信任", source="gm:json")
    assert s.data["relationships"]["张三"] == "信任"
    meta = s.data["relationship_meta"]["张三"]
    assert meta["updated_turn"] == 7
    assert meta["previous"] is None
    assert meta["source"] == "gm:json"

    s.data["turn"] = 9
    s.update_relationship("张三", "警惕", source="gm")
    meta2 = s.data["relationship_meta"]["张三"]
    assert meta2["previous"] == "信任"
    assert meta2["updated_turn"] == 9


def test_add_memory_tags_known_characters_and_time():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["player"]["name"] = "李四"
    s.data["world"]["time"] = "第三日清晨"
    s.data["turn"] = 3
    assert s.add_memory("facts", "张三在北港把钥匙交给李四")
    item = next(i for i in s.data["memory"]["items"]
                if i.get("text") == "张三在北港把钥匙交给李四")
    assert "张三" in (item.get("characters") or [])
    assert "李四" in (item.get("characters") or [])
    assert item.get("time_label") == "第三日清晨"


def test_assembler_recalls_older_relevant_fact_by_query():
    s = GameState.new()
    s.data["turn"] = 1
    s.add_memory("facts", "张三在码头把钥匙交给守卫")
    # facts 候选窗口 = max(24, depth×8)=64：写 70 条无关事实，把相关事实挤出
    # 候选池，确保它只能通过「查询召回」进入上下文。
    for i in range(70):
        s.data["turn"] = i + 2
        s.add_memory("facts", f"无关的最近事实{i}")
    from schemas.memory import MemorySettings
    ms = MemorySettings(recall_depth=1, token_budget=1600)
    text, _lines, debug = MemoryAssembler(
        s, ms, demand=Demand(player_intent="张三 钥匙")
    ).build()
    assert "事实：无关的最近事实69" in text
    assert "事实：张三在码头把钥匙交给守卫" not in text
    assert "相关记忆：张三在码头把钥匙交给守卫" in text
    assert debug["recalled_count"] == 1


def test_assembler_recalls_older_relevant_note_too():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["turn"] = 1
    s.add_memory("notes", "张三喜欢在码头交接钥匙")
    # 持久桶候选 = max(40, depth×12)=96：写 100 条把相关笔记挤出候选池，
    # 验证查询召回。
    for i in range(100):
        s.data["turn"] = i + 2
        s.add_memory("notes", f"无关的最近笔记{i}")
    from schemas.memory import MemorySettings
    text, _lines, debug = MemoryAssembler(
        s, MemorySettings(recall_depth=1, token_budget=1600),
        demand=Demand(player_intent="张三 钥匙"),
    ).build()
    assert "相关笔记：张三喜欢在码头交接钥匙" in text
    assert debug["recalled_count"] >= 1


def test_assembler_no_recall_without_query():
    s = GameState.new()
    s.data["turn"] = 1
    s.add_memory("facts", "张三在码头把钥匙交给守卫")
    s.data["turn"] = 2
    s.add_memory("facts", "无关的最近事实")
    from schemas.memory import MemorySettings
    text, _lines, debug = MemoryAssembler(
        s, MemorySettings(recall_depth=1), demand=None
    ).build()
    assert "相关记忆：" not in text
    assert debug["recalled_count"] == 0


def test_assembler_token_used_within_budget():
    s = GameState.new()
    s.data["memory"]["pinned"] = [f"固定{i}" for i in range(10)]
    s.data["memory"]["facts"] = [f"事实{i}" * 20 for i in range(10)]
    s.data["memory"]["notes"] = [f"笔记{i}" for i in range(5)]
    from schemas.memory import MemorySettings
    ms = MemorySettings(token_budget=400)
    text, _lines, debug = MemoryAssembler(s, ms).build()
    assert debug["token_used"] <= ms.token_budget
    assert "固定记忆：" in text
    assert any(sec["id"] == "pinned" and sec["selected"] >= 1
               for sec in debug["sections"])


def test_memory_layer_has_min_context_budget():
    assert layer_min_chars("memory", 4000) >= 1200
    assert _LAYER_MIN_CHARS.get("memory", 0) >= 1200


def test_maintenance_is_wired_in_async_and_sync_paths():
    import inspect

    from chat_pipeline import gm
    src = inspect.getsource(gm)
    assert "run_memory_maintenance" in src
    # async 路径 + sync parity 路径都要有调用（async 走 asyncio.to_thread，
    # 函数名后没有左括号，所以按名字计数）。
    assert src.count("run_memory_maintenance") >= 2
    # async 路径必须在 _ms_task 启动前跑，才能让本轮 pending 被精修
    assert src.find("run_memory_maintenance") < src.find("_ms_task = None")


def test_kb_materialize_splits_archived_facts(monkeypatch):
    """KB 读路径: fact 事件还原到 facts，afact 事件还原到 archived_facts。

    不依赖 DB：monkeypatch _vars / _newest_visible / 分支快照查询。
    """
    import kb.save_kb as sk

    monkeypatch.setattr(sk, "_vars", lambda db, save_id, commit_id: {})

    def _fake_newest(db, table, save_id, commit_id, cols):
        if table == "kb_events":
            return [
                {"logical_key": "fact:0", "summary": "当前事实",
                 "metadata": {"source": "memory.facts"}, "seq": 1, "born_commit": 1},
                {"logical_key": "afact:0", "summary": "远期事实",
                 "metadata": {"source": "memory.archived_facts"}, "seq": 2, "born_commit": 1},
                {"logical_key": "afactc:abc", "summary": "更早的冷归档事实",
                 "metadata": {"source": "memory.archived_facts_cold"}, "seq": 4, "born_commit": 1},
                {"logical_key": "kevt:0", "summary": "已知事件",
                 "metadata": {"source": "world.known_events"}, "seq": 3, "born_commit": 1},
                {"logical_key": "kevtc:h1", "summary": "更早的冷事件",
                 "metadata": {"source": "world.known_events_cold"}, "seq": 5, "born_commit": 1},
            ]
        return []

    monkeypatch.setattr(sk.live_repo, "_newest_visible", _fake_newest)

    class _DB:
        def execute(self, *args, **kwargs):
            return self

        def fetchone(self):
            return {"state_snapshot": {"history": [
                {"role": "assistant", "content": "开场"},
            ]}}

    state = sk.materialize(_DB(), 1, 2)
    assert state["memory"]["facts"] == ["当前事实"]
    assert state["memory"]["archived_facts"] == ["远期事实"]
    # afactc 是冷存储，不应投影回 state，也不应污染 known_events。
    assert "更早的冷归档事实" not in state["memory"]["archived_facts"]
    assert state["world"]["known_events"] == ["已知事件"]
    assert "更早的冷事件" not in state["world"]["known_events"]


def test_hashed_cold_import_does_not_retire_orphans(monkeypatch):
    import kb.save_kb as sk

    recorded, retired = [], []
    monkeypatch.setattr(sk.live_repo, "record_event",
                        lambda *a, **kw: recorded.append((a, kw)))
    monkeypatch.setattr(sk.live_repo, "retire_event",
                        lambda *a, **kw: retired.append((a, kw)))

    class _DB:
        def execute(self, sql, params=None):
            return self

        def fetchone(self):
            return {"m": 0}

    old_key = sk._event_hash_key("afactc", "旧冷事实")
    # keep_orphans=True：旧冷事件不在当前 want 集也不能退役
    sk._import_events_hashed(
        _DB(), 1, 2, "afactc", ["新冷事实"], "memory.archived_facts_cold",
        "", {old_key: "旧冷事实"}, keep_orphans=True)
    assert recorded and not retired
    # keep_orphans=False（热 afact）：旧行照常退役
    sk._import_events_hashed(
        _DB(), 1, 2, "afact", ["新热事实"], "memory.archived_facts",
        "", {sk._event_hash_key("afact", "旧热事实"): "旧热事实"})
    assert retired


def test_cold_archived_sql_uses_prefix_and_query_filter():
    from kb.save_kb import _fetch_cold_rows_sql

    captured = {}

    class _DB:
        def execute(self, sql, params=None):
            captured["sql"] = sql
            captured["params"] = params
            return self

        def fetchall(self):
            return [{"logical_key": "afactc:h1", "summary": "冷事实",
                     "metadata": {"source": "memory.archived_facts_cold"}, "seq": 1}]

    rows = _fetch_cold_rows_sql(_DB(), 7, 9, "冷 事实", 200)
    assert rows[0]["summary"] == "冷事实"
    assert "logical_key like 'afactc:%%'" in captured["sql"]
    assert captured["params"]["save"] == 7 and captured["params"]["commit"] == 9
    assert "summary ilike %(q0)s" in captured["sql"]


def test_cold_filter_respects_deleted_hashes():
    import hashlib

    from kb.save_kb import _filter_cold_rows

    text = "已删除的冷事实"
    h = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
    rows = [{"logical_key": f"afactc:h:{h}", "summary": text,
             "metadata": {"source": "memory.archived_facts_cold"}, "seq": 1}]
    assert _filter_cold_rows(rows, "", set(), 10, {h}) == []


def test_known_events_history_filter_matches_and_dedupes():
    from kb.save_kb import _filter_kevt_rows

    rows = [
        {"logical_key": "kevtc:h1", "summary": "旧港码头发生火灾",
         "metadata": {"source": "world.known_events_cold"}, "seq": 1},
        {"logical_key": "kevtc:h2", "summary": "旧港码头发生火灾",
         "metadata": {"source": "world.known_events_cold"}, "seq": 2},
        {"logical_key": "kevtc:h3", "summary": "王城举行庆典",
         "metadata": {"source": "world.known_events_cold"}, "seq": 3},
        {"logical_key": "kevt:0", "summary": "热事件不应走冷过滤",
         "metadata": {"source": "world.known_events"}, "seq": 4},
    ]
    out = _filter_kevt_rows(rows, "码头 火灾", 10)
    assert out == ["旧港码头发生火灾"]


def test_cold_archived_filter_matches_query_and_dedupes():
    from kb.save_kb import _filter_cold_rows

    rows = [
        {"logical_key": "afactc:h1", "summary": "早期把钥匙藏在旧港码头",
         "metadata": {"source": "memory.archived_facts_cold"}, "seq": 1},
        {"logical_key": "afactc:h2", "summary": "早期把钥匙藏在旧港码头",
         "metadata": {"source": "memory.archived_facts_cold"}, "seq": 2},
        {"logical_key": "afactc:h3", "summary": "银怀表在当铺",
         "metadata": {"source": "memory.archived_facts_cold"}, "seq": 3},
        {"logical_key": "afact:h4", "summary": "热归档不应走冷过滤",
         "metadata": {"source": "memory.archived_facts"}, "seq": 4},
    ]
    out = _filter_cold_rows(rows, "钥匙 码头", {"银怀表在当铺"}, 10)
    assert out == ["早期把钥匙藏在旧港码头"]


# ── 事实 supersede（本次记忆修复）──────────────────────────────────────────

def test_fact_similarity_high_for_same_entity_rephrase():
    from state.core import fact_text_similarity
    assert fact_text_similarity(
        "张三在码头把钥匙交给守卫。",
        "张三在码头把钥匙交给守卫并离开",
    ) >= 0.99
    assert fact_text_similarity("张三在码头把钥匙交给守卫", "张三在北港采购补给") < 0.68


def test_auto_supersede_same_entity_high_overlap():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["turn"] = 1
    assert s.add_memory("facts", "张三在码头把钥匙交给守卫", origin="gm:json")
    s.data["turn"] = 2
    assert s.add_memory("facts", "张三在码头把钥匙交给守卫并离开", origin="gm:json")

    assert "张三在码头把钥匙交给守卫" not in s.data["memory"]["facts"]
    assert "张三在码头把钥匙交给守卫并离开" in s.data["memory"]["facts"]
    old = next(i for i in s.data["memory"]["items"]
               if i.get("text") == "张三在码头把钥匙交给守卫")
    assert old.get("status") == "superseded"
    assert old.get("superseded_by") == "张三在码头把钥匙交给守卫并离开"
    assert any(a.get("kind") == "memory_superseded_auto"
               for a in s.data["permissions"]["audit_log"])


def test_auto_supersede_low_overlap_keeps_both():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["turn"] = 1
    s.add_memory("facts", "张三在码头把钥匙交给守卫", origin="gm:json")
    s.data["turn"] = 2
    s.add_memory("facts", "张三在北港采购补给", origin="gm:json")
    assert "张三在码头把钥匙交给守卫" in s.data["memory"]["facts"]
    assert "张三在北港采购补给" in s.data["memory"]["facts"]


def test_auto_supersede_skips_player_origin():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["turn"] = 1
    s.add_memory("facts", "张三在码头把钥匙交给守卫", origin="gm:json")
    s.data["turn"] = 2
    s.add_memory("facts", "张三在码头把钥匙交给守卫并离开", origin="ui_button")
    assert "张三在码头把钥匙交给守卫" in s.data["memory"]["facts"]


def test_explicit_supersede_op_marks_old_and_adds_new():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["turn"] = 1
    s.add_memory("facts", "张三在码头把钥匙交给守卫", origin="gm:json")
    s.data["turn"] = 2
    updates = s.apply_structured_updates(
        '```json\n[{"op":"supersede","path":"memory.facts",'
        '"old":"张三在码头把钥匙交给守卫","new":"张三把钥匙交给了守卫长"}]\n```'
    )
    assert "张三在码头把钥匙交给守卫" not in s.data["memory"]["facts"]
    assert "张三把钥匙交给了守卫长" in s.data["memory"]["facts"]
    old = next(i for i in s.data["memory"]["items"]
               if i.get("text") == "张三在码头把钥匙交给守卫")
    assert old.get("status") == "superseded"
    assert any("取代" in str(u) for u in updates)


def test_recorder_prompt_and_schema_expose_supersede():
    from agents.recorder import _build_system_prompt, _build_tool_schema
    prompt = _build_system_prompt(frozenset({"ops"}))
    assert '"supersede"' in prompt or "supersede" in prompt
    schema = _build_tool_schema(frozenset({"ops"}), None)
    op_enum = schema["input_schema"]["properties"]["ops"]["items"]["properties"]["op"]["enum"]
    assert "supersede" in op_enum
    assert "old" in schema["input_schema"]["properties"]["ops"]["items"]["properties"]


def test_supersede_rejects_non_fact_bucket_ids():
    s = GameState.new()
    s.add_memory("pinned", "主角已失去左手", origin="gm:json")
    item = next(i for i in s.data["memory"]["items"] if i.get("legacy_bucket") == "pinned")
    assert s.supersede_memory_item(item_id=item["id"]) is False
    assert item.get("status") == "active"
    assert "主角已失去左手" in s.data["memory"]["pinned"]


def test_merge_state_ops_supersede_gm_wins():
    from state.json_ops import merge_state_ops
    gm = [{"op": "supersede", "path": "memory.facts", "old": "A", "new": "B"}]
    rec = [{"op": "supersede", "path": "memory.facts", "old": "A", "new": "C"}]
    assert merge_state_ops(gm, rec) == gm


def test_supersede_respects_read_only_pending():
    s = GameState.new()
    s.data["relationships"] = {"张三": "信任"}
    s.data["turn"] = 1
    s.add_memory("facts", "张三在码头把钥匙交给守卫", origin="gm:json")
    s.data["permissions"]["mode"] = "read_only"
    s.data["turn"] = 2
    s.apply_structured_updates(
        '```json\n[{"op":"supersede","path":"memory.facts",'
        '"old":"张三在码头把钥匙交给守卫","new":"张三把钥匙交给了守卫长"}]\n```'
    )
    # 未审批:旧事实仍在,新事实未写
    assert "张三在码头把钥匙交给守卫" in s.data["memory"]["facts"]
    pending = [p for p in s.data["permissions"]["pending_writes"] if p.get("op") == "supersede"]
    assert pending, "read_only 下 supersede 应入 pending"
    # 审批后落地
    s.approve_pending_write(id=pending[0]["id"])
    assert "张三在码头把钥匙交给守卫" not in s.data["memory"]["facts"]
    assert "张三把钥匙交给了守卫长" in s.data["memory"]["facts"]


def test_archive_summary_includes_compact_metadata():
    from context_providers.memory import _append_scan_summary

    mem = {"summaries": []}
    _append_scan_summary(mem, [{
        "text": "把钥匙藏进木箱",
        "turn": 12,
        "characters": ["张三"],
        "location": "旧港码头",
        "time_label": "第三日夜晚",
    }])
    assert "人物：张三" in mem["summaries"][0]
    assert "地点：旧港码头" in mem["summaries"][0]
    assert "时间：第三日夜晚" in mem["summaries"][0]
    assert "张三" in mem["summary_pending"]["texts"][0]


# ── 篇章级 arc rollup（本次记忆修复 Phase 3）────────────────────────────────

def _phase(i, summary, events=None):
    return {
        "phase_index": i, "status": "closed",
        "turn_start": i * 30 + 1, "turn_end": (i + 1) * 30,
        "summary": summary, "key_events": events or [],
        "key_npcs": [{"name": "张三"}], "key_locations": ["北港"],
    }


def test_build_arc_entries_groups_and_skips_open():
    from chat_pipeline.arc_summary import build_arc_entries
    phases = [_phase(i, f"第{i}阶段剧情") for i in range(7)]
    phases.append({"phase_index": 7, "status": "open", "summary": "进行中"})
    arcs = build_arc_entries(phases, group_size=5)
    assert len(arcs) == 2
    assert arcs[0]["phase_start"] == 0 and arcs[0]["phase_end"] == 4
    assert arcs[1]["phase_start"] == 5 and arcs[1]["phase_end"] == 6
    assert arcs[0]["text"].startswith("第1-5阶段")
    assert "第0阶段剧情" in arcs[0]["text"]
    assert "进行中" not in "".join(a["text"] for a in arcs)


def test_arc_prefers_latest_phases_and_keeps_decisions_npcs_locations():
    from chat_pipeline.arc_summary import build_arc_entries

    phases = []
    for i in range(5):
        p = _phase(i, f"第{i}阶段剧情" * 30)
        p["key_decisions"] = [{"turn": i * 30 + 5,
                               "choice": f"玩家在阶段{i}选择帮助张三",
                               "consequence": "张三欠下人情"}]
        phases.append(p)
    phases[-1]["emotion_arc"] = "紧张 → 坚定"
    text = build_arc_entries(phases, group_size=5)[0]["text"]
    # 最新 phase 必须保留；最老的 phase 在预算不足时可以让位。
    assert "第4阶段剧情" in text
    assert "第0阶段剧情" not in text
    assert "选择:" in text
    assert "人物：" in text and "地点：" in text
    assert "心境：" in text


def test_assembler_injects_arc_summaries():
    s = GameState.new()
    s.data["memory"]["arc_summaries"] = [{
        "arc_index": 0, "phase_start": 0, "phase_end": 4,
        "turn_start": 1, "turn_end": 150,
        "text": "第1-5阶段：主角离开村庄，抵达北港，结识张三。",
    }]
    from schemas.memory import MemorySettings
    text, _lines, debug = MemoryAssembler(s, MemorySettings()).build()
    assert "篇章：第1-5阶段" in text
    assert any(sec["id"] == "arc" and sec["selected"] == 1
               for sec in debug["sections"])


def test_refresh_arc_summaries_throttles(monkeypatch):
    import platform_app.db as db_mod
    from chat_pipeline.arc_summary import refresh_arc_summaries

    calls = {"n": 0}

    class _FakeDB:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, *args, **kwargs):
            calls["n"] += 1
            return self

        def fetchall(self):
            # 7 个 closed phase：最近 4 个（3-6）由 runtime_phase_digests 注入，
            # arc 只应汇总 0-2，避免同一段历史重复出现。
            return [
                {"phase_index": i, "turn_start": i * 30 + 1, "turn_end": (i + 1) * 30,
                 "summary": f"第{i}阶段", "key_events": [], "key_npcs": [],
                 "key_locations": [], "status": "closed"}
                for i in range(7)
            ]

    monkeypatch.setattr(db_mod, "connect", lambda: _FakeDB())
    s = GameState.new()
    s.data["turn"] = 100
    assert refresh_arc_summaries(s, 1) == 1
    assert calls["n"] == 1
    arcs = s.data["memory"]["arc_summaries"]
    assert len(arcs) == 1
    assert arcs[0]["phase_end"] == 2, arcs
    # 节流窗口内不查 DB
    s.data["turn"] = 105
    assert refresh_arc_summaries(s, 1) == 0
    assert calls["n"] == 1
    # 超过窗口后重新查
    s.data["turn"] = 111
    assert refresh_arc_summaries(s, 1) in (0, 1)
    assert calls["n"] == 2


# ── per-save 记忆设置（本次记忆修复）──────────────────────────────────────

def test_effective_memory_settings_override_and_validation(monkeypatch):
    import platform_app.settings as settings_mod
    from schemas.memory import MemorySettings

    monkeypatch.setattr(settings_mod, "get_memory_settings",
                        lambda uid: MemorySettings(token_budget=1000, recall_depth=5))
    eff = settings_mod.get_effective_memory_settings(1, {
        "memory_settings": {
            "token_budget": 2000,
            "recall_depth": 3,
            "bucket_world_enabled": False,
            "not_a_field": 1,
            "pinned_max": 9999,  # 非法 → 丢弃，回落全局默认
        }
    })
    assert eff.token_budget == 2000
    assert eff.recall_depth == 3
    assert eff.bucket_world_enabled is False
    assert eff.pinned_max == MemorySettings().pinned_max


def test_provider_uses_per_save_settings(monkeypatch):
    import platform_app.settings as settings_mod
    from schemas.memory import MemorySettings

    monkeypatch.setattr(settings_mod, "get_memory_settings",
                        lambda uid: MemorySettings(token_budget=1600, recall_depth=5))
    s = GameState.new()
    # 本次记忆修复：recall_depth 已不是硬上限（候选池另有下限），改用桶开关验证
    # per-save override 仍然真正生效。
    s.data["memory_settings"] = {"bucket_world_enabled": False}
    s.data["memory"]["facts"] = ["旧事实", "最新事实"]
    text = _collect(s)
    assert "事实：最新事实" not in text
    assert "事实：旧事实" not in text


def test_pressure_archive_limits_active_facts():
    """高密度事实：超过 facts_soft_limit 时按最旧优先归档，避免中程断层。"""
    facts = [f"第{i}回合的事实" for i in range(1, 151)]
    items = [
        {"id": f"f{i}", "kind": "runtime_fact", "text": f"第{i}回合的事实",
         "turn": i, "status": "active", "legacy_bucket": "facts"}
        for i in range(1, 151)
    ]
    s = GameState({"turn": 160, "memory": {"facts": facts, "items": items}})
    ms = MemorySettings(
        summary_window=10, auto_archive_after_turns=200, facts_soft_limit=80)
    _maybe_auto_archive(s, ms)
    active = [i for i in s.data["memory"]["items"]
              if i.get("legacy_bucket") == "facts" and i.get("status") == "active"
              and not i.get("archived")]
    assert len(active) == 80
    assert s.data["memory"]["facts"][0] == "第71回合的事实"
    assert len(s.data["memory"]["archived_facts"]) == 70


def test_age_archive_uses_inclusive_threshold():
    """turn=50、current=100、阈值=50 应归档（旧 < 判断会漏掉边界）。"""
    s = GameState({"turn": 100, "memory": {
        "facts": ["边界事实"],
        "items": [{"id": "f1", "kind": "runtime_fact", "text": "边界事实",
                   "turn": 50, "status": "active", "legacy_bucket": "facts"}],
    }})
    _maybe_auto_archive(s, MemorySettings(
        summary_window=10, auto_archive_after_turns=50, facts_soft_limit=80))
    assert s.data["memory"]["items"][0].get("archived") is True


def test_world_bucket_disabled_pauses_archive():
    s = GameState({"turn": 100, "memory": {
        "facts": [f"事实{i}" for i in range(100)],
        "items": [{"id": f"f{i}", "kind": "runtime_fact", "text": f"事实{i}",
                   "turn": i + 1, "status": "active", "legacy_bucket": "facts"}
                  for i in range(100)],
    }})
    _maybe_auto_archive(s, MemorySettings(
        summary_window=10, auto_archive_after_turns=10,
        facts_soft_limit=20, bucket_world_enabled=False))
    assert all(not i.get("archived") for i in s.data["memory"]["items"])


def test_archive_does_not_remove_readded_fact_with_same_text():
    """旧归档条目与重新添加的同文事实不能发生文本碰撞。"""
    s = GameState({"turn": 60, "memory": {
        "facts": ["钥匙在桌上"],
        "items": [
            {"id": "old", "kind": "runtime_fact", "text": "钥匙在桌上",
             "turn": 1, "status": "active", "legacy_bucket": "facts"},
            {"id": "new", "kind": "runtime_fact", "text": "钥匙在桌上",
             "turn": 55, "status": "active", "legacy_bucket": "facts"},
        ],
    }})
    _maybe_auto_archive(s, MemorySettings())
    assert "钥匙在桌上" in s.data["memory"]["facts"], "新添加的同文事实被旧归档条目误删"
    assert s.data["memory"]["items"][0].get("archived") is True
    assert not s.data["memory"]["items"][1].get("archived")
    # 同文事实仍 active 时不能进远期归档索引，否则 KB 会同时写 fact/afact 重复事件。
    assert "钥匙在桌上" not in (s.data["memory"].get("archived_facts") or [])


def test_hypotheses_are_not_auto_archived():
    s = GameState({"turn": 60, "memory": {
        "items": [{"id": "h1", "kind": "hypothesis", "text": "管家可能是凶手",
                   "turn": 1, "status": "active"}],
    }})
    _maybe_auto_archive(s, MemorySettings())
    assert not s.data["memory"]["items"][0].get("archived")


def test_summary_pending_queue_is_bounded():
    """summary_llm 关闭/持续失败时队首不消费，队列必须有上限，避免长局状态无界增长。"""
    from context_providers.memory import _PENDING_QUEUE_MAX, _append_scan_summary

    mem = {"summaries": [], "summary_pending": {"index": 0, "texts": ["占位"]}}
    for i in range(_PENDING_QUEUE_MAX + 5):
        _append_scan_summary(
            mem,
            [{"text": f"第{i}条旧事实", "turn": i + 1}],
            queue_pending=True,
        )
    assert len(mem["summary_pending"].get("queue") or []) == _PENDING_QUEUE_MAX


def test_assembler_uses_budget_beyond_recall_depth():
    """候选窗口放大后，短事实应能用到远多于 recall_depth 的预算。"""
    s = GameState({"turn": 100, "memory": {
        "facts": [f"第{i}条事实" for i in range(100)],
    }})
    text, lines, dbg = MemoryAssembler(s, MemorySettings()).build()
    selected = len([ln for ln in lines if ln.startswith("事实：")])
    assert selected > 20, f"预算充足时只注入了 {selected} 条，候选窗口仍然过窄"
    assert dbg["token_used"] > 200


def test_assembler_keeps_newest_facts_on_tight_budget():
    """预算紧张时从最新条目开始装填，不能把刚发生的事实丢掉。"""
    s = GameState({"turn": 50, "memory": {
        "facts": [f"第{i}条事实：" + "很长的细节内容" * 5 for i in range(20)],
    }})
    text, lines, dbg = MemoryAssembler(
        s, MemorySettings(token_budget=200, recall_depth=8)
    ).build()
    assert "第19条事实" in text
    assert "第0条事实" not in text
    assert dbg["token_used"] <= 200


def test_token_estimate_factor_changes_budget_selection():
    s = GameState({"turn": 100, "memory": {
        "facts": [f"第{i}条事实" + "细节" * 20 for i in range(100)],
    }})
    _, lines1, dbg1 = MemoryAssembler(
        s, MemorySettings(token_estimate_factor=1.0)
    ).build()
    _, lines2, dbg2 = MemoryAssembler(
        s, MemorySettings(token_estimate_factor=2.0)
    ).build()
    n1 = len([ln for ln in lines1 if ln.startswith("事实：")])
    n2 = len([ln for ln in lines2 if ln.startswith("事实：")])
    assert n2 < n1, (n1, n2)
    assert dbg2["token_estimate_factor"] == 2.0
    assert dbg2["token_used"] > dbg1["token_used"]


def test_persistent_buckets_are_not_cut_to_recall_depth():
    s = GameState({"turn": 100, "memory": {
        "notes": [f"玩家手记{i}" for i in range(20)],
        "abilities": [f"能力{i}" for i in range(20)],
        "resources": [f"资源{i}" for i in range(20)],
    }})
    text, lines, _ = MemoryAssembler(s, MemorySettings()).build()
    assert len([ln for ln in lines if ln.startswith("笔记：")]) == 20
    assert len([ln for ln in lines if ln.startswith("能力：")]) == 20
    assert len([ln for ln in lines if ln.startswith("资源：")]) == 20


def test_memory_write_records_location_scene_and_phase():
    s = GameState({
        "turn": 3,
        "player": {"current_location": "旧港码头"},
        "scene": {"location_id": "dock_01", "module_id": "mod_1"},
        "world": {"timeline": {"current_phase": "第一章·暗流"}},
    })
    s.add_memory("facts", "把钥匙藏进木箱")
    item = next(i for i in s.data["memory"]["items"]
                if i.get("text") == "把钥匙藏进木箱")
    assert item["location"] == "旧港码头"
    assert item["scene_id"] == "dock_01"
    assert item["phase_label"] == "第一章·暗流"


def test_memory_index_rebuilds_on_write_and_powers_recall():
    from context_providers.memory_index import get_memory_index

    s = GameState({"turn": 1, "relationships": {"张三": "信任"}})
    s.add_memory("facts", "张三在码头藏钥匙", origin="gm:json")
    idx1 = get_memory_index(s, s.data["memory"])
    assert idx1 is not None
    assert idx1.by_character.get("张三")
    # 写入后 rev 变化，索引必须重建并包含新条目
    s.add_memory("facts", "李四在客栈留下银票", origin="gm:json")
    idx2 = get_memory_index(s, s.data["memory"])
    assert idx2.rev != idx1.rev
    assert idx2.item_count == idx1.item_count + 1
    assert any("银票" in str(s.data["memory"]["items"][i].get("text"))
               for i in range(idx2.item_count)
               if i in idx2.by_gram.get("银票", set()))


def test_recall_by_current_location_when_query_has_no_names():
    """玩家说“我回到这里看看”时，按当前地点召回旧事实。"""
    s = GameState({
        "turn": 1,
        "player": {"current_location": "旧港码头"},
        "scene": {"location_id": "dock_01"},
    })
    s.add_memory("facts", "把钥匙藏进木箱")
    # 中间 70 条写在别处，避免它们也带上“旧港码头”地点标签、抢走召回 top-k。
    s.data["player"]["current_location"] = "北境雪原"
    for i in range(70):
        s.data["turn"] = i + 2
        s.add_memory("facts", f"无关的最近事实{i}")
    # 离开再回来：当前地点回到旧港码头，但候选窗口里已经没有藏钥匙那条。
    s.data["player"]["current_location"] = "旧港码头"
    text, lines, dbg = MemoryAssembler(
        s, MemorySettings(), demand=Demand(player_intent="我回到这里看看")
    ).build()
    assert "相关记忆：把钥匙藏进木箱" in text
    assert dbg["recalled_count"] >= 1


def test_low_signal_continue_does_not_trigger_location_recall():
    s = GameState({
        "turn": 1,
        "player": {"current_location": "旧港码头"},
    })
    s.add_memory("facts", "把钥匙藏进木箱")
    for i in range(70):
        s.data["turn"] = i + 2
        s.add_memory("facts", f"无关的最近事实{i}")
    text, _, dbg = MemoryAssembler(
        s, MemorySettings(), demand=Demand(player_intent="继续")
    ).build()
    assert dbg["recalled_count"] == 0
    assert "相关记忆：把钥匙藏进木箱" not in text


# ── 统一记忆桶写入（set/overwrite 不得产生僵尸事实）────────────────────────
def test_bucket_replace_supersedes_removed_and_creates_new_items():
    s = GameState({"turn": 10, "relationships": {"张三": "信任"}})
    s.add_memory("facts", "张三把钥匙藏在码头", origin="gm:json")
    s.add_memory("facts", "张三欠李四一百金", origin="gm:json")

    applied = s.apply_state_write_typed(
        "memory.facts", ["张三已离开码头"], source="gm:json")
    assert applied.startswith("状态写入：")

    status = {i["text"]: (i.get("status"), i.get("supersede_reason"))
              for i in s.data["memory"]["items"]}
    assert status["张三把钥匙藏在码头"] == ("superseded", "bucket_replace")
    assert status["张三欠李四一百金"] == ("superseded", "bucket_replace")
    assert status["张三已离开码头"][0] == "active"

    # 被移除的旧事实不能再通过查询召回回到 prompt。
    text, _, _ = MemoryAssembler(
        s, MemorySettings(), demand=Demand(retrieval_query="张三把钥匙藏在哪里")
    ).build()
    assert "事实：张三已离开码头" in text
    assert "相关记忆：张三把钥匙藏在码头" not in text


def test_bucket_replace_revives_archived_fact_and_clears_archive_index():
    s = GameState({"turn": 30, "memory": {
        "facts": [],
        "archived_facts": ["旧城门已经关闭"],
        "items": [{"id": "a1", "kind": "runtime_fact", "text": "旧城门已经关闭",
                   "turn": 5, "status": "active", "archived": True,
                   "legacy_bucket": "facts"}],
    }})
    ok, _ = s.replace_memory_bucket("facts", ["旧城门已经关闭"])
    assert ok
    assert s.data["memory"]["facts"] == ["旧城门已经关闭"]
    item = s.data["memory"]["items"][0]
    assert item["archived"] is False and item["status"] == "active"
    assert "旧城门已经关闭" not in s.data["memory"]["archived_facts"]


def test_bucket_replace_filters_acceptance_and_dedupes():
    s = GameState({"turn": 1})
    ok, _ = s.replace_memory_bucket(
        "facts",
        ["有效事实", "有效事实", "acceptance 本轮跳过：已验证"],
    )
    assert ok
    assert s.data["memory"]["facts"] == ["有效事实"]
    assert len([i for i in s.data["memory"]["items"] if i["status"] == "active"]) == 1


def test_remove_memory_records_deleted_fact_tombstone():
    s = GameState({"turn": 5, "memory": {
        "facts": ["待删除事实"],
        "items": [{"id": "f1", "kind": "runtime_fact", "text": "待删除事实",
                   "turn": 1, "status": "active", "legacy_bucket": "facts"}],
    }})
    s.remove_memory("facts", 0)
    assert "待删除事实" in s.data["memory"]["facts_deleted"]
    # 重新添加同文事实应清掉 tombstone，否则冷归档会永久排除它。
    s.add_memory("facts", "待删除事实")
    assert "待删除事实" not in s.data["memory"]["facts_deleted"]


def test_remove_memory_removes_extra_drifted_items():
    """桶里只剩一条同文时，items 里多出来的 active 副本也应一起删掉。"""
    s = GameState({"turn": 5, "memory": {
        "facts": ["重复事实"],
        "items": [
            {"id": "x1", "kind": "runtime_fact", "text": "重复事实", "turn": 1,
             "status": "active", "legacy_bucket": "facts"},
            {"id": "x2", "kind": "runtime_fact", "text": "重复事实", "turn": 2,
             "status": "active", "legacy_bucket": "facts"},
        ],
    }})
    s.remove_memory("facts", 0)
    assert s.data["memory"]["facts"] == []
    assert [i for i in s.data["memory"]["items"]
            if i.get("legacy_bucket") == "facts" and i.get("status") == "active"] == []


def test_edit_memory_backfills_item_for_legacy_only_entry():
    s = GameState({"turn": 5, "memory": {"facts": ["只有 legacy 的旧事实"]}})
    assert s.edit_memory("facts", 0, "编辑后的旧事实")
    assert s.data["memory"]["facts"] == ["编辑后的旧事实"]
    active = [i for i in s.data["memory"]["items"] if i["status"] == "active"]
    assert [i["text"] for i in active] == ["编辑后的旧事实"]
    assert active[0]["legacy_bucket"] == "facts"


def test_reconcile_backfills_characters_for_old_items():
    s = GameState({
        "turn": 5,
        "relationships": {"张三": "信任"},
        "memory": {
            "facts": ["张三把钥匙藏在码头"],
            "items": [{"id": "f1", "kind": "runtime_fact",
                       "text": "张三把钥匙藏在码头", "turn": 2,
                       "status": "active", "legacy_bucket": "facts"}],
        },
    })
    s.reconcile_memory_items()
    item = next(i for i in s.data["memory"]["items"] if i["id"] == "f1")
    assert "张三" in (item.get("characters") or [])


def test_explicit_supersede_matches_normalized_old_text():
    s = GameState({"turn": 10, "relationships": {"张三": "信任"}})
    s.add_memory("facts", "张三在码头把钥匙弄丢了", origin="gm:json")
    # 旧文本带标点差异，精确匹配会失败；归一化唯一匹配应成功
    ok = s.supersede_memory_item(
        old_text="张三，在码头把钥匙弄丢了。",
        new_text="张三把钥匙交给了守卫",
        source="gm:json",
    )
    assert ok
    assert "张三在码头把钥匙弄丢了" not in s.data["memory"]["facts"]
    assert "张三把钥匙交给了守卫" in s.data["memory"]["facts"]


def test_explicit_supersede_new_text_does_not_chain_auto_supersede():
    """显式 supersede 的 new 不应再自动取代另一条相似事实。"""
    s = GameState({"turn": 10, "relationships": {"张三": "信任"}})
    s.add_memory("facts", "张三在码头把钥匙弄丢了", origin="gm:json")
    s.add_memory("facts", "张三在码头把钥匙交给了守卫", origin="gm:json")
    # 显式取代第一条，new 与第二条高度相似；skip_auto_supersede 必须保护第二条。
    ok = s.supersede_memory_item(
        old_text="张三在码头把钥匙弄丢了",
        new_text="张三在码头把钥匙交给了守卫队长",
        source="gm:json",
    )
    assert ok
    status = {i["text"]: i.get("status") for i in s.data["memory"]["items"]}
    assert status["张三在码头把钥匙交给了守卫"] == "active"
    assert status["张三在码头把钥匙交给了守卫队长"] == "active"


def test_auto_supersede_scans_beyond_recent_120_items():
    s = GameState({"turn": 1, "relationships": {"张三": "信任"}})
    s.add_memory("facts", "张三在码头把钥匙弄丢了", origin="gm:json")
    # 130 条无关 item 把旧事实挤出“最近 120 条”窗口
    for i in range(130):
        s.add_memory_item(text=f"无关事实条目{i}", kind="runtime_fact",
                          source="test", legacy_bucket="facts")
        s.data["memory"]["facts"].append(f"无关事实条目{i}")
    s.data["turn"] = 20
    s.add_memory("facts", "张三在码头把钥匙弄丢了并大声呼喊", origin="gm:json")
    status = {i["text"]: i.get("status") for i in s.data["memory"]["items"]}
    assert status["张三在码头把钥匙弄丢了"] == "superseded"


def test_reconcile_canonicalizes_existing_characters_and_throttles(monkeypatch):
    import kb.alias as alias_mod

    monkeypatch.setattr(
        alias_mod, "canonical_name_for_save",
        lambda save_id, name: "云韵" if name == "云芝" else name,
    )
    s = GameState({
        "turn": 5,
        "_active_save_id": 123,
        "relationships": {"云韵": "信任"},
        "memory": {
            "facts": ["云芝把药交给玩家"],
            "items": [{"id": "f1", "kind": "runtime_fact", "text": "云芝把药交给玩家",
                       "turn": 1, "status": "active", "legacy_bucket": "facts",
                       "characters": ["云芝"]}],
        },
    })
    s.reconcile_memory_items()
    item = next(i for i in s.data["memory"]["items"] if i["id"] == "f1")
    assert item["characters"] == ["云韵"]
    assert item["characters_scanned_turn"] == 5
    # 节流窗口内不重复扫描
    s.data["turn"] = 10
    s.reconcile_memory_items()
    assert item["characters_scanned_turn"] == 5


def test_query_memory_characters_filter_uses_alias(monkeypatch):
    import json

    import kb.alias as alias_mod
    from tools_dsl.command_tools_queries import _t_query_memory

    monkeypatch.setattr(
        alias_mod, "canonical_name_for_save",
        lambda save_id, name: "云韵" if name == "云芝" else name,
    )
    s = GameState({
        "turn": 5,
        "_active_save_id": 123,
        "memory": {"items": [{
            "id": "f1", "kind": "runtime_fact", "text": "云芝把药交给玩家",
            "turn": 1, "status": "active", "legacy_bucket": "facts",
            "characters": ["云芝"],
        }], "facts": ["云芝把药交给玩家"]},
    })
    out = json.loads(_t_query_memory(s, {"characters": ["云韵"]}))
    assert any(x["id"] == "f1" for x in out)


def test_memory_characters_canonicalizes_alias(monkeypatch):
    import kb.alias as alias_mod

    monkeypatch.setattr(
        alias_mod, "canonical_name_for_save",
        lambda save_id, name: "云韵" if name == "云芝" else name,
    )
    s = GameState({
        "turn": 1,
        "_active_save_id": 123,
        "relationships": {"云芝": "信任"},
        "memory": {},
    })
    chars = s._memory_characters_for("云芝把药交给了玩家")
    assert "云韵" in chars and "云芝" not in chars


# ── query_memory 主动检索（文本/归档/摘要/篇章/分页）──────────────────────
def test_query_memory_text_search_reaches_old_items_and_archived():
    import json

    from tools_dsl.command_tools_queries import _t_query_memory

    items = [
        {"id": f"m{i}", "kind": "runtime_fact", "text": f"第{i}条无关事实",
         "turn": i, "status": "active", "legacy_bucket": "facts"}
        for i in range(300)
    ]
    items.insert(0, {
        "id": "old", "kind": "runtime_fact", "text": "早期把钥匙藏在旧港码头",
        "turn": 1, "status": "active", "legacy_bucket": "facts",
    })
    s = GameState({
        "turn": 300,
        "memory": {
            "facts": [i["text"] for i in items],
            "items": items,
            "archived_facts": ["更早的银怀表在当铺"],
            "summaries": ["第1-10轮：玩家在旧港拿到银怀表"],
            "arc_summaries": [{"arc_index": 0, "phase_start": 0, "phase_end": 4,
                               "turn_start": 1, "turn_end": 10,
                               "text": "第一章：旧港码头的钥匙交易"}],
        },
    })
    # 300 条 items 之后仍能按文本查到第 1 条（旧实现只扫 items[-200:]）
    active = json.loads(_t_query_memory(s, {"query": "钥匙", "scope": "active"}))
    assert any(x["id"] == "old" for x in active)

    archived = json.loads(_t_query_memory(s, {"query": "银怀表", "scope": "archived"}))
    assert archived[0]["source"] == "archived_facts"

    summaries = json.loads(_t_query_memory(s, {"query": "银怀表", "scope": "summaries"}))
    assert summaries[0]["kind"] == "summary"

    arcs = json.loads(_t_query_memory(s, {"query": "钥匙", "scope": "arc"}))
    assert arcs[0]["kind"] == "arc"

    all_hits = json.loads(_t_query_memory(s, {"query": "钥匙", "scope": "all", "limit": 100}))
    assert {x["kind"] for x in all_hits} >= {"runtime_fact", "arc"}


def test_query_memory_status_filter_and_all_dedupe():
    import json

    from tools_dsl.command_tools_queries import _t_query_memory

    s = GameState({"turn": 5, "memory": {
        "facts": ["当前事实"],
        "items": [
            {"id": "a", "kind": "runtime_fact", "text": "当前事实", "turn": 1,
             "status": "active", "legacy_bucket": "facts"},
            {"id": "b", "kind": "runtime_fact", "text": "旧版本事实", "turn": 2,
             "status": "superseded", "legacy_bucket": "facts"},
        ],
        "summaries": ["当前事实"],
    }})
    superseded = json.loads(_t_query_memory(s, {"status": "superseded", "scope": "archived"}))
    assert [x["id"] for x in superseded] == ["b"]
    archived_raw = _t_query_memory(s, {"status": "archived"})
    assert archived_raw == "(无匹配)" or all(
        x.get("archived") for x in json.loads(archived_raw))
    # all scope 下同一文本只在第一个 scope 出现一次
    all_hits = json.loads(_t_query_memory(s, {"query": "当前事实", "scope": "all"}))
    assert len([x for x in all_hits if x["text"] == "当前事实"]) == 1


def test_query_memory_archived_falls_back_to_cold(monkeypatch):
    import json

    import tools_dsl.command_tools_queries as q

    monkeypatch.setattr(
        q, "_memory_query_cold_archived",
        lambda state, query, limit, exclude: [{
            "id": None, "kind": "runtime_fact", "text": "冷归档里的钥匙",
            "turn": None, "time_label": None, "characters": None,
            "legacy_bucket": "facts", "source": "kb_archived_cold",
            "archived": True, "status": "active",
        }],
    )
    s = GameState({"turn": 5, "memory": {
        "facts": [], "items": [], "archived_facts": [],
    }})
    out = json.loads(q._t_query_memory(s, {"query": "钥匙", "scope": "archived"}))
    assert any(x["source"] == "kb_archived_cold" for x in out)


def test_query_memory_paginates_and_reads_legacy_only():
    import json

    from tools_dsl.command_tools_queries import _t_query_memory

    s = GameState({"turn": 5, "memory": {
        "facts": ["legacy 独有钥匙线索"],
        "items": [
            {"id": "a", "kind": "runtime_fact", "text": "钥匙在甲处", "turn": 1,
             "status": "active", "legacy_bucket": "facts"},
            {"id": "b", "kind": "runtime_fact", "text": "钥匙在乙处", "turn": 2,
             "status": "active", "legacy_bucket": "facts"},
        ],
    }})
    page1 = json.loads(_t_query_memory(s, {"query": "钥匙", "limit": 2, "offset": 0}))
    page2 = json.loads(_t_query_memory(s, {"query": "钥匙", "limit": 2, "offset": 2}))
    assert len(page1) == 2
    assert len(page2) >= 1
    texts = {x["text"] for x in page1 + page2}
    assert "legacy 独有钥匙线索" in texts


def test_validate_memory_settings_patch_reports_errors():
    from platform_app.settings import validate_memory_settings_patch_with_errors

    clean, errors = validate_memory_settings_patch_with_errors({
        "recall_depth": 3,
        "token_budget": 99,      # < 200
        "bucket_world_enabled": False,
        "not_a_field": 1,
    })
    assert clean == {"recall_depth": 3, "bucket_world_enabled": False}
    assert "token_budget" in errors
    assert "200" in errors["token_budget"] or "greater" in errors["token_budget"].lower()
    assert errors["not_a_field"] == "未知设置项"


def test_restore_superseded_and_archived_facts():
    s = GameState({"turn": 10, "relationships": {"张三": "信任"}})
    s.add_memory("facts", "张三把钥匙藏在码头", origin="gm:json")
    superseded_id = next(i["id"] for i in s.data["memory"]["items"]
                         if i["text"] == "张三把钥匙藏在码头")
    s.supersede_memory_item(old_text="张三把钥匙藏在码头",
                            new_text="张三把钥匙交给了守卫", source="gm:json")
    # 恢复旧版本会与当前新版本冲突：先要求确认，确认后才 supersede 当前版本。
    ok, info = s.restore_memory_item_ex(item_id=superseded_id)
    assert not ok and info.get("needs_confirmation")
    assert any("交给了守卫" in c["text"] for c in info["conflicts"])
    ok, info = s.restore_memory_item_ex(
        item_id=superseded_id, supersede_conflicts=True)
    assert ok and info.get("superseded_conflicts") == 1
    restored = next(i for i in s.data["memory"]["items"] if i["id"] == superseded_id)
    assert restored["status"] == "active" and not restored.get("archived")
    assert "张三把钥匙藏在码头" in s.data["memory"]["facts"]
    assert "张三把钥匙交给了守卫" not in s.data["memory"]["facts"]

    # archived_facts 只有文本、没有 item 的旧归档也能恢复。
    s.data["memory"]["archived_facts"] = ["更早的银怀表在当铺"]
    assert s.restore_memory_item(bucket="facts", text="更早的银怀表在当铺")
    assert "更早的银怀表在当铺" in s.data["memory"]["facts"]
    assert "更早的银怀表在当铺" not in s.data["memory"]["archived_facts"]
    assert any(i["text"] == "更早的银怀表在当铺" and i["status"] == "active"
               for i in s.data["memory"]["items"])


def test_reconcile_orphans_duplicate_active_items():
    s = GameState({"turn": 12, "memory": {
        "facts": ["同一条事实"],
        "items": [
            {"id": "f1", "kind": "runtime_fact", "text": "同一条事实", "turn": 1,
             "status": "active", "legacy_bucket": "facts"},
            {"id": "f2", "kind": "runtime_fact", "text": "同一条事实", "turn": 2,
             "status": "active", "legacy_bucket": "facts"},
        ],
    }})
    out = s.reconcile_memory_items()
    assert out["orphaned"] == 1
    active = [i for i in s.data["memory"]["items"] if i["status"] == "active"]
    assert len(active) == 1


def test_reconcile_backfills_legacy_and_orphans_missing_items():
    s = GameState({"turn": 12, "memory": {
        "facts": ["legacy 独有事实"],
        "archived_facts": ["legacy 独有事实"],
        "notes": ["玩家手记"],
        "items": [
            {"id": "n1", "kind": "runtime_fact", "text": "玩家手记", "turn": 2,
             "status": "active", "legacy_bucket": "notes"},
            {"id": "f1", "kind": "runtime_fact", "text": "已被覆盖的僵尸事实", "turn": 3,
             "status": "active", "legacy_bucket": "facts"},
        ],
    }})
    out = s.reconcile_memory_items()
    assert out["backfilled"] == 1
    assert out["orphaned"] == 1
    texts = {i["text"]: i for i in s.data["memory"]["items"]}
    assert texts["legacy 独有事实"]["status"] == "active"
    assert texts["legacy 独有事实"]["legacy_bucket"] == "facts"
    assert "legacy 独有事实" not in s.data["memory"]["archived_facts"]
    assert texts["已被覆盖的僵尸事实"]["status"] == "orphaned"

    # 幂等：第二次不应再补建/孤立。
    out2 = s.reconcile_memory_items()
    assert out2["backfilled"] == 0 and out2["orphaned"] == 0


def test_items_prune_keeps_active_and_drops_oldest_history():
    s = GameState({"turn": 1, "memory": {"items": []}})
    items = s.data["memory"]["items"]
    # 200 条 archived 历史 + 400 条 active（超过 500 上限）
    for i in range(200):
        items.append({"id": f"a{i}", "text": f"归档{i}", "status": "active",
                      "archived": True, "legacy_bucket": "facts"})
    for i in range(400):
        items.append({"id": f"x{i}", "text": f"活跃{i}", "status": "active"})
    s._prune_memory_items(items)
    active = [i for i in items if not i.get("archived")]
    archived = [i for i in items if i.get("archived")]
    assert len(active) == 400, "active 条目不能被数量上限砍掉"
    assert len(archived) == 100, "只应保留最新的 100 条非 active 历史"
