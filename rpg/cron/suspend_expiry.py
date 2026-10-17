"""rpg.cron.suspend_expiry — 定时暂停到期自动解封.

aup 暂停支持 duration_days(users.suspended_until),此前既没有这列、也没有任何到期
解封逻辑——到期后账号仍停在停用态,只能人工解。本任务把 suspended_until 已到期、
且未进入终止删除队列的停用账号批量恢复。

用法:
    from cron.suspend_expiry import run_suspend_expiry
    result = run_suspend_expiry(db)   # db = psycopg.Connection (dict_row)

由 scripts/run_cron.py 的 `all` 每日调度;到期解锁最多滞后一个调度周期。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def run_suspend_expiry(db) -> dict:
    """解封 suspended_until 已到期的账号;返回 {unsuspended: int}。"""
    row = db.execute(
        """
        with expired as (
            update users
            set deactivated_at = null, ban_reason = '', suspended_until = null
            where deactivated_at is not null
              and suspended_until is not null
              and suspended_until <= now()
              and not exists (
                  select 1 from account_delete_queue q
                  where q.user_id = users.id and q.completed_at is null
              )
            returning id
        )
        select count(*) as unsuspended from expired
        """
    ).fetchone()
    result = {"unsuspended": int(row["unsuspended"]) if row else 0}
    if result["unsuspended"]:
        logger.info("suspend_expiry: auto-unsuspended %s account(s)", result["unsuspended"])
    return result
