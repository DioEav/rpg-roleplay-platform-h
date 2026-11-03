"""test_resplit_script_knowledge_rebuild.py — P1 修复回归测试

背景: resplit_script 的旧 docstring 声称"知识库(chapter_facts 等)不动，
需要时调一次 sync"，但 documents/document_chunks/chapter_facts 三表对
script_chapters(id) 都是 on delete cascade 外键 —— `delete from
script_chapters` 一执行，挂在旧章节下的这三表行就被数据库物理级联删空，
不是"过时"。旧返回体 `knowledge_stale: True` 同样具有误导性(暗示"还在只是
过时")。

本文件覆盖:
  1. docstring 不再包含旧的误导性措辞，且包含新的诚实表述关键词。
  2. 返回体同时具备旧字段 knowledge_stale(兼容) 与新字段 knowledge_cleared(诚实)。
  3. resplit_script 执行流程中确实调用了零 LLM 的确定性重建函数
     (import_pipeline.rebuild_chunks_from_db / rebuild_facts_from_db)，
     成功时返回体 facts_rebuilt=True。
  4. 重建函数抛异常时，resplit_script 主流程不崩溃、仍返回 ok=True，
     但 facts_rebuilt=False。

所有 DB 操作用 unittest.mock 替身，不打真 DB(与 tests/unit 目录下其它
script_import 相关测试一致的风格，例如 test_command_tools_misc.py)。
"""
from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from platform_app import script_import


def _make_fake_db(script_row: dict) -> MagicMock:
    """构造一个假的 db 连接:
    - execute(...) 返回一个可以 .fetchone() 出 script_row 的对象(仅在
      script_owned 内部真正用到；resplit_script 本体对 db.execute 的其它
      调用都不关心返回值)。
    - cursor() 支持 `with db.cursor() as cur:` 上下文管理器协议，
      cur.executemany 是 no-op mock。
    """
    db = MagicMock()

    fetch_result = MagicMock()
    fetch_result.fetchone.return_value = script_row
    db.execute.return_value = fetch_result

    cur_cm = MagicMock()
    cur = MagicMock()
    cur_cm.__enter__.return_value = cur
    cur_cm.__exit__.return_value = False
    db.cursor.return_value = cur_cm

    return db


class ResplitScriptDocstringHonesty(unittest.TestCase):
    """docstring 不再撒谎: 不含"不动"/"不受影响"，含级联清空 + 自动重建关键词。"""

    def test_no_misleading_old_phrases(self):
        doc = script_import.resplit_script.__doc__ or ""
        self.assertNotIn("知识库（chapter_facts/character_cards/worldbook）不动", doc)
        self.assertNotIn("知识库不受影响", doc)

    def test_contains_honest_cascade_and_rebuild_keywords(self):
        doc = script_import.resplit_script.__doc__ or ""
        self.assertIn("cascade", doc)
        self.assertIn("级联", doc)
        self.assertIn("重建", doc)


class ResplitScriptReturnBodyFields(unittest.TestCase):
    """返回体字段: 旧字段兼容保留 + 新增诚实字段 + 重建结果字段。"""

    def _run_resplit_with_rebuild_mocks(self, *, chunks_ok=True, facts_ok=True,
                                         rebuild_side_effect=None):
        script_row = {
            "id": 1, "source_path": "scripts/demo.txt", "title": "demo",
        }
        fake_db = _make_fake_db(script_row)

        fake_chapters = [
            {"title": "第一章", "content": "内容一", "volume_title": "",
             "source_marker": "", "is_author_note": False,
             "exclude_from_extraction": False, "title_confidence": 1.0,
             "content_descriptor": ""},
            {"title": "第二章", "content": "内容二", "volume_title": "",
             "source_marker": "", "is_author_note": False,
             "exclude_from_extraction": False, "title_confidence": 1.0,
             "content_descriptor": ""},
        ]
        fake_report = {"confidence": 0.9, "mode": "rule_chapter_cn"}

        with patch.object(script_import, "init_db"), \
             patch.object(script_import, "connect") as mock_connect, \
             patch.object(script_import, "script_owned", return_value=script_row), \
             patch.object(script_import, "_lock_chapter_struct"), \
             patch.object(script_import.Path, "exists", return_value=True), \
             patch.object(script_import.Path, "read_bytes", return_value=b"raw bytes"), \
             patch.object(script_import.chapter_splitter, "decode_bytes",
                          return_value=("raw text", "utf-8")), \
             patch.object(script_import.chapter_splitter, "clean_text",
                          return_value="raw text"), \
             patch.object(script_import.chapter_splitter, "split_chapters_with_report",
                          return_value=(fake_chapters, fake_report)):

            mock_connect.return_value.__enter__.return_value = fake_db
            mock_connect.return_value.__exit__.return_value = False

            import platform_app.import_pipeline as ip

            with patch.object(ip, "rebuild_chunks_from_db",
                               side_effect=rebuild_side_effect,
                               return_value={"ok": chunks_ok}) as mock_chunks, \
                 patch.object(ip, "rebuild_facts_from_db",
                              side_effect=rebuild_side_effect,
                              return_value={"ok": facts_ok}) as mock_facts:
                result = script_import.resplit_script(
                    user_id=1, script_id=1, split_rule="auto",
                )
                return result, mock_chunks, mock_facts

    def test_knowledge_cleared_true_and_legacy_field_kept(self):
        result, _chunks, _facts = self._run_resplit_with_rebuild_mocks()
        self.assertTrue(result.get("ok"))
        self.assertIs(result.get("knowledge_cleared"), True)
        # 旧字段仍在(未发现消费方读取，但为兼容未知调用方保留)
        self.assertIs(result.get("knowledge_stale"), True)

    def test_rebuild_functions_are_called_and_facts_rebuilt_true(self):
        result, mock_chunks, mock_facts = self._run_resplit_with_rebuild_mocks()
        # 整本重切后章节结构全变:必须显式 incremental=False(全量),不能走增量。
        mock_chunks.assert_called_once_with(1, 1, incremental=False)
        mock_facts.assert_called_once_with(1, 1)
        self.assertIs(result.get("facts_rebuilt"), True)
        self.assertIs(result.get("chunks_rebuilt"), True)

    def test_rebuild_exception_does_not_crash_resplit_and_reports_false(self):
        result, mock_chunks, _mock_facts = self._run_resplit_with_rebuild_mocks(
            rebuild_side_effect=RuntimeError("boom: indexer unavailable"),
        )
        # 主流程必须继续成功返回，不能因为重建失败而抛异常/整体失败
        self.assertTrue(result.get("ok"))
        self.assertIs(result.get("facts_rebuilt"), False)
        mock_chunks.assert_called_once_with(1, 1, incremental=False)


if __name__ == "__main__":
    unittest.main()
