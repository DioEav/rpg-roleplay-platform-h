"""回归:extract.llm.parse_json 截断打捞 + extract_chapter 不再因截断丢整弧。

生产实证(吞噬星空 ch150 段):弧级 schema 输出被 max_tokens 截断 → 半份 JSON
被旧版 parse_json 整份丢弃(allow_truncated 默认 False)→ extract_chapter 空壳。
修复:parse_json 开 allow_truncated(与 import_pipeline._parse_json 同口径),
max_tokens 5500 → 8000,警告日志带 finish_reason。
"""
from __future__ import annotations

import pytest

from extract.llm import parse_json
from extract.per_chapter import ChapterExtract, extract_chapter


class _MockLLM:
    """返回预设内容的假 LLM(str=原样返回,Exception=抛出)。

    str 走真实 parse_json:复刻 ExtractLLM.complete_json「LLM 返回文本 → 解析成
    dict」的行为(extract_chapter 只认 dict,拿到 str 会判 raw_ok=False)。"""

    def __init__(self, payload):
        self._payload = payload

    def complete_json(self, system, user, max_tokens=2000):
        if isinstance(self._payload, Exception):
            raise self._payload
        if isinstance(self._payload, str):
            return parse_json(self._payload)
        return self._payload


# 复刻生产日志里的截断形态:最外层 { 未闭合,截在 story_time 中段
TRUNCATED_ARC_JSON = (
    '{"chapter_summary":"罗峰在澳洲雾岛躲避李耀追杀,沿途击溃食人花后钻地脱险;'
    '随后八位战神进入9号古文明遗迹,接受生死未知的考验。",'
    '"story_time":{"label":"冬末","relativ'
)


def test_truncated_json_salvages_complete_fields():
    """截断响应按已完整字段打捞:chapter_summary 保留,残缺的 story_time 丢尾。"""
    data = parse_json(TRUNCATED_ARC_JSON)
    assert isinstance(data, dict)
    assert "罗峰" in data.get("chapter_summary", "")
    assert "story_time" not in data  # 残缺字段不产出半吊子


def test_truncated_still_fails_when_nothing_salvageable():
    """纯散文/无 JSON 结构 → 仍抛 ValueError(调用方重试兜底不变)。"""
    with pytest.raises(ValueError):
        parse_json("好的,以下是您要的JSON,请查收:")


def test_empty_response_raises():
    with pytest.raises(ValueError, match="空响应"):
        parse_json("")


def test_extract_chapter_salvages_truncated_response():
    """extract_chapter 遇截断响应:打捞出的字段照常成卡,不再返回空壳。"""
    ex = extract_chapter(_MockLLM(TRUNCATED_ARC_JSON), 150, "正文", era="星历2930年代")
    assert isinstance(ex, ChapterExtract)
    assert ex.raw_ok is True
    assert "罗峰" in ex.chapter_summary
