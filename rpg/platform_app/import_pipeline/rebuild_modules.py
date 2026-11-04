"""import_pipeline.rebuild_modules — 单模块 rebuild 函数(被 /rebuild/{module} 路由调用)

来源: 原 rpg/platform_app/import_pipeline.py rebuild_chunks_from_db / rebuild_facts_from_db / rebuild_cards_from_canon / rebuild_cards_with_llm / rebuild_worldbook_with_llm(原 L2154-2406) 区段,纯机械搬家(函数体逐字未动),零行为变化。
"""
from __future__ import annotations

from typing import Any

from ..db import connect
from ..knowledge._utils import CHUNK_VERSION
from ..perms import script_owned


# ══════════════════════════════════════════════════════════════════════
#  phase_backend: 单模块 rebuild 函数(被 /rebuild/{module} 路由调用)
#  各 rebuild 返 {ok, before_count, after_count, partial_failures, source}
# ══════════════════════════════════════════════════════════════════════
def _incremental_chunk_plan(
    db, script_id: int, chapters: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str]:
    """阶段 4:决定增量重切的范围。

    返回 (要重切的章, fallback_reason):
      · fallback_reason 非空 → 不安全,调用方必须全量(返回全部章);
      · 空串 → 只重切 changed 章节,其余章节的 chunks/向量原样保留。

    安全检查(任一命中即全量):
      · 没有任何旧 chunks(首次);
      · chunks.metadata.chunking_version ≠ 当前 CHUNK_VERSION(切片算法变了);
      · 有 orphan chunks(chapter_id 已不在 script_chapters);
      · chunk.chapter_index ≠ script_chapters.chapter_index(章号漂移/合并/重排);
      · 没有 created_at 基线。
    增量补齐:新增章/从未切过的非空章没有 chunks,按"变更章"只补它们,不回退全量。
    变更检测:script_chapters.updated_at > max(document_chunks.created_at)。
    """
    def _scalar(sql: str, params: tuple) -> int:
        row = db.execute(sql, params).fetchone()
        return int(row["c"]) if row else 0

    total_chunks = _scalar(
        "select count(*) as c from document_chunks where script_id = %s", (script_id,)
    )
    if total_chunks == 0:
        return list(chapters), "no_existing_chunks"

    version_mismatch = _scalar(
        "select count(*) as c from document_chunks where script_id = %s "
        "and coalesce(metadata->>'chunking_version','') <> %s",
        (script_id, CHUNK_VERSION),
    )
    if version_mismatch:
        return list(chapters), "chunking_version_changed"

    orphan = _scalar(
        "select count(*) as c from document_chunks dc where dc.script_id = %s "
        "and not exists (select 1 from script_chapters sc where sc.id = dc.chapter_id)",
        (script_id,),
    )
    if orphan:
        return list(chapters), "orphan_chunks"

    # 章号漂移(合并/删除/整本重排后 chapter_id 还在但 chapter_index 变了)→ 全量。
    # 新增章节不属于这里:它没有 chunks,会在下面 missing 列表里按"变更章"增量补齐。
    mismatch = _scalar(
        "select count(*) as c from document_chunks dc "
        "join script_chapters sc on sc.id = dc.chapter_id "
        "where dc.script_id = %s and dc.chapter_index <> sc.chapter_index",
        (script_id,),
    )
    if mismatch:
        return list(chapters), "chapter_structure_changed"

    missing_rows = db.execute(
        "select sc.chapter_index from script_chapters sc where sc.script_id = %s "
        "and length(coalesce(sc.content,'')) > 0 "
        "and not exists (select 1 from document_chunks dc where dc.chapter_id = sc.id) "
        "order by sc.chapter_index",
        (script_id,),
    ).fetchall()
    missing_idx = {int(r["chapter_index"]) for r in missing_rows}

    baseline_row = db.execute(
        "select max(created_at) as m from document_chunks where script_id = %s",
        (script_id,),
    ).fetchone()
    baseline = baseline_row.get("m") if isinstance(baseline_row, dict) else None
    if baseline is None:
        return list(chapters), "no_baseline"

    changed_rows = db.execute(
        "select chapter_index from script_chapters where script_id = %s "
        "and updated_at > %s order by chapter_index",
        (script_id, baseline),
    ).fetchall()
    changed_idx = missing_idx | {int(r["chapter_index"]) for r in changed_rows}
    return [c for c in chapters if int(c["chapter_index"]) in changed_idx], ""


def rebuild_chunks_from_db(user_id: int, script_id: int, *,
                          incremental: bool = True) -> dict[str, Any]:
    """零 LLM:重新切 document_chunks。

    incremental(阶段 4,默认 True):
      · 安全时只重切 updated_at > 旧 chunks.created_at 的章节,其余章节的
        chunks + embedding_vec 原样保留;
      · 首次/切片版本变化/章节结构变化/orphan chunks 命中 → 自动回退全量,
        并在返回体里带 fallback_reason;
      · incremental=False 强制全量(如重切/合并/删除章节后)。
    """
    from .. import knowledge
    partial_failures: list[dict[str, Any]] = []
    with connect() as db:
        before = db.execute(
            "select count(*) as c from document_chunks where script_id = %s",
            (script_id,),
        ).fetchone()
        before_count = int(before["c"]) if before else 0
        script = script_owned(db, script_id, user_id)
        if not script:
            return {"ok": False, "error": "无权访问该剧本"}
        book = knowledge._ensure_book(db, script)
        chapters = db.execute(
            "select * from script_chapters where script_id = %s order by chapter_index",
            (script_id,),
        ).fetchall()

        mode = "full"
        fallback_reason = ""
        changed_chapters: list[dict[str, Any]] = list(chapters)
        if incremental and chapters:
            changed_chapters, fallback_reason = _incremental_chunk_plan(
                db, script_id, chapters,
            )
            mode = "full" if fallback_reason else "incremental"
        elif not incremental:
            fallback_reason = "requested_full"

        # 全量:清整本;增量:只清变更章(按 chapter_id,不按章号,避免章号漂移误删)。
        if mode == "full":
            db.execute("delete from document_chunks where script_id = %s", (script_id,))
            deleted_count = before_count
            kept_chunks = 0
        else:
            deleted_count = 0
            if changed_chapters:
                chapter_ids = [c["id"] for c in changed_chapters]
                deleted_row = db.execute(
                    "select count(*) as c from document_chunks "
                    "where script_id = %s and chapter_id = any(%s)",
                    (script_id, chapter_ids),
                ).fetchone()
                deleted_count = int(deleted_row["c"]) if deleted_row else 0
                db.execute(
                    "delete from document_chunks where script_id = %s "
                    "and chapter_id = any(%s)",
                    (script_id, chapter_ids),
                )
            kept_chunks = max(0, before_count - deleted_count)

        total = 0
        for chapter in changed_chapters:
            # 每章一个 savepoint:某章 insert 失败时只回滚该章,不把整个事务打成
            # aborted(否则后续章全失败、最终 commit 回滚,partial_failures 形同虚设)。
            # chapter_total 在 savepoint 成功提交后才累加,失败章不计入 new_chunks。
            chapter_total = 0
            try:
                with db.transaction():
                    doc = knowledge._upsert_document(db, book, script, chapter)
                    # v2 场景化切片,与首次导入同一口径(避免重建后块粒度突然变化)。
                    chunks = knowledge._chunk_chapter(
                        chapter["content"],
                        script_id=script["id"],
                        chapter_id=chapter["id"],
                        chapter_index=chapter["chapter_index"],
                        title=chapter.get("title") or "",
                    )
                    for ci, chunk in enumerate(chunks):
                        knowledge._insert_chunk(
                            db, book, script, chapter, doc, ci, chunk["content"],
                            metadata=chunk["metadata"],
                        )
                        chapter_total += 1
                total += chapter_total
            except Exception as exc:
                partial_failures.append({
                    "chapter": chapter.get("chapter_index"),
                    "error": str(exc),
                })
        # after_count 用表内真实总数:增量模式下 total 只是"本次新增块",
        # 卡片/任务面板要看到的是 kept + new 的最终总量。
        after_row = db.execute(
            "select count(*) as c from document_chunks where script_id = %s",
            (script_id,),
        ).fetchone()
        after_count = int(after_row["c"]) if after_row else before_count
    return {
        "ok": True, "source": "script_chapters",
        "before_count": before_count, "after_count": after_count,
        "mode": mode,
        "changed_chapters": len(changed_chapters),
        "kept_chunks": kept_chunks,
        "new_chunks": total,
        "fallback_reason": fallback_reason,
        "partial_failures": partial_failures,
    }


def rebuild_facts_from_db(user_id: int, script_id: int) -> dict[str, Any]:
    """零 LLM:从 script_chapters 重抽 chapter_facts(规则匹配,不调 LLM)。"""
    from .. import knowledge
    partial_failures: list[dict[str, Any]] = []
    with connect() as db:
        before = db.execute(
            "select count(*) as c from chapter_facts where script_id = %s",
            (script_id,),
        ).fetchone()
        before_count = int(before["c"]) if before else 0
        script = script_owned(db, script_id, user_id)
        if not script:
            return {"ok": False, "error": "无权访问该剧本"}
        book = knowledge._ensure_book(db, script)
        chapters = db.execute(
            "select * from script_chapters where script_id = %s order by chapter_index",
            (script_id,),
        ).fetchall()
        chars = knowledge._load_characters(script_id=script_id) or {}
        world = knowledge._load_world(script_id=script_id) or {}
        summaries = knowledge._load_summaries()
        known_names = knowledge._known_names(chars)
        known_locations = knowledge._known_locations(world)
        known_concepts = knowledge._known_concepts(world)
        total = 0
        for chapter in chapters:
            # 每章 savepoint:单章 upsert 失败只回滚该章,不把整个事务打成 aborted。
            # 与 chunks 重建同一口径;否则 partial_failures 记录后,后续章全失败、
            # 最终 commit 回滚,用户看到的是“重做失败”而不是“某章失败其余成功”。
            try:
                with db.transaction():
                    doc = db.execute(
                        "select * from documents where script_id = %s and chapter_id = %s",
                        (script_id, chapter["id"]),
                    ).fetchone()
                    if not doc:
                        doc = knowledge._upsert_document(db, book, script, chapter)
                    fact = knowledge._fact_from_chapter(
                        chapter, summaries, known_names, known_locations, known_concepts,
                    )
                    knowledge._upsert_chapter_fact(db, book, script, chapter, doc, fact)
                total += 1
            except Exception as exc:
                partial_failures.append({
                    "chapter": chapter.get("chapter_index"),
                    "error": str(exc),
                })
        # 清孤儿:章节合并/删除后,chapter_index 已不存在的旧 facts 行会永久残留
        # (本函数只按现有章 upsert,不删旧行 → 状态卡 done>total、阶段窗口/锚点回填
        # 引用幽灵章;实测:合并后 1487 facts / 1486 章)。
        db.execute(
            """delete from chapter_facts cf
               where cf.script_id = %s
                 and not exists (select 1 from script_chapters sc
                                 where sc.script_id = cf.script_id
                                   and sc.chapter_index = cf.chapter)""",
            (script_id,),
        )
        after_row = db.execute(
            "select count(*) as c from chapter_facts where script_id = %s", (script_id,),
        ).fetchone()
        after_count = int(after_row["c"]) if after_row else 0
    return {
        "ok": True, "source": "script_chapters",
        "before_count": before_count, "after_count": after_count,
        "partial_failures": partial_failures,
    }


def rebuild_cards_from_canon(user_id: int, script_id: int, *,
                             chapter_max: int | None = None,
                             preserve_existing: bool = False) -> dict[str, Any]:
    """零 LLM:从 kb_canon_entities 的 character 类回填 character_cards。
    无 canon 数据时退化为 _aggregate_characters_from_facts(零 LLM 词频)。

    chapter_max(进度感知角色卡 Phase 1A):仅回填 first_revealed_chapter<=chapter_max
    的角色(过滤掉中后期才出场的角色,序章重建时不引入未登场角色);并透传
    first_revealed_chapter 给 _sync(别再被刷成 0 丢防剧透章)。None=全书(默认)。

    preserve_existing(手编保护,2026-10):默认 False(兼容其它调用方)。True 时,若目标卡
    已有非空的 identity / aliases,就把本次输入对应字段置空 —— 借助 _sync 既有的
    "excluded 非空才覆盖"规则,实现"只补空、不覆盖已有卡面"。矩阵的角色卡重建
    (零 LLM 与 LLM 丰富)都默认开启;只有用户在弹窗里显式取消"保留已有卡面"才会关闭。
    """
    from .. import knowledge
    from ..knowledge.session import _aggregate_characters_from_facts
    partial_failures: list[dict[str, Any]] = []
    cmax = int(chapter_max) if chapter_max is not None else None
    with connect() as db:
        before = db.execute(
            "select count(*) as c from character_cards "
            "where script_id = %s and card_type = 'npc'",
            (script_id,),
        ).fetchone()
        before_count = int(before["c"]) if before else 0
        script = script_owned(db, script_id, user_id)
        if not script:
            return {"ok": False, "error": "无权访问该剧本"}
        book = knowledge._ensure_book(db, script)
        # 优先用 canon entity (LLM extract 已有);否则用 facts 聚合。
        # 补取 first_revealed_chapter:① 透传给 _sync 修「重建后丢防剧透章」② chapter_max 区间过滤。
        # 0 / NULL = 未知章节,保守放行(不误隐藏该出场的角色,与 canon_repo._reveal_clause 语义一致)。
        canon_sql = (
            "select name, aliases, summary, importance, "
            "coalesce(first_revealed_chapter, 0) as first_revealed_chapter "
            "from kb_canon_entities "
            "where script_id = %s and type = 'character' "
        )
        canon_args: list[Any] = [script_id]
        if cmax is not None:
            canon_sql += "and (coalesce(first_revealed_chapter, 0) <= %s or coalesce(first_revealed_chapter, 0) = 0) "
            canon_args.append(cmax)
        canon_sql += "order by importance desc nulls last"
        canon_rows = db.execute(canon_sql, tuple(canon_args)).fetchall()
        source = "canon"
        if canon_rows:
            chars: dict[str, Any] = {}
            for r in canon_rows:
                nm = (r.get("name") or "").strip()
                if not nm:
                    continue
                chars[nm] = {
                    "name": nm,
                    "identity": (r.get("summary") or "")[:200],
                    "appearance": "",
                    "personality": "",
                    "speech_style": "",
                    "current_status": "",
                    "secrets": "",
                    "sample_dialogue": [],
                    "priority": int(r.get("importance") or 0),
                    "aliases": list(r.get("aliases") or []),
                    # 透传防剧透章(canon SELECT 已取),否则 _sync 写 0 丢章。
                    "first_revealed_chapter": int(r.get("first_revealed_chapter") or 0),
                    "importance": int(r.get("importance") or 0),
                }
        else:
            source = "chapter_facts"
            try:
                chars = _aggregate_characters_from_facts(script_id, chapter_max=cmax)
            except Exception as exc:
                partial_failures.append({"stage": "aggregate", "error": str(exc)})
                chars = {}
        # 手编保护(字段级,2026-10):只把 manual_fields 里的人设字段置空，让 _sync
        # 的"excluded 非空才覆盖"规则保留原值；**非手编字段仍可用 canon 新值刷新**。
        # 旧数据只有 metadata.source='editor' 没有 manual_fields → protected_card_fields()
        # 返回全部人设字段（整行兜底）。
        if preserve_existing and chars:
            try:
                from ..knowledge._manual import protected_card_fields
                existing_rows = db.execute(
                    "select name, metadata from character_cards "
                    "where script_id = %s and card_type = 'npc'",
                    (script_id,),
                ).fetchall()
                existing_by_name = {r["name"]: r for r in existing_rows}
                for nm, card in chars.items():
                    protected = protected_card_fields(
                        (existing_by_name.get(nm) or {}).get("metadata"))
                    if "identity" in protected:
                        card["identity"] = ""
                    if "aliases" in protected:
                        card["aliases"] = []
            except Exception as exc:
                # 保护逻辑失败不该阻断重建;退回旧行为(可能覆盖),并记录 partial。
                partial_failures.append({"stage": "preserve_existing", "error": str(exc)})
        from ..knowledge._sync import _sync_character_cards
        try:
            after_count = _sync_character_cards(db, book, script, chars)
        except Exception as exc:
            partial_failures.append({"stage": "_sync_character_cards", "error": str(exc)})
            after_count = 0
        else:
            if not preserve_existing and chars:
                # 强制覆盖（preserve_existing=False）后，只清本次真正写进去的字段标记。
                # _sync 的 SQL 对空字符串/空数组走 else 分支保留旧值，所以“覆盖集合”
                # 必须按本次传入的非空值计算；没写的 personality/tags 等继续保留手编。
                # 标记回收失败不回滚已写入的卡片，只记 partial（下次重建仍会继续尝试）。
                # 用 SAVEPOINT 隔离：若清理 SQL 出错，只回滚清理，不把 _sync 的写入
                # 一起拖进 aborted transaction（PostgreSQL 一旦报错，后续 COMMIT 会变
                # 成 ROLLBACK，表现为“任务成功但卡片没写成”）。
                try:
                    db.execute("SAVEPOINT card_manual_marks")
                    from ..knowledge._manual import (
                        CARD_MANUAL_FIELDS,
                        clear_character_card_force_marks,
                    )
                    _rows = db.execute(
                        "select name, metadata from character_cards "
                        "where script_id = %s and card_type = 'npc'",
                        (script_id,),
                    ).fetchall()
                    _meta_by_name = {r["name"]: r.get("metadata") for r in _rows}
                    _written_card_fields = (
                        "full_name", "aliases", "identity", "background", "appearance",
                        "personality", "speech_style", "current_status", "secrets",
                        "sample_dialogue",
                    )
                    for nm, card in chars.items():
                        overwritten = set()
                        for f in _written_card_fields:
                            v = card.get(f)
                            if isinstance(v, (list, tuple)):
                                if v:
                                    overwritten.add(f)
                            elif str(v or ""):
                                # _sync 对 full_name/background 会先 strip()，其它文本
                                # 原样写入；这里与它保持同一归一化，避免纯空白值判断错。
                                _s = str(v or "")
                                if f in ("full_name", "background"):
                                    _s = _s.strip()
                                if _s:
                                    overwritten.add(f)
                        overwritten &= set(CARD_MANUAL_FIELDS)
                        if overwritten:
                            clear_character_card_force_marks(
                                db, script_id, nm, _meta_by_name.get(nm), overwritten)
                    db.execute("RELEASE SAVEPOINT card_manual_marks")
                except Exception as exc:
                    try:
                        db.execute("ROLLBACK TO SAVEPOINT card_manual_marks")
                    except Exception:
                        pass
                    partial_failures.append(
                        {"stage": "clear_manual_marks", "error": str(exc)})
    return {
        "ok": True, "source": source,
        "before_count": before_count, "after_count": after_count,
        "chapter_max": cmax,
        "partial_failures": partial_failures,
    }


def rebuild_cards_with_llm(user_id: int, script_id: int, *,
                           chapter_max: int | None = None,
                           model: str = "deepseek-v4-flash",
                           api_id: str = "deepseek",
                           progress_cb=None,
                           preserve_existing: bool = False,
                           force_overwrite_manual: bool = False) -> dict[str, Any]:
    """可选 LLM 丰富重建(进度感知角色卡 Phase 1A):走 run_llm_extraction(带 chapter_max)
    对 1..chapter_max 区间重抽规范层,产「该时期态」的丰富 identity/background,然后零 LLM
    路径把 canon 回填到 character_cards。BYOK,用户付费。

    优雅降级:LLM 抽取失败(无 key / 配额 / 网络)→ 回退零 LLM 版(rebuild_cards_from_canon),
    保证「重建」永远有产物、永不报错卡死。

    preserve_existing 透传给回填步骤:默认 False(兼容其它调用方);矩阵的 LLM 丰富
    重建默认传 True(与零 LLM 一致保护手编),只有用户显式取消才覆盖。
    force_overwrite_manual(2026-10):弹窗「强制覆盖手编字段」勾选时 True,必须同时透传给
    run_llm_extraction —— 否则 LLM 重抽阶段仍按默认保护 canon 手编字段,回填只能读到旧值,
    出现「勾了强制覆盖但卡片没变」。
    """
    from ..knowledge.llm_extract import run_llm_extraction
    llm_ok = False
    llm_error = ""
    try:
        r = run_llm_extraction(
            user_id, script_id,
            algorithm="arc",
            model=model, api_id=api_id,
            chapter_min=1, chapter_max=chapter_max,
            confirmed=True,
            progress_cb=progress_cb,
            force_overwrite_manual=force_overwrite_manual,
        )
        llm_ok = bool(r.get("ok"))
        if not llm_ok:
            llm_error = str(r.get("error") or r.get("message") or "llm_extract failed")
    except (InterruptedError, KeyboardInterrupt):
        # 用户在弧边界取消:不能走"LLM 失败 → 回退零 LLM"分支 —— 那会把取消变成
        # 一次额外的全量回填,且最终被标成 done。直接上抛给 worker 落 cancelled。
        raise
    except Exception as exc:
        llm_error = str(exc)
    # 无论 LLM 是否成功,都跑零 LLM 回填把(新或旧)canon → character_cards。
    out = rebuild_cards_from_canon(
        user_id, script_id, chapter_max=chapter_max,
        preserve_existing=preserve_existing,
    )
    out["source"] = "llm_extract" if llm_ok else (out.get("source") or "canon")
    out["llm_ok"] = llm_ok
    if llm_error and not llm_ok:
        out.setdefault("partial_failures", []).append({"stage": "llm_extract", "error": llm_error})
    return out


def rebuild_worldbook_with_llm(user_id: int, script_id: int, *,
                                source: str = "canon",
                                preserve_manual: bool = True) -> dict[str, Any]:
    """worldbook 重建。source='canon' 零 LLM(rebuild_worldbook_from_db),
    'llm' 走 _stage_worldbook 一次 LLM 调用 + 写库。

    preserve_manual(2026-10):默认 True 按 manual_fields 字段级保护手编内容；
    False = 弹窗「强制覆盖手编字段」，canon 聚合路径也不保留手编字段。
    """
    partial_failures: list[dict[str, Any]] = []
    with connect() as db:
        before = db.execute(
            "select count(*) as c from worldbook_entries where script_id = %s",
            (script_id,),
        ).fetchone()
        before_count = int(before["c"]) if before else 0
        if not script_owned(db, script_id, user_id):
            return {"ok": False, "error": "无权访问该剧本"}
    if source == "canon":
        with connect() as db:
            from extract.rebuild import rebuild_worldbook_from_db
            res = rebuild_worldbook_from_db(
                db, script_id, preserve_manual=preserve_manual,
            )
        if not res.get("ok"):
            return {
                "ok": False, "source": "canon",
                "before_count": before_count, "after_count": before_count,
                "error": res.get("error"),
                "partial_failures": partial_failures,
            }
        with connect() as db:
            after_row = db.execute(
                "select count(*) as c from worldbook_entries where script_id = %s",
                (script_id,),
            ).fetchone()
        return {
            "ok": True, "source": "canon",
            "before_count": before_count,
            "after_count": int(after_row["c"]) if after_row else 0,
            "partial_failures": partial_failures,
        }
    # source == 'llm' — 走 _stage_worldbook (一次 LLM)。job_id 由调用方传入 ctl
    raise NotImplementedError(
        "rebuild_worldbook_with_llm(source='llm') 必须从 rebuild job runner 调用,"
        "需要 JobController 上下文以记 usage_actual"
    )
