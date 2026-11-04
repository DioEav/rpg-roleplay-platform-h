"""extract/facts_refine.py — chapter_facts 的 LLM 摘要精炼层。

背景:确定性 chapter_facts(零 LLM)已经提供每章结构化事实,但 summary 只是事件句的
规则摘录;本模块在已有 chapter_facts 行上,把 summary / in_world_time 升级成 LLM 真摘要。
它**不创建行、不写 events/人物/关系/锚点**,因此不能替代零 LLM 的 chapter-facts 模块。

P0 修复:
  · 不再读 document_chunks 的前 12 块(长章尾部会丢),改读 script_chapters 正文;
  · 长章取开头/中段/结尾各 3,000 字,共 ≤9,000 字;
  · 增量:默认只处理未精炼/内容变更/摘要版本变化的章节;force 才全量;
  · 写入 chapter_content_hash/summary_version/model,供重建时保护和下次增量判断;
  · 只更新 summary/in_world_time,不覆盖 story_time_label(时间线分段标签保持不变)。

CLI: python -m extract.facts_refine <script_id> [--from N] [--to M] [--api-id X --model Y] [--apply] [--force]
     默认 dry-run 打印前 3 章产出;--apply 才写库;--force 忽略增量。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

log = logging.getLogger(__name__)

MAX_CONTENT_CHARS = 9000   # 每章喂给 LLM 的正文上限(超长章取头/中/尾)
SAMPLE_PART_CHARS = 3000   # 超长章每段保留字数
MIN_SUMMARY_CHARS = 20
MAX_SUMMARY_CHARS = 300
MAX_TIME_CHARS = 40
SUMMARY_VERSION = "llm-v2"

_SYSTEM = """你是小说章节摘要器。只依据用户给出的本章正文，禁止使用后文、原著其他章节或外部知识。
输出严格 JSON(不要代码围栏):
{"chapter_summary": "本章主线的第三人称浓缩,200-300字。写清谁做了什么、结果/局势有何变化。绝不照抄原文句子,必须是归纳复述。不要逐句罗列,不要评价,不要剧透后文。",
 "in_world_time": "本章明确的故事内时间,如「穿越当日下午」「三个月后的冬天」「紧接上章当夜」;若正文没有明确时间就输出空字符串。严禁用章节标题、「第N章」或剧情描述冒充时间"}
只输出这一个 JSON 对象。"""


def _chapter_content_hash(content: str) -> str:
    """与 `_chunks._chapter_content_hash` / SQL `substr(md5(...),1,16)` 同口径。"""
    return hashlib.md5(
        (content or "").encode("utf-8"), usedforsecurity=False,
    ).hexdigest()[:16]


def _sample_chapter_content(content: str) -> str:
    """长章采样:开头 + 中段 + 结尾,保证章节高潮/结尾进入摘要模型。"""
    text = (content or "").strip()
    if len(text) <= MAX_CONTENT_CHARS:
        return text
    part = min(SAMPLE_PART_CHARS, MAX_CONTENT_CHARS // 3)
    mid_start = max(0, len(text) // 2 - part // 2)
    return (
        "【开头】\n" + text[:part]
        + "\n\n【中段】\n" + text[mid_start:mid_start + part]
        + "\n\n【结尾】\n" + text[-part:]
    )


def build_refine_prompts(title: str, content: str, prev_summary: str = "") -> tuple[str, str]:
    body = _sample_chapter_content(content)
    parts: list[str] = []
    if prev_summary:
        parts.append("【上一章摘要(仅用于承接,勿照抄)】" + (prev_summary or "").strip()[:200])
    parts.append(f"【章节标题】{(title or '').strip() or '(无题)'}")
    if len(content or "") > MAX_CONTENT_CHARS:
        parts.append("【说明】正文过长,以下只给开头/中段/结尾三段;中间省略部分不要编造。")
    parts.append("【本章正文】\n" + body)
    return _SYSTEM, "\n\n".join(parts)


def _clean_time_label(value: str, title: str = "") -> str:
    """清洗故事时间;标题/占位标签不算时间。"""
    s = str(value or "").strip()
    if not s:
        return ""
    if len(s) > MAX_TIME_CHARS:
        return ""  # 超长不是时间短语,截断反而造出半句
    try:
        from extract.world_key_backfill import clean_in_world_time
        s = clean_in_world_time(s)
    except Exception:
        pass
    if not s:
        return ""
    # “第N章/第N回”开头是章节号,不是故事时间。
    if re.match(r"^第\s*[零〇一二三四五六七八九十百千万两0-9]+\s*[章回话]", s):
        return ""

    def _norm(x: str) -> str:
        return re.sub(r"\s+", "", x or "")

    if title and _norm(s) == _norm(title):
        return ""
    return s


def validate_refined(raw_text: str, content: str, *, title: str = "") -> dict | None:
    """解析+验收。拒收:非 JSON/摘要过短过长/摘要照抄原文/以残句标点开头。"""
    if not raw_text:
        return None
    text = raw_text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        text = m.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    summary = re.sub(r"\s+", " ", str(data.get("chapter_summary") or "").strip())
    if not (MIN_SUMMARY_CHARS <= len(summary) <= MAX_SUMMARY_CHARS + 60):
        return None
    if len(summary) > MAX_SUMMARY_CHARS:
        # 模型偶尔超长;优先在句界收尾,避免硬切出半句直接进 GM 提示词。
        cut = summary[:MAX_SUMMARY_CHARS]
        best = max(cut.rfind(p) for p in ("。", "！", "？", "!", "?", "…", "」", "”"))
        summary = cut[:best + 1] if best >= MAX_SUMMARY_CHARS // 2 else cut
    # 闭引号/标点开头 = 从对话或句中截出的残片,不能当摘要首句。
    if summary[:1] in "”’」』）)；，。、!?！？…—":
        return None
    # 照抄检测:摘要里任一 25 字连续片段逐字出现在正文 → 拒(要求归纳复述)
    body = re.sub(r"\s+", "", content or "")
    probe = re.sub(r"\s+", "", summary)
    for i in range(0, max(1, len(probe) - 25), 12):
        if probe[i:i + 25] and probe[i:i + 25] in body:
            return None
    itime = _clean_time_label(str(data.get("in_world_time") or ""), title)
    return {"summary": summary, "in_world_time": itime}


def _load_chapter_material(db, script_id: int, chapter_index: int) -> dict | None:
    """一次取当前章正文/标题、事实行 id、上一章摘要。"""
    row = db.execute(
        """
        select sc.title, sc.content, cf.id as fact_id,
               (select p.summary from chapter_facts p
                 where p.script_id = sc.script_id
                   and p.chapter = sc.chapter_index - 1) as prev_summary
        from script_chapters sc
        left join chapter_facts cf
          on cf.script_id = sc.script_id and cf.chapter = sc.chapter_index
        where sc.script_id = %s and sc.chapter_index = %s
        """,
        (int(script_id), int(chapter_index)),
    ).fetchone()
    return dict(row) if row else None


def refine_chapter(db, script_id: int, chapter_index: int, user_id: int,
                   api_id: str, model: str, *, material: dict | None = None) -> dict | None:
    """单章精炼。返回写库负载或 None(跳过)。只读章节/事实,不在此写库。"""
    material = material if material is not None else _load_chapter_material(
        db, script_id, chapter_index,
    )
    if not material or material.get("fact_id") is None:
        return None  # 没有 chapter_facts 行:LLM 跑了也无处写,直接跳过
    raw_content = str(material.get("content") or "")
    content = raw_content.strip()
    if len(content) < 80:
        return None  # 空/短章(幽灵章残留)不烧钱
    title = str(material.get("title") or "").strip()
    sys_p, usr_p = build_refine_prompts(
        title, content, str(material.get("prev_summary") or ""),
    )
    from agents._harness import call_agent_json_guarded
    # 结构化微任务禁深思(268 实锤族)+空正文护栏
    text, _usage = call_agent_json_guarded(
        api_id, model, sys_p, usr_p, user_id,
        # 200-300 汉字摘要 + JSON 包装约 400-600 token;300 会截尾导致 JSON 不完整。
        tool_schema=None, max_tokens=800, timeout_sec=45,
        no_think=True, log_tag="facts_refine",
    )
    out = validate_refined(text or "", content, title=title)
    if out:
        # 与 _chunks._chapter_content_hash / SQL md5 一样用原始 content(不 strip),
        # 否则导出的章首尾空白会让 hash 与 facts 重建侧不一致,误判“内容变了”。
        out["_content_hash"] = _chapter_content_hash(raw_content)
    return out


def apply_refined(db, script_id: int, chapter_index: int, refined: dict, *,
                  content_hash: str = "", model: str = "") -> bool:
    """UPSERT 回 chapter_facts:真摘要+故事内时间,来源标 llm_refined。

    不写 story_time_label —— 它仍是时间线分段标签(Option A);逐章时间只进
    in_world_time,由 GM/世界书/编辑器显示时优先读取。
    返回是否实际更新到行(防止 chapter_facts 缺行时“LLM 跑完仍计 done”)。
    """
    meta = {
        "source": "llm_refined",
        "summary_version": SUMMARY_VERSION,
    }
    if content_hash:
        meta["chapter_content_hash"] = content_hash
    if model:
        meta["summary_model"] = model
    cur = db.execute(
        """update chapter_facts
           set summary = %s,
               in_world_time = nullif(%s, ''),
               confidence = greatest(coalesce(confidence, 0), 0.85),
               metadata = coalesce(metadata, '{}'::jsonb) || %s::jsonb,
               updated_at = now()
           where script_id = %s and chapter = %s""",
        (refined["summary"], refined.get("in_world_time") or "",
         json.dumps(meta, ensure_ascii=False),
         int(script_id), int(chapter_index)),
    )
    try:
        return int(getattr(cur, "rowcount", 0) or 0) > 0
    except Exception:
        return True


def _candidate_chapters(db, script_id: int, ch_from: int, ch_to: int, *,
                        only_missing: bool, force: bool) -> list[int]:
    """增量候选。

    默认只选:
      · 没有 chapter_facts 行;
      · 不是 llm_refined;
      · 有 hash 且与当前正文 md5 不同;
      · 有 summary_version 且不是当前版本。
    老数据无 hash 的 llm_refined 行视为“legacy 已精炼”直接跳过 —— 旧 apply_refined
    不 bump updated_at,无法可靠判断内容是否变过;升级后不能因此一次性重烧全库。
    需要重做老数据时走 force。
    """
    if force or not only_missing:
        return list(range(int(ch_from), int(ch_to) + 1))
    rows = db.execute(
        """
        select sc.chapter_index
        from script_chapters sc
        left join chapter_facts cf
          on cf.script_id = sc.script_id and cf.chapter = sc.chapter_index
        where sc.script_id = %s and sc.chapter_index between %s and %s
          and (
            cf.id is null
            or coalesce(cf.metadata->>'source', '') <> 'llm_refined'
            or (
              coalesce(cf.metadata->>'chapter_content_hash', '') <> ''
              and cf.metadata->>'chapter_content_hash'
                  <> substr(md5(coalesce(sc.content, '')), 1, 16)
            )
            or (
              coalesce(cf.metadata->>'summary_version', '') <> ''
              and cf.metadata->>'summary_version' <> %s
            )
          )
        order by sc.chapter_index
        """,
        (int(script_id), int(ch_from), int(ch_to), SUMMARY_VERSION),
    ).fetchall()
    return [int(r["chapter_index"]) for r in (rows or [])]


def count_refine_candidates(script_id: int, ch_from: int = 1, ch_to: int | None = None,
                            *, only_missing: bool = True, force: bool = False) -> int:
    """给估算/调用方用的候选数(与实际 refine_script 同口径)。"""
    from platform_app.db import connect, init_db
    init_db()
    with connect() as db:
        row = db.execute(
            "select coalesce(max(chapter_index), 0) m from script_chapters where script_id=%s",
            (int(script_id),),
        ).fetchone()
        max_ch = int((row or {}).get("m") or 0)
        ch_to = min(int(ch_to or max_ch), max_ch)
        if ch_to < int(ch_from):
            return 0
        return len(_candidate_chapters(
            db, int(script_id), int(ch_from), ch_to,
            only_missing=only_missing, force=force,
        ))


def refine_script(script_id: int, user_id: int, *, ch_from: int = 1, ch_to: int | None = None,
                  api_id: str | None = None, model: str | None = None,
                  apply: bool = False, only_missing: bool = True, force: bool = False,
                  should_cancel=None, progress_cb=None) -> dict[str, Any]:
    """批量精炼 [ch_from, ch_to]。

    only_missing(默认 True):只处理未精炼/内容变更/版本变化的章节;force=True 全量。
    apply=False 只打样前 3 章。should_cancel 每章开头检查;progress_cb(done,total)
    的 total 是候选章节数,不是整个区间长度。
    """
    from platform_app.db import connect, init_db
    init_db()
    from agents.recorder import _resolve_recorder_api_and_model
    rapi, rmodel = _resolve_recorder_api_and_model(user_id, api_id, model)
    if not rapi or not rmodel:
        return {"ok": False, "error": "无可用 api/model(BYOK 未配置)"}
    with connect() as db:
        row = db.execute(
            "select coalesce(max(chapter_index),0) m from script_chapters where script_id=%s",
            (int(script_id),),
        ).fetchone()
        max_ch = int(row["m"] or 0)
        ch_to = min(int(ch_to or max_ch), max_ch)
        if ch_to < int(ch_from):
            return {
                "ok": True, "refined": 0, "skipped": 0, "failed": 0,
                "already_done": 0, "range": [ch_from, ch_to],
                "samples": [], "applied": bool(apply), "cancelled": False,
            }
        candidates = _candidate_chapters(
            db, int(script_id), int(ch_from), ch_to,
            only_missing=bool(only_missing), force=bool(force),
        )
    total_ch = max(ch_to - int(ch_from) + 1, 0)
    already_done = max(0, total_ch - len(candidates))
    done = processed = skipped = failed = 0
    samples: list[dict] = []
    cancelled = False
    total_candidates = len(candidates)

    for ch in candidates:
        # 取消检查点:放在每章 LLM 调用之前 → 最坏等一章,而不是等整本跑完。
        if should_cancel is not None:
            try:
                if should_cancel():
                    cancelled = True
                    log.info("[facts_refine] script=%s 用户取消,停在 ch%d(已精炼 %d 章)",
                             script_id, ch, done)
                    break
            except Exception:
                pass  # 取消信号查询失败不该中断正在跑的任务
        if progress_cb is not None:
            try:
                progress_cb(processed, total_candidates)
            except Exception:
                pass
        try:
            with connect() as db:
                material = _load_chapter_material(db, script_id, ch)
                refined = refine_chapter(
                    db, script_id, ch, user_id, rapi, rmodel, material=material,
                )
                if not refined:
                    # 验收拒/缺 facts 行/空章:重试一次便宜模型偶发照抄;仍拒才跳过。
                    refined = refine_chapter(
                        db, script_id, ch, user_id, rapi, rmodel, material=material,
                    )
                if not refined:
                    skipped += 1
                    processed += 1
                    continue
                if apply:
                    applied = apply_refined(
                        db, script_id, ch, refined,
                        content_hash=str(refined.get("_content_hash") or ""),
                        model=rmodel,
                    )
                    if not applied:
                        skipped += 1
                        processed += 1
                        continue
                    if hasattr(db, "commit"):
                        db.commit()
                elif len(samples) < 3:
                    samples.append({"chapter": ch, **{
                        k: v for k, v in refined.items() if not k.startswith("_")
                    }})
            done += 1
            processed += 1
            if done % 20 == 0:
                log.info("[facts_refine] script=%s 进度 %d 章(至 ch%d)", script_id, done, ch)
            if not apply and done >= 3:
                break  # dry-run 只打样
        except Exception as exc:
            failed += 1
            processed += 1
            log.warning("[facts_refine] ch%s 失败跳过: %s", ch, exc)
    if progress_cb is not None and not cancelled:
        try:
            progress_cb(processed, total_candidates)
        except Exception:
            pass
    return {
        "ok": True, "refined": done, "skipped": skipped, "failed": failed,
        "already_done": already_done, "processed": processed,
        "total": total_candidates, "range": [ch_from, ch_to],
        "samples": samples, "applied": bool(apply), "cancelled": cancelled,
    }


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("script_id", type=int)
    ap.add_argument("--from", dest="ch_from", type=int, default=1)
    ap.add_argument("--to", dest="ch_to", type=int, default=None)
    ap.add_argument("--user-id", type=int, default=1)
    ap.add_argument("--api-id", default=None)
    ap.add_argument("--model", default=None)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--force", action="store_true", help="忽略增量,重精炼全部")
    a = ap.parse_args()
    out = refine_script(a.script_id, a.user_id, ch_from=a.ch_from, ch_to=a.ch_to,
                        api_id=a.api_id, model=a.model, apply=a.apply,
                        only_missing=not a.force, force=a.force)
    print(json.dumps(out, ensure_ascii=False, indent=2))
