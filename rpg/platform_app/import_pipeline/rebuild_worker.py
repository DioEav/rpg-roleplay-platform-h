"""import_pipeline.rebuild_worker — rebuild job worker

来源: 原 rpg/platform_app/import_pipeline.py _run_module_rebuild / _count(原 L2847-3209) 区段,纯机械搬家(函数体逐字未动),零行为变化。
"""
from __future__ import annotations

import time
from typing import Any

from ..db import connect
from .control import JobController
from .rebuild_modules import (
    rebuild_cards_from_canon,
    rebuild_cards_with_llm,
    rebuild_chunks_from_db,
    rebuild_facts_from_db,
    rebuild_worldbook_with_llm,
)
from .rebuild_registry import REBUILD_MODULES
from .runner import _finalize_cancelled, finalize_job_if_unterminated
from .stages_llm import _resolve_extractor_llm, _stage_story_phase_llm, _stage_worldbook


def _run_module_rebuild(
    job_id: str, user_id: int, script_id: int, module: str, body: dict[str, Any],
) -> None:
    """rebuild worker。统一 import_jobs + SSE,失败标 failed,
    partial 失败标 done_with_errors,写 before/after_count + warnings。

    取消语义(v1.78.9 修):此前本 worker **一个 ctl.is_cancelled() 都没有** —— /cancel 端点
    只把 import_jobs.cancel_requested 置 true,没有任何人读它,任务照跑到底。表现为「点取消
    一直卡在那里,取消了几十分钟」(群反馈:大道),facts_refine 这种整本逐章调 LLM 的模块
    正好是最慢的那批。现在:① 派发前先看一眼(排队期间被取消的直接不跑);② 长循环模块把
    ctl.is_cancelled 作为 should_cancel 传进去,在章/条边界退出;③ 收尾时若已取消,落
    'cancelled' 而不是 'done'(否则用户点了取消最后还是看到"重做完成")。"""
    ctl = JobController(job_id)
    ctl.update(status="running", stage=module, overall_progress=0)
    with connect() as db:
        db.execute("update import_jobs set started_at = now() where job_id = %s", (job_id,))
    try:
        # ① 派发前检查:任务可能在排队(queued)期间就被取消了,那一步 LLM 都不该烧。
        if ctl.is_cancelled():
            return _finalize_cancelled(ctl)
        if module == "chunks":
            result = _rebuild_chunks(ctl, user_id, script_id, body)
        elif module == "chapter-facts":
            result = _rebuild_chapter_facts(ctl, user_id, script_id, body)
        elif module == "cards":
            result = _rebuild_cards(ctl, user_id, script_id, body)
        elif module == "canon":
            result = _rebuild_canon(ctl, user_id, script_id, body)
        elif module == "worldbook":
            result = _rebuild_worldbook(ctl, user_id, script_id, body)
        elif module == "anchors":
            result = _rebuild_anchors(ctl, user_id, script_id, body)
        elif module == "embeddings":
            result = _rebuild_embeddings(ctl, user_id, script_id, body)
        elif module == "facts_refine":
            result = _rebuild_facts_refine(ctl, user_id, script_id, body)
        elif module == "worldbook_enrich":
            result = _rebuild_worldbook_enrich(ctl, user_id, script_id, body)
        elif module == "world_key":
            result = _rebuild_world_key(ctl, user_id, script_id, body)
        elif module == "story_phase":
            result = _rebuild_story_phase(ctl, user_id, script_id, body)
        else:
            result = {"ok": False, "error": f"unhandled module: {module}"}
        # ③ 收尾前先看取消:模块自己在检查点退出后会带 cancelled=True 回来;没带的模块
        #    (短任务/无循环)再查一次 DB 兜底。命中就落 'cancelled',不能覆盖成 'done' ——
        #    否则用户点了取消、等半天,最后弹的还是「重做完成」。
        if bool(result.get("cancelled")) or ctl.is_cancelled():
            return _finalize_cancelled(ctl)
        # 写终态 — 任何 partial_failures 标 done_with_errors
        partial_failures = list(result.get("partial_failures") or [])
        ok = bool(result.get("ok"))
        final_status = "done" if ok and not partial_failures else (
            "failed" if not ok else "done_with_errors"
        )
        ctl.update(
            status=final_status,
            stage="done",
            overall_progress=1,
            overall_total=1,   # 重置:canon 进度回传期间把 overall_total 改成弧数,终态要还原成 1/1=100%
            stage_progress=1,
            stage_total=1,
            source=str(result.get("source") or ""),
            before_count=int(result.get("before_count") or 0),
            after_count=int(result.get("after_count") or 0),
            warnings=partial_failures,
            error=str(result.get("error") or "")[:500],
            stages=[{
                "id": module,
                "label": REBUILD_MODULES[module][1],
                "status": "error" if final_status == "failed" else "done",
                "before_count": int(result.get("before_count") or 0),
                "after_count": int(result.get("after_count") or 0),
            }],
        )
        with connect() as db:
            db.execute(
                "update import_jobs set finished_at=now() where job_id=%s", (job_id,),
            )
    except (InterruptedError, KeyboardInterrupt):
        # 长任务(canon 全量 / cards LLM)在弧边界抛取消信号。必须单独接住并落
        # cancelled —— 旧实现只在模块返回后检查,取消要等整本书跑完才生效;
        # 若被下面的 except Exception 吞掉还会被标成 failed。
        return _finalize_cancelled(ctl)
    except Exception as exc:
        import logging as _logging
        import traceback as _tb
        _logging.getLogger(__name__).exception(
            "_run_module_rebuild %s failed: %s", job_id, exc,
        )
        ctl.update(
            status="failed",
            error=f"{type(exc).__name__}: {str(exc)[:400]}",
            warnings={
                "stage": module,
                "exception": type(exc).__name__,
                "traceback": _tb.format_exc()[:800],
            },
        )
        with connect() as db:
            db.execute(
                "update import_jobs set finished_at=now() where job_id=%s", (job_id,),
            )
    finally:
        # 兜底:无论正常/异常/被吞的错误,确保不留 status='running' 僵尸行(镜像 _run_pipeline)
        finalize_job_if_unterminated(job_id)


def _count(db, table: str, script_id: int) -> int:
    row = db.execute(
        f"select count(*) as c from {table} where script_id = %s", (script_id,),
    ).fetchone()
    return int(row["c"]) if row else 0


def _auto_embed_incremental(ctl, user_id, script_id, new_chunks: int) -> dict:
    """增量重切后自动补新块向量(best-effort)。

    只处理 chunks 进度:embed_script 内部还会顺带补 cards/worldbook 的 NULL,
    但本函数在 chunks done>=total 时立即返回,不等其它类型 —— 避免为一次改章
    等整本卡片向量。

    语义:
      · new_chunks==0 → skipped,不启动线程;
      · 凭证缺失 → 返回 ok=False + needs_credentials,调用方**不**因此把 chunks
        任务标失败(块数据本身是好的,向量由 embeddings 卡提示);
      · provider/线程失败 → ok=False,调用方记 partial_failure;
      · 用户取消 → ok=True + cancelled=True,worker 落 cancelled,后台线程继续补。
    """
    if new_chunks <= 0:
        return {"ok": True, "skipped": "no_new_chunks"}
    from ..knowledge import embedding as _embed

    try:
        start = _embed.embed_script(user_id, script_id)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}
    if start.get("ok") is False and not start.get("already_running"):
        return {
            "ok": False,
            "needs_credentials": bool(start.get("needs_credentials")),
            "error": str(start.get("error") or "embedding provider unavailable")[:300],
        }

    started = time.monotonic()
    last_done = -1
    stall_polls = 0
    retried = False
    while True:
        try:
            st = _embed.embed_status(script_id)
        except Exception as exc:
            return {"ok": False, "error": f"embed_status failed: {str(exc)[:200]}"}
        chunks = st.get("chunks") or {}
        done = int(chunks.get("done") or 0)
        total = int(chunks.get("total") or 0)
        try:
            ctl.update(
                stage="embedding",
                stage_progress=done, stage_total=max(total, 1),
                overall_progress=done, overall_total=max(total, 1),
            )
        except Exception:
            pass
        if total == 0:
            return {"ok": True, "done": 0, "total": 0}
        if done >= total:
            return {"ok": True, "done": done, "total": total}
        if ctl.is_cancelled():
            return {"ok": True, "cancelled": True, "done": done, "total": total}
        if not st.get("running"):
            # 另一条 embed 线程可能已跑过 chunks 阶段,新块没被拾取 → 再触发一轮。
            if not retried:
                retried = True
                try:
                    _embed.embed_script(user_id, script_id)
                except Exception:
                    pass
                time.sleep(1)
                continue
            return {
                "ok": False, "done": done, "total": total,
                "error": f"embedding incomplete {done}/{total}",
            }
        if done == last_done:
            stall_polls += 1
        else:
            stall_polls = 0
            last_done = done
        if stall_polls >= 40:
            return {
                "ok": False, "done": done, "total": total,
                "error": "embedding stalled 120s",
            }
        if time.monotonic() - started > 15 * 60:
            return {
                "ok": False, "done": done, "total": total,
                "error": "embedding timeout 15min",
            }
        time.sleep(3)


def _rebuild_chunks(ctl, user_id, script_id, body) -> dict:
    # 阶段 4:默认增量(只重切变更章);用户/结构变更可显式传 incremental=false 全量。
    result = rebuild_chunks_from_db(
        user_id, script_id,
        incremental=bool(body.get("incremental", True)),
    )
    # 增量重切产生的新块 embedding_vec 为 NULL:自动补一次,避免用户忘了点「向量索引」。
    # 全量重切不走自动补(可能整本重嵌,成本和旧行为一致,交给 embeddings 模块)。
    if result.get("ok") and result.get("mode") == "incremental":
        emb = _auto_embed_incremental(
            ctl, user_id, script_id, int(result.get("new_chunks") or 0),
        )
        result["extra"] = {"auto_embedding": emb}
        if emb.get("cancelled"):
            result["cancelled"] = True
        elif not emb.get("ok") and not emb.get("needs_credentials"):
            result.setdefault("partial_failures", []).append({
                "stage": "auto_embedding",
                "error": str(emb.get("error") or "embedding failed"),
            })
    return result


def _rebuild_chapter_facts(ctl, user_id, script_id, body) -> dict:
    result = rebuild_facts_from_db(user_id, script_id)
    return result


def _rebuild_cards(ctl, user_id, script_id, body) -> dict:
    source = str(body.get("source") or body.get("mode") or "")
    # 进度感知角色卡:chapter_max 区间 + 可选 LLM 丰富(source/mode=='llm')。
    cmax_raw = body.get("chapter_max")
    try:
        cmax = int(cmax_raw) if cmax_raw not in (None, "") else None
    except (TypeError, ValueError):
        cmax = None
    # 手编保护(字段级,默认开):manual_fields 里的字段不覆盖。
    # 弹窗「强制覆盖手编字段」勾选时传 force_overwrite_manual=true → 全部刷新。
    # 兼容旧 API:preserve_existing=false 仍等价于强制覆盖。
    if "force_overwrite_manual" in body:
        preserve_existing = not bool(body.get("force_overwrite_manual"))
    else:
        preserve_existing = bool(body.get("preserve_existing", True))
    if source == "llm":
        # 进度只有 0/100 的根因:此前只有 arc_extract 阶段写 overall_progress,seed/
        # per_chapter/resolve/embed 只写 stage_progress,而前端浮窗读的是 overall_*。给每个
        # 阶段分配一段 overall 进度带,段内按 done/total 线性插值 → 全程平滑推进。
        _BANDS = {"seed": (0, 5), "per_chapter": (5, 60), "arc_extract": (60, 85),
                  "resolve": (85, 95), "embed": (95, 100)}

        def _cards_progress(stage: str, info: dict) -> None:
            # 取消检查点:arc 每完成一弧回调一次,命中即抛 InterruptedError,
            # 由 run_arc_extraction 取消未开始的 future 并一路冒泡到 worker。
            if ctl.is_cancelled():
                raise InterruptedError("cancelled")
            try:
                total = int(info.get("total") or 0)
                done = int(info.get("done") or 0)
                band = _BANDS.get(stage)
                if band:
                    lo, hi = band
                    frac = (done / total) if total > 0 else 0.0
                    overall = int(lo + (hi - lo) * max(0.0, min(1.0, frac)))
                    ctl.update(stage=stage, stage_progress=done, stage_total=max(total, 1),
                               overall_progress=overall, overall_total=100)
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass
        # 模型兜底与 estimate/凭证闸同源(_resolve_extractor_llm):此前硬编码
        # deepseek/deepseek-v4-flash,而 schedule_module_rebuild 的 require_user_llm_credential
        # 校验的是用户提取模型凭证 —— 没配 deepseek key 的用户过闸后执行必败,且失败被
        # extract_chapter 吞成空壳 → 假「重做完成」(实测 script 1 五连 done、0 实体 0 token)。
        _def_api, _def_model = _resolve_extractor_llm(user_id)
        result = rebuild_cards_with_llm(
            user_id, script_id, chapter_max=cmax,
            model=str(body.get("model") or _def_model),
            api_id=str(body.get("api_id") or _def_api),
            progress_cb=_cards_progress,
            preserve_existing=preserve_existing,
            # force 必须同时进 LLM 重抽阶段：否则 canon 手编字段仍被保护，回填读不到新值。
            force_overwrite_manual=not preserve_existing,
        )
    else:
        result = rebuild_cards_from_canon(
            user_id, script_id, chapter_max=cmax, preserve_existing=preserve_existing,
        )
    return result


def _rebuild_canon(ctl, user_id, script_id, body) -> dict:
    source = str(body.get("source") or body.get("mode") or "")
    force_manual = bool(body.get("force_overwrite_manual"))
    # full = 重抽 LLM;resolve_only = 从 chapter_extracts 重 cluster (零 LLM)
    from extract.rebuild import rebuild_canon_resolve_from_facts
    if source == "resolve_only":
        with connect() as db:
            result = rebuild_canon_resolve_from_facts(
                db, script_id, include_editor=force_manual,
            )
    else:
        # full LLM: 走 schedule_llm_extraction 同款 (但这里直接调底层)
        from platform_app.knowledge.llm_extract import run_llm_extraction
        # db 复用修复:上面写 started_at 的 with connect() 已退出、连接已还池,这里不能再用
        # 那个 db(workers≥2 时可能已被别的 worker 取走 = 未定义行为)。各取独立连接。
        with connect() as _dbc:
            before = _count(_dbc, "kb_canon_entities", script_id)
        # 进度回传:arc 每弧完成 → 更新 overall 进度。否则整段 ~100 弧提取期 overall_progress
        # 恒 0、stage 卡在 canon,用户以为卡死(实则后台在烧)。arc_extract 是主阶段,映射到
        # overall;done/total 由 as_completed 串行回调,无并发竞争。终态会把 overall_total
        # 重置回 1(见下方写终态),避免 done 时显示 1/弧数。
        def _canon_progress(stage: str, info: dict) -> None:
            # 取消检查点(2026-10):canon 全量是整本最烧钱的模块,旧实现只在派发前/
            # 返回后看 cancel_requested → 点取消仍要跑完整本书。arc 每完成一弧都会回调
            # 这里,抛 InterruptedError 后 run_arc_extraction 会取消未开始的 future 并
            # 一路冒泡到 worker,终态落 cancelled。
            if ctl.is_cancelled():
                raise InterruptedError("cancelled")
            try:
                total = int(info.get("total") or 0)
                done = int(info.get("done") or 0)
                if stage == "arc_extract" and total:
                    ctl.update(stage="arc_extract", stage_progress=done,
                               stage_total=total, overall_progress=done,
                               overall_total=max(total, 1))
                elif stage in ("seed", "per_chapter", "resolve", "embed"):
                    ctl.update(stage=stage, stage_progress=done,
                               stage_total=max(total, 1))
            except (InterruptedError, KeyboardInterrupt):
                raise
            except Exception:
                pass
        # 模型兜底与 estimate/凭证闸同源(_resolve_extractor_llm),同 _rebuild_cards:
        # 硬编码 deepseek 会让没配 deepseek key 的用户「过闸即必败」,失败再被吞成空壳。
        _def_api, _def_model = _resolve_extractor_llm(user_id)
        r = run_llm_extraction(
            user_id, script_id,
            algorithm=str(body.get("algorithm") or "arc"),
            model=str(body.get("model") or _def_model),
            api_id=str(body.get("api_id") or _def_api),
            confirmed=True,
            progress_cb=_canon_progress,
            # 强制覆盖手编字段：一路传到 resolve_and_write，跳过 manual_fields guard。
            force_overwrite_manual=force_manual,
        )
        with connect() as _dbc:
            after = _count(_dbc, "kb_canon_entities", script_id) if r.get("ok") else before
        # partial_failures 必须透传(此前写死 []):arc 管线 success_ratio<0.9 时标了
        # 失败弧明细,丢掉的话 worker 收不到 → done_with_errors 退化成 done,用户看不到
        # 「成功 N/共 M 弧」之外的任何异常线索。
        result = {
            "ok": bool(r.get("ok")),
            "source": "llm_extract",
            "before_count": before,
            "after_count": after,
            "partial_failures": list(r.get("partial_failures") or []),
            "error": r.get("error") if not r.get("ok") else "",
        }
    return result


def _rebuild_worldbook(ctl, user_id, script_id, body) -> dict:
    source = str(body.get("source") or body.get("mode") or "")
    src = source or "canon"
    force_manual = bool(body.get("force_overwrite_manual"))
    if src == "llm":
        # 走 import pipeline 的 _stage_worldbook(单次 LLM)
        with connect() as db:
            before = db.execute(
                "select count(*) as c from worldbook_entries where script_id = %s",
                (script_id,),
            ).fetchone()
            before_count = int(before["c"]) if before else 0
        count = _stage_worldbook(
            ctl, user_id, script_id, force_overwrite_manual=force_manual,
        )
        # _stage_worldbook 的返回值只统计"真正插入/更新的行";与 editor/extracted
        # 同名的条目会被它有意跳过(rowcount=0)。旧实现用 count>0 判成功 → LLM 返回的
        # 条目如果全部与 canon 已建条目同名,明明按设计工作却报「重做失败」。
        # 成功条件改为:无异常 且 (写入>0 或 跳过重复>0);after_count 用表内真实总数
        # (旧实现直接把"新增数"当 after_count,和矩阵里的条数对不上)。
        stage_error = str(getattr(_stage_worldbook, "_last_error", "") or "")
        skipped_dup = int(getattr(_stage_worldbook, "_last_skipped", 0) or 0)
        with connect() as db:
            after_row = db.execute(
                "select count(*) as c from worldbook_entries where script_id = %s",
                (script_id,),
            ).fetchone()
        after_count = int(after_row["c"]) if after_row else before_count
        ok = (not stage_error) and (count > 0 or skipped_dup > 0)
        result = {
            "ok": ok, "source": "llm",
            "before_count": before_count, "after_count": after_count,
            "partial_failures": [] if ok else [
                {"stage": "worldbook",
                 "error": stage_error or "LLM returned 0 entries（未写入也未命中同名条目）"}
            ],
        }
    else:
        result = rebuild_worldbook_with_llm(
            user_id, script_id, source="canon",
            preserve_manual=not force_manual,
        )
    return result


def _rebuild_anchors(ctl, user_id, script_id, body) -> dict:
    with connect() as db:
        before = db.execute(
            "select count(*) as c from script_timeline_anchors where script_id = %s",
            (script_id,),
        ).fetchone()
        before_count = int(before["c"]) if before else 0
        from extract.rebuild import rebuild_timeline_from_db
        r = rebuild_timeline_from_db(
            db, script_id,
            include_editor=bool(body.get("force_overwrite_manual")),
        )
        after = db.execute(
            "select count(*) as c from script_timeline_anchors where script_id = %s",
            (script_id,),
        ).fetchone()
        after_count = int(after["c"]) if after else 0
        result = {
            "ok": bool(r.get("ok")),
            "source": "chapter_facts",
            "before_count": before_count,
            "after_count": after_count,
            "partial_failures": [],
            "error": r.get("error") if not r.get("ok") else "",
        }
    return result


def _rebuild_story_phase(ctl, user_id, script_id, body) -> dict:
    """阶段划分重做:LLM 把章节分到 开端/发展前期/中期/后期/结局 五阶段 →
    聚合 phase_digests → 把锚点的 story_phase 按章节重叠回填(多数阶段)。

    锚点**只更新 story_phase 字段**,不整表重建 —— 时间线锚点可能被用户手编过
    (keywords/story_time_label),rebuild_timeline_from_db 全量重算会冲掉这些编辑。
    前置:chapter_facts 非空(阶段划分以章节事实的摘要为输入)。
    """
    from .stages_core import _stage_phase_digests
    with connect() as _dbc:
        facts_n = _count(_dbc, "chapter_facts", script_id)
    if facts_n == 0:
        return {
            "ok": False, "source": "story_phase",
            "error": "chapter_facts 为空,请先重做「章节事实」再划分阶段",
            "partial_failures": [],
        }

    # 1) LLM 阶段划分。重做语义 = 重新划分:先清空旧阶段(_stage_story_phase_llm 只补
    #    story_phase 为空的行,不清空的话第二次重做会静默 no-op);LLM 失败/解析失败时
    #    该函数内建 5 段均分兜底,不会把 chapter_facts 留空。单次调用,无取消检查点需求。
    with connect() as db:
        db.execute("update chapter_facts set story_phase = '' where script_id = %s", (script_id,))
    _stage_story_phase_llm(ctl, user_id, script_id)

    # 2) phase_digests 聚合(供 worldbook_agent.consult 按阶段取锚)
    n_phases = _stage_phase_digests(script_id)

    # 3) 锚点 story_phase 回填:每锚取其章节范围内 chapter_facts 的多数阶段
    with connect() as db:
        before = int(db.execute(
            "select count(*) as c from script_timeline_anchors "
            "where script_id = %s and coalesce(story_phase,'') <> ''",
            (script_id,),
        ).fetchone()["c"])
        db.execute(
            """
            update script_timeline_anchors a
               set story_phase = m.phase, updated_at = now()
              from (
                select a2.id as anchor_id,
                       (select cf.story_phase
                          from chapter_facts cf
                         where cf.script_id = a2.script_id
                           and cf.chapter between a2.chapter_min and a2.chapter_max
                           and coalesce(cf.story_phase,'') <> ''
                         group by cf.story_phase
                         order by count(*) desc
                         limit 1) as phase
                from script_timeline_anchors a2
                where a2.script_id = %(sid)s
              ) m
             where a.id = m.anchor_id and coalesce(m.phase,'') <> ''
            """,
            {"sid": script_id},
        )
        after = int(db.execute(
            "select count(*) as c from script_timeline_anchors "
            "where script_id = %s and coalesce(story_phase,'') <> ''",
            (script_id,),
        ).fetchone()["c"])

    result = {
        "ok": True,
        "source": "story_phase_llm",
        "before_count": before,
        "after_count": after,
        "partial_failures": [],
        "extra": {"phases": n_phases, "facts": facts_n, "anchors_phased": after - before},
    }
    return result


def _rebuild_embeddings(ctl, user_id, script_id, body) -> dict:
    """向量重嵌入。**任务在向量真正写完后才落 done。**

    旧实现:先强制清空向量 → `embed_script()` 起后台线程(fire-and-forget)→ 立即返回,
    `after_count` 直接用 chunks 总行数假装完成。结果是任务秒完成、矩阵仍显示 0/N,
    下一次有人在后台线程跑完前查 RAG 会拿到空结果。现在改成:
      1. 先记录 before(选中类型的已嵌入数);
      2. 清空选中类型 → canon 同步重嵌 → chunks/cards/worldbook 触发后台 embed 并
         **轮询到结束**(期间汇报真实进度、响应取消);
      3. after 用真实计数,残留 NULL 记为 partial failure。

    阶段 4 incremental(默认 false):不强制清空已有向量,只补 embedding_vec/embedding
    为 NULL 的条目。适合"刚增量重切/新增章节"后只补新块;内容已改但向量仍存在的
    cards/worldbook 不会被刷新(那需要 full)。
    """
    includes = list(body.get("include") or ["chunks", "cards", "worldbook", "canon"])
    includes = [k for k in includes if k in ("chunks", "cards", "worldbook", "canon")]
    if not includes:
        return {"ok": False, "error": "include 里没有可重嵌的类型（chunks/cards/worldbook/canon）"}
    incremental = bool(body.get("incremental"))
    from extract.embed import embed_canon_entities

    from ..knowledge import embedding as _embed
    counts = {}
    partial_failures = []
    # KB 卫生(设计 O §5.2):「重做」= 强制重嵌。先把被选类型的向量清成 NULL,再跑增量循环
    # (_embed_chunks_loop_inner / embed_canon_entities 都按 WHERE embedding_vec IS NULL 重嵌)→
    # 真重嵌全部,而非「秒完成」空操作(群反馈:世界书编辑后重做秒完成、实际没重新生成)。
    # embed_script 会重嵌 chunks+cards+worldbook,canon 由 embed_canon_entities 重嵌,故清空安全。
    _FORCE_CLEAR = {
        "chunks":    "update document_chunks set embedding_vec=NULL where script_id=%s",
        "cards":     "update character_cards set embedding_vec=NULL, embedded_at=NULL where script_id=%s and card_type='npc'",
        "worldbook": "update worldbook_entries set embedding_vec=NULL, embedded_at=NULL where script_id=%s",
        "canon":     "update kb_canon_entities set embedding=NULL where script_id=%s",
    }
    # before 必须在清空之前取:旧实现在清空后才数 → before 恒 0(任务卡"0 → N"是假的)。
    def _selected_counts() -> dict:
        st = _embed.embed_status(script_id)
        return {k: (int(st[k]["done"]), int(st[k]["total"])) for k in includes}

    before_counts = _selected_counts()
    before_count = sum(v[0] for v in before_counts.values())
    # 阶段 4:incremental 只补 NULL,不清已有向量。full 保持原"强制重嵌"语义。
    if not incremental:
        with connect() as db:
            for _k in includes:
                _sql = _FORCE_CLEAR.get(_k)
                if not _sql:
                    continue
                try:
                    db.execute(_sql, (script_id,))
                except Exception as exc:
                    partial_failures.append({"stage": f"force_clear_{_k}", "error": str(exc)})
            db.commit()
    with connect() as db:
        if "canon" in includes:
            try:
                # embed_canon_entities 默认 only_missing=True:full(已清空)会全嵌,
                # incremental(未清空)只补 NULL,正是阶段 4 要的行为。
                emb = embed_canon_entities(db, script_id, user_id=user_id)
                counts["canon"] = emb
            except Exception as exc:
                partial_failures.append({"stage": "embed_canon", "error": str(exc)})

    # chunks/cards/worldbook 走后台 embed 线程;这里等它真正结束。
    # 注意:embed_script 内部三类型一起跑(未选中的类型若本来就有 NULL 也会被补嵌)。
    # 这是幂等增量,不会动已有点向量,可接受;真正"未勾选 = 不重嵌"由 force_clear 保证。
    if any(k in includes for k in ("chunks", "cards", "worldbook")):
        for _round in range(2):
            try:
                start = _embed.embed_script(user_id, script_id)
            except Exception as exc:
                partial_failures.append({"stage": "embed_script", "error": str(exc)})
                break
            if start.get("ok") is False and not start.get("already_running"):
                partial_failures.append({
                    "stage": "embed_script",
                    "error": str(start.get("error") or "embedding provider unavailable"),
                })
                break
            # 轮询到后台线程结束;每 3s 用真实计数刷新 job 进度。
            # 两道保险,防止 job 永远卡在 running:
            #   · 120s 进度无变化 → 视为 provider/线程停滞(也可能是 Redis 里残留的
            #     运行锁把 embed_script 误判成 already_running),退出并标 partial;
            #   · 总等待 30 分钟 → 硬上限(超长书 + 慢 provider 的正常上限之上)。
            _wait_started = time.monotonic()
            _last_done = -1
            _stall_polls = 0
            while True:
                _cur = _selected_counts()
                _done = sum(v[0] for v in _cur.values())
                _total = sum(v[1] for v in _cur.values())
                if _done == _last_done:
                    _stall_polls += 1
                else:
                    _stall_polls = 0
                    _last_done = _done
                try:
                    ctl.update(
                        stage="embeddings",
                        stage_progress=_done, stage_total=max(_total, 1),
                        overall_progress=_done, overall_total=max(_total, 1),
                    )
                except Exception:
                    pass
                if ctl.is_cancelled():
                    # 后台线程无法安全中断(正在发 HTTP);让它自然跑完即可,
                    # 这里先如实返回 cancelled,由 worker 落终态。
                    return {
                        "ok": True, "source": "pgvector", "cancelled": True,
                        "before_count": before_count, "after_count": _done,
                        "partial_failures": partial_failures, "extra": {"counts": counts},
                    }
                if not _embed.embed_status(script_id).get("running"):
                    break
                if _stall_polls >= 40:
                    partial_failures.append({
                        "stage": "embedding_stalled",
                        "error": f"后台嵌入 120s 无进度（已完成 {_done}/{_total}），已停止等待；"
                                 "若 provider 正常，可稍后再次点重做补齐剩余条目。",
                    })
                    break
                if time.monotonic() - _wait_started > 30 * 60:
                    partial_failures.append({
                        "stage": "embedding_timeout",
                        "error": f"后台嵌入等待超过 30 分钟（已完成 {_done}/{_total}），已停止等待。",
                    })
                    break
                time.sleep(3)
            # 竞态:若另一条 embed 线程已跑过 cards/worldbook 阶段,刚被清空的向量可能
            # 不会被它拾取。检查选中类型是否仍有 NULL,有则再来一轮(最多 2 轮)。
            _left = any(
                _cur[k][0] < _cur[k][1] for k in includes
                if k in ("chunks", "cards", "worldbook")
            )
            if not _left:
                break

    after_counts = _selected_counts()
    after_count = sum(v[0] for v in after_counts.values())
    # 仍有 NULL = provider 失败/配额/模型下线;如实标 partial,不再谎报完成。
    leftover = {
        k: f"{after_counts[k][0]}/{after_counts[k][1]}"
        for k in includes
        if after_counts[k][0] < after_counts[k][1]
    }
    if leftover:
        partial_failures.append({
            "stage": "embedding_incomplete",
            "error": "仍有未嵌入条目: " + ", ".join(f"{k} {v}" for k, v in leftover.items()),
        })
    result = {
        "ok": True, "source": "pgvector",
        "before_count": before_count,
        "after_count": after_count,
        "partial_failures": partial_failures,
        "extra": {
            "counts": counts,
            "incremental": incremental,
            "before": {k: v[0] for k, v in before_counts.items()},
            "after": {k: v[0] for k, v in after_counts.items()},
            "total": {k: v[1] for k, v in after_counts.items()},
        },
    }
    return result


def _rebuild_facts_refine(ctl, user_id, script_id, body) -> dict:
    # extract.facts_refine.refine_script:逐章调 LLM 精炼 chapter_facts.summary/
    # in_world_time。options 透传 {ch_from, ch_to, api_id, model};不传 api_id/model
    # 时 refine_script 内部走 _resolve_recorder_api_and_model 解析用户默认模型。
    from extract.facts_refine import refine_script
    ch_from_raw = body.get("ch_from")
    ch_to_raw = body.get("ch_to")
    try:
        ch_from = int(ch_from_raw) if ch_from_raw not in (None, "") else 1
    except (TypeError, ValueError):
        ch_from = 1
    try:
        ch_to = int(ch_to_raw) if ch_to_raw not in (None, "") else None
    except (TypeError, ValueError):
        ch_to = None
    with connect() as _dbc:
        before = _count(_dbc, "chapter_facts", script_id)
    def _refine_progress(done: int, total: int) -> None:
        try:
            ctl.update(stage="facts_refine", stage_progress=int(done), stage_total=max(int(total), 1),
                       overall_progress=int(done), overall_total=max(int(total), 1))
        except Exception:
            pass
    r = refine_script(
        script_id, user_id,
        ch_from=ch_from, ch_to=ch_to,
        api_id=(body.get("api_id") or None), model=(body.get("model") or None),
        apply=True,
        should_cancel=ctl.is_cancelled, progress_cb=_refine_progress,
    )
    with connect() as _dbc:
        after = _count(_dbc, "chapter_facts", script_id)
    partial_failures = []
    if int(r.get("skipped") or 0) or int(r.get("failed") or 0):
        partial_failures.append({
            "stage": "facts_refine",
            "error": f"skipped={r.get('skipped')} failed={r.get('failed')}",
        })
    result = {
        "ok": bool(r.get("ok")),
        "source": "llm_refined",
        "before_count": before,
        "after_count": after,
        "partial_failures": partial_failures,
        "error": r.get("error") if not r.get("ok") else "",
        "cancelled": bool(r.get("cancelled")),
        "extra": {"refined": r.get("refined"), "range": r.get("range")},
    }
    return result


def _rebuild_worldbook_enrich(ctl, user_id, script_id, body) -> dict:
    # extract.worldbook_enrich.enrich_script_worldbook:命中 pattern 的世界书条目
    # LLM 重写 content。pattern 默认核心设定类词汇正则。
    from extract.worldbook_enrich import enrich_script_worldbook
    pattern = str(body.get("pattern") or "力量|概念|势力|体系")
    with connect() as _dbc:
        before = _count(_dbc, "worldbook_entries", script_id)
    def _enrich_progress(done: int, total: int) -> None:
        try:
            ctl.update(stage="worldbook_enrich", stage_progress=int(done), stage_total=max(int(total), 1),
                       overall_progress=int(done), overall_total=max(int(total), 1))
        except Exception:
            pass
    r = enrich_script_worldbook(
        script_id, user_id, pattern=pattern,
        api_id=(body.get("api_id") or None), model=(body.get("model") or None),
        apply=True,
        # 默认跳过 metadata.source='editor' 的手编条目 —— 与世界书/canon 重建的
        # "护手编"铁律一致。旧实现会无条件覆盖手编正文。需要覆盖时显式传
        # include_editor=true(API 可用,UI 不暴露)。
        include_editor=bool(body.get("include_editor")),
        should_cancel=ctl.is_cancelled, progress_cb=_enrich_progress,
    )
    entries = list(r.get("entries") or [])
    ok_count = sum(1 for e in entries if e.get("status") == "ok")
    partial_failures = [
        {"stage": "worldbook_enrich", "entry_id": e.get("id"), "error": e.get("status")}
        for e in entries if e.get("status") not in ("ok",)
    ]
    result = {
        "ok": bool(r.get("ok")),
        "source": "llm_enriched",
        "before_count": before,
        "after_count": before,   # UPDATE,不新增行;充实数用 extra.enriched 体现
        "partial_failures": partial_failures,
        "error": r.get("error") if not r.get("ok") else "",
        "cancelled": bool(r.get("cancelled")),
        "extra": {"enriched": ok_count, "total_matched": len(entries)},
    }
    return result


def _rebuild_world_key(ctl, user_id, script_id, body) -> dict:
    # extract.world_key_backfill.backfill_worldlines:结构先验回填 worldline_key/
    # in_world_time;body.use_llm 真值时追加第二层 LLM 窄确认(BYOK)。
    from extract.world_key_backfill import backfill_worldlines
    with connect() as _dbc:
        before = _count(_dbc, "script_timeline_anchors", script_id)
    r = backfill_worldlines(
        script_id,
        dry_run=False,
        use_llm=bool(body.get("use_llm")),
        user_id=user_id,
        api_id_override=(body.get("api_id") or None),
        model_override=(body.get("model") or None),
        should_cancel=ctl.is_cancelled,
    )
    with connect() as _dbc:
        after = _count(_dbc, "script_timeline_anchors", script_id)
    partial_failures = []
    if r.get("overcut"):
        partial_failures.append({
            "stage": "world_key",
            "error": "overcut:分段过密已整体退回单世界(null)",
        })
    # 单世界守卫:书无可识别的多世界结构 → 该模块无事可做。
    # 语义:**成功完成检查**并如实报告"不适用",不是失败 —— ok=True 落 done,
    # 状态接口(listing._build)按 error 文案判定 not_applicable → 卡片显示
    # 「— 不适用」而非红色「重做失败」;error 字段仍携带原因供前端提示。
    if r.get("worldless"):
        return {
            "ok": True,
            "source": "structural_prior" if not body.get("use_llm") else "structural_prior+llm",
            "before_count": before, "after_count": before,
            "partial_failures": [],
            "error": r.get("message") or "未发现多世界结构,无需世界观切分(此模块仅对无限流/穿越类多世界小说有意义)",
            "extra": {"written": 0, "worldless": True},
        }
    result = {
        "ok": True,
        "source": "structural_prior" if not body.get("use_llm") else "structural_prior+llm",
        "before_count": before,
        "after_count": after,
        "partial_failures": partial_failures,
        "cancelled": bool(r.get("cancelled")),
        "extra": {"written": r.get("written"), "would_write": r.get("would_write"),
                  "overcut": r.get("overcut")},
    }
    return result
