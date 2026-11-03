"""
test_resplit_contract.py — resplit_script 知识库契约诚实性 + 自动重建回归锁定

背景(审计坐实的问题):resplit_script 的旧 docstring 声称"知识库(chapter_facts 等)
不动,需要时调一次 sync",但 documents/document_chunks/chapter_facts 三表对
script_chapters(id) 都设了 on delete cascade 外键 → `delete from script_chapters`
实际把三表物理级联清空,docstring 撒谎。

本测试锁定修复后的契约:
  1. docstring 不再包含"不动"这种误导性表述。
  2. 源码里存在 knowledge_cleared 字段(诚实标注三表已被级联清空)。
  3. resplit 成功路径:自动调用零 LLM 确定性重建入口
     (import_pipeline.rebuild_chunks_from_db / rebuild_facts_from_db,与
     /rebuild/{module} 路由复用同一对函数,不重新发明)重建 document_chunks
     与 chapter_facts,返回体 facts_rebuilt=True。
  4. 重建入口异常路径:不炸主流程(resplit 本身仍 ok=True),返回体
     facts_rebuilt=False + 有 rebuild_error,且已 warning 日志。

纯单测,不接触真实数据库:connect()/init_db()/script_owned()/chapter_splitter/
_lock_chapter_struct/_validate_custom_pattern 全部 monkeypatch 成内存假件。
"""
from __future__ import annotations

import inspect
import os
import sys
from contextlib import contextmanager
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

os.environ.setdefault("RPG_REQUIRE_AUTH", "0")

import platform_app  # noqa: E402
from platform_app import script_import  # noqa: E402


def _patch_import_pipeline(monkeypatch, fake_module):
    """resplit_script 内部用 `from . import import_pipeline`(函数体内延迟导入)。
    一旦 platform_app 包上已经真实绑定过 import_pipeline 属性(测试会话里几乎
    总会发生,因为别的测试模块会真实 import 到它),`from package import submodule`
    优先读包属性而不是重新查 sys.modules,所以只 monkeypatch.setitem(sys.modules,...)
    在全量测试套件里不可靠——必须同时把 platform_app 包对象上的属性也换掉。"""
    monkeypatch.setitem(sys.modules, "platform_app.import_pipeline", fake_module)
    monkeypatch.setattr(platform_app, "import_pipeline", fake_module, raising=False)


# ══════════════════════════════════════════════════════════════════════
#  纯内存假 DB:够用即可,只支持 resplit_script 实际用到的调用形状
# ══════════════════════════════════════════════════════════════════════
class _FakeCursor:
    def __init__(self):
        self.executemany_calls: list[tuple[str, list]] = []

    def executemany(self, sql, seq):
        self.executemany_calls.append((sql, list(seq)))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeDB:
    """记录被执行的 SQL,不真正连库。"""

    def __init__(self):
        self.executed: list[tuple[str, tuple]] = []
        self.cursor_obj = _FakeCursor()

    def execute(self, sql, params=()):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        return None

    def cursor(self):
        return self.cursor_obj


@contextmanager
def _fake_connect():
    yield _FakeDB()


SCRIPT_ROW = {
    "id": 42, "title": "测试剧本", "source_path": "scripts/dummy_source.txt",
}

FAKE_CHAPTERS = [
    {"title": "第一章", "content": "内容一" * 10, "volume_title": "", "source_marker": ""},
    {"title": "第二章", "content": "内容二" * 10, "volume_title": "", "source_marker": ""},
]
FAKE_REPORT = {"confidence": 0.9}


class _FakeSplitter:
    @staticmethod
    def decode_bytes(raw):
        return "原始文本", "utf-8"

    @staticmethod
    def clean_text(text):
        return text

    @staticmethod
    def split_chapters_with_report(text, *, split_rule, custom_pattern, source_name, title):
        return list(FAKE_CHAPTERS), dict(FAKE_REPORT)


def _install_common_fakes(monkeypatch, *, source_exists=True):
    """把 resplit_script 依赖的一切 DB/文件系统调用换成假件。"""
    monkeypatch.setattr(script_import, "init_db", lambda: None)
    monkeypatch.setattr(script_import, "connect", _fake_connect)
    monkeypatch.setattr(script_import, "script_owned", lambda db, sid, uid: dict(SCRIPT_ROW))
    monkeypatch.setattr(script_import, "chapter_splitter", _FakeSplitter)
    monkeypatch.setattr(script_import, "_lock_chapter_struct", lambda db, sid: None)
    monkeypatch.setattr(script_import, "_validate_custom_pattern", lambda pattern: None)

    fake_path = REPO / "dummy_resplit_source_for_test.txt"
    monkeypatch.setattr(script_import.Path, "exists", lambda self: source_exists)
    monkeypatch.setattr(script_import.Path, "read_bytes", lambda self: b"raw bytes")
    monkeypatch.setattr(script_import.Path, "resolve", lambda self: fake_path)
    # BASE.resolve() 是常量路径对象,需在越界检查里仍判定 fake_path 落在 BASE 下
    monkeypatch.setattr(
        script_import, "BASE",
        type(script_import.BASE)(str(fake_path.parent)),
    )


# ══════════════════════════════════════════════════════════════════════
#  1) docstring 诚实性
# ══════════════════════════════════════════════════════════════════════
def test_docstring_no_longer_claims_untouched():
    doc = script_import.resplit_script.__doc__ or ""
    # 旧的撒谎契约原句:"知识库(chapter_facts 等)不动,需要时调一次 sync"。
    # 断言这句连起来的假契约字面不再存在(注意:"scripts/game_saves 不动"是另一句
    # 真实的、无关的声明,不应被误伤;而修复后的新文本虽然会引用"不动"两字来
    # *反驳*它,但不会再出现"知识库...不动"这个连续假称)。
    assert "知识库（chapter_facts 等）不动" not in doc
    assert "知识库(chapter_facts 等)不动" not in doc
    # 应该明确讲清级联删空 + 自动重建,而不是含糊带过
    assert "级联" in doc
    assert "重建" in doc
    assert "cascade" in doc.lower() or "级联" in doc


def test_source_declares_knowledge_cleared_field():
    src = inspect.getsource(script_import.resplit_script)
    assert "knowledge_cleared" in src


# ══════════════════════════════════════════════════════════════════════
#  2) 成功路径:自动重建入口被调用,返回体诚实
# ══════════════════════════════════════════════════════════════════════
def test_resplit_success_rebuilds_chunks_and_facts(monkeypatch):
    _install_common_fakes(monkeypatch)

    calls: list[str] = []

    class _FakePipeline:
        @staticmethod
        def rebuild_chunks_from_db(user_id, script_id, *, incremental=True):
            calls.append(f"chunks:{user_id}:{script_id}:{incremental}")
            return {"ok": True, "before_count": 0, "after_count": 2, "partial_failures": []}

        @staticmethod
        def rebuild_facts_from_db(user_id, script_id):
            calls.append(f"facts:{user_id}:{script_id}")
            return {"ok": True, "before_count": 0, "after_count": 2, "partial_failures": []}

    _patch_import_pipeline(monkeypatch, _FakePipeline)

    result = script_import.resplit_script(user_id=7, script_id=42, split_rule="auto")

    assert result["ok"] is True
    assert result["knowledge_cleared"] is True
    assert result["chunks_rebuilt"] is True
    assert result["facts_rebuilt"] is True
    assert result.get("rebuild_error", "") == ""
    # 两个零 LLM 确定性重建入口都必须被调用,且透传同一 user_id/script_id。
    # resplit 换了章节结构,chunks 必须走全量(incremental=False),不能沿用增量。
    assert "chunks:7:42:False" in calls
    assert "facts:7:42" in calls


# ══════════════════════════════════════════════════════════════════════
#  3) 失败路径:重建入口炸了不带垮 resplit 主流程
# ══════════════════════════════════════════════════════════════════════
def test_resplit_survives_rebuild_failure(monkeypatch):
    _install_common_fakes(monkeypatch)

    class _FakePipelineBoom:
        @staticmethod
        def rebuild_chunks_from_db(user_id, script_id, *, incremental=True):
            raise RuntimeError("模拟重建炸了")

        @staticmethod
        def rebuild_facts_from_db(user_id, script_id):
            raise AssertionError("chunks 已经炸了,facts 不该被调用到这里也不该影响主流程")

    _patch_import_pipeline(monkeypatch, _FakePipelineBoom)

    result = script_import.resplit_script(user_id=7, script_id=42, split_rule="auto")

    # resplit 的核心操作(换章节结构)必须仍然成功
    assert result["ok"] is True
    assert result["chapter_count"] == len(FAKE_CHAPTERS)
    # 但重建失败要如实反映,不能假装成功
    assert result["facts_rebuilt"] is False
    assert result.get("rebuild_error", "") != ""


def test_resplit_partial_rebuild_failure_reports_facts_rebuilt_false(monkeypatch):
    """chunks 重建成功但 facts 重建返回 ok=False(非异常,是业务失败)时,
    facts_rebuilt 必须诚实为 False,不能被 chunks 的成功掩盖。"""
    _install_common_fakes(monkeypatch)

    class _FakePipelinePartial:
        @staticmethod
        def rebuild_chunks_from_db(user_id, script_id, *, incremental=True):
            return {"ok": True, "before_count": 0, "after_count": 2, "partial_failures": []}

        @staticmethod
        def rebuild_facts_from_db(user_id, script_id):
            return {"ok": False, "error": "无权访问该剧本"}

    _patch_import_pipeline(monkeypatch, _FakePipelinePartial)

    result = script_import.resplit_script(user_id=7, script_id=42, split_rule="auto")

    assert result["ok"] is True
    assert result["chunks_rebuilt"] is True
    assert result["facts_rebuilt"] is False
