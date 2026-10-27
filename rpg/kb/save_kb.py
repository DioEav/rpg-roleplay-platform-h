"""kb.save_kb — 完整的「存档知识库」DB-resident 引擎(可行性验证版,与现有 blob 平行,不动生产)。

目标(用户拍板):存档状态**完全数据库化**、**单一来源**、是剧本知识库的**运行时态**。
本模块把整坨 GameState.data JSONB blob **完整无遗漏**地拆成 DB 行,并能**无损投影回**等价 state
——「新系统本身先是一个完整的」+ 可行性验证。**完整性靠 by-construction**:每个非瞬态字段都路由到
唯一归宿,materialize 逆向重组;深比对(原 state ∪ 减瞬态)== materialize 结果。

路由(单一来源,blob 退场):
  · 关系(relationships)                 → kb_relationships(from='_player' 或 NPC↔NPC)
  · 离散事实/事件(memory.facts 标 source=memory / world.known_events 标 source=world)→ kb_events
  · 人/物/概念/地点(含玩家 _player)+ 剧本 canon T0 → kb_entities(COW,T0 seed)
  · 对话历史(history)                   → messages 表(已存在;不重复存,单一来源)
  · **其余所有顶层键**(player/world/memory 标量/worldline/scene/encounter/ruleset/dice_log/
    permissions/player_private/player_character/active_entities/turn/session_model/meta)
                                         → kb_worldline_vars(logical_key=顶层键,value=该子树 jsonb)
  · 纯瞬态(last_context*/last_projection/_active_save_id/_turn_images_generated 等)→ 丢弃,非状态

绝不写剧本域(只读 kb_canon_entities);所有写落 save 域 COW 行,born_commit=当前 commit。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from kb import live_repo, t0_seed

log = logging.getLogger(__name__)

# 顶层纯瞬态键:每回合重生/纯运行时指针,不是存档状态 → 不进 KB。
_DROP_TOP = {"_active_save_id", "_turn_images_generated", "history", "relationships"}
# memory 子键里的瞬态(调试缓存)。
_DROP_MEM = {"last_context", "last_retrieval", "last_context_agent", "last_structured_updates"}
# worldline 子键里的瞬态。
_DROP_WL = {"last_projection", "last_validation", "pending_projection"}
# 本次记忆修复：state 里 archived_facts 只保留最近 1000 条；KB 用 afactc（cold）事件
# 保存所有曾进入 state 的归档事实，永不因 state 裁剪而退役，供 query_memory 冷检索。
ARCHIVED_FACTS_STATE_MAX = 1000


def _setvar(db, save_id: int, commit_id: int, key: str, value: Any) -> None:
    live_repo.set_worldline_var(db, save_id, commit_id, key, value=value)


def _vars(db, save_id: int, commit_id: int) -> dict[str, Any]:
    rows = live_repo._newest_visible(db, "kb_worldline_vars", save_id, commit_id, ("logical_key", "value"))
    return {r["logical_key"]: r["value"] for r in rows}


# ── 写:把整坨 blob state 完整拆进 KB(by-construction 不遗漏)──────────────────
def import_state(db, save_id: int, commit_id: int, state_data: dict) -> dict[str, int]:
    n_var = n_rel = n_evt = n_ent = n_skip = 0
    sd = dict(state_data or {})

    # no-op 守卫:每回合全量 re-import,但绝大多数 var/关系/事实并未变 → 若仍逐条 INSERT 新 COW 行,
    # 行数随回合数 ×N 线性爆炸(实测 17 可见键 7 回合=119 行),且 _newest_visible 每读全表扫历史 →
    # 长局退化。读当前可见(继承自父 commit;本 commit 尚未写自有行,故即父态),与待写值 byte 比对,
    # 相同则跳过。跳过一条 byte-相同写【绝不改变】_newest_visible 结果(继承值本就等同),故零正确性风险。
    cur_rel = {
        r["logical_key"]: (r["kind"], r.get("metadata") or {})
        for r in live_repo._newest_visible(db, "kb_relationships", save_id, commit_id,
                                           ("logical_key", "kind", "metadata"))
    }
    cur_evt = {
        r["logical_key"]: r["summary"]
        for r in live_repo._newest_visible(db, "kb_events", save_id, commit_id, ("logical_key", "summary"))
    }
    cur_var = _vars(db, save_id, commit_id)

    # 1) 关系 → kb_relationships
    for npc, rel in (sd.get("relationships") or {}).items():
        kind = rel if isinstance(rel, str) else (rel.get("status") if isinstance(rel, dict) else str(rel))
        kind = str(kind or "neutral")
        meta = rel if isinstance(rel, dict) else {}
        lk = f"_player->{npc}"
        if cur_rel.get(lk) == (kind, meta):
            n_skip += 1
            continue
        live_repo.set_relationship(db, save_id, commit_id, lk,
                                   from_key="_player", to_key=str(npc), kind=kind,
                                   note="", metadata=meta)
        n_rel += 1

    # 2) 事实/事件 → kb_events(分别标 source 以便无损还原 memory.facts vs world.known_events)
    mem = dict(sd.get("memory") or {})
    world = dict(sd.get("world") or {})
    _facts = list(dict.fromkeys(str(f) for f in (mem.get("facts") or []) if f is not None and str(f).strip()))
    # 归档事实索引（本次记忆修复）: 已从 facts 桶移出的远期事实，单独用 afact 事件
    # 写入 kb_events。facts 桶保持精简（注入只看最近 N 条），archived_facts 供
    # episodic/远期召回；materialize 仍还原到 memory.archived_facts，不混回 facts。
    _afacts = list(dict.fromkeys(
        str(f) for f in (mem.get("archived_facts") or []) if f is not None and str(f).strip()))
    # 玩家显式删除的事实（本次记忆修复）：冷归档不能把已删除事实重新召回。
    _deleted = {str(f).strip() for f in (mem.get("facts_deleted") or []) if str(f).strip()}
    _deleted_hashes = {
        str(h).strip() for h in (mem.get("facts_deleted_hashes") or []) if str(h).strip()
    }
    _kevts = list(dict.fromkeys(str(e) for e in (world.get("known_events") or []) if e is not None and str(e).strip()))
    _story_time = str(world.get("time") or "")
    from core.feature_flags import feature_enabled_for_save
    if feature_enabled_for_save("kb_hash_keys", save_id, db):
        # 方案A(哈希键+seq):文本即身份(键=内容哈希,槽位概念消失),seq=插入期一次性
        # 分配的单调序号(非列表位置)→ 中段删除只退役被删行,幸存行零重写,归档窗口期的
        # O(list) COW 写放大归零(index 键制式实测一次 13 删 76 重写)。legacy 位置键可见
        # 行(首次开启/回滚再开启)一次性转换后退役——代价等于一次归档重排,此后快路径。
        n_evt += _import_events_hashed(db, save_id, commit_id, "fact", _facts,
                                       "memory.facts", _story_time, cur_evt)
        n_evt += _import_events_hashed(db, save_id, commit_id, "afact", _afacts,
                                       "memory.archived_facts", _story_time, cur_evt)
        # 冷存储：afactc 用内容哈希键，只写不退休。state 的 archived_facts 满 1000 后
        # 会裁掉最旧条目（afact 事件随之退役），但 afactc 保留原文，query_memory
        # 的 archived scope 可回退到这里检索。
        n_evt += _import_events_hashed(db, save_id, commit_id, "afactc", _afacts,
                                       "memory.archived_facts_cold", _story_time, cur_evt,
                                       keep_orphans=True)
        n_evt += _import_events_hashed(db, save_id, commit_id, "kevt", _kevts,
                                       "world.known_events", _story_time, cur_evt)
    else:
        # legacy(位置键):去重保序(同一文本绝不占多个 fact:{i})。桶收缩/重排后高 index 的
        # 旧 fact:{i} 会变孤儿,不退役就被 materialize 重复读出 → 「事实库重复条目」累积根因。
        for i, summ in enumerate(_facts):
            lk = f"fact:{i}"
            if cur_evt.get(lk) == summ:
                n_skip += 1
                continue
            live_repo.record_event(db, save_id, commit_id, lk, summary=summ,
                                   story_time=_story_time, metadata={"source": "memory.facts"})
            n_evt += 1
        for i, summ in enumerate(_afacts):
            lk = f"afact:{i}"
            if cur_evt.get(lk) == summ:
                n_skip += 1
                continue
            live_repo.record_event(db, save_id, commit_id, lk, summary=summ,
                                   story_time=_story_time, metadata={"source": "memory.archived_facts"})
            n_evt += 1
        # 冷存储（本次记忆修复）：即使 kb_hash_keys 关闭，也单独用内容哈希键写一份
        # afactc，永不退休；legacy afact:{i} 仍按 state 列表裁剪。
        n_evt += _import_events_hashed(db, save_id, commit_id, "afactc", _afacts,
                                       "memory.archived_facts_cold", _story_time, cur_evt,
                                       keep_orphans=True)
        for i, summ in enumerate(_kevts):
            lk = f"kevt:{i}"
            if cur_evt.get(lk) == summ:
                n_skip += 1
                continue
            live_repo.record_event(db, save_id, commit_id, lk, summary=summ,
                                   story_time=_story_time, metadata={"source": "world.known_events"})
            n_evt += 1
        # 退役孤儿 index(桶变短/去重后 index 超界的旧 fact:/kevt: 行)。哈希键行(flag 曾开后
        # 关=回滚)也一并退役:legacy 位置键此刻已重建全量,不清会被 materialize 按文本去重
        # 掩盖但行残留 → 回滚自愈,flag 语义才是真逃生阀。
        for lk in list(cur_evt):
            prefix, _, rest = lk.partition(":")
            if prefix not in ("fact", "afact", "kevt"):
                continue
            if rest.startswith("h:"):
                live_repo.retire_event(db, save_id, commit_id, lk)
                n_evt += 1
                continue
            if not rest.isdigit():
                continue
            idx = int(rest)
            if ((prefix == "fact" and idx >= len(_facts))
                    or (prefix == "afact" and idx >= len(_afacts))
                    or (prefix == "kevt" and idx >= len(_kevts))):
                live_repo.retire_event(db, save_id, commit_id, lk)
                n_evt += 1

    # 玩家明确删除的事实：退役对应的热/冷归档事件，避免冷存储/ episodic 召回
    # 把已删除内容重新带给 GM。facts_deleted 只保留最近 1000 条，足够覆盖
    # 长局中仍可能被检索到的窗口。
    if _deleted or _deleted_hashes:
        for text in _deleted:
            # 哈希键的冷/热事件（无论当前 state 是否还包含该文本，都主动退役一次；
            # retire 幂等，重复调用不会产生新语义）。
            for prefix in ("afactc", "afact"):
                lk = _event_hash_key(prefix, text)
                if lk in cur_evt or text in _afacts:
                    live_repo.retire_event(db, save_id, commit_id, lk)
                    n_evt += 1
        # 文本 tombstone 被裁后，hash tombstone 仍能让冷/热事件退役。
        for h in _deleted_hashes:
            for prefix in ("afactc", "afact"):
                lk = f"{prefix}:h:{h}"
                if lk in cur_evt:
                    live_repo.retire_event(db, save_id, commit_id, lk)
                    n_evt += 1
        # legacy 位置键的 afact:{i} 用内容比对退役。
        for lk, summ in list(cur_evt.items()):
            if lk.startswith("afact:") and summ in _deleted:
                live_repo.retire_event(db, save_id, commit_id, lk)
                n_evt += 1

    # 3) 玩家自身 → kb_entities(_player)
    player = dict(sd.get("player") or {})
    if player.get("name"):
        live_repo.upsert_entity(db, save_id, commit_id, "_player", name=player["name"], type="player",
                                status="live", summary=player.get("background") or "",
                                attrs={"role": player.get("role"), "current_location": player.get("current_location")},
                                origin="player", metadata={})
        n_ent += 1

    # 4) 其余所有顶层键 → kb_worldline_vars(子树作为该键的 value;剥掉已路由/瞬态子键)
    for top, val in sd.items():
        if top in _DROP_TOP:
            continue
        if top == "memory":
            val = {k: v for k, v in (val or {}).items()
                   if k not in _DROP_MEM and k not in ("facts", "archived_facts")}
        elif top == "world":
            val = {k: v for k, v in (val or {}).items() if k != "known_events"}
        elif top == "worldline":
            val = {k: v for k, v in (val or {}).items() if k not in _DROP_WL}
        if top in cur_var and cur_var[top] == val:
            n_skip += 1
            continue
        _setvar(db, save_id, commit_id, top, val)
        n_var += 1

    return {"vars": n_var, "relationships": n_rel, "events": n_evt, "entities": n_ent, "skipped": n_skip}


# 数字感知排序键已下沉到 live_repo(_newest_visible 层统一兜底,v1.69.2);这里保留
# 别名供本模块显式排序与既有测试引用。前科与语义见 live_repo.logical_key_order 文档串。
from kb.live_repo import logical_key_order as _logical_key_order


def _event_hash_key(prefix: str, text: str) -> str:
    """方案A 内容哈希键:文本即身份。sha1[:16] 对去重后的桶(百量级)碰撞概率可忽略。"""
    import hashlib
    return f"{prefix}:h:{hashlib.sha1(text.encode('utf-8')).hexdigest()[:16]}"


def _evt_sort_key(e: dict) -> tuple:
    """事件还原排序:哈希键行按显式 seq(插入序),legacy 位置键行按数字键序。
    混态只会在异常中断时短暂出现(转换与退役同事务),legacy(更旧)排前作兜底。"""
    seq = e.get("seq")
    if seq is not None:
        return (1, "", 0, int(seq), e["logical_key"])
    p, g, i, lk = _logical_key_order(e["logical_key"])
    return (0, p, g, i, lk)


def _import_events_hashed(db, save_id: int, commit_id: int, prefix: str, items: list[str],
                          source: str, story_time: str, cur_evt: dict[str, str],
                          *, keep_orphans: bool = False) -> int:
    """方案A 写路径:增量=只写新文本(seq=全表单调 max+1),删除=只退役被删行;
    可见的 legacy 位置键行不在 want 集 → 随退役循环一次性清除(首次开启的自迁移)。

    keep_orphans=True 用于冷存储 afactc：state 的 archived_facts 只保留最近 1000 条，
    被裁掉的旧文本不能退役 —— 它们正是冷存储要保活的远期事实。
    """
    writes = 0
    want: dict[str, str] = {}
    for t in items:
        want[_event_hash_key(prefix, t)] = t  # dict 保插入序 → 转换时 seq 分配循原列表序
    vis = {lk: s for lk, s in cur_evt.items() if lk.startswith(prefix + ":")}
    next_seq = int(db.execute(
        "select coalesce(max(seq), 0) as m from kb_events where save_id = %s", (save_id,),
    ).fetchone()["m"])
    for lk, text in want.items():
        if vis.get(lk) == text:
            continue
        next_seq += 1
        live_repo.record_event(db, save_id, commit_id, lk, summary=text,
                               story_time=story_time, metadata={"source": source}, seq=next_seq)
        writes += 1
    if not keep_orphans:
        for lk in vis:
            if lk not in want:
                live_repo.retire_event(db, save_id, commit_id, lk)
                writes += 1
    return writes


# ── 读:从 KB 完整投影回等价 state ─────────────────────────────────────────────
def materialize(db, save_id: int, commit_id: int) -> dict[str, Any]:
    v = _vars(db, save_id, commit_id)
    state: dict[str, Any] = {k: val for k, val in v.items()}  # 顶层子树 vars 直接还原

    # 事件层 → 还原 memory.facts / world.known_events(按 source)
    evts = live_repo._newest_visible(db, "kb_events", save_id, commit_id, ("logical_key", "summary", "metadata", "seq"))
    # ⚠️ 按文本去重(保序):事实/事件用 index-keyed logical_key(fact:{i}/kevt:{i}),桶收缩/重排后
    # 高 index 的旧行未退役会残留 → 同一文本落在多个 logical_key 上,_newest_visible 各取一行 →
    # materialize 重复读(群反馈「事实库大量重复条目」,真库 save 268 实测 149 条仅 41 唯一)。这里按
    # summary 去重,让所有存档下次加载即干净;import_state 侧再退役孤儿根治累积(见下)。
    facts, afacts, kevts = [], [], []
    _seen_f: set[str] = set()
    _seen_a: set[str] = set()
    _seen_k: set[str] = set()
    from state.json_ops import is_acceptance_meta
    for e in sorted(evts, key=_evt_sort_key):
        src = (e.get("metadata") or {}).get("source")
        summ = e["summary"]
        # 自愈清洗:历史污染进库的 acceptance 验收元信息条目,还原时直接剥掉
        # (写入闸已堵新增;这里让存量存档下次加载即干净,import_state 随后退役孤儿行)。
        if is_acceptance_meta(summ):
            continue
        if src == "memory.facts" or e["logical_key"].startswith("fact:"):
            if summ not in _seen_f:
                _seen_f.add(summ)
                facts.append(summ)
        elif src == "memory.archived_facts" or e["logical_key"].startswith("afact:"):
            # 归档事实索引（本次记忆修复）: 还原到 memory.archived_facts，不混回 facts。
            if summ not in _seen_a:
                _seen_a.add(summ)
                afacts.append(summ)
        elif src == "memory.archived_facts_cold" or e["logical_key"].startswith("afactc:"):
            # 冷存储只供 query_memory 回退检索，不投影回 state（否则 state 会重新
            # 无界增长，等于把刚裁掉的历史又装回来）。
            continue
        elif summ not in _seen_k:
            _seen_k.add(summ)
            kevts.append(summ)
    # state 只保留最近 1000 条热归档；更早的留在 KB 冷事件里。
    if len(afacts) > ARCHIVED_FACTS_STATE_MAX:
        afacts = afacts[-ARCHIVED_FACTS_STATE_MAX:]
    state.setdefault("memory", {})
    if facts or "memory" in state:
        state["memory"]["facts"] = facts
    if afacts or "memory" in state:
        state["memory"]["archived_facts"] = afacts
    state.setdefault("world", {})
    if kevts or "world" in state:
        state["world"]["known_events"] = kevts
    # 自愈补全:memory 顶层 blob(kb_worldline_vars 整存)里的 notes/pinned/resources/
    # abilities 四桶可能含写入闸补齐(v1.69.2)之前进库的 acceptance 历史污染,还原时
    # 同样剥离(facts/kevts 已在上面按行清洗;这四桶不走 kb_events,得在 blob 里清)。
    _mem = state.get("memory")
    if isinstance(_mem, dict):
        for _bk in ("notes", "pinned", "resources", "abilities"):
            _lst = _mem.get(_bk)
            if isinstance(_lst, list):
                _mem[_bk] = [x for x in _lst if not is_acceptance_meta(x)]

    # 关系层 → 还原 relationships(玩家视角)。metadata 非空=原 dict 关系;空=原字符串关系用 kind 还原。
    # dict 按 born_commit(最后更新的 commit)升序插入 → 键序=更新时序,下游所有
    # 「最近 N 条」窗口(short_summary[-20:]/史官快照[-8:])才有真实语义。此前按
    # logical_key(名字)序重建 + state jsonb 落库不保键序,窗口=按名字字节序的任意子集
    # (实测长局 65 关系只随机可见 20)。
    rels = live_repo._newest_visible(db, "kb_relationships", save_id, commit_id,
                                     ("logical_key", "from_key", "to_key", "kind", "metadata"))
    rels.sort(key=lambda r: int(r.get("born_commit") or 0))
    state["relationships"] = {r["to_key"]: (r["metadata"] if r.get("metadata") else r["kind"])
                              for r in rels if r["from_key"] == "_player"}

    # 历史 → 从【本 commit】的 state_snapshot blob 读(分支正确 + 开场只含 assistant)。
    # 根因(星之游/耀月余辉反馈):messages 表按 (save_id, turn) 存、无分支维度,跨分支共享同一
    # save_id → materialize 直接 `where save_id` 会把【所有分支】的消息都读出来:
    #   ① 切/建分支后老分支的对话没消失(「新建分支又没删除老分支」);
    #   ② 开场把空 player_input 也写进 messages → 顶部出现一条空白玩家气泡(「新建存档顶部空白输入」)。
    # commit blob 按 commit DAG 逐分支隔离、且开场只 append assistant(routes/game.py),是非
    # kb_native 路径一直在读的同一份历史 → 改读它,两个症状一并消除。
    # blob 缺失/无 history 时回退 messages 并滤掉空行(冷迁移/旧档兜底,绝不破历史)。
    history: list[dict[str, Any]] = []
    try:
        crow = db.execute(
            "select state_snapshot from branch_commits where id = %s and save_id = %s",
            (commit_id, save_id),
        ).fetchone()
        snap = crow.get("state_snapshot") if isinstance(crow, dict) else None
        if isinstance(snap, str):
            snap = json.loads(snap)
        if isinstance(snap, dict) and isinstance(snap.get("history"), list):
            history = [
                {"role": m.get("role"), "content": m.get("content")}
                for m in snap["history"]
                if isinstance(m, dict) and str(m.get("content") or "").strip()
            ]
    except Exception:
        history = []
    if not history:
        msgs = db.execute(
            "select role, content from messages where save_id = %s order by turn, id", (save_id,)
        ).fetchall()
        history = [
            {"role": m["role"], "content": m["content"]}
            for m in msgs
            if str(m["content"] or "").strip()
        ]
    state["history"] = history
    state["_history_count"] = len(history)

    # 世界树实体(运行时可见;含 T0 seed)— 供 KB 查询,不属 blob 顶层
    state["_entities_visible"] = len(live_repo._newest_visible(db, "kb_entities", save_id, commit_id, ("logical_key",)))
    return state


def _cold_text_match(text: str, query: str) -> bool:
    """冷归档文本匹配：与 query_memory 同口径（空格分词 AND，大小写不敏感）。"""
    q = str(query or "").strip().lower()
    if not q:
        return True
    t = str(text or "").lower()
    return all(tok in t for tok in q.split())


def _filter_cold_rows(rows: list[dict], query: str, exclude_texts: set[str],
                      limit: int,
                      exclude_hashes: set[str] | None = None) -> list[str]:
    """纯函数：从 afactc 事件行里筛出匹配的文本（新→旧，按 summary 去重）。

    单独拆出来便于单测；DB 读取在 search_archived_cold 里。
    exclude_hashes 对应 memory.facts_deleted_hashes（文本 tombstone 被裁后仍能
    阻止已删除事实从冷存储复活）。
    """
    import hashlib

    _ex_hashes = set(exclude_hashes or set())
    out: list[str] = []
    seen: set[str] = set()
    for r in sorted(rows or [], key=lambda x: int(x.get("seq") or 0), reverse=True):
        lk = str((r or {}).get("logical_key") or "")
        src = ((r or {}).get("metadata") or {}).get("source")
        if not (lk.startswith("afactc:") or src == "memory.archived_facts_cold"):
            continue
        text = str((r or {}).get("summary") or "").strip()
        if not text or text in seen or text in exclude_texts:
            continue
        if _ex_hashes:
            h = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
            if h in _ex_hashes:
                continue
        if not _cold_text_match(text, query):
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= max(1, int(limit)):
            break
    return out


def _fetch_cold_rows_sql(db, save_id: int, commit_id: int, query: str,
                         fetch_limit: int) -> list[dict]:
    """按 save+谱系+afactc 前缀拉冷事件（本次记忆修复）。

    旧实现用 _newest_visible 读取整表再 Python 过滤，长局冷事件几万条时每次
    GM 查询都要全扫。这里把 save_id / born_commit 谱系 / logical_key 前缀
    下推到 SQL，利用 idx_kb_events_key(save_id, logical_key, born_commit)。
    """
    from kb.live_repo import _ANCESTRY

    tokens = [t for t in str(query or "").split() if t][:4]
    params: dict[str, Any] = {
        "commit": int(commit_id),
        "save": int(save_id),
        "fetch": max(1, min(int(fetch_limit), 2000)),
    }
    extra = ""
    for i, tok in enumerate(tokens):
        # psycopg 命名参数 + ILIKE；token 里的 %/_ 作为宽匹配可接受（先粗筛后 Python 精筛）。
        params[f"q{i}"] = f"%{tok}%"
        extra += f" and summary ilike %(q{i})s"
    sql = _ANCESTRY + f"""
    , live as (
        select distinct on (summary) logical_key, summary, metadata, seq
        from kb_events
        where save_id = %(save)s
          and born_commit in (select cid from ancestry)
          and retired_at_commit is null
          and logical_key like 'afactc:%%'
          and coalesce(summary, '') <> ''
          {extra}
        order by summary, seq desc
    )
    select logical_key, summary, metadata, seq
    from live
    order by seq desc
    limit %(fetch)s
    """
    rows = db.execute(sql, params).fetchall() or []
    return [dict(r) for r in rows]


def search_archived_cold(save_id: int, commit_id: int, query: str = "", *,
                         limit: int = 100,
                         exclude_texts: set[str] | None = None,
                         exclude_hashes: set[str] | None = None) -> list[str]:
    """检索 KB 冷归档事实（本次记忆修复）。

    state 的 memory.archived_facts 只保留最近 1000 条；更早的原文以 afactc 事件
    永久保存在 kb_events。query_memory(scope="archived"/"all") 在热结果不足时
    回退到这里，避免“归档满了以后，早期事实从所有检索入口消失”。

    优先走 SQL 下推；fake DB/旧库不支持 ILIKE/命名参数时回退
    live_repo._newest_visible（行为不变）。任何 DB 失败都返回 []，不阻塞 GM。
    """
    if not save_id or not commit_id:
        return []
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            rows = _fetch_cold_rows_sql(
                db, int(save_id), int(commit_id), query,
                max(200, int(limit) * 4),
            )
    except Exception:
        try:
            from kb import live_repo
            from platform_app.db import connect, init_db
            init_db()
            with connect() as db:
                rows = live_repo._newest_visible(
                    db, "kb_events", int(save_id), int(commit_id),
                    ("logical_key", "summary", "metadata", "seq"),
                )
        except Exception as exc:
            log.debug("[save_kb] cold archived search skipped: %s", exc)
            return []
    return _filter_cold_rows(
        list(rows or []), query, set(exclude_texts or set()),
        max(1, int(limit)), set(exclude_hashes or set()))


def count_archived_cold(save_id: int, commit_id: int) -> int:
    """当前分支可见的冷归档事实条数（按 summary 去重，本次记忆修复）。

    永久保留策略下需要容量指标；只在历史面板/调试主动查询时调用，不进每回合热路径。
    """
    if not save_id or not commit_id:
        return 0
    try:
        from kb.live_repo import _ANCESTRY
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            row = db.execute(
                _ANCESTRY + """
                select count(distinct summary) as n
                from kb_events
                where save_id = %(save)s
                  and born_commit in (select cid from ancestry)
                  and retired_at_commit is null
                  and logical_key like 'afactc:%%'
                  and coalesce(summary, '') <> ''
                """,
                {"commit": int(commit_id), "save": int(save_id)},
            ).fetchone()
        return int((row or {}).get("n") or 0)
    except Exception:
        return 0


def seed_full_t0(db, save_id: int, script_id: int, *, commit_id: int | None = None,
                 keys: list[str] | None = None) -> dict[str, Any]:
    """完整 T0 seed:剧本 canon 实体 → 存档 kb_entities(继承字段)。keys=定向/懒。"""
    return t0_seed.seed_save_kb_from_script(db, save_id, script_id, commit_id=commit_id, keys=keys)


# ── 史官:从本回合正文【确定性】维护结构化 KB(实体 encountered + 全部关系)──────────
# 根因修复:GM(flash)只读 KB、不调结构化写工具,LLM 提取器又偶发漏(漏了卡切尔关系)。
# → 不靠 LLM 调工具:确定性扫正文里出现的 canon 实体名/别名,凡出现的 character 一律确保
#   存档关系(_player→NPC),凡出现的实体标 encountered。这样「遇到谁」由代码缝保证,不漏。
def maintain_structured_kb(db, save_id: int, script_id: int, commit_id: int,
                           prose: str, player_name: str = "") -> dict[str, Any]:
    if not prose or not script_id:
        return {"entities": 0, "relationships": 0, "mentioned": []}
    canon = db.execute(
        "select logical_key, name, type, summary, aliases, identity, background, "
        "coalesce(first_revealed_chapter, 0) as frc "
        "from kb_canon_entities where script_id = %s", (int(script_id),)
    ).fetchall()
    # 群反馈(斗破档):GM 从训练数据薅后文角色名(韩枫)当原创路人 → 史官全量扫确证
    # =未来角色被提前标 encountered,且 canon identity(真身份"药老徒弟")进 KB →
    # 下回合材料带真身份=剧透泄漏闭环。确证跟随 GM 输出不能不记(召回需要),但
    # 未揭示实体降级:不抄 identity/background/summary,metadata 标 premature。
    _prog_ch = 0
    try:
        from agents.anchor_seed_agent import get_progress_window as _gpw_kb
        _prog_ch = int((_gpw_kb(save_id, script_id=int(script_id), window_size=12) or {}).get("chapter_min") or 0)
    except Exception:
        _prog_ch = 0
    # 关系只给「无歧义的人」:同名实体若还以非 character 类型出现(如 人造邪神/伟大意志 同时是
    # character 和 concept),多半是势力/概念/怪物而非人 → 不建人际关系(避免误判过捕)。
    _ambiguous = {c["name"] for c in canon if (c.get("type") or "") != "character"}
    # 已有关系目标(不覆盖 GM/提取器已设的更具体 kind)
    existing_rel = {
        r["to_key"] for r in live_repo._newest_visible(
            db, "kb_relationships", save_id, commit_id, ("logical_key", "to_key", "from_key"))
        if r["from_key"] == "_player"
    }
    n_ent = n_rel = 0
    seen_keys: set[str] = set()
    mentioned: list[str] = []
    for c in canon:
        names = [c["name"]] + [a for a in (c.get("aliases") or []) if a]
        names = [n for n in names if isinstance(n, str) and len(n) >= 2]
        if not any(n in prose for n in names):
            continue
        lk = c["logical_key"]
        # 玩家身份保护:canon 实体绝不能覆盖存档的 _player(玩家自己的主角)。若某剧本把原著男主
        # 映射到了 _player 槽,prose 一提及就会把玩家改成原著男主(群反馈)。硬跳过。
        if lk == "_player":
            continue
        if lk in seen_keys:
            continue
        seen_keys.add(lk)
        mentioned.append(c["name"])
        # 标 encountered(运行时实体态,COW 新行覆盖 T0)
        attrs = {"_encountered": True, "_encountered_commit": commit_id}
        _premature = bool(_prog_ch and int(c.get("frc") or 0) > _prog_ch)
        if not _premature:
            for k in ("identity", "background"):
                if c.get(k):
                    attrs[k] = c[k]
        live_repo.upsert_entity(db, save_id, commit_id, lk, name=c["name"],
                                type=(c.get("type") or "entity"), status="live",
                                summary=("" if _premature else (c.get("summary") or "")), attrs=attrs,
                                origin="recorder",
                                metadata={"source": "prose_mention", **({"premature": True} if _premature else {})})
        n_ent += 1
        # character(非玩家本人、非歧义概念/势力)且尚无关系 → 确定性补一条「初识」
        if (c.get("type") or "") == "character" and c["name"] != (player_name or "") \
                and c["name"] not in _ambiguous and c["name"] not in existing_rel:
            live_repo.set_relationship(db, save_id, commit_id, f"_player->{c['name']}",
                                       from_key="_player", to_key=c["name"], kind="初识",
                                       note="本回合正文中出现并交互", metadata={})
            existing_rel.add(c["name"])
            n_rel += 1
    return {"entities": n_ent, "relationships": n_rel, "mentioned": mentioned}
