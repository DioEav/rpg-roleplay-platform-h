"""拆书审计 R2/R3/R4 修复单测:LLM 精炼验收 / 句边界截断 / 残句指纹检测。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from chapter_fact_indexer import _sentence_truncate, _summary_from_events  # noqa: E402
from console_assistant.editor_context import _is_garbage_summary  # noqa: E402
from extract.facts_refine import build_refine_prompts, refine_script, validate_refined  # noqa: E402
from platform_app.knowledge._chunks import _upsert_chapter_fact  # noqa: E402

_CONTENT = (
    "林有德耸了耸肩，说：“我和司令官先生进行了友好的切磋，他对我的看法表示赞赏。”"
    "随后他转身离开了指挥部,外面的战姬们正在列队。" * 6
)


# ── validate_refined ─────────────────────────────────────────────────

def _raw(summary, itime="穿越次日下午"):
    return json.dumps({"chapter_summary": summary, "in_world_time": itime}, ensure_ascii=False)


def test_accepts_real_summary():
    out = validate_refined(_raw("林有德在指挥部与司令官会面并获得认可,离开时注意到战姬部队正在集结,他开始思考如何利用先知优势立足。"), _CONTENT)
    assert out and out["in_world_time"] == "穿越次日下午"


def test_rejects_verbatim_copy():
    """照抄原文 25 字连续片段 → 拒(schema 铁律:绝不照抄)。"""
    copied = "林有德耸了耸肩，说：“我和司令官先生进行了友好的切磋，他对我的看法表示赞赏。”"
    assert validate_refined(_raw(copied), _CONTENT) is None


def test_rejects_too_short_and_garbage():
    assert validate_refined(_raw("太短了"), _CONTENT) is None
    assert validate_refined("不是JSON", _CONTENT) is None


def test_fence_stripped():
    ok = "```json\n" + _raw("林有德离开指挥部后观察战姬列队,决定先弄清这个世界的军事格局再谋出路,为此他准备接近司令部的参谋们。") + "\n```"
    assert validate_refined(ok, _CONTENT) is not None


def test_prompts_carry_title_and_body():
    sys_p, usr_p = build_refine_prompts("第1章 穿越", "正文内容" * 10)
    assert "绝不照抄" in sys_p and "第1章 穿越" in usr_p


# ── _sentence_truncate(R2 确定性侧) ─────────────────────────────────

def test_truncate_at_sentence_boundary():
    s = ("这是第一句话。" * 33)  # 231 字帧,加尾巴后超 240
    long = s + "这是最后一个不完整的句子会被截断在词中间xxxxxxxxxxxxxxxx"
    out = _sentence_truncate(long)
    assert out.endswith("。") and len(out) <= 240


def test_truncate_short_untouched():
    assert _sentence_truncate("短句。") == "短句。"


def test_summary_from_events_uses_boundary():
    ev = [{"event": "很长的事件描述" + "内容" * 60}]
    out = _summary_from_events(ev, [])
    assert len(out) <= 300


def test_summary_from_events_covers_first_mid_last():
    """长章摘要不能只摘前两句;首/中/尾都要有代表。"""
    ev = [
        {"event": "第零段，林有德抵达指挥部并说明来意。"},
        {"event": "第一段，林有德确认了战姬部队的部署。"},
        {"event": "第二段，林有德发现司令官隐瞒了伤情。"},
        {"event": "第三段，林有德与参谋发生争执。"},
        {"event": "第四段，林有德离开时带走了一份名单。"},
    ]
    out = _summary_from_events(ev, [])
    assert "第零段" in out and "第二段" in out and "第四段" in out
    assert len(out) <= 300


def test_summary_from_events_skips_fragment_and_dialogue():
    ev = [
        {"event": "”这时有人从门后探出头来，语气很急。"},
        {"event": "“你终于来了，我等了你三天。”"},
        {"event": "林有德推门进入指挥部，确认了战姬部队的部署。"},
    ]
    out = _summary_from_events(ev, [])
    assert out.startswith("林有德")
    assert "”" not in out[:1] and "“" not in out[:1]


def test_long_chapter_prompt_keeps_tail_marker():
    content = "开头内容。" * 1500 + "TAIL_MARKER_结尾转折。" + "结尾内容。" * 500
    _sys, usr = build_refine_prompts("第40章 长夜", content)
    assert "TAIL_MARKER_结尾转折" in usr
    assert "【开头】" in usr and "【中段】" in usr and "【结尾】" in usr


def test_time_equal_to_title_is_rejected():
    raw = _raw("林有德在指挥部与司令官会面并获得认可,离开时注意到战姬部队正在集结,他开始思考如何利用先知优势立足。",
               itime="第40章 长夜")
    out = validate_refined(raw, _CONTENT, title="第40章 长夜")
    assert out and out["in_world_time"] == ""


# ── _is_garbage_summary(R4 残句指纹) ────────────────────────────────

def test_garbage_divider_still_caught():
    assert _is_garbage_summary("======")


def test_fragment_starting_with_close_quote():
    assert _is_garbage_summary("”这时候有人对林有德说，“大炮可是很笨重的")


def test_hard_cut_tail_caught():
    frag = "林有德说了很多" + "内容" * 113  # ≥232 字且无句尾标点
    assert _is_garbage_summary(frag[:235])


def test_real_summary_passes():
    assert not _is_garbage_summary("林有德在指挥部与司令官会面并获得认可,随后开始筹划如何在这个战姬世界立足。")


# ── chapter_facts upsert:精炼保护 ───────────────────────────────────

def test_upsert_chapter_fact_preserves_refined_summary_by_hash():
    class _DB:
        sql = ""

        def execute(self, sql, params=None):
            self.sql = sql
            return None

    db = _DB()
    _upsert_chapter_fact(
        db, {"id": 1}, {"id": 2},
        {"id": 3, "content": "正文内容", "chapter_index": 1},
        {"id": 4},
        {
            "chapter": 1, "title": "标题", "viewpoint": "", "summary": "规则摘要",
            "story_phase": "", "story_time_label": "标题", "scene_count": 1,
            "token_estimate": 2, "characters": [], "locations": [], "factions": [],
            "concepts": [], "items": [], "relationships": [], "events": [],
            "confidence": 0.5,
        },
    )
    assert "chapter_content_hash" in db.sql
    assert "chapter_facts.metadata->>'source' = 'llm_refined'" in db.sql
    assert "in_world_time = case when" in db.sql
    assert "chapter_facts.summary" in db.sql


def test_refine_script_only_processes_candidates():
    """增量:候选只有 3/5,已精炼的 1/2/4 不计入 LLM 调用,也不应算 partial。"""
    class _Cur:
        def __init__(self, one=None, rows=None):
            self.one, self.rows = one, rows or []

        def fetchone(self):
            return self.one

        def fetchall(self):
            return self.rows

    class _DB:
        def execute(self, sql, params=None):
            s = " ".join(str(sql).split()).lower()
            if "coalesce(max(chapter_index)" in s:
                return _Cur(one={"m": 5})
            if "left join chapter_facts" in s:
                return _Cur(rows=[{"chapter_index": 3}, {"chapter_index": 5}])
            return _Cur(one=None, rows=[])

        def commit(self):
            pass

    db = _DB()
    calls: list[int] = []

    def _fake_refine(db_, script_id, ch, user_id, api_id, model, **kwargs):
        calls.append(ch)
        return {"summary": "新摘要", "in_world_time": "", "_content_hash": "h"}

    class _CM:
        def __enter__(self):
            return db

        def __exit__(self, *a):
            return False

    with patch("platform_app.db.init_db"), \
         patch("platform_app.db.connect", return_value=_CM()), \
         patch("agents.recorder._resolve_recorder_api_and_model",
               return_value=("deepseek", "deepseek-v4-flash")), \
         patch("extract.facts_refine.refine_chapter", side_effect=_fake_refine), \
         patch("extract.facts_refine.apply_refined", return_value=True):
        out = refine_script(7, 1, ch_from=1, ch_to=5, apply=True)

    assert calls == [3, 5]
    assert out["refined"] == 2
    assert out["already_done"] == 3
    assert out["total"] == 2
