"""test_chapter_commit_history — 编辑器手动保存章节 → 写入/合并「改动历史」(script_commits)。

背景:AI 改章节走 tools_dsl 的写工具(自带 commit);作者在编辑器里手改此前完全没有记录
→ 章节「改动历史」列表永远为空。本测试锁定补上的写入侧:

  · 手动保存 → 一条 chapter_edit 记录,before 是改前全文,source='editor';
  · 编辑会话合并:窗口内连续保存只留一条,save_count 递增(不按每次保存堆记录);
  · 窗口关闭(设 0)→ 每次保存各一条,before = 上一次编辑后的版本;
  · AI 记录(无 source)不参与合并,且 AI 改过之后的下一次手动保存开新记录;
  · 无字段变更 → 不写记录;
  · 手动记录不进 /undo(AI 撤销)闸门,但 /history 可见且 /restore 可用;
  · 端到端:/history 返回 source/save_count/has_before → /restore 恢复到编辑前;
  · 可逆:撤销/恢复自身也存快照 → 「恢复到此前」可退回恢复前的状态(点错能退回);
  · 删除单条记录:只删审计不动正文;删 head 时 head 指针正确回退(否则后续记录撞外键写不进)。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))
os.environ.setdefault("RPG_REQUIRE_AUTH", "1")

from tests.helpers import cleanup_test_users, make_client, register_user  # noqa: E402
import platform_app.api.scripts.chapters as chapters_mod  # noqa: E402


def _chapter_content(sid: int, ci: int) -> str:
    from platform_app.db import connect
    with connect() as db:
        r = db.execute(
            "select content from script_chapters where script_id=%s and chapter_index=%s", (sid, ci),
        ).fetchone()
    return str((r or {}).get("content") or "")


def _commits(sid: int, ci: int | None = None) -> list[dict]:
    """该剧本(或该章)的 script_commits,按 id 升序。"""
    from platform_app.db import connect
    with connect() as db:
        if ci is None:
            rows = db.execute(
                "select id, kind, message, payload from script_commits "
                "where script_id=%s order by id",
                (sid,),
            ).fetchall()
        else:
            rows = db.execute(
                "select id, kind, message, payload from script_commits "
                "where script_id=%s and coalesce(payload->'ids'->>'chapter_index','')=%s order by id",
                (sid, str(ci)),
            ).fetchall()
    return [dict(r) for r in rows]


class ChapterCommitHistoryE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cleanup_test_users()
        cls.client = make_client()

    @classmethod
    def tearDownClass(cls):
        cleanup_test_users()

    def _setup(self) -> tuple[dict, int, int]:
        u = register_user(self.client)
        uid = int(self.client.get("/api/v1/auth/me", cookies=u["cookies"]).json()["user"]["id"])
        from platform_app.db import connect
        with connect() as db:
            sid = int(db.execute(
                "insert into scripts(owner_id, title) values (%s,%s) returning id",
                (uid, "integtest_commit_history"),
            ).fetchone()["id"])
            db.execute(
                "insert into script_chapters(script_id, chapter_index, title, content) values (%s,%s,%s,%s)",
                (sid, 1, "开篇", "原始正文 v0"),
            )
        return u, uid, sid

    def _save(self, u: dict, sid: int, ci: int, **fields):
        """走真实 HTTP 端点保存章节(与编辑器同路径)。"""
        return self.client.post(
            f"/api/v1/scripts/{sid}/chapters/{ci}", json=fields, cookies=u["cookies"],
        )

    # ── 基础:手动保存落一条记录,before 是改前全文 ──────────────────────────────
    def test_manual_save_records_commit_with_before_snapshot(self):
        u, _uid, sid = self._setup()
        r = self._save(u, sid, 1, content="手动改 v1")
        self.assertTrue(r.json().get("ok"), r.text)
        self.assertEqual(_chapter_content(sid, 1), "手动改 v1")

        rows = _commits(sid)
        self.assertEqual(len(rows), 1, rows)
        c = rows[0]
        self.assertEqual(c["kind"], "chapter_edit")
        self.assertIn("手动编辑章节 #1", c["message"])
        p = c["payload"]
        self.assertEqual(p["source"], "editor")
        self.assertEqual(p["save_count"], 1)
        self.assertEqual(p["before"]["content"], "原始正文 v0", "before 必须是改前全文")
        self.assertFalse(p["undoable"], "手动记录不进 AI 撤销闸门")

    # ── 编辑会话合并:窗口内连续保存只留一条,save_count 递增 ───────────────────
    def test_consecutive_saves_coalesce_into_one_record(self):
        u, _uid, sid = self._setup()
        for i in range(5):
            self.assertTrue(self._save(u, sid, 1, content=f"连打 v{i + 1}").json().get("ok"))

        rows = _commits(sid)
        self.assertEqual(len(rows), 1, f"窗口内连续保存应合并为一条: {rows}")
        p = rows[0]["payload"]
        self.assertEqual(p["save_count"], 5)
        self.assertEqual(p["before"]["content"], "原始正文 v0", "before 保持编辑会话开始前的版本")
        self.assertEqual(_chapter_content(sid, 1), "连打 v5")

    # ── 窗口关闭 → 每次保存各一条,before 滚动 ──────────────────────────────────
    def test_window_disabled_creates_new_record_per_save(self):
        u, _uid, sid = self._setup()
        with patch.object(chapters_mod, "_CHAPTER_COMMIT_MERGE_MINUTES", 0):
            self._save(u, sid, 1, content="v1")
            self._save(u, sid, 1, content="v2")

        rows = _commits(sid)
        self.assertEqual(len(rows), 2, rows)
        self.assertEqual(rows[0]["payload"]["before"]["content"], "原始正文 v0")
        self.assertEqual(rows[1]["payload"]["before"]["content"], "v1",
                         "窗口外新记录的 before = 上一次编辑后的版本")

    # ── AI 记录不参与合并:与编辑器记录并存,且其后手动保存开新记录 ─────────────
    def test_ai_commit_not_coalesced_and_starts_new_session(self):
        u, uid, sid = self._setup()
        from tools_dsl.command_tools_script_write import _t_update_script_chapter

        self._save(u, sid, 1, content="手动 v1")
        out = _t_update_script_chapter(uid, sid, {"chapter_index": 1, "content": "AI v2"}, None)
        self.assertIn("已更新", out)
        self._save(u, sid, 1, content="手动 v3")

        rows = _commits(sid)
        kinds = [(r["kind"], (r["payload"] or {}).get("source")) for r in rows]
        self.assertEqual(len(rows), 3, kinds)
        self.assertEqual(kinds[0], ("chapter_edit", "editor"))
        self.assertEqual(kinds[1], ("chapter_edit", None), "AI 记录无 source 字段")
        self.assertEqual(kinds[2], ("chapter_edit", "editor"))
        self.assertEqual(rows[2]["payload"]["before"]["content"], "AI v2",
                         "AI 改过之后的手动保存开新记录,before = AI 改写后的版本")

    # ── 无字段变更 → 不写记录 ──────────────────────────────────────────────────
    def test_noop_save_writes_nothing(self):
        u, _uid, sid = self._setup()
        r = self._save(u, sid, 1)  # 不带任何字段
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(_commits(sid), [])

    # ── 手动记录不进 /undo 闸门(保护 AI 撤销语义)──────────────────────────────
    def test_manual_commit_not_undoable_by_ai_undo(self):
        u, _uid, sid = self._setup()
        self._save(u, sid, 1, content="手动改")
        r = self.client.get(f"/api/v1/scripts/{sid}/chapters/1/undoable", cookies=u["cookies"]).json()
        self.assertFalse(r.get("undoable"), "手动编辑不应进入 AI 撤销闸门")

    # ── 端到端:/history 可见 → /restore 恢复到编辑前 ───────────────────────────
    def test_history_and_restore_roundtrip(self):
        u, _uid, sid = self._setup()
        self._save(u, sid, 1, content="改后正文")

        h = self.client.get(f"/api/v1/scripts/{sid}/chapters/1/history", cookies=u["cookies"]).json()
        self.assertTrue(h.get("ok"), h)
        vs = h["versions"]
        self.assertEqual(len(vs), 1, vs)
        v = vs[0]
        self.assertTrue(v["has_before"], "手动记录必须带改前快照(恢复按钮据此显示)")
        self.assertEqual(v["source"], "editor")
        self.assertEqual(v["save_count"], 1)

        rr = self.client.post(
            f"/api/v1/scripts/{sid}/chapters/1/restore",
            json={"commit_id": v["id"]}, cookies=u["cookies"],
        ).json()
        self.assertTrue(rr.get("ok"), rr)
        self.assertEqual(_chapter_content(sid, 1), "原始正文 v0", "恢复到编辑前")

    # ── 可逆:恢复自身也存快照 → 可退回「恢复之前」 ────────────────────────────
    def test_restore_is_reversible(self):
        """点「恢复到此前」会写一条带快照的 chapter_revert → 可再恢复它来回退(点错能退回)。"""
        u, _uid, sid = self._setup()
        self._save(u, sid, 1, content="改后 A")

        h = self.client.get(f"/api/v1/scripts/{sid}/chapters/1/history", cookies=u["cookies"]).json()
        target = h["versions"][0]  # 唯一的编辑记录:点它会回到「原始正文 v0」

        r1 = self.client.post(f"/api/v1/scripts/{sid}/chapters/1/restore",
                              json={"commit_id": target["id"]}, cookies=u["cookies"]).json()
        self.assertTrue(r1.get("ok"), r1)
        self.assertEqual(_chapter_content(sid, 1), "原始正文 v0")

        h2 = self.client.get(f"/api/v1/scripts/{sid}/chapters/1/history", cookies=u["cookies"]).json()
        reverts = [v for v in h2["versions"] if v["kind"] == "chapter_revert"]
        self.assertEqual(len(reverts), 1, h2["versions"])
        self.assertTrue(reverts[0]["has_before"], "恢复记录必须带快照,否则点错无法退回")

        r2 = self.client.post(f"/api/v1/scripts/{sid}/chapters/1/restore",
                              json={"commit_id": reverts[0]["id"]}, cookies=u["cookies"]).json()
        self.assertTrue(r2.get("ok"), r2)
        self.assertEqual(_chapter_content(sid, 1), "改后 A", "恢复本身必须可逆")

    # ── 可逆:AI 撤销同样存快照 → 撤销后可通过恢复退回 ─────────────────────────
    def test_undo_is_reversible(self):
        u, uid, sid = self._setup()
        from tools_dsl.command_tools_script_write import _t_update_script_chapter

        _t_update_script_chapter(uid, sid, {"chapter_index": 1, "content": "AI 版"}, None)
        undo = self.client.post(f"/api/v1/scripts/{sid}/chapters/1/undo", cookies=u["cookies"]).json()
        self.assertTrue(undo.get("ok"), undo)
        self.assertEqual(_chapter_content(sid, 1), "原始正文 v0")

        h = self.client.get(f"/api/v1/scripts/{sid}/chapters/1/history", cookies=u["cookies"]).json()
        reverts = [v for v in h["versions"] if v["kind"] == "chapter_revert"]
        self.assertEqual(len(reverts), 1, h["versions"])
        self.assertTrue(reverts[0]["has_before"], "撤销记录必须带快照,否则撤销后无法退回")

        rr = self.client.post(f"/api/v1/scripts/{sid}/chapters/1/restore",
                             json={"commit_id": reverts[0]["id"]}, cookies=u["cookies"]).json()
        self.assertTrue(rr.get("ok"), rr)
        self.assertEqual(_chapter_content(sid, 1), "AI 版", "撤销本身必须可逆")

    # ── 删除历史记录:只删审计,正文不动;删 head 后指针必须正确回退 ──────────────
    def test_delete_commit_keeps_text_and_pointer(self):
        u, _uid, sid = self._setup()
        with patch.object(chapters_mod, "_CHAPTER_COMMIT_MERGE_MINUTES", 0):
            self._save(u, sid, 1, content="v1")
            self._save(u, sid, 1, content="v2")  # 第二条 = head

        rows = _commits(sid)
        self.assertEqual(len(rows), 2, rows)
        head_id = rows[-1]["id"]

        r = self.client.delete(f"/api/v1/scripts/{sid}/commits/{head_id}", cookies=u["cookies"]).json()
        self.assertTrue(r.get("ok"), r)
        self.assertEqual(_chapter_content(sid, 1), "v2", "删记录不得改动正文")
        self.assertEqual(len(_commits(sid)), 1)

        # 关键:head 已回退 → 再保存不得撞 parent_commit_id 外键。
        # (悬空指针会让 _write_commit 静默失败 → 记录不再新增,故断言条数而非仅看响应。)
        with patch.object(chapters_mod, "_CHAPTER_COMMIT_MERGE_MINUTES", 0):
            r2 = self._save(u, sid, 1, content="v3")
        self.assertTrue(r2.json().get("ok"), r2.text)
        self.assertEqual(len(_commits(sid)), 2, "删 head 后必须仍能继续记录(head 指针回退失效)")

    def test_delete_commit_requires_owner(self):
        u, _uid, sid = self._setup()
        self._save(u, sid, 1, content="v1")
        cid = _commits(sid)[0]["id"]
        other = register_user(self.client)
        r = self.client.delete(f"/api/v1/scripts/{sid}/commits/{cid}", cookies=other["cookies"])
        self.assertEqual(r.status_code, 403)
        self.assertEqual(len(_commits(sid)), 1, "非 owner 删除不应生效")

    # ── 剧本级 /commits:游标翻页 + 可回退性字段 ────────────────────────────────
    def test_commits_cursor_pagination_and_fields(self):
        """抽屉的分页与按类型回退都依赖 /commits:翻页不重不漏,且返回
        chapter_index / has_snapshot(前端据此判断该条能否用章节级恢复回退)。"""
        u, _uid, sid = self._setup()
        with patch.object(chapters_mod, "_CHAPTER_COMMIT_MERGE_MINUTES", 0):
            for i in range(5):
                self._save(u, sid, 1, content=f"v{i + 1}")

        p1 = self.client.get(f"/api/v1/scripts/{sid}/commits?limit=2", cookies=u["cookies"]).json()
        self.assertTrue(p1.get("ok"), p1)
        self.assertEqual(len(p1["commits"]), 2)
        self.assertTrue(p1.get("next_cursor"), "还有更早记录时必须返回 next_cursor")

        p2 = self.client.get(
            f"/api/v1/scripts/{sid}/commits?limit=2&cursor={p1['next_cursor']}",
            cookies=u["cookies"],
        ).json()
        self.assertEqual(len(p2["commits"]), 2)
        ids1 = {c["id"] for c in p1["commits"]}
        ids2 = {c["id"] for c in p2["commits"]}
        self.assertFalse(ids1 & ids2, "翻页不得重复")
        self.assertLess(max(ids2), min(ids1), "第二页必须是更早的记录")

        # 可回退性字段:章节记录必须能被前端识别为"可恢复"
        head = p1["commits"][0]
        self.assertEqual(head["chapter_index"], "1")
        self.assertTrue(head["has_snapshot"])

        p3 = self.client.get(
            f"/api/v1/scripts/{sid}/commits?limit=2&cursor={p2['next_cursor']}",
            cookies=u["cookies"],
        ).json()
        self.assertEqual(len(p3["commits"]), 1, "最后一页只剩 1 条")
        self.assertIsNone(p3.get("next_cursor"), "取完最后一条后不得再给 cursor")

    # ── 正文被"不走 commit 的写入方"改过 → 不得合并(防串章) ─────────────────────
    def test_content_change_outside_commit_breaks_merge(self):
        """结构操作(合并/拆分/删除/整本重切)不写 script_commits 却会重排 chapter_index。
        若只按 chapter_index 合并,会把旧章的 before 快照并进本章 → 「恢复到此前」写错内容。
        本用例用 after_hash 指纹校验拦它:中间正文变了就必须开新记录。"""
        u, _uid, sid = self._setup()
        self._save(u, sid, 1, content="我的第一版")

        # 模拟结构操作换章:直接改库(与 script_import 的 merge/split/delete/resplit 同性质——不落 commit)
        from platform_app.db import connect
        with connect() as db:
            db.execute(
                "update script_chapters set content=%s where script_id=%s and chapter_index=1",
                ("另一章被合并进来的正文", sid),
            )
            db.commit()

        self._save(u, sid, 1, content="继续编辑")

        rows = [r for r in _commits(sid) if (r["payload"] or {}).get("source") == "editor"]
        self.assertEqual(len(rows), 2, f"正文被外部改过必须开新记录(否则会串章): {rows}")
        self.assertEqual(rows[1]["payload"]["before"]["content"], "另一章被合并进来的正文",
                         "新记录的 before 必须是实际的改前正文")

    # ── 无正文快照的记录(超长护栏)必须被拒:防「假成功」 ───────────────────────
    def test_restore_rejects_record_without_content_snapshot(self):
        """before 里 content=None(正文过长未存)的记录:恢复必须 409,且 /history 报 has_before=false
        (否则前端会给一个"点了不动正文"的恢复按钮)。"""
        import json as _json
        u, _uid, sid = self._setup()
        self._save(u, sid, 1, content="v1")
        from platform_app.db import connect
        with connect() as db:
            row = db.execute(
                """insert into script_commits(script_id, kind, message, payload)
                   values (%s, 'chapter_edit', '超长正文记录', %s::jsonb) returning id""",
                (sid, _json.dumps({
                    "table": "script_chapters", "op": "edit",
                    "ids": {"chapter_index": 1},
                    "before": {"title": "开篇", "content": None, "volume_title": ""},
                    "undoable": False, "source": "editor",
                })),
            ).fetchone()
            cid = int(row["id"])
            db.commit()

        r = self.client.post(f"/api/v1/scripts/{sid}/chapters/1/restore",
                             json={"commit_id": cid}, cookies=u["cookies"])
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(_chapter_content(sid, 1), "v1", "被拒的恢复不得改动正文")

        h = self.client.get(f"/api/v1/scripts/{sid}/chapters/1/history", cookies=u["cookies"]).json()
        bad = [v for v in h["versions"] if v["id"] == cid]
        self.assertTrue(bad, h["versions"])
        self.assertFalse(bad[0]["has_before"], "无正文快照必须报 has_before=false(否则前端给假按钮)")


if __name__ == "__main__":
    unittest.main()
