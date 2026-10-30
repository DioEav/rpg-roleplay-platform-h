"""import_pipeline.rebuild_scheduler — rebuild 估算 + 异步调度(kind='rebuild_*' 写 import_jobs)

来源: 原 rpg/platform_app/import_pipeline.py estimate_module_rebuild / schedule_module_rebuild(原 L2472-2844) 区段,纯机械搬家(函数体逐字未动),零行为变化。
"""
from __future__ import annotations

import json
import secrets
import threading
from typing import Any

from psycopg.types.json import Jsonb

from ..db import connect, init_db
from ..perms import script_owned
from .errors import MissingUserCredentialError
from .rebuild_registry import (
    REBUILD_MODULES,
    _embedding_preflight_or_raise,
    _embedding_prereq,
    normalize_rebuild_module,
)
from .rebuild_worker import _run_module_rebuild
from .stages_llm import (
    _credential_api_id_for,
    _has_user_llm_credential,
    _resolve_extractor_llm,
)

# ── 执行侧模型解析(estimate / 凭证闸 / runner 必须同源)────────────────────
# facts_refine / worldbook_enrich / world_key 的 runner 实际走 agents.recorder 的
# 模型偏好(recorder.*, 回退 extractor.*);而 estimate 和凭证闸此前用 extractor.*。
# 用户配了 recorder 模型但没配 key 时,估算显示可用、派发也过闸,执行才报
# 「无可用 api/model」。这里统一按模块选择执行侧解析器。
_RECORDER_MODULES = frozenset({"facts_refine", "worldbook_enrich", "world_key"})


def _resolve_recorder_llm(user_id: int, body: dict[str, Any]) -> tuple[str, str]:
    """recorder 模型解析(与 extract.facts_refine / worldbook_enrich / world_key 同源)。

    单独包一层便于测试 patch;任何解析异常降级为 ("",""),由调用方按"无可用凭证"处理。
    """
    try:
        from agents.recorder import _resolve_recorder_api_and_model
        from model_aliases import normalize_api_id

        api_id, model = _resolve_recorder_api_and_model(
            user_id, body.get("api_id") or None, body.get("model") or None,
        )
        return normalize_api_id(api_id or ""), (model or "")
    except Exception:
        return "", ""


def _execution_llm(user_id: int, module: str, body: dict[str, Any]) -> tuple[str, str]:
    """返回该模块**执行侧**真正会用的 (api_id, model)。"""
    if module in _RECORDER_MODULES:
        return _resolve_recorder_llm(user_id, body)
    return _resolve_extractor_llm(user_id)


def _options_fingerprint(body: dict[str, Any] | None) -> str:
    """任务参数指纹:用于判断"同 kind 已在跑"的任务是否和本次请求同参。

    旧实现只看 kind,直接复用 job_id —— 用户先点「零 LLM 重建」再点「LLM 丰富重建」
    会被静默合并成前者。这里把 options 标准化后比较,参数不同就明确报错。
    """
    try:
        return json.dumps(body or {}, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:
        return str(body or {})


def _count_enrich_candidates(db, script_id: int, pattern: str, include_editor: bool = False) -> int:
    """世界书充实的候选条目数(estimate / status / runner 三处必须同一口径)。

    默认排除 metadata.source='editor' 的手编条目 —— runner 默认也不会覆盖它们
    (见 extract.worldbook_enrich)。旧实现三处口径不一致:status 算全部、estimate
    算全部、runner 覆盖全部,导致"手编条目被悄悄重写"且进度数字对不上。
    """
    sql = (
        "select count(*) as c from worldbook_entries "
        "where script_id = %s and title ~ %s"
    )
    params: list[Any] = [script_id, pattern]
    if not include_editor:
        from ..knowledge._manual import WORLDBOOK_CONTENT_GUARD_SQL
        sql += WORLDBOOK_CONTENT_GUARD_SQL
    row = db.execute(sql, tuple(params)).fetchone()
    return int(row["c"]) if row else 0


def estimate_module_rebuild(
    user_id: int, script_id: int, module: str, *, body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Estimate a module rebuild and expose blocking prereqs for the UI modal."""
    init_db()
    module = normalize_rebuild_module(module)
    body = dict(body or {})
    if module not in REBUILD_MODULES:
        raise ValueError(f"unknown module: {module}")

    def _scalar(db, sql: str) -> int:
        row = db.execute(sql, (script_id,)).fetchone()
        return int(row["c"]) if row else 0

    with connect() as db:
        script = script_owned(db, script_id, user_id)
        if not script:
            raise ValueError("无权访问该剧本")

        chapter_count = int(script.get("chapter_count") or 0)
        _counts = _gather_module_counts(db, script_id)
    chunks_total = _counts["chunks_total"]
    chunks_done = _counts["chunks_done"]
    canon_total = _counts["canon_total"]
    canon_done = _counts["canon_done"]
    cards_total = _counts["cards_total"]
    cards_done = _counts["cards_done"]
    wb_total = _counts["wb_total"]
    wb_done = _counts["wb_done"]

    prereqs: list[dict[str, Any]] = []
    affects: list[str] = []
    note = ""
    model: str | None = None
    tokens_est = 0       # 仅真·chat-LLM 模块(canon 全量 / worldbook-llm)>0;其余为 0 = 真免费
    cost_est = 0.0

    kind, _label, needs_llm = REBUILD_MODULES[module]
    source_pref = str(body.get("source") or body.get("mode") or "").lower()
    # needs_llm 必须反映 runner 的**实际**调用:之前 tokens_est/cost_est 写死 0,所有模块(含真
    # 烧 LLM 的 canon 全量重抽 / worldbook-llm)都显示「免费」,会误导用户(群反馈)。这里按真实
    # 路径校正 needs_llm,下方再据此算 token+成本。
    # - worldbook 默认 canon(零 LLM),仅 source=='llm' 才烧 LLM;
    # - cards = rebuild_cards_from_canon,**零 LLM**(从 canon/facts 反推),恒免费;
    # - canon 默认全量 LLM 重抽,resolve_only 是零 LLM。
    if module == "worldbook":
        needs_llm = (source_pref == "llm")
    if module == "cards":
        # cards 默认零 LLM(从 canon/facts 反推),恒免费;仅 source/mode=='llm' 的丰富重建烧 LLM。
        needs_llm = (source_pref == "llm")
    if module == "canon" and source_pref == "resolve_only":
        needs_llm = False
    if module == "world_key":
        # 结构先验默认零 LLM;仅 body.use_llm 真值时才需要 BYOK(第二层窄确认)。
        needs_llm = bool(body.get("use_llm"))

    if module == "embeddings":
        includes = [str(x) for x in (body.get("include") or ["chunks", "cards", "worldbook", "canon"])]
        pre = _embedding_prereq(user_id)
        prereqs.append(pre)
        model = str(pre.get("model") or "")
        target_pairs = {
            "chunks": (chunks_done, chunks_total, "document_chunks.embedding_vec"),
            "cards": (cards_done, cards_total, "character_cards.embedding_vec"),
            "worldbook": (wb_done, wb_total, "worldbook_entries.embedding_vec"),
            "canon": (canon_done, canon_total, "kb_canon_entities.embedding"),
        }
        target_total = 0
        target_done = 0
        for name in includes:
            done, total, table = target_pairs.get(name, (0, 0, name))
            target_done += done
            target_total += total
            affects.append(table)
        if "chunks" in includes and chunks_total == 0:
            prereqs.append({
                "key": "chunks",
                "label": "章节切块",
                "ok": False,
                "hint": "当前剧本还没有章节切块,请先重做「章节切片」。",
                "count": 0,
                "total": max(chapter_count, 1),
            })
        note = f"将检查 {target_total} 条向量目标,当前已完成 {target_done} 条。"
    else:
        affects = {
            "chunks": ["document_chunks"],
            "chapter-facts": ["chapter_facts"],
            "canon": ["kb_canon_entities"],
            "cards": ["character_cards"],
            "worldbook": ["worldbook_entries"],
            "anchors": ["script_timeline_anchors"],
            "facts_refine": ["chapter_facts"],
            "worldbook_enrich": ["worldbook_entries"],
            "world_key": ["chapter_facts", "script_timeline_anchors"],
            "story_phase": ["chapter_facts", "phase_digests", "script_timeline_anchors"],
        }.get(module, [kind])
        # 章节是所有派生数据的根:chunks / chapter-facts 只依赖 script_chapters。
        # 旧实现对 chapter-facts 也要求 chunks,实际 rebuild_facts_from_db 只读章节,
        # 导致有章节、没切块时无法生成摘要。
        if module in {"chunks", "chapter-facts"} and chapter_count == 0:
            prereqs.append({
                "key": "chapters",
                "label": "章节",
                "ok": False,
                "hint": "该剧本还没有章节,请先导入正文或新建章节。",
                "count": 0,
                "total": 0,
            })
        # anchors 真正读的是 chapter_facts(rebuild_timeline_from_db),不是 chunks。
        # 旧实现给 anchors 挂「先重做章节切片」→ 有 facts 也被挡;反过来 facts 空时
        # 估算放行、派发后才报「chapter_facts 没有章节数据」。world_key 同理。
        if module in {"anchors", "world_key"}:
            with connect() as db:
                facts_total = _scalar(db, "select count(*) as c from chapter_facts where script_id = %s")
            if facts_total == 0:
                prereqs.append({
                    "key": "chapter_facts",
                    "label": "章节事实",
                    "ok": False,
                    "hint": "当前剧本还没有章节事实,请先重做「章节事实」。",
                    "count": 0,
                    "total": max(chapter_count, 1),
                })
        # worldbook 默认 canon(零 LLM,从知识库人物建)且**无回退** → canon 为空时硬失败
        # 「kb_canon_entities 为空」(前端表现为「点了没反应」,群反馈行者无疆)→ 给阻断 prereq。
        # cards **不在此列**:rebuild_cards_from_canon 在 canon 为空时会退化为 facts 词频(零 LLM),
        # 不会硬失败,不该被拦。
        if module == "worldbook" and source_pref != "llm" and canon_total == 0:
            prereqs.append({
                "key": "canon",
                "label": "规范实体",
                "ok": False,
                "hint": "当前没有规范实体(知识库人物为空),请先重做「知识库人物」,"
                        "或将世界书来源改为 LLM 生成。",
            })
        # story_phase 以章节事实的摘要为输入,facts 为空则无从划分
        if module == "story_phase":
            with connect() as db:
                facts_total = _scalar(db, "select count(*) as c from chapter_facts where script_id = %s")
            if facts_total == 0:
                prereqs.append({
                    "key": "chapter_facts",
                    "label": "章节事实",
                    "ok": False,
                    "hint": "当前剧本还没有章节事实,请先重做「章节事实」。",
                    "count": 0,
                    "total": max(chapter_count, 1),
                })
        # facts_refine 精炼的是已有 chapter_facts 行(UPDATE,不新增),facts 为空则无可精炼。
        if module == "facts_refine":
            with connect() as db:
                facts_total = _scalar(db, "select count(*) as c from chapter_facts where script_id = %s")
            if facts_total == 0:
                prereqs.append({
                    "key": "chapter_facts",
                    "label": "章节事实",
                    "ok": False,
                    "hint": "当前剧本还没有章节事实,请先重做「章节事实」。",
                    "count": 0,
                    "total": max(chapter_count, 1),
                })
        # worldbook_enrich 充实的是已存在、标题命中 pattern 且**非手编**的世界书条目。
        # 候选为 0 时该模块对本剧本不适用(卡片会显示 n/a),估算层直接说明原因,
        # 避免用户点了半天发现没有任何可处理条目。
        if module == "worldbook_enrich":
            _pattern = str(body.get("pattern") or "力量|概念|势力|体系")
            _matched: int | None
            try:
                with connect() as db:
                    _matched = _count_enrich_candidates(
                        db, script_id, _pattern, bool(body.get("include_editor")),
                    )
            except Exception as exc:
                # 标题正则是用户可传的 API 参数;非法正则不该把估算打成 500。
                prereqs.append({
                    "key": "pattern",
                    "label": "匹配正则",
                    "ok": False,
                    "hint": f"标题正则无效：{str(exc)[:200]}",
                })
                _matched = None
            if _matched == 0:
                prereqs.append({
                    "key": "worldbook_enrich_candidates",
                    "label": "可充实条目",
                    "ok": False,
                    "hint": "没有标题命中核心设定词的可充实条目(手编条目默认跳过),该模块对本剧本不适用。",
                    "count": 0,
                })
        if needs_llm:
            # estimate 必须和 runner 用同一套模型解析:facts_refine / worldbook_enrich /
            # world_key 执行侧走 recorder.* 偏好(回退 extractor.*),其余走 extractor.*。
            # 旧实现一律用 extractor,导致"估算可用、执行报无模型"。
            api_id, llm_model = _execution_llm(user_id, module, body)
            model = llm_model
            if not api_id or not _has_user_llm_credential(user_id, api_id):
                prereqs.append({
                    "key": "llm_credentials",
                    "label": "LLM API Key",
                    "ok": False,
                    "hint": "请先在「设置 → API 设置」配置本模块实际使用的模型 API Key"
                            "(摘要精炼/世界书充实/世界观切分走「史官」模型,其余走「知识提取」模型)。",
                    "api_id": api_id,
                    "model": llm_model,
                    "credential_api_id": _credential_api_id_for(api_id) if api_id else "",
                    "needs_credentials": True,
                })
            # 真·chat-LLM 路径才算 token+成本(否则「免费」会撒谎)。粗估,UI 标注≈。
            #   canon 全量重抽 = 跑全书 chunks(input≈全文,output≈每块结构化产出);
            #   worldbook-llm = 按 canon 规模的若干次抽取调用。
            est_in = est_out = 0
            if module == "canon":
                est_in, est_out = _estimate_tokens_canon(script_id, llm_model, user_id=user_id)
            elif module == "cards":                 # 必是 source=='llm'(否则 needs_llm=False)
                est_in, est_out = _estimate_tokens_cards(script_id, llm_model, body, chapter_count, user_id=user_id)
            elif module == "worldbook":             # 必是 source=='llm'(否则 needs_llm=False)
                est_in, est_out = _estimate_tokens_worldbook(canon_total)
            elif module == "facts_refine":
                est_in, est_out = _estimate_tokens_facts_refine(body, chapter_count)
            elif module == "worldbook_enrich":
                est_in, est_out = _estimate_tokens_worldbook_enrich(script_id, body)
            elif module == "world_key":              # 必是 use_llm=True(否则 needs_llm=False)
                est_in, est_out = _estimate_tokens_world_key(script_id)
            elif module == "story_phase":
                est_in, est_out = _estimate_tokens_story_phase()
            if est_in or est_out:
                tokens_est = est_in + est_out
                try:
                    from model_probe import get_pricing
                    _pr = get_pricing(api_id, llm_model) or {}
                    _ip = float(_pr.get("input", 0) or 0)
                    _op = float(_pr.get("output", 0) or 0)
                    cost_est = round((est_in * _ip + est_out * _op) / 1_000_000, 4)
                except Exception:
                    cost_est = 0.0
        note = "该模块将作为后台任务运行,可关闭页面后回来查看进度。"

    return {
        "ok": True,
        "script_id": script_id,
        "module": module,
        "kind": kind,
        "tokens_est": tokens_est,
        "cost_est": cost_est,
        "est_input_tokens": tokens_est,  # 兼容前端 est_input_tokens 读取
        "approximate": tokens_est > 0,   # >0 即非免费,UI 可标「≈」
        "model": model,
        "affects": affects,
        "prereqs": prereqs,
        "note": note,
    }


def schedule_module_rebuild(
    user_id: int, script_id: int, module: str,
    *, body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """异步调度单模块重建。返 {ok, job_id}。"""
    init_db()
    module = normalize_rebuild_module(module)
    body = dict(body or {})
    if module not in REBUILD_MODULES:
        raise ValueError(f"unknown module: {module}")
    kind, action_label, needs_llm = REBUILD_MODULES[module]
    source_pref = str(body.get("source") or body.get("mode") or "").lower()
    if needs_llm:
        # canon 默认走 LLM;worldbook **默认 canon(零 LLM)**,仅 source=='llm' 才需 LLM ——
        # 必须与 _run_module_rebuild 的 `src = source or "canon"` 对齐。否则默认(无 source)的
        # worldbook 会被误要求 LLM 凭证(没配 key 直接 credentials_required),而 runner 实际走
        # canon → 表现为「点生成世界书没反应/报错」。
        if module == "worldbook":
            needs_llm = (source_pref == "llm")
        if module == "canon" and source_pref == "resolve_only":
            needs_llm = False
    # 进度感知角色卡:cards 默认零 LLM(False);仅 source/mode=='llm' 的丰富重建才需 BYOK 凭证。
    if module == "cards" and source_pref == "llm":
        needs_llm = True
    # world_key:结构先验默认零 LLM(REBUILD_MODULES 基线 False);仅 body.use_llm 真值时才需要
    # BYOK(第二层窄确认)—— 与 estimate_module_rebuild 同一对齐规则。
    if module == "world_key" and body.get("use_llm"):
        needs_llm = True
    # 先校验所有权再做凭证检查:非 owner 不应从错误码/提示里推断出凭证状态,
    # 也避免"无凭证"错误盖掉"无权访问"。
    with connect() as db:
        if not script_owned(db, script_id, user_id):
            raise ValueError("无权访问该剧本")
    if needs_llm:
        # 凭证闸与 estimate / runner 同源:执行侧真正会用哪个 provider 就检查哪个。
        _api_id, _llm_model = _execution_llm(user_id, module, body)
        if not _api_id or not _has_user_llm_credential(user_id, _api_id):
            raise MissingUserCredentialError(
                _api_id or "unknown", _llm_model or "",
                _credential_api_id_for(_api_id) if _api_id else "",
            )
    if module == "embeddings":
        _embedding_preflight_or_raise(user_id)

    with connect() as db:
        # 单飞（per-script）:同一剧本同一时刻只允许一个后台任务。
        # 旧实现只按 kind 去重,两个标签页可以同时跑 canon 全量 + facts_refine
        # (双倍 LLM 花费 + DB 争用);而全量导入本来就有全局并发闸,不该被 rebuild 绕过。
        # 同 kind 且参数相同 → 复用(幂等);参数不同 → 明确报错,不能静默跑错模式。
        existing = db.execute(
            "select job_id, kind, budget_estimate from import_jobs "
            "where user_id = %s and script_id = %s "
            "and status in ('queued', 'pending', 'running') "
            "order by id desc limit 1",
            (user_id, script_id),
        ).fetchone()
        if existing:
            if existing["kind"] != kind:
                return {
                    "ok": False,
                    "code": "script_busy",
                    "job_id": existing["job_id"],
                    "error": f"该剧本已有任务在跑（{existing['kind']}），请等它完成或取消后再试。",
                }
            old_options = ((existing.get("budget_estimate") or {}).get("options") or {})
            if _options_fingerprint(old_options) != _options_fingerprint(body):
                return {
                    "ok": False,
                    "code": "options_mismatch",
                    "job_id": existing["job_id"],
                    "error": "该模块已有任务在跑且参数不同（如零 LLM / LLM 丰富），请等它完成后再试。",
                }
            return {"ok": True, "job_id": existing["job_id"], "reused": True}
        job_id = f"rb_{module}_{script_id}_{secrets.token_hex(6)}"
        db.execute(
            """
            insert into import_jobs(
              job_id, user_id, script_id, kind, status, stage,
              module, sub_kind, overall_total, budget_estimate, stages
            ) values (%s, %s, %s, %s, 'pending', 'pending',
                      %s, %s, 1, %s, %s)
            """,
            (
                job_id, user_id, script_id, kind,
                module, kind,
                Jsonb({"options": body, "action": action_label}),
                Jsonb([{"id": module, "label": action_label, "status": "pending"}]),
            ),
        )
    th = threading.Thread(
        target=_run_module_rebuild,
        args=(job_id, user_id, script_id, module, body),
        daemon=True,
    )
    th.start()
    return {"ok": True, "job_id": job_id, "reused": False, "module": module, "kind": kind}


def _gather_module_counts(db, script_id) -> dict:
    def _scalar(db, sql: str) -> int:
        row = db.execute(sql, (script_id,)).fetchone()
        return int(row["c"]) if row else 0
    chunks_total = _scalar(db, "select count(*) as c from document_chunks where script_id = %s")
    chunks_done = _scalar(
        db,
        "select count(*) as c from document_chunks "
        "where script_id = %s and embedding_vec is not null",
    )
    canon_total = _scalar(db, "select count(*) as c from kb_canon_entities where script_id = %s")
    canon_done = _scalar(
        db,
        "select count(*) as c from kb_canon_entities "
        "where script_id = %s and embedding is not null",
    )
    cards_total = _scalar(
        db,
        "select count(*) as c from character_cards "
        "where script_id = %s and card_type='npc'",
    )
    cards_done = _scalar(
        db,
        "select count(*) as c from character_cards "
        "where script_id = %s and card_type='npc' and embedding_vec is not null",
    )
    wb_total = _scalar(db, "select count(*) as c from worldbook_entries where script_id = %s")
    wb_done = _scalar(
        db,
        "select count(*) as c from worldbook_entries "
        "where script_id = %s and embedding_vec is not null",
    )
    return {
        "chunks_total": chunks_total,
        "chunks_done": chunks_done,
        "canon_total": canon_total,
        "canon_done": canon_done,
        "cards_total": cards_total,
        "cards_done": cards_done,
        "wb_total": wb_total,
        "wb_done": wb_done,
    }


def _estimate_tokens_canon(script_id, llm_model, *, user_id: int | None = None) -> tuple[int, int]:
    # canon 全量重抽走 arc 算法。真实用量用 **arc 感知**的 extract.budget.estimate
    # (与 wizard /llm-extract/estimate 同一权威源)。target_arcs 引用单一真源常量:
    # 必须与执行路径(run_llm_extraction / run_arc_extraction)同值,否则估算弧数和
    # 实际弧数对不上,弹窗 Tokens 失真(历史病灶:估 100 弧跑 40 弧,高估 2.7 倍)。
    try:
        from extract.arc_pipeline import EXTRACTION_TARGET_ARCS
        from extract.budget import estimate as _budget_estimate
        with connect() as db:
            _b = _budget_estimate(
                db, script_id, algorithm="arc",
                model=(llm_model or "deepseek-v4-flash"),
                target_arcs=EXTRACTION_TARGET_ARCS,
                user_id=user_id,
            )
        est_in = int(_b.get("est_input_tokens") or 0)
        est_out = int(_b.get("est_output_tokens") or 0)
    except Exception:
        est_in = est_out = 0
    return est_in, est_out


def _estimate_tokens_cards(script_id, llm_model, body, chapter_count, *, user_id: int | None = None) -> tuple[int, int]:
    # 丰富重建走 run_llm_extraction(arc),与 canon 同口径估;chapter_max 限区间。
    # target_arcs 引用单一真源常量(见 _estimate_tokens_canon 注释)。
    try:
        from extract.arc_pipeline import EXTRACTION_TARGET_ARCS
        from extract.budget import estimate as _budget_estimate
        _cmax_raw = body.get("chapter_max")
        try:
            _cmax = int(_cmax_raw) if _cmax_raw not in (None, "") else None
        except (TypeError, ValueError):
            _cmax = None
        with connect() as db:
            _b = _budget_estimate(
                db, script_id, algorithm="arc",
                model=(llm_model or "deepseek-v4-flash"),
                target_arcs=EXTRACTION_TARGET_ARCS,
                user_id=user_id,
            )
        est_in = int(_b.get("est_input_tokens") or 0)
        est_out = int(_b.get("est_output_tokens") or 0)
        # chapter_max 区间钳:按 chapter_max/全书章数 线性折减(粗估,UI 标≈)。
        if _cmax and chapter_count and _cmax < chapter_count:
            ratio = max(0.0, min(1.0, _cmax / float(chapter_count)))
            est_in = int(est_in * ratio)
            est_out = int(est_out * ratio)
    except Exception:
        est_in = est_out = 0
    return est_in, est_out


def _estimate_tokens_worldbook(canon_total) -> tuple[int, int]:
    _base = max(canon_total, 20)
    est_in = _base * 1500
    est_out = _base * 300
    return est_in, est_out


def _estimate_tokens_facts_refine(body, chapter_count) -> tuple[int, int]:
    # 逐章调 LLM 精炼 summary/in_world_time(extract.facts_refine.refine_script)。
    # 涉及章节数 = [ch_from, ch_to] 区间(默认整本),按 ~1.5k tokens/章估算
    # (与 estimate_module_rebuild 既有粗估口径一致,不接 arc budget——精炼是逐章
    # 独立小调用,非 arc 弧段合并调用)。
    _ch_from_raw = body.get("ch_from")
    _ch_to_raw = body.get("ch_to")
    try:
        _ch_from = int(_ch_from_raw) if _ch_from_raw not in (None, "") else 1
    except (TypeError, ValueError):
        _ch_from = 1
    try:
        _ch_to = int(_ch_to_raw) if _ch_to_raw not in (None, "") else chapter_count
    except (TypeError, ValueError):
        _ch_to = chapter_count
    _ch_to = min(_ch_to, chapter_count) if chapter_count else _ch_to
    _n_chapters = max(0, _ch_to - _ch_from + 1) if (_ch_to and _ch_from) else 0
    est_in = _n_chapters * 1500
    est_out = _n_chapters * 100  # 摘要产出短(≤200字),output 远小于 input
    return est_in, est_out


def _estimate_tokens_worldbook_enrich(script_id, body) -> tuple[int, int]:
    # 候选条目数必须与 runner 同一口径(默认排除 editor 手编,可 include_editor 覆盖),
    # 否则估算的 token 数和实际会处理的条目数对不上。
    _pattern = str(body.get("pattern") or "力量|概念|势力|体系")
    try:
        with connect() as db:
            _n_entries = _count_enrich_candidates(
                db, script_id, _pattern, bool(body.get("include_editor")),
            )
    except Exception:
        _n_entries = 0
    est_in = _n_entries * 2000
    est_out = _n_entries * 400
    return est_in, est_out


def _estimate_tokens_world_key(script_id) -> tuple[int, int]:
    # 第二层 LLM 窄确认按段(segment)发起调用,一段边界一次调用。段数用零 IO 的
    # classify_segments 纯函数算(不落库、不调 LLM),口径与 backfill_worldlines
    # 实际跑时产生的段数一致。
    try:
        from extract.world_key_backfill import classify_segments as _classify_segments
        with connect() as db:
            _ck_rows = db.execute(
                "select chapter_index, title, volume_title from script_chapters "
                "where script_id = %s", (script_id,),
            ).fetchall()
        _chapters_for_seg = [
            {"chapter_index": r["chapter_index"], "title": r.get("title") or "",
             "volume_title": r.get("volume_title") or ""}
            for r in (_ck_rows or [])
        ]
        _segments = _classify_segments(_chapters_for_seg)
        _n_segments = max(0, len(_segments) - 1)  # 首段无边界可确认,N 段有 N-1 条边界
    except Exception:
        _n_segments = 0
    est_in = _n_segments * 1000
    est_out = _n_segments * 150
    return est_in, est_out


def _estimate_tokens_story_phase() -> tuple[int, int]:
    # 阶段划分 = **一次** LLM 调用(_stage_story_phase_llm):≤30 章采样摘要
    # (每行 章号+标题+120 字摘要 ≈ 150 字) → 输出 5 段 JSON 数组(~200 tok)。
    # 输入按采样上限计(章节更多也不会超过 30 行);输出固定极小。
    return 6000, 400
