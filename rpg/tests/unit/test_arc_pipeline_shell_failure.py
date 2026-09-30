"""回归:arc 管线不得把「空壳弧」当成功(假 ok=True → 假「重做完成」)。

生产实证(script 1《吞噬星空》rebuild_canon 五连):提取模型凭证缺失 → extract_chapter
把 LLM 异常吞成 ChapterExtract(raw_ok=False) 空壳 → 旧版 _one 只判 `ex is not None`,
106 个空壳全部计成成功弧 → run_arc_extraction 返回 ok=True、0 实体、0 token,
job 状态 done,前端弹「重做完成」。本文件锁死修复后的语义:
  · raw_ok=False 的弧 = 失败弧(重试后计入 failed_arcs,不进 extracts);
  · 全部弧失败 → ok=False,error 指向提取模型凭证。
"""
from __future__ import annotations

from types import SimpleNamespace

import extract.arc_pipeline as arc_pipeline
from extract.arc_pipeline import run_arc_extraction
from extract.per_chapter import ChapterExtract


class _FakeConn:
    """只服务 run_arc_extraction 第一段「读章节」查询;全失败路径不会再碰 DB。"""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, args=None):
        rows = [
            {"chapter_index": i, "title": f"第{i}章",
             "content": "正文内容。" * 30, "content_descriptor": ""}
            for i in (1, 2, 3)
        ]
        return SimpleNamespace(fetchall=lambda: rows)


def _install(monkeypatch, *, shell: bool):
    monkeypatch.setattr("platform_app.db.connect", lambda: _FakeConn())
    monkeypatch.setattr("time.sleep", lambda s: None)  # 跳过重试退避,测试秒回
    monkeypatch.setattr(
        arc_pipeline, "build_seed",
        lambda *a, **k: SimpleNamespace(era="", power_system=[], entity_vocab=[]),
    )
    if shell:
        # extract_chapter 吞异常后的产物:空壳(raw_ok=False)
        monkeypatch.setattr(
            arc_pipeline, "extract_arc",
            lambda llm, arc, **k: ChapterExtract(chapter=arc[0]["chapter_index"], raw_ok=False),
        )
    else:
        def _raise(llm, arc, **k):
            raise RuntimeError("simulated LLM outage")
        monkeypatch.setattr(arc_pipeline, "extract_arc", _raise)


def test_all_shell_extracts_fail_not_ok(monkeypatch):
    """全部弧返回空壳(raw_ok=False)→ ok=False,不得假成功。"""
    _install(monkeypatch, shell=True)
    r = run_arc_extraction(1, 1, model="bogus", api_id="bogus")
    assert r.get("ok") is False
    assert "全部弧段" in str(r.get("error"))
    assert "凭证" in str(r.get("error"))


def test_all_arc_exceptions_fail_not_ok(monkeypatch):
    """全部弧抛异常 → ok=False(同时覆盖 _one 重试后 failed_arcs 可达路径)。"""
    _install(monkeypatch, shell=False)
    r = run_arc_extraction(1, 1, model="bogus", api_id="bogus")
    assert r.get("ok") is False
    assert "全部弧段" in str(r.get("error"))
