"""
command_tools_queries.py — task 87 Phase 3: B 类只读查询工具。

让 LLM 主动检索上下文,而不是被动接受静态 prompt 摘要。

scope 划分:
  global  : 无作用域要求 (list_models, list_tools)
  user    : 当前用户的资源 (list_my_personas, list_my_character_cards)
  script  : 当前剧本的资源 (get_chapter_facts, list_script_npcs)
  save    : 当前 save 状态 (query_memory, get_current_scene, get_user_variables)

所有工具不写 state,只读;允许所有 origin 调用。
"""
from __future__ import annotations

import json
from typing import Any

from tools_dsl.command_dispatcher import ToolSpec, get_registry

# task 48: console_assistant 是 user-driven agent,所有 read 工具都对它开放
_READ_ANY_ORIGIN = frozenset({
    "ui_button", "api_direct", "llm_set", "llm_chat", "mcp_call", "console_assistant",
})


# ── save 级 (读 GameState) ──────────────────────────────


def _t_get_game_state(state: Any, args: dict) -> str:
    fields = args.get("fields") or []
    if not isinstance(fields, list):
        fields = []
    d = state.data
    snapshot = {
        "turn": d.get("turn"),
        "player": d.get("player", {}),
        "world": {
            "time": (d.get("world") or {}).get("time"),
            "timeline": {
                "current_label": ((d.get("world") or {}).get("timeline") or {}).get("current_label"),
                "current_phase": ((d.get("world") or {}).get("timeline") or {}).get("current_phase"),
                "user_set_jump_turn": ((d.get("world") or {}).get("timeline") or {}).get("user_set_jump_turn"),
            },
            "known_events": (d.get("world") or {}).get("known_events", [])[-10:],
        },
        "relationships": d.get("relationships", {}),
        "memory": {
            "main_quest": (d.get("memory") or {}).get("main_quest"),
            "current_objective": (d.get("memory") or {}).get("current_objective"),
            "mode": (d.get("memory") or {}).get("mode"),
        },
    }
    if fields:
        snapshot = {k: v for k, v in snapshot.items() if k in set(fields)}
    return json.dumps(snapshot, ensure_ascii=False, indent=2)


def _memory_query_text_match(text: Any, query: str) -> bool:
    """query_memory 的文本匹配（本次记忆修复）。

    中文用空格分词没有意义，所以按“所有空白分隔 token 都出现在文本里”处理：
      · "钥匙" → 命中包含钥匙的条目；
      · "张三 钥匙" → 两个词都要命中（AND），比单关键词更可控。
    大小写不敏感，不做分词/embedding，保证确定性、零外部依赖。
    """
    q = str(query or "").strip().lower()
    if not q:
        return True
    t = str(text or "").lower()
    return all(tok in t for tok in q.split())


def _memory_query_real_items(state: Any, *, scope: str) -> list[dict]:
    """按 scope 收集真实 items（active/archived）。"""
    items = (state.data.get("memory") or {}).get("items") or []
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    # 新→旧返回：GM 主动查记忆通常先关心最近发生的事；分页 offset 也按这个顺序。
    for it in reversed(items):
        if not isinstance(it, dict):
            continue
        archived = bool(it.get("archived"))
        status = it.get("status") or "active"
        if scope == "active":
            if archived or status != "active":
                continue
        else:
            # archived scope = 归档/已取代/孤立/已拒绝的历史；active 且未归档的当前
            # 条目不混进来（否则 scope=archived 会返回整个当前记忆库）。
            if not archived and status == "active":
                continue
            if status not in ("active", "superseded", "orphaned", "rejected"):
                continue
        out.append(it)
    return out


def _memory_query_synthetic_legacy(state: Any) -> list[dict]:
    """旧存档里只有 legacy 桶、没有 items 的条目（本次记忆修复）。

    正常路径 add_memory 会 dual-write；但历史档/手工修档可能存在 legacy-only。
    query_memory 如果只读 items，GM 会误以为这些记忆不存在。这里按文本补成
    伪 item（id=None），让查询和分页仍能覆盖；真正的补建交给回合后的
    reconcile_memory_items。
    """
    mem = (state.data.get("memory") or {})
    items = mem.get("items") or []
    active_keys: set[tuple[str, str]] = set()
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            if (it.get("status") or "active") != "active" or it.get("archived"):
                continue
            b = str(it.get("legacy_bucket") or "")
            t = str(it.get("text") or "").strip()
            if b and t:
                active_keys.add((b, t))
    out: list[dict] = []
    for bucket in ("facts", "notes", "pinned", "abilities", "resources"):
        raw_list = mem.get(bucket)
        if not isinstance(raw_list, list):
            continue
        for raw in raw_list:
            text = str(raw or "").strip()
            if not text or (bucket, text) in active_keys:
                continue
            out.append({
                "id": None,
                "kind": "runtime_fact",
                "text": text,
                "turn": 0,
                "time_label": None,
                "characters": None,
                "legacy_bucket": bucket,
                "source": "legacy_only",
            })
    return out


def _memory_query_cold_archived(state: Any, query: str, limit: int,
                                exclude_texts: set[str]) -> list[dict]:
    """从 KB 冷归档（afactc）回退检索远期事实（本次记忆修复）。

    state 的 archived_facts 只保留最近 1000 条；更早原文在 kb_events 的 afactc
    事件里。这里按当前 save 的 active commit 做分支隔离查询；DB 不可用/无 save
    时返回空，不影响 GM 工具调用。
    """
    data = getattr(state, "data", None)
    if not isinstance(data, dict):
        return []
    save_id = data.get("_active_save_id")
    if not save_id:
        return []
    try:
        from platform_app.db import connect
        with connect() as db:
            row = db.execute(
                "select active_commit_id from game_saves where id=%s",
                (int(save_id),),
            ).fetchone()
        commit_id = int((row or {}).get("active_commit_id") or 0)
        if not commit_id:
            return []
        from kb.save_kb import search_archived_cold
        mem = data.get("memory") or {}
        texts = search_archived_cold(
            int(save_id), commit_id, query,
            limit=max(1, min(int(limit), 200)),
            exclude_texts=exclude_texts,
            exclude_hashes=set(mem.get("facts_deleted_hashes") or ()),
        )
        if texts:
            try:
                state._bump_memory_stat("cold_queries")
            except Exception:
                pass
    except Exception:
        return []
    return [{
        "id": None,
        "kind": "runtime_fact",
        "text": text,
        "turn": None,
        "time_label": None,
        "characters": None,
        "legacy_bucket": "facts",
        "source": "kb_archived_cold",
        "archived": True,
        "status": "active",
    } for text in texts]


def _t_query_memory(state: Any, args: dict) -> str:
    kind = (args.get("kind") or "").strip() or None
    characters = args.get("characters") or []
    time_label = (args.get("time_label") or "").strip() or None
    query = str(args.get("query") or "").strip()
    scope = str(args.get("scope") or "active").strip().lower()
    if scope not in {"active", "archived", "summaries", "arc", "all"}:
        scope = "active"
    status_filter = str(args.get("status") or "").strip().lower()
    if status_filter not in {"active", "superseded", "orphaned", "rejected", "archived"}:
        status_filter = ""
    try:
        offset = max(0, int(args.get("offset") or 0))
    except (TypeError, ValueError):
        offset = 0
    try:
        limit = max(1, min(int(args.get("limit") or 20), 100))
    except (TypeError, ValueError):
        limit = 20
    mem = (state.data.get("memory") or {})
    _save_id = state.data.get("_active_save_id")
    # 本次记忆修复：characters 过滤做一次别名归一（云芝 → 云韵）。旧 item 可能
    # 仍存着化名，GM 用主名查询时不能直接判空。
    char_filters = {str(c).strip() for c in (characters or []) if str(c).strip()}

    def _norm_chars(vals) -> set[str]:
        out = {str(c).strip() for c in (vals or []) if str(c).strip()}
        if out and _save_id:
            try:
                from kb.alias import canonical_name_for_save
                out |= {canonical_name_for_save(_save_id, c) or c for c in list(out)}
            except Exception:
                pass
        return out

    char_filters = _norm_chars(char_filters) if char_filters else set()

    def _matches_item(it: dict) -> bool:
        if kind and it.get("kind") != kind:
            return False
        if status_filter:
            if status_filter == "archived":
                if not it.get("archived"):
                    return False
            elif (it.get("status") or "active") != status_filter:
                return False
        if char_filters:
            it_chars = _norm_chars(it.get("characters") or [])
            if not (char_filters & it_chars):
                return False
        if time_label and it.get("time_label") != time_label:
            return False
        return _memory_query_text_match(it.get("text"), query)

    def _real_scope(which: str) -> list[dict]:
        out_items: list[dict] = []
        for it in _memory_query_real_items(state, scope=which):
            if not _matches_item(it):
                continue
            out_items.append({
                "id": it.get("id"),
                "kind": it.get("kind"),
                "text": it.get("text"),
                "turn": it.get("turn"),
                "time_label": it.get("time_label"),
                "characters": it.get("characters"),
                "location": it.get("location"),
                "phase_label": it.get("phase_label"),
                "legacy_bucket": it.get("legacy_bucket"),
                "source": it.get("source"),
                "archived": bool(it.get("archived")),
                "status": it.get("status") or "active",
            })
        return out_items

    def _archived_scope() -> list[dict]:
        out_items = _real_scope("archived")
        # archived_facts 索引：某些旧档 item 已被 500 上限裁掉，但原文还在索引/KB。
        seen = {str(x.get("text") or "") for x in out_items}
        arch = mem.get("archived_facts")
        if isinstance(arch, list):
            for text in reversed(arch):
                text = str(text or "").strip()
                if not text or text in seen:
                    continue
                if not _memory_query_text_match(text, query):
                    continue
                if kind and kind != "runtime_fact":
                    continue
                if characters or time_label:
                    continue  # 索引没有实体/时间元数据
                out_items.append({
                    "id": None,
                    "kind": "runtime_fact",
                    "text": text,
                    "turn": None,
                    "time_label": None,
                    "characters": None,
                    "legacy_bucket": "facts",
                    "source": "archived_facts",
                    "archived": True,
                    "status": "active",
                })
                seen.add(text)
        # 冷归档回退（本次记忆修复）：热数据不足时查 KB afactc，覆盖 state 1000 条
        # 上限之外的远期事实。characters/time_label 过滤对冷数据无意义，直接跳过。
        remaining = max(0, offset + limit - len(out_items))
        if (remaining > 0 and not char_filters and not time_label
                and status_filter in ("", "active", "archived")
                and (not kind or kind == "runtime_fact")):
            exclude = set(seen)
            exclude.update(str(t or "").strip() for t in (mem.get("facts") or []))
            exclude.update(str(t or "").strip() for t in (mem.get("facts_deleted") or []))
            for it in (mem.get("items") or []):
                if isinstance(it, dict) and (it.get("status") or "active") == "active":
                    exclude.add(str(it.get("text") or "").strip())
            out_items.extend(_memory_query_cold_archived(
                state, query, remaining, exclude))
        return out_items

    def _summary_scope() -> list[dict]:
        out_items: list[dict] = []
        summaries = mem.get("summaries")
        if isinstance(summaries, list):
            for i, text in enumerate(reversed(summaries)):
                text = str(text or "").strip()
                if text and _memory_query_text_match(text, query):
                    out_items.append({
                        "id": None,
                        "kind": "summary",
                        "text": text,
                        "index": len(summaries) - 1 - i,
                        "source": "memory.summaries",
                    })
        return out_items

    def _arc_scope() -> list[dict]:
        out_items: list[dict] = []
        arcs = mem.get("arc_summaries")
        if isinstance(arcs, list):
            for a in reversed(arcs):
                if not isinstance(a, dict):
                    continue
                text = str(a.get("text") or "").strip()
                if not text or not _memory_query_text_match(text, query):
                    continue
                out_items.append({
                    "id": None,
                    "kind": "arc",
                    "text": text,
                    "arc_index": a.get("arc_index"),
                    "phase_start": a.get("phase_start"),
                    "phase_end": a.get("phase_end"),
                    "turn_start": a.get("turn_start"),
                    "turn_end": a.get("turn_end"),
                    "source": "memory.arc_summaries",
                })
        return out_items

    # ── 按 scope 汇总 ────────────────────────────────────────────────────
    if scope == "active":
        out = _real_scope("active") + [
            it for it in _memory_query_synthetic_legacy(state) if _matches_item(it)
        ]
    elif scope == "archived":
        out = _archived_scope()
    elif scope == "summaries":
        out = _summary_scope()
    elif scope == "arc":
        out = _arc_scope()
    else:  # all
        out = (_real_scope("active") + _archived_scope()
               + _summary_scope() + _arc_scope())
        if status_filter:
            # summaries/arc 没有 item status，带 status 过滤时不混入。
            out = [x for x in out if x.get("kind") not in ("summary", "arc")]

    # 跨 scope 去重：同一文本可能同时是 active fact、summary 源、arc 片段；
    # 保持首次出现（active 优先）并对齐分页。
    _seen_text: set[str] = set()
    _deduped: list[dict] = []
    for _it in out:
        _text = str(_it.get("text") or "")
        if _text and _text in _seen_text:
            continue
        if _text:
            _seen_text.add(_text)
        _deduped.append(_it)
    out = _deduped

    if offset:
        out = out[offset:]
    out = out[:limit]
    if not out:
        return "(无匹配)"
    return json.dumps(out, ensure_ascii=False, indent=2)


def _t_get_user_variables(state: Any, args: dict) -> str:
    variables = (state.data.get("worldline") or {}).get("user_variables") or {}
    if not variables:
        return "(无 user_variables)"
    out = {k: v.get("value") for k, v in variables.items()}
    return json.dumps(out, ensure_ascii=False, indent=2)


def _t_get_current_scene(state: Any, args: dict) -> str:
    scene = state.data.get("scene") or {}
    enc = state.data.get("encounter") or {}
    return json.dumps({
        "module_id": scene.get("module_id"),
        "location_id": scene.get("location_id"),
        "visible_clues": scene.get("visible_clues"),
        "exits": scene.get("exits"),
        "encounter_active": enc.get("active"),
        "active_entities": state.data.get("active_entities", []),
    }, ensure_ascii=False, indent=2)


def _t_get_known_events(state: Any, args: dict) -> str:
    events = (state.data.get("world") or {}).get("known_events") or []
    limit = int(args.get("limit") or 20)
    return json.dumps(events[-limit:], ensure_ascii=False, indent=2)


def _t_list_relationships(state: Any, args: dict) -> str:
    rels = state.data.get("relationships") or {}
    return json.dumps(rels, ensure_ascii=False, indent=2)


def _t_get_pending_questions(state: Any, args: dict) -> str:
    qs = (state.data.get("permissions") or {}).get("pending_questions") or []
    return json.dumps(qs, ensure_ascii=False, indent=2)


def _t_get_pending_writes(state: Any, args: dict) -> str:
    pws = (state.data.get("permissions") or {}).get("pending_writes") or []
    return json.dumps(pws, ensure_ascii=False, indent=2)


def _t_recent_audit_log(state: Any, args: dict) -> str:
    limit = int(args.get("limit") or 10)
    kind_filter = (args.get("kind") or "").strip() or None
    audit = (state.data.get("permissions") or {}).get("audit_log") or []
    if kind_filter:
        audit = [a for a in audit if a.get("kind") == kind_filter]
    return json.dumps(audit[-limit:], ensure_ascii=False, indent=2)


# ── user 级 (读 DB) ─────────────────────────────────────


def _t_list_my_personas(user_id: int, args: dict) -> str:
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            rows = db.execute(
                "select id, name, identity as role, personality, is_default "
                "from character_cards where user_id = %s and card_type = 'persona' "
                "order by updated_at desc limit 30",
                (user_id,),
            ).fetchall() or []
        return json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2) if rows else "(无 persona)"
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


def _t_list_my_character_cards(user_id: int, args: dict) -> str:
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            rows = db.execute(
                "select id, name, identity, personality, enabled "
                "from character_cards where user_id = %s and card_type = 'pc' "
                "order by updated_at desc limit 50",
                (user_id,),
            ).fetchall() or []
        return json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2) if rows else "(无 card)"
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


def _t_get_my_usage(user_id: int, args: dict) -> str:
    days = int(args.get("days") or 30)
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            rows = db.execute(
                "select date_trunc('day', created_at) as day, "
                "sum(input_tokens) as in_t, sum(output_tokens) as out_t, count(*) as n "
                "from llm_usage_log where user_id = %s and created_at > now() - %s::interval "
                "group by day order by day desc limit 30",
                (user_id, f"{days} days"),
            ).fetchall() or []
        return json.dumps([dict(r) for r in rows], ensure_ascii=False, default=str, indent=2)
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


# ── script 级 (读剧本数据) ──────────────────────────────


def _t_list_scripts(user_id: int, args: dict) -> str:
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            rows = db.execute(
                "select id, title, chapter_count, word_count from scripts "
                "where owner_id = %s "
                "order by updated_at desc limit 50",
                (user_id,),
            ).fetchall() or []
        return json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2) if rows else "(无 script)"
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


def _user_can_read_script(db, sid: int, user_id: int) -> bool:
    """剧本读权限:owner 或订阅者。防 LLM 用任意 script_id 跨用户读他人私有剧本(章节/NPC)。

    权威谓词收敛到 platform_app.perms.script_readable(owner ∪ subscription),此处保留
    同名壳(被 tests 的 patch-where-used 锚定)+ int(sid) 强转位置与异常行为。
    """
    from platform_app.perms import script_readable
    return bool(script_readable(db, int(sid), user_id))


def _t_get_script_chapters(user_id: int, script_id: int | None, args: dict, state: Any) -> str:
    sid = script_id or args.get("script_id")
    if not sid:
        return "失败: script_id 必填"
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            if not _user_can_read_script(db, int(sid), user_id):
                return f"失败 (权限): 剧本 #{int(sid)} 不属于当前用户或未订阅"
            # summary 权威源是 chapter_facts(提取流程写入,列名 chapter);script_chapters
            # 从无 summary 列(旧查询 100% UndefinedColumn)。LEFT JOIN 保留全量章节(标题/序
            # 来自权威的 script_chapters,未提取的章节不丢),summary 有则补、无则空串。
            rows = db.execute(
                "select sc.chapter_index, sc.title, coalesce(cf.summary, '') as summary "
                "from script_chapters sc "
                "left join chapter_facts cf "
                "  on cf.script_id = sc.script_id and cf.chapter = sc.chapter_index "
                "where sc.script_id = %s order by sc.chapter_index limit 200",
                (int(sid),),
            ).fetchall() or []
        return json.dumps([dict(r) for r in rows[:50]], ensure_ascii=False, indent=2)
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


def _t_list_script_npcs(user_id: int, script_id: int | None, args: dict, state: Any) -> str:
    """列出剧本的 NPC 角色卡(精简清单)。

    历史 bug:之前查的是 v28 起已不存在的 `script_character_cards` 表 + `summary` 列,
    在线上 100% UndefinedTable 抛错 → LLM「提取不到 NPC 角色卡」。NPC 卡的权威表是
    `character_cards`(card_type='npc',按 script_id 归属)。这里只返回挑卡所需的精简字段;
    要完整人设(背景/外貌/性格/语气/范例对白)走 get_script_character_card。
    """
    sid = script_id or args.get("script_id")
    if not sid:
        return "失败: script_id 必填"
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            if not _user_can_read_script(db, int(sid), user_id):
                return f"失败 (权限): 剧本 #{int(sid)} 不属于当前用户或未订阅"
            rows = db.execute(
                "select id, name, full_name, identity, importance, "
                "       first_revealed_chapter, "
                "       (avatar_path is not null and avatar_path <> '') as has_avatar "
                "from character_cards "
                "where script_id = %s and card_type = 'npc' and coalesce(enabled, true) "
                "order by importance desc nulls last, name "
                "limit 80",
                (int(sid),),
            ).fetchall() or []
        if not rows:
            return (
                f"(剧本 #{int(sid)} 暂无 NPC 角色卡。可能该剧本尚未提取/生成角色卡——"
                "可让用户在剧本编辑器里生成,或用 get_script_chapters / get_chapter_facts 看剧情自行勾勒。)"
            )
        return json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2, default=str)
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


def _t_get_script_character_card(user_id: int, script_id: int | None, args: dict, state: Any) -> str:
    """读取剧本内某张 NPC 角色卡的完整人设(先用 list_script_npcs 拿 id)。"""
    sid = script_id or args.get("script_id")
    card_id = args.get("card_id")
    if not sid:
        return "失败: script_id 必填"
    if not card_id:
        return "失败: card_id 必填(先调 list_script_npcs 拿到角色卡 id)"
    try:
        from platform_app import knowledge as _know
        card = _know.get_character_card(user_id, int(sid), int(card_id))
        if not card:
            return f"失败: 剧本 #{int(sid)} 内找不到角色卡 #{int(card_id)}"
        return json.dumps(card, ensure_ascii=False, indent=2, default=str)
    except ValueError as exc:
        return f"失败 (权限): {exc}"
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


# ── global 级 ───────────────────────────────────────────


def _t_list_available_tools(args: dict) -> str:
    """元工具: LLM 自查当前工具表。"""
    origin = (args.get("origin") or "").strip()
    reg = get_registry()
    if origin:
        tools = reg.list_for_origin(origin)
    else:
        tools = reg.list_all()
    # SEC(I-1): 不向 LLM 暴露 origins / destructive 元数据 —— 这是攻击面地图(便于设计注入链)。
    # 仅返回 name/description/scope 供自发现;破坏性工具本就被 dispatcher 从 llm_chat 硬阻。
    out = [
        {
            "name": t.name,
            "description": t.description,
            "scope": t.scope,
        }
        for t in tools
    ]
    return json.dumps(out, ensure_ascii=False, indent=2)


def _t_list_modules(args: dict) -> str:
    try:
        import modules as _modules
        cat = _modules.list_modules() if hasattr(_modules, "list_modules") else []
        return json.dumps(cat, ensure_ascii=False, indent=2)
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


def _t_list_available_models(args: dict) -> str:
    try:
        from model_registry import load_model_catalog
        cat = load_model_catalog() or {}
        # 只暴露简略信息,避免 prompt 爆炸
        apis = cat.get("apis") or []
        return json.dumps(
            [{"id": a.get("id"), "kind": a.get("kind"),
              "models": [m.get("id") for m in a.get("models") or []][:8]}
             for a in apis[:12]],
            ensure_ascii=False, indent=2,
        )
    except Exception as exc:
        return f"失败: {type(exc).__name__}: {exc}"


# ── 注册 ─────────────────────────────────────────────────


def register_query_tools() -> None:
    registry = get_registry()
    save_specs = [
        ("get_game_state",
         "返回当前 save 状态的精简快照: turn/player/world/relationships/memory 概要。"
         "fields 可选,只返指定一级 key。",
         {"type": "object", "properties": {
             "fields": {"type": "array", "items": {"type": "string"}}}},
         _t_get_game_state),
        ("query_memory",
         "按文本 / kind / characters / time_label / scope 检索记忆。"
         "scope=active 查当前生效；archived 查归档与已取代历史；summaries 查压缩概要；"
         "arc 查篇章汇总；all 查全部。文本 query 按空白分词 AND 匹配。",
         {"type": "object", "properties": {
             "query": {"type": "string",
                       "description": "关键词（中文直接写，多个词用空格分隔，全部命中才返回）"},
             "scope": {"type": "string",
                       "enum": ["active", "archived", "summaries", "arc", "all"],
                       "default": "active"},
             "kind": {"type": "string",
                      "enum": ["canon_fact", "runtime_fact", "hypothesis", "user_constraint"]},
             "status": {"type": "string",
                        "enum": ["active", "superseded", "orphaned", "rejected", "archived"],
                        "description": "按 item 状态过滤；archived=仅已归档条目"},
             "characters": {"type": "array", "items": {"type": "string"}},
             "time_label": {"type": "string"},
             "offset": {"type": "integer", "default": 0, "minimum": 0},
             "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
         }},
         _t_query_memory),
        ("get_user_variables",
         "返回 worldline.user_variables 当前键值对。",
         {"type": "object", "properties": {}},
         _t_get_user_variables),
        ("get_current_scene",
         "返回当前 scene/encounter/active_entities 快照。",
         {"type": "object", "properties": {}},
         _t_get_current_scene),
        ("get_known_events",
         "返回最近的 world.known_events。",
         {"type": "object", "properties": {"limit": {"type": "integer"}}},
         _t_get_known_events),
        ("list_relationships",
         "返回 relationships dict。",
         {"type": "object", "properties": {}},
         _t_list_relationships),
        ("get_pending_questions",
         "返回当前 pending_questions。",
         {"type": "object", "properties": {}},
         _t_get_pending_questions),
        ("get_pending_writes",
         "返回当前 pending_writes (待审批的状态写入)。",
         {"type": "object", "properties": {}},
         _t_get_pending_writes),
        ("recent_audit_log",
         "返回最近的 audit_log,可按 kind 过滤。",
         {"type": "object", "properties": {
             "kind": {"type": "string"},
             "limit": {"type": "integer", "default": 10},
         }},
         _t_recent_audit_log),
    ]
    for name, desc, schema, exec_ in save_specs:
        if not registry.has(name):
            registry.register(ToolSpec(
                name=name, description=desc, input_schema=schema,
                executor=exec_, scope="save", origins=_READ_ANY_ORIGIN,
            ))

    user_specs = [
        ("list_my_personas", "列出当前用户的 persona。",
         {"type": "object", "properties": {}}, _t_list_my_personas),
        ("list_my_character_cards", "列出当前用户的角色卡。",
         {"type": "object", "properties": {}}, _t_list_my_character_cards),
        ("get_my_usage", "返回最近 N 天的 LLM token 消耗。",
         {"type": "object", "properties": {"days": {"type": "integer", "default": 30}}},
         _t_get_my_usage),
        ("list_scripts", "列出当前用户可见的剧本。",
         {"type": "object", "properties": {}}, _t_list_scripts),
    ]
    for name, desc, schema, exec_ in user_specs:  # type: ignore[assignment]
        if not registry.has(name):
            registry.register(ToolSpec(
                name=name, description=desc, input_schema=schema,
                executor=exec_, scope="user", origins=_READ_ANY_ORIGIN,
            ))

    script_specs = [
        ("get_script_chapters",
         "列出剧本的章节目录。可不带 script_id 时从 save 派生。",
         {"type": "object", "properties": {"script_id": {"type": "integer"}}},
         _t_get_script_chapters),
        ("list_script_npcs",
         "列出剧本附带的 NPC 角色卡(精简清单:id/名字/身份/重要度)。要完整人设走 get_script_character_card。",
         {"type": "object", "properties": {"script_id": {"type": "integer"}}},
         _t_list_script_npcs),
        ("get_script_character_card",
         "读取剧本内某张 NPC 角色卡的完整人设(背景/外貌/性格/语气/范例对白等)。先用 list_script_npcs 拿 card_id。",
         {"type": "object", "properties": {
             "script_id": {"type": "integer"},
             "card_id": {"type": "integer"},
         }, "required": ["card_id"]},
         _t_get_script_character_card),
    ]
    for name, desc, schema, exec_ in script_specs:  # type: ignore[assignment]
        if not registry.has(name):
            registry.register(ToolSpec(
                name=name, description=desc, input_schema=schema,
                executor=exec_, scope="script", origins=_READ_ANY_ORIGIN,
            ))

    global_specs = [
        ("list_available_tools",
         "元工具: 列出当前所有已注册工具。可按 origin 过滤(返回 LLM 可见的子集)。",
         {"type": "object", "properties": {"origin": {"type": "string"}}},
         _t_list_available_tools),
        ("list_modules",
         "列出所有 5E 模组目录。",
         {"type": "object", "properties": {}},
         _t_list_modules),
        ("list_available_models",
         "列出当前可用的 LLM API + model 配置。",
         {"type": "object", "properties": {}},
         _t_list_available_models),
    ]
    for name, desc, schema, exec_ in global_specs:  # type: ignore[assignment]
        if not registry.has(name):
            registry.register(ToolSpec(
                name=name, description=desc, input_schema=schema,
                executor=exec_, scope="global", origins=_READ_ANY_ORIGIN,
            ))


__all__ = ["register_query_tools"]
