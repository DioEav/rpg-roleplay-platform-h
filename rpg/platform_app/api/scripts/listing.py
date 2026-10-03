"""platform_app.api.scripts.listing —— 剧本列表 + 状态/元数据只读端点。

/api/scripts、modules-status、embed/status、chapter-facts、timeline、birthpoints、
recommend-identity。纯机械搬家,行为零变化。
"""
from __future__ import annotations

from typing import Any

from fastapi import Depends, Request

from ... import knowledge
from ...db import connect
from .._deps import json_response, require_user, value_error_response
from ._shared import router


@router.get("/api/scripts")
# 同步 def:scripts_page 在协程里阻塞事件循环 → 启动六路请求被迫串行。线程池并行。
# 回归锁同 tests/unit/test_boot_endpoints_sync.py。
def api_scripts(limit: int | None = None, cursor: str | None = None, user=Depends(require_user)):
    from ... import workspace
    return json_response({"ok": True, **workspace.scripts_page(user["id"], limit, cursor)})


# phase_backend: 旧 POST /api/scripts/{id}/embed 移到 api/imports.py 作为
# /rebuild/embeddings 的 alias(走统一 import_jobs + SSE);此处只留 /embed/status。


@router.get("/api/scripts/{script_id}/modules-status")
async def api_script_modules_status(script_id: int, user=Depends(require_user)):
    """phase_backend: 一次返 7 模块各自的 done/total/stale/last_job_id。

    7 模块:chunks/chapter-facts/canon/cards/worldbook/anchors/embeddings
    每模块返:
      done: 当前已落库的行数(>0 即视为可用)
      total: 目标数(章节数 / canon entity 数 等参考值)
      stale: 是否过期(若有更晚的同 script 写入但本模块未跟上,如 chapters 改了但 chunks 未重建)
      last_job_id: 最近一次本模块的 import_jobs.job_id(可用于继续/重订 SSE)
    """
    with connect() as db:
        owned = db.execute(
            """select s.chapter_count, s.updated_at,
                      (select max(updated_at) from script_chapters sc
                        where sc.script_id = s.id) as chapters_updated_at
            from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        # stale 判定的时间源 = **章节表**的最后变更时间,而非 scripts.updated_at:
        # 后者被提取流水线收尾(review_status 重置 + updated_at=now())、编辑 commit 等
        # 大量非章节操作顶新 → 全矩阵模块被误标「需要重建」(实测:全量提取完成后
        # 7 卡全亮)。章节被合并/拆分/编辑才会 bump 章节行 updated_at,语义精确。
        script_updated = owned.get("chapters_updated_at") or owned.get("updated_at")
        chapter_count = int(owned.get("chapter_count") or 0)

        # 各模块当前 done / total
        def _scalar(sql: str) -> int:
            row = db.execute(sql, (script_id,)).fetchone()
            return int(row["c"]) if row else 0

        chunks_done = _scalar("select count(*) as c from document_chunks where script_id = %s")
        facts_done = _scalar("select count(*) as c from chapter_facts where script_id = %s")
        # 阶段划分(额外卡):done = 已有阶段标签的章数,total = 总章数
        story_phase_done = _scalar(
            "select count(*) as c from chapter_facts where script_id = %s and coalesce(story_phase,'') <> ''"
        )
        # 章节摘要精炼(额外卡):done = LLM 真摘要的章数(source=llm_refined),total = 总章数
        refine_done = _scalar(
            "select count(*) as c from chapter_facts where script_id = %s "
            "and metadata->>'source' = 'llm_refined'"
        )
        # 世界书条目充实(额外卡):done/total = 可充实的核心条目数
        # (标题命中 力量|概念|势力|体系 模式,与 enrich 执行侧同一口径)
        enrich_total = _scalar(
            "select count(*) as c from worldbook_entries where script_id = %s and title ~ '力量|概念|势力|体系'"
        )
        # 世界观切分回填(额外卡):done = 已回填 worldline_key 的章数,total = 总章数。
        # 单世界书(worldless)特殊处理:回填器会如实返回「未发现多世界结构」,该模块对
        # 这本书是**不适用**而非缺失 —— done=total(=总章数) 让状态派生为 ready,
        # 前端展示为「N 章 · 覆盖 N 章(单世界)」的中性信息,而非永远「缺失」的伪失败。
        world_key_done = _scalar(
            "select count(*) as c from chapter_facts where script_id = %s and coalesce(worldline_key,'') <> ''"
        )
        world_key_not_applicable = False
        row_na = db.execute(
            """select error from import_jobs
               where script_id = %s and kind = 'rebuild_world_key'
                 and error like '%%未发现多世界结构%%'
               order by id desc limit 1""",
            (script_id,),
        ).fetchone()
        if row_na:
            world_key_not_applicable = True
            world_key_done = max(world_key_done, 1)  # 占位使 done>=total 成立(具体数值前端不渲染)
        canon_done = _scalar("select count(*) as c from kb_canon_entities where script_id = %s")
        cards_done = _scalar("select count(*) as c from character_cards where script_id = %s and card_type='npc'")
        wb_done = _scalar("select count(*) as c from worldbook_entries where script_id = %s")
        anchors_done = _scalar("select count(*) as c from script_timeline_anchors where script_id = %s")
        # embeddings — chunks 的 embedding_vec 是真相源(不是 jsonb embedding)
        embed_done = _scalar(
            "select count(*) as c from document_chunks where script_id = %s and embedding_vec is not null"
        )

        # 每模块最近一次 job(by kind)
        # kind → 该任务刷新的**模块列表**(多数任务只影响一个模块;全量类任务覆盖多个)。
        # 全量类(llm_extract/full_pipeline)必须计入其覆盖的各模块最近任务 —— 否则全量
        # 提取完成后,知识库人物/世界书/锚点/角色卡的数据明明已刷新,卡片却因为
        # last_job 还停在旧的单模块重做而显示「需要重建」(误报)。
        kind_to_modules = {
            "rebuild_chunks": ["chunks"],
            "rebuild_facts": ["chapter-facts"],
            "rebuild_canon": ["canon"],
            "rebuild_cards": ["cards"],
            "rebuild_worldbook": ["worldbook"],
            "rebuild_anchors": ["anchors"],
            "rebuild_embeddings": ["embeddings"],
            "rebuild_facts_refine": ["facts_refine"],
            "rebuild_worldbook_enrich": ["worldbook_enrich"],
            "rebuild_world_key": ["world_key"],
            "rebuild_story_phase": ["story_phase"],
            "llm_extract": ["canon", "cards", "anchors", "worldbook"],
            "full_pipeline": ["chunks", "chapter-facts", "canon", "cards",
                              "worldbook", "anchors", "embeddings", "story_phase"],
        }
        job_rows = db.execute(
            "select kind, job_id, status, finished_at, created_at "
            "from import_jobs where script_id = %s "
            "order by created_at desc limit 50",
            (script_id,),
        ).fetchall()
        last_job_by_module: dict[str, dict[str, Any]] = {}
        for r in job_rows:
            kind = r.get("kind") or ""
            for mod in kind_to_modules.get(kind) or []:
                if mod in last_job_by_module:
                    continue  # job_rows 按时间倒序,首个即该模块最近一次
                last_job_by_module[mod] = {
                    "job_id": r.get("job_id"),
                    "status": r.get("status"),
                    "finished_at": str(r.get("finished_at")) if r.get("finished_at") else None,
                    "kind": kind,
                }

    # E2E 暴露:rebuild-panel agent 的前端读 m.done_count/m.total_count/m.status,
    # 但 _build 返的是 done/total + 没 status → 卡片"条数:—" + "modules.status.unknown"
    # 同时双写新字段(done_count/total_count/status)+ 老字段(done/total)兼容
    def _build(name: str, done: int, total: int, not_applicable: bool = False) -> dict[str, Any]:
        lj = last_job_by_module.get(name)
        stale = False
        if lj and lj.get("finished_at") and script_updated and done > 0:
            stale = str(script_updated) > str(lj.get("finished_at"))
        # status 派生:
        #   running: 有活跃 job (pending/running)
        #   stale:   旧版数据但 chapters 已变
        #   ready:   done>=total>0 或 done>0 且 total=0(canon/cards 等无 total 概念)
        #   partial: 0<done<total
        #   missing: done==0
        #   n/a:     模块对该剧本不适用(如单世界书的世界观切分)——非缺失也非失败
        if not_applicable:
            status = "n/a"
        elif lj and lj.get("status") in ("pending", "running"):
            status = "running"
        elif stale:
            status = "stale"
        elif total > 0:
            status = "ready" if done >= total else ("partial" if done > 0 else "missing")
        else:
            status = "ready" if done > 0 else "missing"
        return {
            "module": name,
            "done": done,
            "total": total,
            "done_count": done,       # 新字段名,前端 ModuleStatusCard 期望的
            "total_count": total,     # 同上
            "status": status,         # 派生 'ready'|'partial'|'missing'|'stale'|'running'|'n/a'
            "not_applicable": not_applicable,
            "stale": stale,
            "last_job_id": (lj or {}).get("job_id"),
            "last_status": (lj or {}).get("status"),
        }

    return json_response({
        "ok": True,
        "script_id": script_id,
        "modules": [
            _build("chunks", chunks_done, max(chapter_count, 1)),
            _build("chapter-facts", facts_done, max(chapter_count, 1)),
            _build("story_phase", story_phase_done, max(chapter_count, 1)),
            # 三张操作型额外卡:done/total 反映各自的操作覆盖面
            # (摘要精炼/世界观切分按章计;条目充实按可充实条目计,0=无可充实条目→ready)
            _build("facts_refine", refine_done, max(chapter_count, 1)),
            _build("worldbook_enrich", enrich_total, 0),
            _build("world_key", world_key_done, max(chapter_count, 1), not_applicable=world_key_not_applicable),
            _build("canon", canon_done, 0),
            _build("cards", cards_done, 0),
            _build("worldbook", wb_done, 0),
            _build("anchors", anchors_done, 0),
            _build("embeddings", embed_done, max(chunks_done, 1)),
        ],
    })


@router.get("/api/scripts/{script_id}/embed/status")
async def api_script_embed_status(script_id: int, user=Depends(require_user)):
    """task 51: 查询某剧本的向量化进度。前端轮询用。"""
    from ...knowledge import embedding as _embed
    with connect() as db:
        owned = db.execute(
            """select 1 from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
    if not owned:
        return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
    return json_response({"ok": True, "status": _embed.embed_status(script_id)})


@router.get("/api/scripts/{script_id}/chapter-facts")
async def api_script_chapter_facts(script_id: int, limit: int | None = None, cursor: str | None = None, user=Depends(require_user)):
    try:
        return json_response({"ok": True, **knowledge.list_chapter_facts(user["id"], script_id, limit, cursor)})
    except ValueError as exc:
        return value_error_response(exc)


@router.get("/api/scripts/{script_id}/timeline")
async def api_script_timeline(script_id: int, user=Depends(require_user)):
    """剧本时间线锚点 — script_timeline_anchors 全量按 chapter_min 顺序返。

    跟 /birthpoints (按 phase 聚合采样,给入场选择用) 不同:
    本 endpoint 给"时间线编辑器 tab"用,要看到所有 anchor + 故事时间标签。
    返:{phases: [{phase_label, anchors: [{chapter_min/max, story_time_label, sample_summary, story_phase}]}]}
    若 story_phase 全为空(LLM extract 没填),把全部 anchor 放到一个"未分阶段"桶。
    """
    with connect() as db:
        owned = db.execute(
            """select 1 from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        rows = db.execute(
            """
            select id, story_phase, story_time_label, chapter_min, chapter_max,
                   chapter_count, sample_summary, confidence, keywords, sample_title
            from script_timeline_anchors
            where script_id = %s
            order by chapter_min asc, id asc
            """,
            (script_id,),
        ).fetchall()
    # 按 story_phase 聚合;phase 全空时归"未分阶段"
    buckets: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        phase = (r.get("story_phase") or "").strip() or "未分阶段"
        buckets.setdefault(phase, []).append({
            "anchor_id": r["id"],
            "id": r["id"],
            "story_time_label": r["story_time_label"],
            "chapter_min": r["chapter_min"],
            "chapter_max": r["chapter_max"],
            "chapter_count": r["chapter_count"],
            "sample_summary": r["sample_summary"],
            "confidence": float(r["confidence"] or 0),
            # 编辑器锚点编辑需全字段回显,否则用户在「看似为空」的 keywords/sample_title 里输入
            # 会静默覆盖 DB 真实值(审计 P0 数据丢失)。keywords 是 text[] → 原样返回数组。
            "keywords": r["keywords"] or [],
            "sample_title": r["sample_title"] or "",
        })
    phases = []
    for p, items in buckets.items():
        cmins = [a["chapter_min"] for a in items if a.get("chapter_min") is not None]
        cmaxs = [a["chapter_max"] for a in items if a.get("chapter_max") is not None]
        phases.append({
            "phase_label": p,
            "chapter_min": min(cmins) if cmins else None,
            "chapter_max": max(cmaxs) if cmaxs else None,
            "anchor_count": len(items),
            "anchors": items,
        })
    return json_response({"ok": True, "phases": phases, "total": len(rows)})


@router.get("/api/scripts/{script_id}/birthpoints")
async def api_script_birthpoints(script_id: int, user=Depends(require_user)):
    """入场选出生点：按 phase 聚合 + 每 phase 均匀采样代表性 anchor。

    返回 phase_digests 的各阶段，以及每阶段从 script_timeline_anchors 均匀采样的
    5-15 个 anchor（≤15 全取，否则步长 round(N/12) 采样）。
    """
    with connect() as db:
        owned = db.execute(
            """select 1 from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)

        # 全部锚点(按章序)。真实锚点是唯一可靠数据源 —— phase_digests 的 chapter_min/max
        # 在历史迁移后常与锚点的章号不在同一标尺(实测多剧本:phase 范围覆盖全书但锚点只落早章,
        # 或 phase 用阶段序号当章号),strict containment 会让整段出生点空掉(用户「显示不出来」)。
        all_anchors = db.execute(
            """
            select id, story_time_label, chapter_min, chapter_max, chapter_count, sample_summary
            from script_timeline_anchors
            where script_id = %s
              and coalesce(source, 'novel') = 'novel'
            order by chapter_min asc, id asc
            """,
            (script_id,),
        ).fetchall()
        if not all_anchors:
            # 无锚点 → 前端走空态(从头开始),不渲染空的 phase 手风琴。
            return json_response({"ok": True, "phases": []})

        phase_rows = db.execute(
            """
            select phase_label, chapter_min, chapter_max, chapter_count, summary
            from phase_digests
            where script_id = %s
            order by chapter_min asc
            """,
            (script_id,),
        ).fetchall()

        def _sample(rows):
            # ≤15 全取，否则步长 round(N/12) 均匀采样 + 末尾兜底
            n = len(rows)
            if n <= 15:
                return list(rows)
            step = max(1, round(n / 12))
            s = list(rows[::step])
            if rows[-1] not in s:
                s.append(rows[-1])
            return s

        def _dto(ar):
            return {
                "anchor_id": int(ar["id"]),
                "story_time_label": ar["story_time_label"],
                "chapter_min": int(ar["chapter_min"]),
                "chapter_max": int(ar["chapter_max"]),
                "chapter_count": int(ar["chapter_count"]),
                "sample_summary": ar["sample_summary"] or "",
            }

        # 优先:phase_digests 与锚点「完全对齐」(所有锚点都按重叠落进某段 + 每段非空)
        # 才用富 phase 信息(真实 arc 标签/章号/摘要)。
        phases = None
        if phase_rows:
            buckets = [[] for _ in phase_rows]
            unassigned = 0
            for a in all_anchors:
                amin, amax = int(a["chapter_min"]), int(a["chapter_max"])
                hit = next(
                    (i for i, pr in enumerate(phase_rows)
                     if amin <= int(pr["chapter_max"]) and amax >= int(pr["chapter_min"])),
                    None,
                )
                if hit is None:
                    unassigned += 1
                else:
                    buckets[hit].append(a)
            if unassigned == 0 and all(buckets):
                phases = [
                    {
                        "phase_label": pr["phase_label"],
                        "chapter_min": int(pr["chapter_min"]),
                        "chapter_max": int(pr["chapter_max"]),
                        "chapter_count": int(pr["chapter_count"]),
                        "summary": pr["summary"] or "",
                        "anchors": [_dto(ar) for ar in _sample(buckets[i])],
                    }
                    for i, pr in enumerate(phase_rows)
                ]

        # 否则(phase_digests 缺失 / 与锚点章号错位)→ 直接把真实锚点按序均分成 N 段,
        # 沿用 arc 标签命名,每段章号取该段锚点的真实首尾 —— 保证每段都有真实锚点、绝不空。
        if phases is None:
            labels = [pr["phase_label"] for pr in phase_rows] if phase_rows else \
                ["开端", "发展前期", "发展中期", "发展后期", "结局"]
            n_seg = max(1, len(labels))
            total = len(all_anchors)
            phases = []
            for i in range(n_seg):
                seg = all_anchors[(total * i) // n_seg:(total * (i + 1)) // n_seg]
                if not seg:
                    continue
                phases.append({
                    "phase_label": labels[i] if i < len(labels) else f"阶段 {i + 1}",
                    "chapter_min": int(seg[0]["chapter_min"]),
                    "chapter_max": int(seg[-1]["chapter_max"]),
                    "chapter_count": int(seg[-1]["chapter_max"]) - int(seg[0]["chapter_min"]) + 1,
                    "summary": "",
                    "anchors": [_dto(ar) for ar in _sample(seg)],
                })

    return json_response({"ok": True, "phases": phases})


@router.post("/api/scripts/{script_id}/recommend-identity")
async def api_script_recommend_identity(request: Request, script_id: int, user=Depends(require_user)):
    """task 123: 入场 wizard Step 4 — LLM 推荐玩家初始身份。
    入参 body: {birthpoint_phase, birthpoint_label, character_card_id?, character_card_kind?, n?}
    返回: {ok, recommendations: [{name, role, background}, ...]}
    """
    body = await request.json()
    # 校验 script 归属
    with connect() as db:
        owned = db.execute(
            """select 1 from scripts s
            where s.id = %s and (
              s.owner_id = %s
              or s.id in (select script_id from user_script_subscriptions where user_id = %s)
            )""",
            (script_id, user["id"], user["id"]),
        ).fetchone()
        if not owned:
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
    # 调 recommend_player_identity 工具
    try:
        import secrets as _sec

        from console_assistant import dispatch_assistant_tool
        args = {
            "script_id": int(script_id),
            "birthpoint_phase": str(body.get("birthpoint_phase") or ""),
            "birthpoint_label": str(body.get("birthpoint_label") or ""),
            "n": int(body.get("n") or 4),
        }
        if body.get("character_card_id") is not None:
            args["character_card_id"] = int(body["character_card_id"])
        if body.get("character_card_kind"):
            args["character_card_kind"] = str(body["character_card_kind"])
        # player_origin: 'isekai'(穿越/转生) | 'native'(原作角色) — 透到 LLM 工具,
        # 决定生成的 4 个候选是"现代灵魂穿越成 X"还是"原作世界里的 X 身份"
        po = str(body.get("player_origin") or "").lower()
        if po == "isekai":
            po = "soul"  # 旧值兼容
        if po in ("soul", "body", "dual", "native"):
            args["player_origin"] = po
        result = dispatch_assistant_tool(
            user_id=int(user["id"]),
            tool="recommend_player_identity",
            args=args,
            save_id=None,
            script_id=int(script_id),
            trace_id=f"wizard-{_sec.token_urlsafe(6)}",
            call_id=f"wiz-{_sec.token_urlsafe(6)}",
        )
        # 工具 return JSON 字符串, parse 一下
        import json as _j
        try:
            payload = _j.loads(result.result) if isinstance(result.result, str) else result.result
        except Exception:
            payload = {"ok": False, "error": "无法解析推荐结果", "raw": str(result.result)[:200]}
        if not result.ok:
            return json_response({"ok": False, "error": result.error or "工具执行失败"}, status_code=200)
        # task: 工具自报 ok=false (LLM 403 / 上下文不足 / 模型不可用 等)返 200 + ok:false,
        # payload.error 含详细原因(如 Vertex 403:用户 SA 缺权限 / 未启用 API)。
        # 前端按 ok 字段判断,不再被 HTTP 502 generic message 吞掉真因。
        # (旧设计返 502 让前端"区分系统问题",反而让真错误信息丢失。)
        if isinstance(payload, dict) and payload.get("ok") is False:
            return json_response(payload, status_code=200)
        return json_response(payload)
    except Exception as exc:
        return json_response(
            {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
            status_code=500,
        )
