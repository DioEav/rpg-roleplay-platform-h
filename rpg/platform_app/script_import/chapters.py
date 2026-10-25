from __future__ import annotations

import datetime as _dt
from typing import Any

from ..db import connect, cursor_id, expose, init_db, limit_value, page_payload
from ..perms import script_owned, script_readable


def _parse_base_ts(value: Any) -> _dt.datetime | None:
    """把 base_updated_at 解析成 UTC datetime;空值返回 None。

    与 api/script_edit/_shared._parse_baseline_ts 同一语义(本章节模块不反向依赖
    API 层,故保留一份等价实现):jsonable_encoder 下发的 ISO 用 'T' 分隔,psycopg
    读回的是 datetime/空格分隔字符串,时区可能写成 'Z' / '+00:00'。直接比字符串
    会因格式误判冲突,统一转 UTC 后按微秒比较,只反映真实变化。
    非法值抛 ValueError → 端点回 400,不交给 Postgres 变 500。
    """
    if value is None or value == "":
        return None
    try:
        if isinstance(value, _dt.datetime):
            ts = value
        else:
            ts = _dt.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("base_updated_at 不是合法时间戳") from exc
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_dt.UTC)
    return ts.astimezone(_dt.UTC)



def list_chapters(user_id: int, script_id: int, limit: int | str | None = None, cursor: str | None = None) -> dict[str, Any]:
    init_db()
    # 章节列表只回 180-char preview 元数据,放宽 limit 上限到 5000 — 给章节
    # 浏览 modal 一次拉完;500 万字小说约 1200 章,5000 cap 留 4x 余量
    page_limit = limit_value(limit, default=200, maximum=5000)
    before_index = cursor_id(cursor)
    with connect() as db:
        # 读权限 = owner ∪ subscriber(script_readable),与同资源的全文搜索分支/单章
        # 详情端点同谓词。此前误用 script_owned(写谓词)→ 订阅者点「章节」列表恒 400,
        # 而搜索/详情却能看(同文件三路两种权限,自相矛盾)。写操作(下方编辑/合并/拆分)
        # 仍走 script_owned,不受影响。
        script = script_readable(db, script_id, user_id)
        if not script:
            raise ValueError("无权访问该剧本")
        rows = db.execute(
            """
            select id, public_id, chapter_index, title, word_count, volume_title,
                   left(content, 180) as content_preview, created_at, updated_at
            from script_chapters
            where script_id = %s and (%s::integer is null or chapter_index > %s)
            order by chapter_index asc
            limit %s
            """,
            (script_id, before_index, before_index, page_limit + 1),
        ).fetchall()
    payload = page_payload(rows, page_limit)
    if payload["items"]:
        payload["page"]["next_cursor"] = str(payload["items"][-1]["chapter_index"]) if payload["page"]["has_more"] else None
    payload["script"] = expose(script)
    return payload


# 游标解析单一真相源 = db.cursor_id;保留 _cursor_index 名做薄别名,门面
# script_import/__init__.py 按名 re-export 本符号,保留 name parity。
_cursor_index = cursor_id


# ══════════════════════════════════════════════════════════════════════
#  章节手动编辑 / 合并 / 拆分
# ══════════════════════════════════════════════════════════════════════
def create_blank_script(user_id: int, title: str = "") -> dict[str, Any]:
    """作者优先:从零创建空白剧本 —— 建 scripts 行 + 第 1 章空章,供作者直接写、用选区提取边写边建 KB。
    不跑批量提取器(那是导入已完结小说的路径)。"""
    init_db()
    t = (str(title or "").strip() or "新剧本")[:200]
    with connect() as db:
        row = db.execute(
            "insert into scripts(owner_id, title, description) values (%s, %s, '') returning id",
            (int(user_id), t),
        ).fetchone()
        sid = int(row["id"])
        db.execute(
            "insert into script_chapters(script_id, chapter_index, title, content, word_count, "
            "volume_title, source_marker, confidence) values (%s, 1, %s, '', 0, '', 'manual', 1.0)",
            (sid, "第1章"),
        )
        db.execute("update scripts set chapter_count = 1, word_count = 0, updated_at = now() where id = %s", (sid,))
        db.commit()
    return {"ok": True, "script_id": sid, "title": t}


def create_chapter(user_id: int, script_id: int, title: str = "") -> dict[str, Any]:
    """作者优先:给剧本追加一个空白新章(owner 闸)。返回新章 chapter_index。"""
    init_db()
    with connect() as db:
        if not script_owned(db, script_id, user_id):
            raise ValueError("无权编辑该剧本")
        # 与 split/merge/delete 用同一把章节结构 advisory lock:并发双击「新建章节」
        # 会同时读到同一个 max(chapter_index),第二笔 INSERT 撞唯一键 → 500。
        _lock_chapter_struct(db, script_id)
        mx = db.execute(
            "select coalesce(max(chapter_index),0) as m from script_chapters where script_id = %s",
            (int(script_id),),
        ).fetchone()
        ci = int(mx["m"]) + 1
        t = (str(title or "").strip() or f"第{ci}章")[:200]
        db.execute(
            "insert into script_chapters(script_id, chapter_index, title, content, word_count, "
            "volume_title, source_marker, confidence) values (%s, %s, %s, '', 0, '', 'manual', 1.0)",
            (int(script_id), ci, t),
        )
        cnt = db.execute(
            "select count(*) as n from script_chapters where script_id = %s", (int(script_id),),
        ).fetchone()
        db.execute("update scripts set chapter_count = %s, updated_at = now() where id = %s",
                   (int(cnt["n"]), int(script_id)))
        db.commit()
    return {"ok": True, "chapter_index": ci, "title": t}


class ChapterConflict(Exception):
    """乐观锁冲突:调用方带 base_updated_at 但服务端已被他方(AI 工具/另一标签)更新。
    携带服务端当前版本供前端做三方合并(编辑器 P0:AI 写库 vs 未保存改动静默互覆盖)。"""

    def __init__(self, server_chapter: dict[str, Any]):
        super().__init__("chapter updated by someone else")
        self.server_chapter = server_chapter


class ChapterStructureChanged(Exception):
    """章节身份冲突:调用方的稳定 chapter id 与当前 chapter_index 指向的行不一致。

    chapter_index 会因删除/拆分/合并/重切整本重排;编辑器标签如果还按旧 index 保存,
    服务端此时指向的可能是**另一章**。这种情况绝不能走内容三方合并/force-save ——
    会把旧章正文写进另一章。端点转 409 + structure_changed,前端只提示重新打开,
    不提供合并。携带当前行供调用方提示/刷新。
    """

    def __init__(self, server_chapter: dict[str, Any]):
        super().__init__("chapter structure changed")
        self.server_chapter = server_chapter


def update_chapter(user_id: int, script_id: int, chapter_index: int, *,
                   title: str | None = None, content: str | None = None,
                   volume_title: str | None = None,
                   base_updated_at: str | None = None,
                   base_chapter_id: int | str | None = None) -> dict[str, Any]:
    """编辑单章。title/content/volume_title 任一可传。

    base_updated_at(可选,乐观锁):传入调用方打开/上次保存时拿到的 updated_at;
    与服务端当前值不一致时抛 ChapterConflict(不落库),端点转 409+服务端版本。
    base_chapter_id(可选,身份锁):传入编辑器打开的稳定 chapter id(script_chapters.id)。
    当前 index 若已指向另一行(外部删除/拆分/合并/重切),抛 ChapterStructureChanged,
    端点返回 structure_changed,前端禁止合并/force-save,避免跨章覆盖。
    不传=老客户端/AI 工具路径,保持原覆盖语义。"""
    init_db()

    # 时间戳基线统一解析成 UTC datetime(微秒精度),与文档内其他实体的
    # _parse_baseline_ts 保持一致:秒级截断会让同一秒内的两次并发保存都通过,
    # 后写者仍会静默覆盖先写者。
    base_ts = _parse_base_ts(base_updated_at)

    with connect() as db:
        if not script_owned(db, script_id, user_id):
            raise ValueError("无权访问该剧本")
        want_id = None
        if base_chapter_id is not None:
            try:
                want_id = int(base_chapter_id)
            except (TypeError, ValueError) as exc:
                raise ValueError("base_chapter_id 必须是整数") from exc
        if base_ts is not None or want_id is not None:
            cur = db.execute(
                "select id, public_id, chapter_index, title, volume_title, word_count, "
                "content, created_at, updated_at from script_chapters "
                "where script_id = %s and chapter_index = %s",
                (script_id, chapter_index),
            ).fetchone()
            if not cur:
                raise ValueError(f"章节 {chapter_index} 不存在")
            if want_id is not None:
                # 先判身份再判内容版本:身份都变了,内容合并没有意义。
                if int(cur["id"]) != want_id:
                    raise ChapterStructureChanged(expose(cur))
            if base_ts is not None and _parse_base_ts(cur.get("updated_at")) != base_ts:
                raise ChapterConflict(expose(cur))
        sets, params = [], []
        if title is not None:
            sets.append("title = %s")
            params.append(str(title)[:200])
        if content is not None:
            new_content = str(content)
            sets.append("content = %s")
            params.append(new_content)
            sets.append("word_count = %s")
            params.append(len(new_content))
        if volume_title is not None:
            sets.append("volume_title = %s")
            params.append(str(volume_title)[:200])
        if not sets:
            raise ValueError("没有要更新的字段")
        sets.append("updated_at = now()")
        # 上面的 SELECT 只做「快速失败」;真正的并发保护放进 UPDATE 的 WHERE:
        # 两个标签同时保存时都会通过预检(读到同一基线),若只按 index 更新,后写者
        # 会静默覆盖先写者。把 id / 微秒级 updated_at 一起放进条件,数据库行级锁下
        # 只有基线仍一致的那个 UPDATE 能命中。
        where = ["script_id = %s", "chapter_index = %s"]
        params.extend([script_id, chapter_index])
        if want_id is not None:
            where.append("id = %s")
            params.append(want_id)
        if base_ts is not None:
            where.append("updated_at = %s")
            params.append(base_ts)
        row = db.execute(
            f"update script_chapters set {', '.join(sets)} "
            f"where {' and '.join(where)} returning *",
            tuple(params),
        ).fetchone()
        if not row:
            # 预检通过但 UPDATE 0 行 = 检查与写入之间被并发删除/重排/改写。
            # 重新取当前行区分原因,返回与预检一致的异常(不能伪装成成功或 404)。
            cur = db.execute(
                "select id, public_id, chapter_index, title, volume_title, word_count, "
                "content, created_at, updated_at from script_chapters "
                "where script_id = %s and chapter_index = %s",
                (script_id, chapter_index),
            ).fetchone()
            if not cur:
                raise ValueError(f"章节 {chapter_index} 不存在")
            if want_id is not None and int(cur["id"]) != want_id:
                raise ChapterStructureChanged(expose(cur))
            if base_ts is not None:
                raise ChapterConflict(expose(cur))
            raise ValueError(f"章节 {chapter_index} 不存在")
        # 同步刷新 scripts.word_count
        total = db.execute(
            "select coalesce(sum(word_count),0) as n from script_chapters where script_id = %s",
            (script_id,),
        ).fetchone()
        db.execute(
            "update scripts set word_count = %s, updated_at = now() where id = %s",
            (int(total["n"]), script_id),
        )
    return {"ok": True, "chapter": expose(row)}


# 章节结构变更(split / merge / resplit)按 script 串行化。两类历史 bug:
# ① 并发双击 → 两个事务同时 shift+insert,撞 (script_id, chapter_index) 唯一约束;
# ② 单条 `chapter_index = chapter_index ± 1` 自增/自减,非 deferrable 唯一约束逐行即时校验,
#    Postgres 按非确定顺序处理时会瞬时撞键(生产 500 UniqueViolation 的真因)。
# 本锁是事务级 advisory lock,提交即释放,解决 ①;②由下方「负区两段式」位移解决。
_CHAPTER_STRUCT_LOCK_NS = 0x53435054  # 'SCPT'


def _lock_chapter_struct(db, script_id: int) -> None:
    db.execute("select pg_advisory_xact_lock(%s, %s)", (_CHAPTER_STRUCT_LOCK_NS, int(script_id)))


def _shift_to_negative(db, script_id: int, gt_index: int) -> None:
    """把 chapter_index > gt_index 的行整体挪到负区(o → -1-o):负数互不冲突、也不与正数冲突,
    给后续 insert / 重排腾出干净空间,避免单条 UPDATE 自增时瞬时撞唯一键。"""
    db.execute(
        "update script_chapters set chapter_index = -1 - chapter_index, updated_at = now() "
        "where script_id = %s and chapter_index > %s",
        (script_id, gt_index),
    )


def _restore_from_negative(db, script_id: int, delta: int) -> None:
    """把负区行翻正并整体平移 delta:原值 o = -1-x,目标 = o + delta = -1 - x + delta。"""
    db.execute(
        "update script_chapters set chapter_index = -1 - chapter_index + %s, updated_at = now() "
        "where script_id = %s and chapter_index < 0",
        (int(delta), script_id),
    )


def _renumber_contiguous(db, script_id: int) -> None:
    """把某剧本所有章节按当前顺序重排成【无缝隙连续】序号,保留原起始基数(0 或 1)。
    self-heal:历史上 split/merge/过滤可能留下序号缝隙(如 1,2,4,5),会让「按 index 取相邻章」
    的操作(合并)失败。负区两段式 + 窗口函数一次重排,避免逐行更新瞬时撞 (script_id,chapter_index) 唯一键。"""
    base_row = db.execute(
        "select min(chapter_index) as m from script_chapters where script_id = %s", (script_id,),
    ).fetchone()
    if not base_row or base_row["m"] is None:
        return
    base = int(base_row["m"])
    # 1) 全挪负区(-1-idx,互不冲突也不与正数冲突)
    db.execute(
        "update script_chapters set chapter_index = -1 - chapter_index where script_id = %s",
        (script_id,),
    )
    # 2) 负值降序 = 原 index 升序 → 重排成 base, base+1, …(正数,不与负区冲突)
    db.execute(
        """
        with ordered as (
          select id, (row_number() over (order by chapter_index desc) - 1 + %s) as new_idx
          from script_chapters where script_id = %s and chapter_index < 0
        )
        update script_chapters c set chapter_index = o.new_idx, updated_at = now()
        from ordered o where c.id = o.id
        """,
        (base, script_id),
    )


def merge_chapters(user_id: int, script_id: int, first_index: int,
                   *, second_index: int | None = None, keep_title_index: int | None = None,
                   separator: str = "\n\n") -> dict[str, Any]:
    """合并两章为一章,随后整本重排成连续序号。

    second_index 缺省时取 first_index 之后【按序的下一章】,而不是假设 first_index+1
    ——章节序号可能有缝隙(如 1,2,4,5),硬算 +1 会找不到章而合并失败
    (用户反馈:有序章的剧本合并不了)。

    keep_title_index 指定保留哪一章的标题(缺省=序号小的那章)。「合并上一章」时传当前章序号,
    使序章/前言折进第一章后标题仍是「第一章」(用户反馈:没办法合并到第一章)。内容始终按
    章序拼接(序号小的在前)。"""
    init_db()
    with connect() as db:
        _lock_chapter_struct(db, script_id)
        if not script_owned(db, script_id, user_id):
            raise ValueError("无权访问该剧本")
        a = db.execute(
            "select * from script_chapters where script_id = %s and chapter_index = %s",
            (script_id, first_index),
        ).fetchone()
        if not a:
            raise ValueError(f"章节 {first_index} 不存在")
        if second_index is not None:
            b = db.execute(
                "select * from script_chapters where script_id = %s and chapter_index = %s",
                (script_id, second_index),
            ).fetchone()
        else:
            b = db.execute(
                "select * from script_chapters where script_id = %s and chapter_index > %s "
                "order by chapter_index asc limit 1",
                (script_id, first_index),
            ).fetchone()
        if not b or b["id"] == a["id"]:
            raise ValueError("要合并的相邻章节不存在")
        # 始终把序号小的当作留存章(内容在前),删除序号大的
        if int(b["chapter_index"]) < int(a["chapter_index"]):
            a, b = b, a
        # 标题:缺省留 a(序号小);keep_title_index 指向 b 时留 b 的标题
        # (「合并上一章」把前面的序章折进当前章、仍叫当前章标题)。
        keep_b_title = keep_title_index is not None and int(keep_title_index) == int(b["chapter_index"])
        new_title = (b["title"] if keep_b_title else a["title"])

        merged_content = (a["content"] or "") + separator + (b["content"] or "")
        db.execute(
            "update script_chapters set content = %s, word_count = %s, title = %s, updated_at = now() where id = %s",
            (merged_content, len(merged_content), str(new_title or "")[:200], a["id"]),
        )
        db.execute("delete from script_chapters where id = %s", (b["id"],))
        # 删除后重排为连续序号(顺带 self-heal 任何历史缝隙)
        _renumber_contiguous(db, script_id)
        cnt = db.execute(
            "select count(*) as n, coalesce(sum(word_count),0) as w from script_chapters where script_id = %s",
            (script_id,),
        ).fetchone()
        db.execute(
            "update scripts set chapter_count = %s, word_count = %s, updated_at = now() where id = %s",
            (int(cnt["n"]), int(cnt["w"]), script_id),
        )
    return {"ok": True, "merged_into": int(a["chapter_index"]), "new_chapter_count": int(cnt["n"])}


def delete_chapters(user_id: int, script_id: int, chapter_indexes: list[int]) -> dict[str, Any]:
    """删除一批章节(按 chapter_index),随后整本重排为连续序号。

    一次性删全部再重排,而不是逐章删——逐章删每次都 _renumber_contiguous 会让后续 index
    漂移,导致删错章(用户多选删除时尤其明显)。负区两段式重排避免瞬时撞唯一键。

    注意(与 merge/split 同):章节是 RAG(chunks/facts/锚点按 chapter_index 外键)的源,
    结构改动后这些派生数据需重新提取才能完全对齐——本函数只做确定性的删除 + 重排 + 计数更新。
    """
    init_db()
    idxs = sorted({int(i) for i in (chapter_indexes or [])})
    if not idxs:
        raise ValueError("未指定要删除的章节")
    with connect() as db:
        _lock_chapter_struct(db, script_id)
        if not script_owned(db, script_id, user_id):
            raise ValueError("无权访问该剧本")
        total = int(db.execute(
            "select count(*) as n from script_chapters where script_id = %s", (script_id,),
        ).fetchone()["n"])
        rows = db.execute(
            "select chapter_index from script_chapters where script_id = %s and chapter_index = any(%s)",
            (script_id, idxs),
        ).fetchall()
        hit = [int(r["chapter_index"]) for r in rows]
        if not hit:
            raise ValueError("要删除的章节都不存在")
        if len(hit) >= total:
            raise ValueError("不能删除全部章节(会清空剧本);如需清空请删除整个剧本")
        db.execute(
            "delete from script_chapters where script_id = %s and chapter_index = any(%s)",
            (script_id, hit),
        )
        _renumber_contiguous(db, script_id)
        cnt = db.execute(
            "select count(*) as n, coalesce(sum(word_count),0) as w from script_chapters where script_id = %s",
            (script_id,),
        ).fetchone()
        db.execute(
            "update scripts set chapter_count = %s, word_count = %s, updated_at = now() where id = %s",
            (int(cnt["n"]), int(cnt["w"]), script_id),
        )
        # 重排会给「所有」章节 bump updated_at(_renumber_contiguous)。编辑器还开着其他
        # 章节标签时,它们手里的 base_updated_at 全部失效,下一次保存会误报 409。
        # 把重排后的真实 updated_at 随响应带回,前端据此刷新打开标签的基线(只更新基线,
        # 不动用户未保存的正文),避免删除一章导致所有打开章节弹假冲突。
        renumbered = db.execute(
            "select id, chapter_index, updated_at from script_chapters "
            "where script_id = %s order by chapter_index",
            (script_id,),
        ).fetchall()
    return {
        "ok": True,
        "deleted": len(hit),
        "new_chapter_count": int(cnt["n"]),
        "chapters": [
            # id = 稳定身份;前端用它更新打开标签的 chapterId,后续保存可校验 index
            # 是否还指向同一章(外部重排/多标签场景下的跨章覆盖防护)。
            {"chapter_index": int(r["chapter_index"]), "id": int(r["id"]), "updated_at": r["updated_at"]}
            for r in (renumbered or [])
        ],
    }


def split_chapter(user_id: int, script_id: int, chapter_index: int,
                  *, split_at: int, new_title: str = "") -> dict[str, Any]:
    """按字符位置 split_at 把一章拆成两章。后续 index 全部 +1。"""
    init_db()
    if split_at <= 0:
        raise ValueError("split_at 必须 > 0")
    with connect() as db:
        _lock_chapter_struct(db, script_id)
        if not script_owned(db, script_id, user_id):
            raise ValueError("无权访问该剧本")
        ch = db.execute(
            "select * from script_chapters where script_id = %s and chapter_index = %s",
            (script_id, chapter_index),
        ).fetchone()
        if not ch:
            raise ValueError(f"章节 {chapter_index} 不存在")
        content = ch["content"] or ""
        if split_at >= len(content):
            raise ValueError(f"split_at ({split_at}) 超过章节长度 ({len(content)})")
        left_text = content[:split_at]
        right_text = content[split_at:]
        # 后续章节 index 全部 +1 腾位置(负区两段式:先挪负区,插入后再翻正,
        # 避免单条自增时瞬时撞 (script_id, chapter_index) 唯一键 → 生产 500 真因)
        _shift_to_negative(db, script_id, chapter_index)
        # 改原章为左半部分
        db.execute(
            "update script_chapters set content = %s, word_count = %s, updated_at = now() where id = %s",
            (left_text, len(left_text), ch["id"]),
        )
        # 插入右半为新章(此时 chapter_index+1 已空出)
        db.execute(
            """
            insert into script_chapters(
              script_id, chapter_index, title, content, word_count,
              volume_title, source_marker, confidence
            ) values (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (script_id, chapter_index + 1,
             str(new_title or (str(ch.get("title") or "") + "（下）"))[:200],
             right_text, len(right_text),
             ch.get("volume_title") or "", "manual_split",
             float(ch.get("confidence") or 0)),
        )
        # 负区行翻正并整体 +1(落到 chapter_index+2 起,与新插入的 chapter_index+1 不冲突)
        _restore_from_negative(db, script_id, 1)
        cnt = db.execute(
            "select count(*) as n from script_chapters where script_id = %s",
            (script_id,),
        ).fetchone()
        db.execute(
            "update scripts set chapter_count = %s, updated_at = now() where id = %s",
            (int(cnt["n"]), script_id),
        )
    return {"ok": True, "split_at": split_at, "new_chapter_count": int(cnt["n"])}
