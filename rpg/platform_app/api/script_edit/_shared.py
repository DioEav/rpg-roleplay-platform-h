"""platform_app.api.script_edit._shared —— 拆包共享的单一 router 实例 + 跨资源族写入辅助。

各资源族子模块 `from ._shared import router[, _require_owner, _write_commit]` 后用
`@router.<verb>(...)` 注册端点;`__init__.py` import 全部子模块触发装配,再把这同一个
router 暴露给 `platform_app.api`(`from .script_edit import router`)。这样装配结果与拆分
前的单文件逐端点一致(共享同一 APIRouter 实例)。

_require_owner / _write_commit 是被 fork / 版本控制 / 世界书 / canon / 锚点 多个子模块共用
的写入辅助,故与 router 同居本模块(单一真相源,避免跨子模块循环 import);生产侧
`from platform_app.api.script_edit import _write_commit` 经 __init__ 门面 re-export 不变。
"""
from __future__ import annotations

import datetime as _dt

from fastapi import APIRouter
from psycopg.types.json import Jsonb

from ...perms import script_owned

router = APIRouter()

def _require_owner(db, script_id: int, user_id: int):
    """确认 user 是 script owner，不是则 raise ValueError。

    严格 owner SQL 收敛到 perms.script_owned;但保留本函数特有的两段区分性文案
    (「剧本不存在」vs「必须 fork 后才能编辑」)—— 故非 owner 时再查一次存在性以选文案
    (仅失败分支多一次查询,正常路径单查)。
    """
    owned = script_owned(db, script_id, user_id)
    if owned:
        return owned
    exists = db.execute("SELECT owner_id FROM scripts WHERE id = %s", (script_id,)).fetchone()
    if not exists:
        raise ValueError("剧本不存在")
    raise ValueError("必须 fork 后才能编辑（当前用户不是该剧本 owner）")


def _parse_baseline_ts(value):
    """解析客户端回传的 updated_at 乐观锁基线,返回 UTC datetime;空值返回 None。

    背景:章节早已支持 base_updated_at,非章节实体(世界书/锚点/canon)此前是
    无条件覆盖写。这里给它们补同一套乐观锁:读接口把行的 updated_at 序列化下发,
    编辑器保存时原样回传;UPDATE 把它放进 WHERE,不匹配即 409。

    为什么统一转 UTC 再比:jsonable_encoder 产出的 ISO 是 'T' 分隔,psycopg 读出的
    str(datetime) 是空格分隔,时区还可能写成 'Z' 或 '+00:00'。直接比字符串会因纯格式
    差异误判冲突;转成同一时区后按微秒比较,只反映真正的时间变化。

    非法值抛 ValueError:调用方回 400,而不是把坏参数交给 Postgres 变成 500。
    """
    if value is None or value == "":
        return None
    try:
        if isinstance(value, _dt.datetime):
            dt = value
        else:
            s = str(value).strip()
            if not s:
                return None
            # Python 3.11+ 的 fromisoformat 已支持 'Z',replace 只是兼容更老解释器。
            dt = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("base_updated_at 不是合法时间戳") from exc
    if dt.tzinfo is None:
        # DB 列是 timestamptz,正常一定带时区;防御性把无时区值按 UTC 解释。
        dt = dt.replace(tzinfo=_dt.UTC)
    return dt.astimezone(_dt.UTC)


def _jsonable(obj):
    """递归把 dict/list 里的 datetime/date 转成 isoformat,供 Jsonb 序列化。

    背景:canon 编辑把 before/after 整行塞进 commit payload,行里的 created_at 是
    psycopg dict_row 返回的 datetime → Jsonb() 直接
    "Object of type datetime is not JSON serializable",编辑保存 500。
    """
    import datetime as _dt
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (_dt.datetime, _dt.date)):
        return obj.isoformat()
    return obj


def _write_commit(
    db,
    *,
    script_id: int,
    user_id: int,
    kind: str,
    message: str,
    payload: dict,
    is_checkpoint: bool = False,
) -> int:
    """写入一条 script_commit，更新 scripts.head_commit_id，返回新 commit id。"""
    # 取当前 head 作 parent
    head = db.execute(
        "SELECT head_commit_id FROM scripts WHERE id = %s",
        (script_id,),
    ).fetchone()
    parent_id = int(head["head_commit_id"]) if head and head["head_commit_id"] else None

    row = db.execute(
        """
        INSERT INTO script_commits
          (script_id, parent_commit_id, author_user_id, message, kind, payload, is_checkpoint)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (script_id, parent_id, user_id, message, kind, Jsonb(_jsonable(payload)), is_checkpoint),
    ).fetchone()
    commit_id = int(row["id"])

    db.execute(
        "UPDATE scripts SET head_commit_id = %s, updated_at = now() WHERE id = %s",
        (commit_id, script_id),
    )
    return commit_id
