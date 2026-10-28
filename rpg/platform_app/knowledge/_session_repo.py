"""knowledge._session_repo — session 的 SQL 层 (private)."""
from __future__ import annotations

from typing import Any

from psycopg.types.json import Jsonb

# game_sessions.worldline jsonb 这一列同时承载两类互不重叠命名空间的数据:
#   (1) 世界树运行态(user_variables / last_projection 等)—— 每回合由 state 快照整列重写;
#   (2) 只在 DB 侧维护、state 快照里没有的键 —— 玩家可改设置
#       (steering_strength 等,见 gm_serving/settings.py)+ 进度信号
#       (progress_chapter / user_progress_floor / progress_pace_accum)。
# 若 upsert 直接用 excluded.worldline 覆盖,(2) 会被每回合的 (1) 抹掉 ——
# 表现为游戏内「剧情引导强度」改了之后,下一回合对话又跳回默认「软引导」。
# progress_pace_accum 被抹掉更隐蔽:节奏兜底每回合从 0 重新累计,永远攒不够一章的
# 推进点 —— 生产 save=205 连续多回合 motion=1 却一直卡在同一章,根因就是这里漏了它。
# 修复:覆盖世界树态时,把旧行里的这些键叠加回来(jsonb || 右侧优先,故这些键覆盖在
# 新 worldline 上,而世界树键保持「整列替换」语义不变)。
# 键名须与 gm_serving/settings.py SETTINGS_SCHEMA 同步。
# 维护不变量:任何「只写 DB、state 快照里没有」的 worldline 键,都必须加进本白名单,
# 否则会在下一回合被整列重写静默抹掉。
_PRESERVE_SETTINGS_SQL = (
    "coalesce((select jsonb_object_agg(key, value) "
    "from jsonb_each(game_sessions.worldline) where key in "
    "('starting_worldline','foreknowledge_mode','npc_awareness',"
    "'steering_strength','spoiler_guard','progress_chapter','user_progress_floor',"
    "'progress_pace_accum','auto_pace_advance')), '{}'::jsonb)"
)


def _db_upsert_game_session(db, save_id: int, book_id: int, script_id: int, user_id: int, title: str, payload: dict[str, Any]):
    """repository: upsert game_sessions 并返回 row。"""
    return db.execute(
        """
        insert into game_sessions(
          save_id, book_id, script_id, user_id, title, state,
          memory_mode, permission_mode, worldline, turn
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        on conflict(save_id) do update set
          book_id = excluded.book_id,
          script_id = excluded.script_id,
          title = excluded.title,
          state = excluded.state,
          memory_mode = excluded.memory_mode,
          permission_mode = excluded.permission_mode,
          worldline = excluded.worldline || """ + _PRESERVE_SETTINGS_SQL + """,
          turn = excluded.turn,
          row_version = game_sessions.row_version + 1,
          updated_at = now()
        returning *
        """,
        (
            save_id,
            book_id,
            script_id,
            user_id,
            title,
            Jsonb(payload),
            (payload.get("memory") or {}).get("mode", "normal"),
            (payload.get("permissions") or {}).get("mode", "full_access"),
            Jsonb(payload.get("worldline") or {}),
            int(payload.get("turn") or 0),
        ),
    ).fetchone()
