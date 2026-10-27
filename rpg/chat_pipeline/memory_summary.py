"""chat_pipeline.memory_summary — 归档摘要 LLM 精修（真摘要压缩第二步）。

分工：
  第一步（chat_pipeline.memory_maintenance → context_providers.memory._maybe_auto_archive，
  回合后维护路径）—— 归档时剥桶 + 写机械保底摘要进 memory.summaries，并把原始全文
  记入 memory.summary_pending 任务（多块归档时用 queue 排队）。同步路径永不调 LLM
  （每回合都跑，不能背秒级延迟和故障面）。归档已从读 provider 移出（本次记忆修复）。
  第二步（本模块）——读任务 → 调 LLM 把原始全文生成连贯精细摘要 → **覆盖**
    保底 → 清任务。接线有两处：
    · 生产默认：gm.py 的 async 路径（create_task 起、两个 return 前 await）——
      ⚠️ 必须接在 async 路径！v1.41.0 心跳曾错接 sync-only 的
      _run_post_gm_parallel 导致生产永不触发（老坑，tests/unit/
      test_memory_summary_wiring.py 有源码结构断言钉死）；
    · parity：postproc.py 的 _worker_memory_summary（sync 模式/enqueue 失败
      降级路径）。
    两处写完均由本回合 Phase 5 统一持久化，下一轮注入即见。

纪律（与 extractor/heartbeat 同款）：
  - 全程 try/except 静默：任何失败保底摘要仍在，绝不破回合；
  - attempts 计数封顶（防坏模型反复烧 token，超限放弃保底即终稿）；
  - summary_llm_enabled=False 时直接清任务（用户明确不要精修）；
  - 零新持久化机制：直接改 state.data，Phase 5 统一存。
"""
from __future__ import annotations

from core.logging import get_logger

log = get_logger(__name__)

# 送入 prompt 的事实条数上限（超出截断——极端大批次保住成本上限）
_MAX_PROMPT_FACTS = 40
# 同一 pending 任务最多精修尝试次数；超限清任务，机械保底即终稿
_MAX_ATTEMPTS = 3
# 精修摘要长度上限（与 context_providers.memory._SUMMARY_ENTRY_MAX_CHARS 对齐）
_SUMMARY_MAX_CHARS = 600
# 低于此长度视为模型输出无效（空转/敷衍），保留保底
_MIN_SUMMARY_CHARS = 10


def _promote_next_pending(mem: dict) -> None:
    """处理完队首 pending 后，把 queue 里的下一个提升为队首（本次记忆修复）。

    多块归档摘要共用 summary_pending 队列；每回合只精修一条，避免一次大归档触发
    多次 LLM 调用。没有 queue 时清空，保持旧行为（现有测试全部按 dict 空值断言）。
    """
    cur = mem.get("summary_pending")
    if not isinstance(cur, dict) or not cur:
        mem["summary_pending"] = {}
        return
    queue = cur.get("queue")
    if isinstance(queue, list) and queue:
        nxt = queue.pop(0)
        if isinstance(nxt, dict):
            # 把剩余的队列挂到新的队首任务上，否则 promote 一次就丢掉后面的块。
            if queue:
                nxt["queue"] = queue
            else:
                nxt.pop("queue", None)
            mem["summary_pending"] = nxt
        else:
            mem["summary_pending"] = {}
    else:
        mem["summary_pending"] = {}


def refine_pending_summary(state, user_id: int | None, *, timeout_sec: int = 25) -> bool:
    """处理 memory.summary_pending：LLM 精修成功返回 True。

    失败/关闭/无模型 → 返回 False，机械保底摘要继续在场；任务保留待下轮重试
    （attempts 封顶）。直接改 state.data，由调用方所在回合的 Phase 5 持久化。
    """
    try:
        data = getattr(state, "data", None)
        if not isinstance(data, dict):
            return False
        mem = data.get("memory") or {}
        pending = mem.get("summary_pending")
        if not isinstance(pending, dict) or not pending:
            return False

        from platform_app.settings import get_effective_memory_settings
        from schemas.memory import MemorySettings
        ms = None
        try:
            ms = get_effective_memory_settings(
                int(user_id) if user_id is not None else None,
                getattr(state, "data", None),
            )
        except Exception:
            ms = None
        if ms is None:
            ms = MemorySettings()
        if not ms.summary_llm_enabled:
            # 用户明确不要 LLM 精修:清任务,机械保底即终稿(不清会每轮空转重试)
            mem["summary_pending"] = {}
            return False

        attempts = int(pending.get("attempts", 0) or 0)
        if attempts >= _MAX_ATTEMPTS:
            log.info("[memory_summary] attempts=%d 超限,放弃精修,保底摘要即终稿", attempts)
            # 队首放弃后继续处理 queue 里的下一块摘要；没有队列则清空（旧行为）。
            _promote_next_pending(mem)
            return False
        pending["attempts"] = attempts + 1

        # 模型解析:严格 BYOK,同史官/心跳口径(recorder.* → extractor.* → 通配)
        from agents.recorder import _resolve_recorder_api_and_model
        try:
            api_id, model = _resolve_recorder_api_and_model(user_id, None, None)
        except Exception as exc:
            log.info("[memory_summary] 模型解析失败,保留保底摘要: %s", exc)
            return False
        if not api_id or not model:
            log.info("[memory_summary] 无可用 api_id/model,保留保底摘要")
            return False

        system_prompt, user_prompt = _build_prompts(pending)

        from agents._harness import call_agent_json_guarded
        text, _usage = call_agent_json_guarded(
            api_id=api_id, model=model,
            system_prompt=system_prompt, user_prompt=user_prompt,
            user_id=user_id,
            max_tokens=500,
            timeout_sec=timeout_sec,
            agent_kind="memory_summary",
            no_think=True,
            log_tag="memory_summary",
        )

        from core.json_parse import parse_llm_json
        payload = parse_llm_json(text or "", want=dict)
        if not isinstance(payload, dict):
            log.info("[memory_summary] 输出解析不出 JSON(前80字: %r),保留保底(attempts=%d)",
                     (text or "")[:80], pending["attempts"])
            return False
        refined = _sanitize_summary(str(payload.get("summary") or ""))
        if len(refined) < _MIN_SUMMARY_CHARS:
            log.info("[memory_summary] 精修摘要过短(%d 字),保留保底", len(refined))
            return False

        summaries = mem.get("summaries")
        if not isinstance(summaries, list):
            summaries = []
            mem["summaries"] = summaries
        try:
            idx = int(pending.get("index", -1))
        except (TypeError, ValueError):
            idx = -1
        if 0 <= idx < len(summaries):
            summaries[idx] = refined  # 覆盖保底
        else:
            summaries.append(refined)  # 下标失配(理论不可达)兜底,不丢精修结果
        # 成功：覆盖保底后，把 queue 里的下一块提升为队首（没有队列则清空）。
        _promote_next_pending(mem)
        log.info("[memory_summary] turn_range=%s 精修完成(%d 字)",
                 pending.get("turn_range"), len(refined))
        return True
    except Exception as exc:
        log.debug("[memory_summary] failed silently: %s", exc)
        return False


def _build_prompts(pending: dict) -> tuple[str, str]:
    """构造精修 prompt。要求 JSON 契约 {"summary": ...} —— harness 非 tool 通道
    本身按 JSON 对象约束输出(openai json_mode / anthropic 文本提示),顺着走最稳。"""
    texts = [str(t) for t in (pending.get("texts") or []) if str(t or "").strip()]
    texts = texts[:_MAX_PROMPT_FACTS]
    tr = pending.get("turn_range")
    if isinstance(tr, (list, tuple)) and len(tr) == 2:
        rng = f"第{tr[0]}-{tr[1]}轮"
    else:
        rng = "早期"
    system = (
        "你是剧情编年史编辑。把一批较早回合归档下来的剧情事实压缩成一段连贯的中文摘要。"
        "要求：按时间顺序；保留人名、地点、关键物品、因果与数值变化；"
        "只陈述已发生的事实，不推测、不扩写、不加评论；"
        f"总长不超过 {_SUMMARY_MAX_CHARS} 字。"
        '严格只输出一个 JSON 对象：{"summary": "<摘要正文>"}，不要解释。'
    )
    facts_block = "\n".join(f"- {t}" for t in texts)
    user = f"以下是{rng}归档下来的剧情事实：\n{facts_block}\n\n请压缩成一段摘要。"
    return system, user


def _sanitize_summary(text: str) -> str:
    """摘要入库前清洗:折叠全部空白成单行(面板/注入都按单行渲染),硬截上限。"""
    t = " ".join(str(text or "").split())
    if len(t) > _SUMMARY_MAX_CHARS:
        t = t[:_SUMMARY_MAX_CHARS].rstrip() + "……"
    return t
