"""platform_app.postproc_health — 「后处理 worker 是否在运行」的自检。

背景：AI 生图、验收(acceptance_verifier)、黑天鹅(black_swan) 都**只入队**到
`chat_postproc_tasks`，由**独立进程** `rpg/scripts/run_postproc_worker.py` 消费。这个进程
不属于后端：dev.sh / docker-compose / k8s / 桌面端都没起它（只有 bare-metal 的 systemd 有）。
后果是任务永远 pending、界面永远「生成中」，而**没有任何地方报错** —— 用户只能对着一动不动的
弹窗猜（"点了生图像卡死，不知道为什么"）。本模块把那件事变成可观测的：后端启动时、运行期
每 10 分钟、以及 GET /api/health 上都会给出结论。

判定依据（为什么「pending 到点超过 10 分钟」就足以判死）：
  · 正常部署里 worker 收到 NOTIFY 秒级认领，最差也有 30s 兜底轮询；
  · 失败重试走 `scheduled_at = now() + 2^attempts * 10s`（最长 ~40s）退避，且 attempts 耗尽后
    状态变 `failed`（不是 pending）→ 所以 pending 不会长期挂着；
  · 能长期停在 pending 的只剩一种解释：没有消费者。
反面情况诚实写在告警文案里：worker 在跑但队列被严重积压时也会命中本条，故一并给出条数与最老
时长，由运维判断（不误报成「进程死了」，只说「到点未被消费」）。
"""
from __future__ import annotations

from typing import Any

# 到点后超过这么多分钟仍未被认领 → 判定为「没有消费者」。10 分钟是给「worker 正在跑同一个
# 长任务」与「退避中的重试」留的余量：这两者都不会让一条任务在 pending 停留这么久。
STALE_PENDING_MINUTES = 10

# 运维/开发者需要的下一步动作。刻意把「必须直连 5432」写进去 —— worker 拒绝走 PgBouncer
# (LISTEN/NOTIFY 是会话级的)，照抄后端的环境变量会启动即崩，这是第二个坑。
_HINT = (
    "postproc worker 似乎没有运行（独立进程，不属于后端）。"
    "启动：cd rpg && python -m scripts.run_postproc_worker"
    "（DATABASE_URL 必须直连 Postgres :5432，不能走 PgBouncer :6432）"
)


def check_postproc_worker() -> dict[str, Any]:
    """检查队列里有没有「到点超过阈值仍未被消费」的任务。

    返回 {ok, checked, stale_pending?, oldest_minutes?, by_kind?, hint?}。
    `ok=False` 表示判定为**没有消费者**；DB 异常一律返回 ok=True + checked=False（不误报——
    数据库不通这件事已由 /api/health 的 db 字段负责报）。
    """
    try:
        from .db import connect  # 函数内 import:测试可 patch platform_app.db.connect
        with connect() as db:
            rows = db.execute(
                """
                select task_kind,
                       count(*) as n,
                       floor(extract(epoch from (now() - min(scheduled_at))))::int as oldest_age_s
                  from chat_postproc_tasks
                 where status = 'pending'
                   and scheduled_at <= now() - make_interval(mins => %s)
                 group by task_kind
                 order by n desc
                """,
                (STALE_PENDING_MINUTES,),
            ).fetchall()
    except Exception as exc:  # noqa: BLE001 — 自检绝不向上抛,否则会把 /api/health 带崩
        return {"ok": True, "checked": False, "error": str(exc)[:200]}

    rows = list(rows or [])
    if not rows:
        return {"ok": True, "checked": True, "stale_pending": 0}

    by_kind = {str(r["task_kind"] or "?"): int(r["n"] or 0) for r in rows}
    total = sum(by_kind.values())
    oldest_s = max((int(r["oldest_age_s"] or 0) for r in rows), default=0)
    return {
        "ok": False,
        "checked": True,
        "stale_pending": total,
        "oldest_minutes": max(1, oldest_s // 60),
        "by_kind": by_kind,
        "hint": _HINT,
    }


def describe_postproc_health(health: dict[str, Any]) -> str:
    """把 check_postproc_worker() 的结果写成人能直接读的一行（日志/接口共用同一份文案）。"""
    if health.get("ok"):
        return "postproc 队列无积压"
    kinds = "、".join(f"{k} {v} 条" for k, v in (health.get("by_kind") or {}).items())
    return (
        f"chat_postproc_tasks 有 {health.get('stale_pending')} 条任务到点超过 "
        f"{STALE_PENDING_MINUTES} 分钟仍未被执行（最老 {health.get('oldest_minutes')} 分钟"
        f"{'；' + kinds if kinds else ''}）。这些任务不会有结果 —— "
        f"其中 image_gen 就是「生图一直显示生成中」的原因。{_HINT}"
    )
