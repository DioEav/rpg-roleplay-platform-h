"""extract/budget.py — Phase G 提取精确预算估算器。

提取走 BYOK(用户自己 key 付费),平台只给算法 + **跑前精确报价**。
确定性估算:可提取章数 × 每章估算 token × 用户选的模型单价。设计 NEXT_PHASE_PLAN W4-a。
"""
from __future__ import annotations

# 每 1M token 单价(美元)。便宜模型铁律:只列 flash/haiku 级 + 给个 frontier 警示价。
# 数字按各家 flash/haiku 档公开量级取保守值;可随实际调价更新。
MODEL_PRICING: dict[str, dict] = {
    "gemini-3.5-flash": {"in": 0.10, "out": 0.40, "tier": "flash"},
    "gemini-2.5-flash": {"in": 0.075, "out": 0.30, "tier": "flash"},
    "deepseek-v4-flash": {"in": 0.10, "out": 0.40, "tier": "flash"},  # 官方 V4 flash
    "deepseek-v4-pro":   {"in": 0.30, "out": 1.20, "tier": "flash"},  # 官方 V4 pro
    "claude-haiku-4-5": {"in": 0.80, "out": 4.00, "tier": "haiku"},
    # 仅作对比警示——不建议全程用:
    "claude-sonnet-4-6": {"in": 3.00, "out": 15.00, "tier": "frontier"},
}

# Pass1 每章估算 — **已用真实 gemini-flash 调用校准(二战书 3 章实测)**:
#   实测 输入均值 2930/章(正文截6000字符≈2900 + 词表/摘要)、输出均值 2069/章
#   (固定schema三元组JSON比预想大得多)。取实测 + 小头寸,宁可略高不低估(BYOK 用户付费,
#   报价宁高勿低,避免超账单)。全书重算 ≈ $1.0,贴实测 $0.98。
_PER_CH_CHARS = 10000   # = per_chapter.build_user 截断帽(改执行要同步;2026-10 6000→10000)
_PER_CH_OVERHEAD = 700  # 词表(80 实体名)+ 字段说明骨架
_PER_CH_OUTPUT = 2200   # 实测 2069 + 头寸(原 800 严重低估)
# Pass0 自举:采样 ~min(12, chapters) 章 NER
_SEED_SAMPLE = 12
_SEED_PER_CALL_OUTPUT = 1200
# 嵌入(Vertex text-embedding-004)≈ 平台承担/极廉,不计入 BYOK 报价

# ── 弧段算法:输入侧动态化(2026-10)─────────────────────────────────────────
# 单次调用的输入由**执行侧参数**决定,不再是静态常数:
#   弧提取(extract_arc):3 个代表章(首/中/末) × min(章长, 2500) + 实体词表。
#     per_chapter_chars=2500 是执行侧截断帽 → 章再长单次输入也不涨(上限口径);
#     章短于 2500 时按实际章长计(旧静态 8000 会高估短章书 ~2x)。
#   种子采样(extract.seed.bootstrap_vocab):每章截 4000 字 + prompt 骨架。
# 中文 ~1 字 ≈ 1 token,按字符数直接计。
_ARC_PICKS = 3
_ARC_CHARS_PER_PICK = 6000   # = extract_arc.per_chapter_chars(执行侧截断帽,改执行要同步;2026-10 2500→6000)
_ARC_VOCAB_TOKENS = 500      # 已知实体词表的 prompt 预算(entity_vocab 上限 120 名)
_SEED_CHARS = 4000           # = bootstrap_vocab 的 [:4000](改执行要同步)
_SEED_OVERHEAD = 300         # 种子 prompt 骨架(NER 指令/字段说明)

# ── 弧段算法:输出侧先验 + 自校准(2026-10)───────────────────────────────────
# 弧输出 = 弧级 ChapterExtract JSON(弧摘要 + 全实体含 identity/background/aliases)。
# 输出规模取决于**实体密度**,无法从章长推出 → 先验常数 + 按本剧本历史记账自校准:
# 先验 9000 来自吞噬星空 1487 章 × mimo-v2.6-flash 4 次完整重抽实测均值 8.7k
# (原 3000 低估 ~2.9 倍);同用户同剧本同模型有 ≥20 条 token_usage 记账时,
# 用最近 60 条的输出均值替代先验 —— 跑过一次的书估算越跑越准。
_PER_ARC_OUTPUT = 9000
_ARC_OUTPUT_MIN_SAMPLES = 20
_ARC_OUTPUT_SAMPLE = 60
# 种子输出:NER 词表 JSON,实测均值 ~540(先验 1200 保守,量小不影响大局,保留)


def _per_ch_input_per_call(avg_chapter_chars: float) -> int:
    """逐章单次输入 = min(章长, 10000) + 词表/骨架(对齐 per_chapter.build_user)。
    avg 回退 2500 时 = 3200,与旧静态常数精确连续。"""
    avg = max(0.0, float(avg_chapter_chars or 0))
    return int(min(avg, _PER_CH_CHARS) + _PER_CH_OVERHEAD)


def _arc_input_per_call(avg_chapter_chars: float) -> int:
    """单弧输入 tokens = 3 代表章 × min(章长, 2500) + 词表(对齐 extract_arc 执行参数)。"""
    avg = max(0.0, float(avg_chapter_chars or 0))
    return int(_ARC_PICKS * min(avg, _ARC_CHARS_PER_PICK) + _ARC_VOCAB_TOKENS)


def _seed_input_per_call(avg_chapter_chars: float) -> int:
    """种子单次输入 = min(章长, 4000) + 骨架(对齐 bootstrap_vocab 截断)。"""
    avg = max(0.0, float(avg_chapter_chars or 0))
    return int(min(avg, _SEED_CHARS) + _SEED_OVERHEAD)


def _measured_arc_output(db, user_id: int, script_id: int, model: str) -> float | None:
    """本剧本历史弧提取的输出均值(token_usage 真实记账,同用户+同剧本+同模型)。

    取最近 90 天内 _ARC_OUTPUT_SAMPLE 条的均值(覆盖一次完整重抽,重试尖峰被摊平);
    样本 < _ARC_OUTPUT_MIN_SAMPLES(没跑过/刚换模型/太久没跑)返回 None → 退回先验。
    90 天窗口同时是性能护栏:配合 user_id 走 idx_token_usage_user_time 索引范围扫描,
    避免大表 Seq Scan;过旧的样本本就该过期(书/模型状态可能已变)。
    查询失败绝不抛 —— 估算器不能因为记账表抖动而 500。
    """
    try:
        row = db.execute(
            """select avg(output_tokens) as avg_out, count(*) as n from (
                 select output_tokens from token_usage
                 where user_id = %s and created_at > now() - interval '90 days'
                   and metadata->>'script_id' = %s
                   and metadata->>'source' = 'extract'
                   and metadata->>'algorithm' = 'arc'
                   and model_real_name = %s and output_tokens > 0
                 order by id desc limit %s
               ) t""",
            (int(user_id), str(int(script_id)), str(model or ""), _ARC_OUTPUT_SAMPLE),
        ).fetchone()
        if not row:
            return None
        n = int(row.get("n") or 0)
        avg_out = row.get("avg_out")
        if n < _ARC_OUTPUT_MIN_SAMPLES or avg_out is None:
            return None
        val = float(avg_out)
        return val if val > 0 else None
    except Exception:
        return None


def _model_price(model: str) -> dict:
    return MODEL_PRICING.get(model, MODEL_PRICING["gemini-3.5-flash"])


def _default_target_arcs() -> int:
    """目标弧数单一真源(EXTRACTION_TARGET_ARCS)的惰性解析。

    budget 刻意保持零模块级依赖(被多处懒加载引用),不能顶层 import arc_pipeline
    (会拉起整条提取依赖链,且与 llm_extract 顶层 import 形成潜在环),故惰性取;
    取不到(异常/环)退回 100 —— 与常量当前值一致。
    """
    try:
        from extract.arc_pipeline import EXTRACTION_TARGET_ARCS
        return int(EXTRACTION_TARGET_ARCS)
    except Exception:
        return 100


def estimate(db, script_id: int, *, model: str = "gemini-3.5-flash",
             sample_chapters: int | None = None, batch_discount: bool = False,
             algorithm: str = "per_chapter", target_arcs: int | None = None,
             chapter_min: int | None = None, chapter_max: int | None = None,
             user_id: int | None = None) -> dict:
    """估算一次提取的成本(确定性,跑前可知)。

    algorithm:
      'per_chapter': 每章 1 LLM(老算法,1166 章 ≈ $1.4 / deepseek-v4-flash)。
      'arc'        : 每弧 1 LLM(新算法,1487 章 ≈ 106 弧)。
    sample_chapters: 只提前 N 章(懒/增量提取场景);None=全可提取章。
                     arc 模式下忽略(弧段算法必须看全书等分)。
    target_arcs: arc 模式下的目标弧数;None(默认)= 解析单一真源
                 EXTRACTION_TARGET_ARCS,split_arcs 会按 min/max 钳。
    batch_discount: Batch API 五折(若接)。
    user_id: 提供时(arc 模式)启用输出侧自校准 —— 用该用户在本剧本同模型下的
             历史记账均值替代先验常数;不提供或样本不足退回先验。
    """
    sql = ("select count(*) c, coalesce(sum(word_count),0) chars from script_chapters "
           "where script_id=%s and exclude_from_extraction=false")
    args: list = [script_id]
    if chapter_min is not None:
        sql += " and chapter_index >= %s"
        args.append(int(chapter_min))
    if chapter_max is not None:
        sql += " and chapter_index <= %s"
        args.append(int(chapter_max))
    row = db.execute(sql, tuple(args)).fetchone()
    total = int(row["c"]) if row else 0
    if total <= 0:
        return {"ok": False, "error": "无可提取章节", "chapters": 0}
    if target_arcs is None:
        target_arcs = _default_target_arcs()
    # 平均章长(字)。全 0(异常数据/空壳)→ 退回标准章长假设,防止输入估算塌缩到词表预算
    total_chars = float(row.get("chars") or 0)
    avg_chapter_chars = (total_chars / total) if total and total_chars > 0 else 2500.0

    price = _model_price(model)

    # 输出侧自校准状态(arc 分支填充;per_chapter 分支保持 None/False)
    out_per_arc: float | None = None
    output_calibrated = False

    if algorithm == "arc":
        # 弧数公式必须与执行侧 split_arcs 完全一致(同一套 min5/max40 钳制),
        # 否则长书估算弧数与实际跑的弧数对不上(旧公式 max_arc 用 80 → 长书少估)。
        desired = max(1, total // max(5, total // max(1, target_arcs)))
        desired = max(desired, (total + 40 - 1) // 40)
        desired = min(desired, max(1, total // 5))
        n_arcs = max(1, desired)
        seed_calls = min(_SEED_SAMPLE, total)
        # 输入侧动态:3 代表章 × min(平均章长, 2500) + 词表;种子 min(章长, 4000) + 骨架
        in_per_arc = _arc_input_per_call(avg_chapter_chars)
        in_tok = n_arcs * in_per_arc + seed_calls * _seed_input_per_call(avg_chapter_chars)
        # 输出侧自校准:有本剧本同模型历史记账 → 用实测均值;否则先验 9000
        out_per_arc = float(_PER_ARC_OUTPUT)
        if user_id:
            measured = _measured_arc_output(db, user_id, script_id, model)
            if measured:
                out_per_arc = measured
                output_calibrated = True
        out_tok = int(n_arcs * out_per_arc + seed_calls * _SEED_PER_CALL_OUTPUT)
        unit_label = f"{n_arcs} 弧"
        chapters = total
    else:
        chapters = min(total, sample_chapters) if sample_chapters else total
        seed_calls = min(_SEED_SAMPLE, chapters)
        in_tok = int(chapters * _per_ch_input_per_call(avg_chapter_chars) + seed_calls * _seed_input_per_call(avg_chapter_chars))
        out_tok = chapters * _PER_CH_OUTPUT + seed_calls * _SEED_PER_CALL_OUTPUT
        unit_label = f"{chapters} 章"
        n_arcs = 0

    usd = (in_tok / 1_000_000) * price["in"] + (out_tok / 1_000_000) * price["out"]
    if batch_discount:
        usd *= 0.5

    # 透视字段:仅 arc 分支有值(per_chapter 分支不定义 out_per_arc,置 None 防.NameError)
    in_per_arc_val = _arc_input_per_call(avg_chapter_chars) if algorithm == "arc" else None
    out_per_arc_val = int(out_per_arc) if (algorithm == "arc" and out_per_arc is not None) else None
    calibrated = bool(output_calibrated) if algorithm == "arc" else False

    note = (
        f"约 ${round(usd, 2)}({unit_label} × {model})。"
        + ("⚠️ frontier 档,建议换 flash/haiku" if price["tier"] == "frontier" else "")
    )
    if algorithm == "arc" and calibrated:
        note += f" 输出按上次实测 {out_per_arc_val} tok/弧校准。"

    return {
        "ok": True,
        "script_id": script_id,
        "algorithm": algorithm,
        "model": model,
        "model_tier": price["tier"],
        "chapters": chapters,
        "total_extractable": total,
        "arcs": n_arcs if algorithm == "arc" else None,
        "est_input_tokens": in_tok,
        "est_output_tokens": out_tok,
        "est_usd": round(usd, 3),
        "batch_discount": batch_discount,
        # 输入侧动态化/输出侧自校准的透视字段(前端可不消费,供调试与未来 UI 展示)
        "avg_chapter_chars": round(avg_chapter_chars, 1),
        "arc_input_per_call": in_per_arc_val,
        "arc_output_per_call": out_per_arc_val,
        "output_calibrated": calibrated,
        "note": note,
    }


def cheapest_models() -> list[str]:
    """推荐的便宜模型(按 in 单价升序),给前端下拉默认。"""
    flash = [(m, p) for m, p in MODEL_PRICING.items() if p["tier"] in ("flash", "haiku")]
    return [m for m, _ in sorted(flash, key=lambda x: x[1]["in"])]
