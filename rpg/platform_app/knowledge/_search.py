from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

log = logging.getLogger(__name__)

_VEC_COLUMN_CACHE: dict[str, bool] = {}

# script_id → (embed_api_id, embed_model, cached_at) 进程内 cache
# TTL = 300s：workers=2 时，worker B 最多 5 分钟后自动感知到 worker A 重嵌后的新 meta
_SCRIPT_EMBED_META_CACHE: dict[int, tuple[str, str, float]] = {}
_SCRIPT_EMBED_META_TTL = 300.0

# 「没绑定 embed model」告警降频(2026-07-05 生产实证):未绑定的剧本每次检索
# (每 query 一次)都打一条 WARNING → 刷屏。同一 (script_id, 进程) 只需要提醒一次
# 「该重新拆书绑定」,后续降为 debug。模块级 set,进程重启/TTL 均不重置(未绑定
# 状态在重新 embed 前不会变化,没有必要按时间过期——过期只会让噪声重新出现)。
_UNBOUND_EMBED_WARNED: set[int] = set()


def _vector_column_exists(db, table: str) -> bool:
    if table in _VEC_COLUMN_CACHE:
        return _VEC_COLUMN_CACHE[table]
    try:
        # 必须是**真 pgvector 类型**列(udt_name='vector')才算"有向量列"。无 pgvector 的部署
        # (桌面捆绑版)migration 89 会建 jsonb 同名占位列让 `is not null` 计数不报错,但那种列
        # 不能跑 <=> 相似度 → 这里按 udt_name 区分,jsonb 占位列返回 False,自动退化到关键词检索。
        row = db.execute(
            "select 1 from information_schema.columns "
            "where table_name = %s and column_name = 'embedding_vec' and udt_name = 'vector'",
            (table,),
        ).fetchone()
        _VEC_COLUMN_CACHE[table] = bool(row)
    except Exception:
        _VEC_COLUMN_CACHE[table] = False
    return _VEC_COLUMN_CACHE[table]


def _get_script_embed_meta(db, script_id: int) -> tuple[str, str]:
    """从 scripts 表读取建库时绑定的 (embed_api_id, embed_model)。
    结果 cache 在进程内，TTL=300s（workers=2 下保证跨进程最终一致）。
    返回空字符串表示尚未绑定，调用方需 fallback。
    """
    now = time.monotonic()
    cached = _SCRIPT_EMBED_META_CACHE.get(script_id)
    if cached is not None:
        api_id_c, model_c, ts = cached
        if now - ts < _SCRIPT_EMBED_META_TTL:
            return api_id_c, model_c
        # TTL 过期：从 DB 重新拉
    try:
        row = db.execute(
            "select embed_api_id, embed_model from scripts where id = %s",
            (script_id,),
        ).fetchone()
        if row:
            result_api = row["embed_api_id"] or ""
            result_model = row["embed_model"] or ""
            _SCRIPT_EMBED_META_CACHE[script_id] = (result_api, result_model, now)
            return result_api, result_model
    except Exception as exc:
        log.debug("[_search] _get_script_embed_meta failed for script %s: %s", script_id, exc)
    return ("", "")


def _embed_query(
    text: str,
    *,
    script_id: int | None = None,
    user_id: int | None = None,
    db=None,
) -> str | None:
    """把 query 文本转 vector(768) 字符串。

    P0-fix: 召回时必须用与建库完全相同的 (api_id, model)，否则向量空间错乱。
    优先级:
      1. scripts.embed_api_id / embed_model（建库时锁定）
      2. user_id BYOK（仅 script_id 为 None 时，如 admin 工具）
      3. 系统默认 vertex + text-embedding-004

    失败返 None 自动 fallback ILIKE。
    """
    force_api_id: str | None = None
    force_model: str | None = None

    if script_id is not None and db is not None:
        api_id_locked, model_locked = _get_script_embed_meta(db, script_id)
        if api_id_locked and model_locked:
            force_api_id = api_id_locked
            force_model = model_locked
        else:
            # 已有剧本未绑定：fall back 到系统默认，发出警告。
            # 降频:同一 script_id 每 query 都会重新走到这里(每轮检索都调 _embed_query)
            # → 同一句 WARNING 刷屏。该 script 的绑定状态在重新 embed 前不会变化,
            # 第一次告警已经把「需要重新拆书」的信息传达到位,进程内只报一次即可,
            # 后续降为 debug(仍留痕,不完全消音)。
            if script_id not in _UNBOUND_EMBED_WARNED:
                _UNBOUND_EMBED_WARNED.add(script_id)
                log.warning(
                    "[_search] 召回剧本 %s 没绑定 embed model，fall back 到系统默认。"
                    "重新拆书后会绑定正确的 embed model。(本进程内此后降为 debug)",
                    script_id,
                )
            else:
                log.debug(
                    "[_search] 召回剧本 %s 没绑定 embed model，fall back 到系统默认。",
                    script_id,
                )
    elif script_id is not None and db is None:
        log.warning(
            "[_search] _embed_query: script_id=%s 但未传 db，无法读取建库 embed meta，"
            "fall back 到 user/系统默认。",
            script_id,
        )

    try:
        from .embedding import embed_query as _eq
        return _eq(text, user_id=user_id, force_api_id=force_api_id, force_model=force_model)
    except Exception as exc:
        log.debug("[_search] _embed_query failed: %s", exc)
        return None


def _vector_chunk_rows(
    db, script_id: int, tokens: list[str], chapter_min: int | None,
    chapter_max: int | None, limit: int, *, user_id: int | None = None,
) -> list[dict[str, Any]]:
    """向量路候选:只负责按 cosine 距离取候选,不做章节排序(融合后再排)。"""
    vector_query = _embed_query(" ".join(tokens), script_id=script_id, user_id=user_id, db=db)
    if vector_query is None or not _vector_column_exists(db, "document_chunks"):
        return []
    try:
        query = """
            select id, chapter_index, content, metadata,
                   (1 - (embedding_vec <=> %s::vector)) as score
            from document_chunks
            where script_id = %s
              and embedding_vec is not null
              and (%s::integer is null or chapter_index >= %s)
              and (%s::integer is null or chapter_index <= %s)
            order by embedding_vec <=> %s::vector
            limit %s
        """
        return db.execute(query, (
            vector_query, script_id,
            chapter_min, chapter_min, chapter_max, chapter_max,
            vector_query, max(1, int(limit)),
        )).fetchall()
    except Exception:
        return []


def _keyword_chunk_rows(
    db, script_id: int, tokens: list[str], chapter_min: int | None,
    chapter_max: int | None, limit: int,
) -> list[dict[str, Any]]:
    """关键词路候选:ILIKE 命中数打分(中文无分词,比 tsvector simple 更稳)。"""
    score_clauses = []
    where_clauses = []
    score_params: list[Any] = []
    where_params: list[Any] = []
    for token in tokens[:8]:
        pattern = f"%{token}%"
        score_clauses.append("case when content ilike %s then 1 else 0 end")
        where_clauses.append("content ilike %s")
        score_params.append(pattern)
        where_params.append(pattern)
    if not where_clauses:
        return []
    query = f"""
        select id, chapter_index, content, metadata,
               ({' + '.join(score_clauses)}) as score
        from document_chunks
        where script_id = %s
          and (%s::integer is null or chapter_index >= %s)
          and (%s::integer is null or chapter_index <= %s)
          and ({' or '.join(where_clauses)})
        order by score desc, chapter_index asc, chunk_index asc
        limit {max(1, int(limit))}
    """
    params = score_params + [script_id, chapter_min, chapter_min, chapter_max, chapter_max] + where_params
    try:
        return db.execute(query, tuple(params)).fetchall()
    except Exception:
        return []


def _rrf_fuse(
    vector_rows: list[dict[str, Any]], keyword_rows: list[dict[str, Any]], top_k: int,
) -> list[dict[str, Any]]:
    """RRF 融合(Reciprocal Rank Fusion)。

    · 同 id 在两路都命中 → 分数相加,自然排前;
    · 两路等权(0.5/0.5):若向量权重更高,top_k 较小时"只在关键词路命中"的
      专名/物品会被纯向量候选挤掉(实测 RRF 分数低于 vector rank2),混合检索
      就失去意义;
    · 向量路存在时最终按 chapter_index 升序(给 GM 读时间顺序);
      只有关键词路时保留 score 降序(避免纯词频结果被章节序打散)。
    """
    by_id: dict[Any, dict[str, Any]] = {}

    def _add(rows: list[dict[str, Any]], weight: float) -> None:
        for rank, row in enumerate(rows):
            rid = row.get("id")
            if rid is None:
                continue
            item = by_id.setdefault(rid, {**row, "_fused": 0.0})
            item["_fused"] += weight / (60 + rank + 1)

    _add(vector_rows, 0.5)
    _add(keyword_rows, 0.5)
    picked = sorted(by_id.values(), key=lambda r: -(r.get("_fused") or 0.0))[:max(1, top_k)]
    if vector_rows:
        picked.sort(key=lambda r: (int(r.get("chapter_index") or 0),
                                   -(r.get("_fused") or 0.0)))
    else:
        picked.sort(key=lambda r: (-(r.get("_fused") or 0.0),
                                   int(r.get("chapter_index") or 0)))
    for r in picked:
        r["score"] = r.pop("_fused", 0.0)
    return picked


def _rerank_enabled() -> bool:
    """阶段 3:可选 LLM rerank 总闸,默认 off(RPG_RAG_RERANK=1/true/on/llm 才启用)。"""
    return os.environ.get("RPG_RAG_RERANK", "off").strip().lower() in (
        "1", "true", "on", "yes", "llm",
    )


def _parse_rerank_order(raw: str) -> list[int]:
    if not raw:
        return []
    text = raw.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    data = None
    try:
        data = json.loads(text)
    except Exception:
        a, b = text.find("["), text.rfind("]")
        if a >= 0 and b > a:
            try:
                data = json.loads(text[a:b + 1])
            except Exception:
                return []
    if isinstance(data, dict):
        data = data.get("order") or data.get("ids") or data.get("result") or []
    if not isinstance(data, list):
        return []
    out: list[int] = []
    for x in data:
        if isinstance(x, dict):
            x = x.get("id")
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


def _maybe_llm_rerank(
    tokens: list[str], rows: list[dict[str, Any]], *, user_id: int | None,
) -> list[dict[str, Any]]:
    """可选 LLM rerank:只重排 hybrid top 候选,不改增删;失败/超时原样返回。

    默认关闭;启用后每轮多一次小 LLM 调用(top≤20,每段截 200 字,max_tokens=200,
    timeout=8s)。任何异常都降级为原顺序,绝不阻断检索。
    """
    if not rows or not user_id or len(rows) < 2 or not _rerank_enabled():
        return rows
    try:
        from agents._harness import call_agent_json_guarded, resolve_api_and_model
        from core.llm_backend import DEFAULT_FALLBACK_API, DEFAULT_FALLBACK_MODEL
        from platform_app.knowledge._utils import _pick_snippet

        api_id, model = resolve_api_and_model(
            user_id,
            api_pref_key="extractor.api_id",
            model_pref_key="extractor.model_real_name",
            default_api=DEFAULT_FALLBACK_API,
            default_model=DEFAULT_FALLBACK_MODEL,
        )
        if not api_id or not model:
            return rows
        candidates = []
        for r in rows[:20]:
            candidates.append({
                "id": int(r["id"]),
                "text": _pick_snippet(str(r.get("content") or ""), tokens, max_chars=200),
            })
        prompt = (
            "查询词：" + "、".join(tokens[:10]) + "\n候选片段：\n"
            + json.dumps(candidates, ensure_ascii=False)
            + "\n请按与查询的相关性从高到低排序，只返回 JSON 数组，元素为候选 id，不要解释。"
        )
        raw, _usage = call_agent_json_guarded(
            api_id, model, "你是检索结果重排器，只输出 JSON 数组。", prompt, user_id,
            log_tag="rag_rerank", max_tokens=200, timeout_sec=8, no_think=True,
        )
        order = _parse_rerank_order(raw)
        if not order:
            return rows
        pos = {rid: i for i, rid in enumerate(order)}
        indexed = list(enumerate(rows))
        indexed.sort(key=lambda pair: (
            pos.get(int(pair[1].get("id") or 0), 10 ** 9), pair[0],
        ))
        return [r for _, r in indexed]
    except Exception as exc:
        log.debug("[_search] rerank skipped: %s", exc)
        return rows


def _search_chunks(
    db,
    script_id: int,
    tokens: list[str],
    chapter_min: int | None,
    chapter_max: int | None,
    top_k: int,
    *,
    user_id: int | None = None,
) -> list[dict[str, Any]]:
    """混合检索：向量 + 关键词 RRF，可选 LLM rerank。

    1. 向量候选(embedding_vec 非空, cosine) + 关键词候选(ILIKE 命中数) 各取
       max(12, top_k*4) 条;
    2. RRF 等权融合(向量 0.5 / 关键词 0.5),取 top_k;
    3. 向量路存在时按章节顺序输出;可选 rerank 开启时按 LLM 相关性顺序输出;
    4. 任一路失败自动退化,两路都空返回 [](与旧行为一致)。
    """
    if not tokens:
        return []
    top_k = max(1, min(top_k, 8))
    candidate_n = max(12, min(32, top_k * 4))
    vector_rows = _vector_chunk_rows(
        db, script_id, tokens, chapter_min, chapter_max, candidate_n, user_id=user_id,
    )
    keyword_rows = _keyword_chunk_rows(
        db, script_id, tokens, chapter_min, chapter_max, candidate_n,
    )
    rows = _rrf_fuse(vector_rows, keyword_rows, top_k)
    return _maybe_llm_rerank(tokens, rows, user_id=user_id)


# 父窗口参数(阶段 2):
#   · 命中块先按同场景合并;同场景太短(<min)再扩到同章相邻块;
#   · 父窗口最大 1600 字,只用于提示词,不参与向量;
#   · **绝不跨章**——chapter_index 相同的块才进同一个 seq,ch10 与 ch500 永远不会合并。
_PARENT_WINDOW_MIN_CHARS = 700
_PARENT_WINDOW_MAX_CHARS = 1600


def _window_total(seq: list[dict[str, Any]], lo: int, hi: int) -> int:
    return sum(len(seq[i].get("content") or "") for i in range(lo, hi + 1))


def _expand_chunk_windows(
    db,
    script_id: int,
    rows: list[dict[str, Any]],
    *,
    min_chars: int = _PARENT_WINDOW_MIN_CHARS,
    max_chars: int = _PARENT_WINDOW_MAX_CHARS,
) -> list[dict[str, Any]]:
    """把命中块扩展成**同章**父窗口(small-to-big)。

    输入 rows 是 _search_chunks 的命中行(含 id/chapter_index/content/metadata)。
    输出在原行上追加:
      · window_content   —— 同场景/同章相邻块拼接后的上下文(≤max_chars)
      · window_chunk_ids —— 参与窗口的块 id 元组(调用方据此去重)

    规则:
      1. 同 scene_index 的相邻块优先(场景完整);
      2. 场景总长 < min_chars → 向同章前后块扩展,直到 min_chars 或本章边界;
      3. 超过 max_chars → 从离命中块最远的一侧裁掉;
      4. 只查命中块所在章的块,物理上不可能跨章(第 10 章不会带出第 500 章)。
    """
    if not rows:
        return []
    chapters = sorted({int(r["chapter_index"]) for r in rows})
    if not chapters:
        return []
    # 一次取回所有命中章的全部块;命中章通常 1-3 个,每章块数有限,批量查询比逐命中 N+1 稳。
    all_rows = db.execute(
        "select id, chapter_index, chunk_index, content, metadata "
        "from document_chunks where script_id = %s and chapter_index = any(%s) "
        "order by chapter_index, chunk_index",
        (script_id, chapters),
    ).fetchall()
    by_chapter: dict[int, list[dict[str, Any]]] = {}
    for r in all_rows:
        by_chapter.setdefault(int(r["chapter_index"]), []).append(r)

    # 父窗口查询不到任何块(老库/测试桩/命中章被删)时,退回命中块本身,
    # 绝不因为"扩窗口失败"把命中结果丢掉。
    if not by_chapter:
        return [
            {**r, "window_content": r.get("content") or "",
             "window_chunk_ids": (r.get("id"),)}
            for r in rows if (r.get("content") or "").strip()
        ]

    out: list[dict[str, Any]] = []
    seen_windows: set[tuple[Any, ...]] = set()
    for hit in rows:
        ch = int(hit["chapter_index"])
        seq = by_chapter.get(ch) or []
        if not seq:
            # 命中块所在章没有可扩展块:原样返回命中块(不丢结果)。
            if (hit.get("content") or "").strip():
                out.append({
                    **hit,
                    "window_content": hit.get("content") or "",
                    "window_chunk_ids": (hit.get("id"),),
                })
            continue
        idx = next((i for i, r in enumerate(seq) if r.get("id") == hit.get("id")), None)
        if idx is None:
            idx = 0
        _hit_meta = hit.get("metadata")
        if not isinstance(_hit_meta, dict):
            _hit_meta = {}
        scene = _hit_meta.get("scene_index")
        lo = hi = idx
        if scene is not None:
            # 同场景优先:只合并 scene_index 相同的相邻块
            while True:
                _left_meta = seq[lo - 1].get("metadata") if lo > 0 else None
                if not isinstance(_left_meta, dict) or _left_meta.get("scene_index") != scene:
                    break
                lo -= 1
            while hi + 1 < len(seq):
                _right_meta = seq[hi + 1].get("metadata")
                if not isinstance(_right_meta, dict) or _right_meta.get("scene_index") != scene:
                    break
                hi += 1

        # 场景太短 → 同章前后扩(不跨章)
        while _window_total(seq, lo, hi) < min_chars:
            left = lo - 1 if lo > 0 else None
            right = hi + 1 if hi + 1 < len(seq) else None
            if left is None and right is None:
                break
            left_len = len(seq[left].get("content") or "") if left is not None else 10 ** 9
            right_len = len(seq[right].get("content") or "") if right is not None else 10 ** 9
            if left_len <= right_len:
                lo -= 1
            else:
                hi += 1

        # 超长 → 从离命中块更远的一侧裁
        while _window_total(seq, lo, hi) > max_chars and lo < hi:
            if (idx - lo) >= (hi - idx):
                lo += 1
            else:
                hi -= 1

        ids = tuple(seq[i].get("id") for i in range(lo, hi + 1))
        if ids in seen_windows:
            continue
        seen_windows.add(ids)
        content = "\n".join((seq[i].get("content") or "") for i in range(lo, hi + 1)).strip()
        if not content:
            continue
        out.append({
            **hit,
            "window_content": content[:max_chars],
            "window_chunk_ids": ids,
        })
    return out


def _worldbook_visibility(save_id: int | None) -> tuple[str, list[Any]]:
    """世界书「本档还该不该看见这条」闸:剧本侧 enabled + 存档侧 retirement。

    群反馈(行者无疆):剧本设定里**已关闭**的世界书条目照样被召回进 GM 记忆
    (截图里《食材与天财地宝》enabled=false 仍带着相关度 0.57 出现)。真因=向量
    召回层是唯一没过这道闸的世界书读路径 —— 常驻层(gm_serving/context_inject)、
    激活层(context_engine/loaders)、关键词层(retrieval/sources)、RATH(rath/engine)
    全都 `enabled=true`,只有这里裸查表;`enabled` 又只是关闭开关不脏化向量
    (test_worldbook_embed_hygiene 的约定),条目关了向量还在 → 一召一个准。
    retirement(worldbook_retire 工具的「本档停用」)是同一语义的存档级孪生,
    关键词层同样过滤,这里一并收口,免得两个「已停用」只挡住一个。
    """
    sql = "enabled = true"
    params: list[Any] = []
    if save_id is not None:
        sql += (
            " and not exists (select 1 from save_worldbook_overlays o "
            "where o.save_id = %s and o.kind = 'retirement' "
            "and o.retired_entry_id = worldbook_entries.id)"
        )
        params.append(int(save_id))
    return sql, params


def _search_entities(
    db,
    script_id: int,
    query_text: str,
    *,
    chapter_min: int | None = None,
    chapter_max: int | None = None,
    top_k_cards: int = 3,
    top_k_wb: int = 3,
    user_id: int | None = None,
    save_id: int | None = None,
    mode: str = "none",
) -> dict[str, list[dict[str, Any]]]:
    """task 51/52: LightRAG 双层检索的第二层 — entity 层。

    **时间线对齐**(task 52 关键 + BUG-1 修复): chapter_max 是 GM 当前回合"可见的最大章节"
    (= 玩家进度,见 retrieve_script_context 把 progress_chapter 钳进来)。硬过滤掉
    first_revealed_chapter > chapter_max 的角色/词条 —— 否则第 1 章玩家会被召回第 391 章
    才出现的莉莉丝,严重剧透。

    进度列统一到 first_revealed_chapter(character_cards 自 v28 有;worldbook 自 v53 有),
    not null default 0(0=开局即可见,与 kb_canon_entities / canon_repo._reveal_clause 同约定)。
    **方向铁律**:不再用 `first_chapter is null` 放行 —— 过滤直接 `first_revealed_chapter <= %s`,
    未知/NULL 一律收紧(`null <= x` 为 false → 不召回),绝不放行后期实体。
    旧代码引用从不存在的 first_chapter/last_seen_chapter 列 → 裸 except 静默返空(漏功能但不剧透);
    本修复恢复召回的同时保持"不剧透"。

    Returns: {"cards": [...], "worldbook": [...]}
    """
    out = {"cards": [], "worldbook": []}
    if not query_text:
        return out
    vec = _embed_query(query_text, script_id=script_id, user_id=user_id, db=db)
    if not vec:
        # 无 embedding 时退化为 ILIKE 兜底(与 _search_chunks 同策略)
        tokens = [t for t in query_text.split() if t][:8]
        if not tokens:
            return out
        _OLD_GATE = "(%s::integer is null or first_revealed_chapter <= %s)"
        gate_sql, gate_params = _OLD_GATE, [chapter_max, chapter_max]
        for table, name_col, result_key, extra_cols in [
            ("character_cards", "name", "cards", "identity, personality, appearance,"),
            ("worldbook_entries", "title", "worldbook", "content,"),
        ]:
            if table == "character_cards":
                vis_sql, vis_params = "enabled = true", []
            else:
                vis_sql, vis_params = _worldbook_visibility(save_id)
            where_parts = [f"{name_col} ilike %s" for _ in tokens]
            patterns = [f"%{t}%" for t in tokens]
            try:
                rows = db.execute(
                    f"select id, {name_col}, {extra_cols} first_revealed_chapter, 0.5 as score "
                    f"from {table} "
                    f"where script_id = %s and {vis_sql} "
                    f"and ({' or '.join(where_parts)}) "
                    f"and {gate_sql} "
                    f"limit %s",
                    # ⚠️ 参数序必须跟占位符序:script_id → 可见性 → ilike patterns → 章节闸 → limit。
                    # 旧代码把 patterns 排在 script_id 前面(占位符个数刚好对得上,故没人发现),
                    # 每次都以 "%词%" 去比整数列 → 必抛 → 被下面的裸 except 吞掉:无向量时的
                    # ILIKE 兜底其实一直是条死路(恒返空)。
                    (script_id, *vis_params, *patterns, *gate_params,
                     max(1, min(top_k_cards if result_key == "cards" else top_k_wb, 8))),
                ).fetchall()
                out[result_key] = rows
            except Exception:
                pass
        return out

    # P4(S2):门控有两套。旧=标量 `first_revealed_chapter <= chapter_max`(2 个 chapter_max 占位符);
    # 新=前沿 reveal_clause_v2(save_id)(1 个 save_id 占位符)。用 *gate_params 展开自动适配占位符个数。
    from kb.reveal import _frontier_on, _frontier_shadow, _shadow_diff_log, reveal_clause_v2
    use_v2 = save_id is not None and _frontier_on(save_id)
    _OLD_GATE = "(%s::integer is null or first_revealed_chapter <= %s)"
    if use_v2:
        gate_sql, gate_params = reveal_clause_v2(int(save_id), mode, prefix="", has_public_knowledge=False, has_famous=False, progress_chapter=chapter_max)
    else:
        gate_sql, gate_params = _OLD_GATE, [chapter_max, chapter_max]

    def _gate_ids(table: str, extra: str, extra_params: list, g: str, p: list) -> set:
        """某门控放行的全集 id(不带 vector/limit),供影子比对隔离纯门控差异。"""
        return {r["id"] for r in db.execute(
            f"select id from {table} where script_id=%s and embedding_vec is not null and {extra} and {g}",
            (script_id, *extra_params, *p)).fetchall()}

    def _shadow(table: str, extra: str, extra_params: list, tag: str) -> None:
        """对比旧标量门控 vs 新前沿门控的放行全集(与 vector 排序/limit 无关)。"""
        old_g, old_p = _OLD_GATE, [chapter_max, chapter_max]
        new_g, new_p = reveal_clause_v2(int(save_id), mode, prefix="", has_public_knowledge=False, has_famous=False, progress_chapter=chapter_max)
        _shadow_diff_log(tag, _gate_ids(table, extra, extra_params, old_g, old_p),
                         _gate_ids(table, extra, extra_params, new_g, new_p))

    if _vector_column_exists(db, "character_cards"):
        try:
            out["cards"] = db.execute(
                f"""
                select id, name, identity, personality, appearance,
                       first_revealed_chapter,
                       (1 - (embedding_vec <=> %s::vector)) as score
                from character_cards
                where script_id = %s
                  and embedding_vec is not null
                  and enabled = true
                  -- BUG-1/P4: 时间线硬过滤,GM 不该看到玩家还没读到的章节里的角色。
                  and {gate_sql}
                order by embedding_vec <=> %s::vector
                limit %s
                """,
                (vec, script_id, *gate_params, vec, max(1, min(top_k_cards, 8))),
            ).fetchall()
            if _frontier_shadow() and save_id is not None:
                _shadow("character_cards", "enabled = true", [], "_search cards")
        except Exception:
            pass

    if _vector_column_exists(db, "worldbook_entries"):
        _wb_vis_sql, _wb_vis_params = _worldbook_visibility(save_id)
        try:
            out["worldbook"] = db.execute(
                f"""
                select id, title, content, first_revealed_chapter,
                       (1 - (embedding_vec <=> %s::vector)) as score
                from worldbook_entries
                where script_id = %s
                  and embedding_vec is not null
                  -- 关闭(enabled=false)/本档停用(retirement)的条目不该再被召回。
                  and {_wb_vis_sql}
                  and {gate_sql}
                order by embedding_vec <=> %s::vector
                limit %s
                """,
                (vec, script_id, *_wb_vis_params, *gate_params, vec, max(1, min(top_k_wb, 8))),
            ).fetchall()
            if _frontier_shadow() and save_id is not None:
                _shadow("worldbook_entries", _wb_vis_sql, _wb_vis_params, "_search worldbook")
        except Exception:
            pass

    return out
