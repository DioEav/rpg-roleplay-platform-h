"""platform_app.dmca — DMCA strike 计数与账户终止辅助逻辑。

依赖表:
  dmca_strikes       — 每用户一行的聚合表（strike_count + 最近一次 strike 信息）
  banned_users       — 注册封禁名单（按 email_norm 拦截注册,见 auth.py REG-04）
  account_delete_queue — 待硬删队列（30 天宽限后由 cron/hard_delete 物理删除）
"""
from __future__ import annotations

import logging

from .security import normalize_email

log = logging.getLogger(__name__)

# 累犯阈值：达到此次数自动触发账户终止流程
DMCA_STRIKE_THRESHOLD = 3


def increment_strike(db, user_id: int, reason: str) -> dict:
    """为指定用户累计一次 DMCA strike。

    dmca_strikes 是「每用户一行」的聚合表（user_id 主键），并非逐条日志，
    因此这里用 upsert 递增 strike_count 并刷新最近一次信息。

    返回:
        dict with keys:
          - strike_count (int): 该用户当前累计 strike 数
          - terminate (bool): 是否已达到终止阈值
    """
    row = db.execute(
        """
        insert into dmca_strikes (user_id, strike_count, last_strike_at, last_strike_reason)
        values (%s, 1, now(), %s)
        on conflict (user_id) do update
          set strike_count = dmca_strikes.strike_count + 1,
              last_strike_at = now(),
              last_strike_reason = excluded.last_strike_reason
        returning strike_count
        """,
        (user_id, reason),
    ).fetchone()
    strike_count = int(row["strike_count"]) if row else 1

    terminate = strike_count >= DMCA_STRIKE_THRESHOLD
    if terminate:
        db.execute(
            "update dmca_strikes set terminated_at = now() where user_id = %s and terminated_at is null",
            (user_id,),
        )

    log.info(
        "dmca.strike user_id=%d count=%d/%d terminate=%s",
        user_id, strike_count, DMCA_STRIKE_THRESHOLD, terminate,
    )

    return {
        "strike_count": strike_count,
        "terminate": terminate,
    }


def queue_account_termination(db, user_id: int, reason: str) -> None:
    """将账户加入 30 天硬删队列，写入注册封禁名单，并立即停用登录。

    列结构以 db/migrations.py 为准：account_delete_queue(LC-01)、banned_users(REG-04)。
    注册流程 auth.py 按 email_norm 拦截，故这里用同一 normalize_email 归一化后写入。
    """
    user_row = db.execute(
        "select email from users where id = %s",
        (user_id,),
    ).fetchone()
    email = normalize_email(user_row["email"]) if user_row else ""

    # 30 天宽限后由 cron/hard_delete 物理删除，与用户自助注销同策略
    db.execute(
        """
        insert into account_delete_queue
          (user_id, requested_at, scheduled_hard_delete_at, reason)
        values (%s, now(), now() + interval '30 days', %s)
        on conflict (user_id) do update
          set requested_at = now(),
              scheduled_hard_delete_at = now() + interval '30 days',
              reason = excluded.reason,
              completed_at = null
        """,
        (user_id, reason),
    )

    # 封禁注册；banned_users 无唯一约束，用 not exists 防重复行
    if email:
        db.execute(
            """
            insert into banned_users (email_norm, reason, source_user_id)
            select %s, %s, %s
            where not exists (select 1 from banned_users where email_norm = %s)
            """,
            (email, reason, user_id, email),
        )

    # 立即停用 sessions，阻止继续登录
    db.execute(
        "delete from sessions where user_id = %s",
        (user_id,),
    )

    # 更新用户状态
    db.execute(
        "update users set deactivated_at = now(), updated_at = now(), ban_reason = %s where id = %s",
        (reason, user_id),
    )

    log.warning(
        "dmca.terminate user_id=%d email=%s reason=%r",
        user_id, email, reason,
    )
