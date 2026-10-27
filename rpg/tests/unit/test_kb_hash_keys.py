"""KB 事件哈希键+seq(方案A,flag RPG_KB_HASH_KEYS)——live DB,无 DB 跳过。

验收点:
  a) 新档全程哈希键:键形 fact:h:*/kevt:h:*,materialize 往返顺序=原列表序
  b) 中段删除:幸存行零重写(该 commit 零新 insert),只退役被删行
  c) 追加:单行 insert,seq 单调,落列表尾
  d) legacy 位置键档开 flag:一次性转换(legacy 全退役),次回合零事件写
  e) 回滚(flag 关):写回 legacy 位置键 + 哈希行退役,materialize 仍正确
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


def _db_or_skip():
    try:
        from platform_app.db import connect, init_db
        init_db()
        return connect
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"无 DB,跳过 live KB 测试: {exc}")


def _seed(db):
    uid = db.execute("select id from users order by id limit 1").fetchone()
    sid = db.execute("select id from scripts order by id limit 1").fetchone()
    if not uid or not sid:
        pytest.skip("DB 无 user/script 种子")
    save_id = db.execute(
        "insert into game_saves(user_id,script_id,title,state_path) values (%s,%s,%s,%s) returning id",
        (uid["id"], sid["id"], "hashkeys-pytest", "/tmp/hk_pytest.json"),
    ).fetchone()["id"]

    def mk(parent, tag):
        return db.execute(
            "insert into branch_commits(save_id,parent_id,object_hash,tree_hash,turn_index,kind,title) "
            "values (%s,%s,%s,%s,%s,%s,%s) returning id",
            (save_id, parent, "h_" + tag, "t_" + tag, 0, "round", tag),
        ).fetchone()["id"]

    cs = []
    prev = None
    for tag in ("c1", "c2", "c3", "c4", "c5"):
        prev = mk(prev, tag)
        cs.append(prev)
    return save_id, cs


def _state(facts, kevts):
    return {"memory": {"facts": list(facts)}, "world": {"known_events": list(kevts), "time": "t"},
            "relationships": {}, "player": {}}


def _inserted_events(db, save_id, commit_id):
    # 真·新写行(退役是 born=retired=同 commit 的 tombstone 行,不算 insert)
    return db.execute(
        "select logical_key, summary, seq from kb_events"
        " where save_id=%s and born_commit=%s and retired_at_commit is null",
        (save_id, commit_id),
    ).fetchall()


def _retired_events(db, save_id, commit_id):
    return db.execute(
        "select logical_key from kb_events where save_id=%s and retired_at_commit=%s",
        (save_id, commit_id),
    ).fetchall()


def test_hash_keys_lifecycle():
    connect = _db_or_skip()
    from kb import save_kb
    old = os.environ.get("RPG_KB_HASH_KEYS")
    os.environ["RPG_KB_HASH_KEYS"] = "1"
    try:
        with connect() as db:
            save_id, (c1, c2, c3, c4, c5) = _seed(db)
            try:
                # a) 新档:哈希键 + 往返顺序
                facts = ["甲事实", "乙事实", "丙事实", "丁事实"]
                kevts = ["事件一", "事件二"]
                save_kb.import_state(db, save_id, c1, _state(facts, kevts))
                ins = _inserted_events(db, save_id, c1)
                assert all(":h:" in r["logical_key"] for r in ins), ins
                assert all(r["seq"] is not None for r in ins)
                st = save_kb.materialize(db, save_id, c1)
                assert st["memory"]["facts"] == facts
                assert st["world"]["known_events"] == kevts

                # b) 中段删除「乙事实」:零 insert,单退役,顺序保持
                facts2 = ["甲事实", "丙事实", "丁事实"]
                save_kb.import_state(db, save_id, c2, _state(facts2, kevts))
                assert _inserted_events(db, save_id, c2) == [], "中段删除不应重写幸存行"
                assert len(_retired_events(db, save_id, c2)) == 1
                assert save_kb.materialize(db, save_id, c2)["memory"]["facts"] == facts2

                # c) 追加:单 insert,落尾
                facts3 = facts2 + ["戊事实"]
                save_kb.import_state(db, save_id, c3, _state(facts3, kevts))
                ins3 = _inserted_events(db, save_id, c3)
                assert len(ins3) == 1 and ins3[0]["summary"] == "戊事实"
                assert save_kb.materialize(db, save_id, c3)["memory"]["facts"] == facts3

                # e) 回滚:flag 关 → legacy 位置键重建 + 哈希行退役,materialize 不变
                os.environ["RPG_KB_HASH_KEYS"] = "0"
                save_kb.import_state(db, save_id, c4, _state(facts3, kevts))
                from kb import live_repo as L
                vis = {r["logical_key"] for r in L.read_events(db, save_id, c4)}
                # kevtc 是本次新增的冷历史键：故意在哈希开关关闭时也用内容哈希
                # 永久保留，不受 legacy 回滚影响。这里只断言热状态键已退役。
                hot_vis = {
                    lk for lk in vis
                    if not lk.startswith(("kevtc:", "afactc:"))
                }
                assert not any(":h:" in lk for lk in hot_vis), f"热状态哈希行应全部退役: {hot_vis}"
                assert save_kb.materialize(db, save_id, c4)["memory"]["facts"] == facts3

                # d) 再开 flag(=legacy 档首次转换):一次性转换后,次回合零事件写
                os.environ["RPG_KB_HASH_KEYS"] = "1"
                save_kb.import_state(db, save_id, c5, _state(facts3, kevts))
                assert save_kb.materialize(db, save_id, c5)["memory"]["facts"] == facts3
                c6 = db.execute(
                    "insert into branch_commits(save_id,parent_id,object_hash,tree_hash,turn_index,kind,title) "
                    "values (%s,%s,'h_c6','t_c6',0,'round','c6') returning id",
                    (save_id, c5),
                ).fetchone()["id"]
                save_kb.import_state(db, save_id, c6, _state(facts3, kevts))
                assert _inserted_events(db, save_id, c6) == []
                assert _retired_events(db, save_id, c6) == []
            finally:
                db.execute("delete from game_saves where id=%s", (save_id,))
    finally:
        if old is None:
            os.environ.pop("RPG_KB_HASH_KEYS", None)
        else:
            os.environ["RPG_KB_HASH_KEYS"] = old
