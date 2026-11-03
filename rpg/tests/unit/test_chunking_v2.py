"""test_chunking_v2 — 章节切片阶段 1 回归。

覆盖:
  · 场景分隔符(`***`/2+空行/时间切换句)不被当成正文、不生成 3 字碎片块;
  · 场景内按句累积,单块 ≤1200 字(完整进入 1250 的嵌入上限);
  · content 仍是原文,context_header/chunk_key/char_start/char_end 只进 metadata;
  · 查询感知片段以命中句为中心、落在完整句边界,无命中时退回块头。
"""
from __future__ import annotations

from platform_app.knowledge._utils import (
    _chunk_chapter,
    _normalize_chunk_text,
    _pick_snippet,
    _query_tokens,
)

SAMPLE = """林砚推开客栈的门，风雪灌进来。掌柜抬头看了他一眼，低声道：“客官，可是姓林？”
林砚握紧腰间的青铜短刀，没有说话。
“这把刀……是林家的？”掌柜盯着刀鞘上的缺口。
林砚脸色一变：“你认得这把刀？”
掌柜压低声音：“三年前黑风寨那一夜，我就在场。”

***

三日后，林砚在城外破庙醒来。短刀还在，刀鞘上多了一道刻痕。
他想起掌柜的话，握紧了刀。"""


def _norm(text: str) -> str:
    return _normalize_chunk_text(text)


def test_separator_is_not_a_chunk_and_scene_index_advances():
    chunks = _chunk_chapter(SAMPLE, script_id=12, chapter_id=7,
                            chapter_index=1, title="雪夜来客")
    assert len(chunks) >= 2
    assert all(c["content"].strip() != "***" for c in chunks)
    assert [c["metadata"]["scene_index"] for c in chunks] == list(range(len(chunks)))
    # 显式分隔符两侧属于不同场景
    assert chunks[0]["metadata"]["scene_index"] == 0
    assert chunks[1]["metadata"]["scene_index"] == 1


def test_separator_only_chapter_has_no_chunks():
    """全篇只有 ***/空行时不应兜底生成一个“***”正文块。"""
    assert _chunk_chapter("***\n\n***", script_id=1, chapter_id=1,
                          chapter_index=1, title="空章") == []


def test_long_scene_chunks_are_within_embedding_limit():
    long_text = "".join(
        f"第{i}句，林砚握紧青铜短刀，望向黑风寨的方向。" for i in range(1, 300)
    )
    chunks = _chunk_chapter(long_text, script_id=1, chapter_id=2, chapter_index=3,
                            title="长夜")
    assert len(chunks) > 1
    assert all(len(c["content"]) <= 1200 for c in chunks)
    assert all(c["content"] for c in chunks)


def test_offsets_slice_back_to_content():
    chunks = _chunk_chapter(SAMPLE, script_id=12, chapter_id=7,
                            chapter_index=1, title="雪夜来客")
    norm = _norm(SAMPLE)
    for c in chunks:
        m = c["metadata"]
        assert norm[m["char_start"]:m["char_end"]] == c["content"]


def test_context_header_and_chunk_key():
    chunks = _chunk_chapter(SAMPLE, script_id=12, chapter_id=7,
                            chapter_index=1, title="雪夜来客")
    m = chunks[0]["metadata"]
    assert m["context_header"] == "第1章 雪夜来客"
    assert m["chapter_title"] == "雪夜来客"
    assert m["chunk_key"].startswith("s12:ch7:sc0:")
    assert m["chunking_version"] == "v2-scene"
    # header 不污染正文
    assert not chunks[0]["content"].startswith("第1章")


def test_chinese_numeral_title_is_not_prefixed_twice():
    """标题已是「第一章 …」时不能再拼成「第1章 第一章 …」。"""
    chunks = _chunk_chapter(SAMPLE, script_id=1, chapter_id=1,
                            chapter_index=1, title="第一章 雪夜来客")
    assert chunks[0]["metadata"]["context_header"] == "第一章 雪夜来客"


def test_time_cue_starts_new_scene():
    first = "林砚在客栈里坐了很久，窗外的雪一直没有停。" * 20  # >300 字,允许切
    text = first + "\n\n三日后，林砚在城外破庙醒来。短刀还在，刀鞘上多了一道刻痕。"
    chunks = _chunk_chapter(text, script_id=1, chapter_id=1, chapter_index=1,
                            title="雪夜")
    assert len(chunks) >= 2
    assert any("三日后" in c["content"] for c in chunks)
    # “三日后”应在后续场景的第一块,而不是被并进上一段
    assert chunks[-1]["metadata"]["scene_index"] >= 1


def test_dialogue_sentence_kept_whole():
    chunks = _chunk_chapter(SAMPLE, script_id=1, chapter_id=1, chapter_index=1,
                            title="雪夜来客")
    joined = "\n".join(c["content"] for c in chunks)
    assert "“你认得这把刀？”" in joined


def test_pick_snippet_prefers_query_sentence():
    content = "开头一句。" + "无关内容。" * 80 + "掌柜盯着刀鞘：“这把刀是林家的？”" + "后续内容。" * 40
    snip = _pick_snippet(content, _query_tokens("青铜短刀的来历"), max_chars=160)
    assert "这把刀是林家的" in snip
    assert len(snip) <= 160
    assert snip[-1] in "。！？!?…”’」』"


def test_pick_snippet_falls_back_to_head_without_match():
    content = "第一句。第二句。第三句。" + "填充。" * 100
    snip = _pick_snippet(content, _query_tokens("完全不存在的词"), max_chars=50)
    assert snip == content[:50].strip()


def test_pick_snippet_short_content_returns_all():
    content = "短内容。"
    assert _pick_snippet(content, ["短"], max_chars=100) == content


def test_pick_snippet_does_not_expand_into_oversized_sentence():
    """左侧命中句得分更高但太长放不下时,应扩右侧短句,而不是超限后硬截。"""
    left = "甲乙" + "无" * 38 + "。"       # 41 字,含 1 个查询词
    best = "甲乙丙。"                      # 4 字,含 2 个查询词
    right = "无。"                         # 2 字
    tail = "无" * 30 + "。"                # 31 字
    snip = _pick_snippet(left + best + right + tail, ["甲乙", "丙"], max_chars=30)
    assert snip == best + right
    assert len(snip) <= 30
    assert snip.endswith("。")
