"""AI 写库确认的版本护栏(不依赖 Postgres)。

覆盖两件事:
  1. 预览/待确认时的目标状态指纹:确认期间手动保存、另一标签或另一次 AI 写入会让
     指纹变化,批准执行前被拒绝,而不是用旧预览覆盖新内容。
  2. 章节 AI 工具把服务端注入的 base_updated_at 传给 update_chapter,并在
     ChapterConflict 时返回可行动的失败串(不再静默覆盖)。
"""
from __future__ import annotations

import asyncio  # noqa: F401  (保持与其它 console_assistant 测试一致的可导入性)

import console_assistant.write_guard as guard
import tools_dsl.command_tools_script_write.anchors as ai_anchors
import tools_dsl.command_tools_script_write.canon as ai_canon
import tools_dsl.command_tools_script_write.chapters as ai_chapters
import tools_dsl.command_tools_script_write.npc_cards as ai_cards
import tools_dsl.command_tools_script_write.worldbook as ai_worldbook
from console_assistant.llm_loop import (
    _bind_editor_script_scope,
    _is_editor_write_tool,
    _readonly_blocks_tool,
)
from console_assistant.write_preview import build_write_preview


class _Cur:
    def __init__(self, rows=None):
        self._rows = rows or []

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _DB:
    def __init__(self, row):
        self.row = row

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def commit(self):
        pass

    def rollback(self):
        pass

    def execute(self, sql, params=None):
        # 这些测试只关心 chapter 的指纹/传参;其它查询视为同一条当前行。
        return _Cur([self.row] if self.row else [])


def _patch_db(monkeypatch, row):
    import platform_app.db as dbmod
    import platform_app.perms as perms

    monkeypatch.setattr(dbmod, "init_db", lambda: None)
    monkeypatch.setattr(dbmod, "connect", lambda: _DB(row))
    monkeypatch.setattr(perms, "script_owned", lambda *_a, **_k: {"id": 1})


def test_chapter_fingerprint_changes_after_manual_write(monkeypatch):
    row = {
        "id": 11, "title": "旧标题", "volume_title": "", "content_md5": "aaa",
        "updated_at": "2026-10-25 01:00:00+00:00",
    }
    _patch_db(monkeypatch, row)
    before = guard.preview_fingerprint(
        "update_script_chapter", {"chapter_index": 1, "content": "AI 新正文"}, 7, 1,
    )
    assert before

    # 确认卡打开期间作者手动保存:内容指纹与 updated_at 都变了。
    row["content_md5"] = "bbb"
    row["updated_at"] = "2026-10-25 01:05:00+00:00"
    after = guard.preview_fingerprint(
        "update_script_chapter", {"chapter_index": 1, "content": "AI 新正文"}, 7, 1,
    )
    assert after != before

    pending = {
        "tool": "update_script_chapter",
        "args": {"chapter_index": 1},
        "script_id": 1,
        "target_fingerprint": before,
    }
    assert guard.verify_pending_fingerprint(pending, 7) == guard.STALE_WRITE_ERROR

    # 未变化时允许执行。
    pending["target_fingerprint"] = after
    assert guard.verify_pending_fingerprint(pending, 7) is None


def test_non_chapter_fingerprint_uses_version_columns(monkeypatch):
    row = {"id": 5, "row_version": 3, "updated_at": "t1"}
    _patch_db(monkeypatch, row)
    fp = guard.preview_fingerprint("update_npc_card", {"card_id": 5}, 7, 1)
    assert fp
    row["row_version"] = 4
    assert guard.preview_fingerprint("update_npc_card", {"card_id": 5}, 7, 1) != fp


def test_no_fingerprint_for_create_or_missing_script(monkeypatch):
    _patch_db(monkeypatch, None)
    assert guard.preview_fingerprint("create_npc_card", {"name": "甲"}, 7, 1) is None
    assert guard.preview_fingerprint("update_script_chapter", {"chapter_index": 1}, 7, None) is None
    # 没有 script_id 的用户级工具不参与。
    assert guard.verify_pending_fingerprint({"tool": "x", "args": {}}, 7) is None


def test_ai_chapter_tool_forwards_base_updated_at(monkeypatch, tmp_path):
    row = {"id": 11, "title": "旧", "content": "旧文", "volume_title": ""}
    _patch_db(monkeypatch, row)
    captured = {}

    def fake_update(_uid, _sid, _ci, **kwargs):
        captured.update(kwargs)
        return {"ok": True, "chapter": {"content": "新文", "updated_at": "t2"}}

    import platform_app.api.script_edit as se
    import platform_app.script_import as si

    monkeypatch.setattr(si, "update_chapter", fake_update)
    monkeypatch.setattr(se, "_write_commit", lambda *_a, **_k: None)

    out = ai_chapters._t_update_script_chapter(
        7, 1,
        {"chapter_index": 1, "content": "新文", "base_updated_at": "2026-10-25T01:00:00+00:00"},
        None,
    )
    assert out.startswith("已更新章节")
    assert captured["base_updated_at"] == "2026-10-25T01:00:00+00:00"


def test_ai_chapter_tool_reports_conflict(monkeypatch):
    row = {"id": 11, "title": "旧", "content": "旧文", "volume_title": ""}
    _patch_db(monkeypatch, row)

    class ChapterConflict(Exception):
        pass

    def boom(*_a, **_k):
        raise ChapterConflict("changed")

    import platform_app.script_import as si

    monkeypatch.setattr(si, "update_chapter", boom)
    out = ai_chapters._t_update_script_chapter(
        7, 1,
        {"chapter_index": 1, "content": "新文", "base_updated_at": "2026-10-25T01:00:00+00:00"},
        None,
    )
    assert "确认预览后被修改" in out
    assert "get_chapter_text" in out


def test_editor_destructive_tools_are_bound_to_open_script():
    # 模型传了另一个剧本 id → 直接拒绝(避免编辑器助手破坏另一个剧本)。
    args, err = _bind_editor_script_scope("resplit_script", {"script_id": 99}, 7)
    assert err and "只能操作当前编辑器打开的剧本" in err
    # 没传 → 补成当前剧本。
    bound, err = _bind_editor_script_scope("resplit_script", {"mode": "auto"}, 7)
    assert err is None and bound["script_id"] == 7
    # 传对 → 原样通过。
    same, err = _bind_editor_script_scope("rebuild_script_module", {"script_id": "7", "module": "cards"}, 7)
    assert err is None and same["module"] == "cards"
    # 非绑定工具 / 没有打开剧本 → 不干预。
    other, err = _bind_editor_script_scope("delete_save", {"save_id": 1, "script_id": 99}, 7)
    assert err is None and other["script_id"] == 99
    # 没有打开剧本 → 拒绝(不允许凭 args 操作任意剧本)。
    free, err = _bind_editor_script_scope("resplit_script", {"script_id": 99}, None)
    assert err and "先在编辑器打开" in err and free["script_id"] == 99


def test_read_only_mode_covers_destructive_structure_tools():
    # read_only 必须拦住所有会写库的编辑器工具,包括不在 _SCRIPT_WRITE_TOOLS 里的
    # resplit/rebuild;否则「只读」下仍能整本重切。
    for name in ("update_script_chapter", "import_document_as_chapters",
                 "resplit_script", "rebuild_script_module"):
        assert _is_editor_write_tool(name) is True
    for name in ("get_chapter_text", "list_worldbook_entries", "ask_user_text"):
        assert _is_editor_write_tool(name) is False


def test_readonly_blocks_save_tools_only_on_editor_surface():
    # 编辑器面只读:存档/人设等共享写工具也要拦住。
    for name in ("delete_save", "delete_saves", "create_save", "rename_save",
                 "activate_save", "create_persona", "delete_persona",
                 "create_character_card", "delete_character_card"):
        assert _readonly_blocks_tool(name, "read_only", True) is True, name
    # 游戏控制台/平台控制台(非 editor surface)不受编辑器只读偏好影响。
    assert _readonly_blocks_tool("delete_save", "read_only", False) is False
    # 非只读模式不拦。
    assert _readonly_blocks_tool("delete_save", "review", True) is False
    # 脚本内容写入无论哪个面都受 read_only 约束(原行为)。
    assert _readonly_blocks_tool("update_script_chapter", "read_only", False) is True


def test_script_op_preview_shows_target_and_mode(monkeypatch):
    _patch_db(monkeypatch, {"title": "测试剧本"})
    pv = build_write_preview("resplit_script", {"mode": "auto"}, 7, 42)
    assert pv and pv["kind"] == "script_op"
    assert "测试剧本" in pv["after"] and "#42" in pv["after"]
    assert "auto" in pv["after"]

    pv2 = build_write_preview(
        "rebuild_script_module", {"module": "cards", "source": "llm"}, 7, 42,
    )
    assert pv2 and "cards" in pv2["after"] and "llm" in pv2["after"]

    pv3 = build_write_preview("import_document_as_chapters", {"mode": "replace"}, 7, 42)
    assert pv3 and "替换现有章节" in pv3["after"]


def test_rebuild_fingerprint_covers_target_module(monkeypatch):
    # 章节结构没变,但目标模块(cards)在确认期间被保存 → 指纹必须变化。
    row = {"n": 3, "max_id": 10, "max_ts": "t1", "mv": 2, "mts": "t2"}
    _patch_db(monkeypatch, row)
    before = guard.preview_fingerprint(
        "rebuild_script_module", {"module": "cards"}, 7, 1,
    )
    assert before
    row["mv"] = 3
    row["mts"] = "t3"
    after = guard.preview_fingerprint(
        "rebuild_script_module", {"module": "cards"}, 7, 1,
    )
    assert after != before

    # 别名与规范名指向同一模块(同一个 DB 状态 → 同一指纹)。
    row["mv"] = 2
    row["mts"] = "t2"
    assert guard.preview_fingerprint(
        "rebuild_script_module", {"module": "角色卡"}, 7, 1,
    ) == guard.preview_fingerprint(
        "rebuild_script_module", {"module": "cards"}, 7, 1,
    )


def test_create_chapter_takes_struct_lock_and_syncs_word_count(monkeypatch):
    sqls = []

    class _CreateCur:
        def __init__(self, rows):
            self._rows = rows or []

        def fetchone(self):
            return self._rows[0] if self._rows else None

    class _CreateDB:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def commit(self):
            pass

        def execute(self, sql, params=None):
            s = " ".join(str(sql).split())
            sqls.append(s)
            low = s.lower()
            if low.startswith("select coalesce(max(chapter_index)"):
                return _CreateCur([{"m": 3}])
            if low.startswith("insert into script_chapters"):
                return _CreateCur([{"id": 42}])
            return _CreateCur([])

    import platform_app.api.script_edit as se
    import platform_app.db as dbmod
    import platform_app.perms as perms

    monkeypatch.setattr(dbmod, "init_db", lambda: None)
    monkeypatch.setattr(dbmod, "connect", lambda: _CreateDB())
    monkeypatch.setattr(perms, "script_owned", lambda *_a, **_k: {"id": 1})
    monkeypatch.setattr(se, "_write_commit", lambda *_a, **_k: None)

    out = ai_chapters._t_create_script_chapter(
        7, 1, {"title": "新章", "content": "正文"}, None,
    )
    assert "已新建章节" in out
    # 并发新建/与文件树同时新建必须串行化,否则 max+1 撞唯一键。
    assert any("pg_advisory_xact_lock" in s for s in sqls)
    # content 非空时剧本总字数必须同步,不能只更 chapter_count。
    assert any("word_count=(select coalesce(sum(word_count)" in s for s in sqls)




# ── 非章节写操作:版本基线注入 + 原子 WHERE ─────────────────────────────────

class _RC:
    def __init__(self, rowcount=0, row=None):
        self.rowcount = rowcount
        self._row = row

    def fetchone(self):
        return self._row


def test_preview_baseline_versions(monkeypatch):
    ts = "2026-10-25 01:00:00+00:00"
    row = {"id": 2, "row_version": 5, "updated_at": ts, "title": "t", "content_md5": "m"}
    _patch_db(monkeypatch, row)
    assert guard.preview_baseline("upsert_worldbook_entry", {"entry_id": 2}, 7, 1) == {"base_updated_at": ts}
    assert guard.preview_baseline("delete_worldbook_entry", {"entry_id": 2}, 7, 1) == {"base_updated_at": ts}
    assert guard.preview_baseline("update_npc_card", {"card_id": 2}, 7, 1) == {"base_row_version": 5}
    assert guard.preview_baseline("update_anchor", {"anchor_id": 2}, 7, 1) == {"base_updated_at": ts}
    assert guard.preview_baseline("delete_anchor", {"anchor_id": 2}, 7, 1) == {"base_updated_at": ts}
    assert guard.preview_baseline("upsert_canon_entity", {"logical_key": "k"}, 7, 1) == {"base_updated_at": ts}
    assert guard.preview_baseline(
        "upsert_worldbook_entries", {"entries": [{"entry_id": 2}]}, 7, 1,
    ) == {"entries": {"2": ts}}
    # 创建/无目标不注入。
    assert guard.preview_baseline("upsert_worldbook_entry", {}, 7, 1) is None
    assert guard.preview_baseline("update_script_chapter", {"chapter_index": 1}, 7, 1) is None


def test_worldbook_update_uses_atomic_baseline():
    before = {
        "id": 2, "title": "旧", "content": "旧文", "priority": 50, "token_budget": 600,
        "sticky_turns": 0, "cooldown_turns": 0, "probability": 100.0, "enabled": True,
        "keys": [], "regex_keys": [], "character_filter": [], "scene_filter": [],
        "insertion_position": "worldbook",
    }

    class DB:
        def __init__(self):
            self.update = None

        def execute(self, sql, params=None):
            s = " ".join(str(sql).split()).lower()
            if s.startswith("update worldbook_entries"):
                self.update = (s, params)
                return _RC(0)
            return _RC(1, before)

    db = DB()
    out = ai_worldbook._wb_upsert_one(
        db, 1, 7,
        {"entry_id": 2, "content": "新文", "base_updated_at": "2026-10-25T01:00:00+00:00"},
    )
    assert out["ok"] is False and "已被修改" in out["error"]
    assert "updated_at=%s" in db.update[0]
    assert any(hasattr(p, "year") for p in db.update[1])   # 解析后的 datetime,不是原始字符串


def test_card_update_forwards_base_row_version(monkeypatch):
    card = {"id": 3, "name": "甲", "background": "旧", "metadata": {}}
    _patch_db(monkeypatch, card)
    captured = {}

    def fake_upsert(_uid, _sid, payload):
        captured.update(payload)
        return {"id": 3}

    import platform_app.api.script_edit as se
    import platform_app.knowledge.character_cards as cc

    monkeypatch.setattr(cc, "upsert_character_card", fake_upsert)
    monkeypatch.setattr(se, "_write_commit", lambda *_a, **_k: None)

    out = ai_cards._t_update_npc_card(
        7, 1, {"card_id": 3, "background": "新", "base_row_version": 5}, None,
    )
    assert out.startswith("已更新")
    assert captured["base_row_version"] == 5


def test_card_update_reports_conflict(monkeypatch):
    card = {"id": 3, "name": "甲", "background": "旧", "metadata": {}}
    _patch_db(monkeypatch, card)

    class CharacterCardConflict(Exception):
        pass

    def boom(*_a, **_k):
        raise CharacterCardConflict("changed")

    import platform_app.api.script_edit as se
    import platform_app.knowledge.character_cards as cc

    monkeypatch.setattr(cc, "upsert_character_card", boom)
    monkeypatch.setattr(se, "_write_commit", lambda *_a, **_k: None)

    out = ai_cards._t_update_npc_card(
        7, 1, {"card_id": 3, "background": "新", "base_row_version": 5}, None,
    )
    assert "确认预览后已被修改" in out
    assert "list_script_npcs" in out


def test_anchor_and_canon_use_atomic_baseline(monkeypatch):
    import platform_app.api.script_edit as se
    import platform_app.db as dbmod
    import platform_app.perms as perms

    monkeypatch.setattr(dbmod, "init_db", lambda: None)
    monkeypatch.setattr(perms, "script_owned", lambda *_a, **_k: {"id": 1})
    monkeypatch.setattr(se, "_write_commit", lambda *_a, **_k: None)

    class AnchorDB:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def commit(self):
            pass

        def execute(self, sql, params=None):
            s = " ".join(str(sql).split()).lower()
            if s.startswith("update script_timeline_anchors"):
                return _RC(0)
            return _RC(1, {"id": 8, "story_time_label": "旧"})

    monkeypatch.setattr(dbmod, "connect", lambda: AnchorDB())
    out = ai_anchors._t_update_anchor(
        7, 1, {"anchor_id": 8, "story_time_label": "新", "base_updated_at": "2026-10-25T01:00:00+00:00"}, None,
    )
    assert "确认预览后已被修改" in out

    class CanonDB:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def commit(self):
            pass

        def execute(self, sql, params=None):
            s = " ".join(str(sql).split()).lower()
            if s.startswith("update kb_canon_entities"):
                return _RC(0)
            return _RC(1, {"id": 9})

    monkeypatch.setattr(dbmod, "connect", lambda: CanonDB())
    out2 = ai_canon._t_upsert_canon_entity(
        7, 1, {"logical_key": "k", "summary": "新", "base_updated_at": "2026-10-25T01:00:00+00:00"}, None,
    )
    assert "确认预览后已被修改" in out2


def test_structured_preview_hides_internal_baselines():
    # 服务端注入的 base_* 是并发控制参数,不能出现在“将写入”预览里。
    pv = build_write_preview(
        "update_npc_card", {"card_id": 3, "background": "新", "base_row_version": 5}, 7, 1,
    )
    assert pv and "base_row_version" not in pv["after"]
    pv2 = build_write_preview(
        "upsert_worldbook_entries",
        {"entries": [{"entry_id": 2, "title": "t", "base_updated_at": "2026-10-25T01:00:00+00:00"}]},
        7, 1,
    )
    assert pv2 and "base_updated_at" not in pv2["after"]


def test_worldbook_delete_uses_atomic_baseline(monkeypatch):
    import platform_app.api.script_edit as se
    import platform_app.db as dbmod
    import platform_app.perms as perms

    class DB:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def commit(self):
            pass

        def execute(self, sql, params=None):
            s = " ".join(str(sql).split()).lower()
            if s.startswith("delete from worldbook_entries"):
                return _RC(0)
            return _RC(1, {"title": "旧"})

    monkeypatch.setattr(dbmod, "init_db", lambda: None)
    monkeypatch.setattr(dbmod, "connect", lambda: DB())
    monkeypatch.setattr(perms, "script_owned", lambda *_a, **_k: {"id": 1})
    monkeypatch.setattr(se, "_write_commit", lambda *_a, **_k: None)

    out = ai_worldbook._t_delete_worldbook_entry(
        7, 1, {"entry_id": 2, "base_updated_at": "2026-10-25T01:00:00+00:00"}, None,
    )
    assert "确认预览后已被修改" in out
    assert "list_worldbook_entries" in out
