"""extract 三处结构化微任务禁深思 + 空正文护栏回归测试(268 实锤族,2026-07-10)。

facts_refine.refine_chapter / worldbook_enrich.enrich_script_worldbook /
world_key_backfill._make_llm_call_fn 三处都是结构化 JSON 微任务(章节摘要 / 世界书条目
充实 / 世界线判定),思考模型会无界思考吃光 max_tokens 正文恒空。三处统一从
call_agent_json 换成 call_agent_json_guarded(no_think=True + 空正文护栏)。

护栏内部引用模块全局 _harness.call_agent_json——patch 它即可拦到真实调用,验证:
① no_think 透传为 True;② 第一跳空正文时扩预算(max(2x,1200))重试一次。
"""
import json

from agents import _harness, recorder
from extract import facts_refine, world_key_backfill, worldbook_enrich


def _make_fake(returns):
    """返回 (fake, captured)。fake 顶掉 _harness.call_agent_json,逐次吐 returns 里的
    (text, usage);captured 记录每跳的 no_think / max_tokens 供断言。"""
    seq = iter(returns)
    captured = {"no_think": [], "max_tokens": []}

    def fake(*args, **kwargs):
        captured["no_think"].append(kwargs.get("no_think"))
        captured["max_tokens"].append(kwargs.get("max_tokens"))
        return next(seq)

    return fake, captured


# ── 假 DB(execute(...).fetchall()/fetchone())────────────────────────

class _Cur:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _Conn:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, *a, **k):
        return _Cur(self._rows)

    def commit(self):
        pass


# ── 1. facts_refine.refine_chapter ──────────────────────────────────

# ≥80 字正文(过 len<80 护栏);全是「甲」,与摘要零 25 字连续重叠(过照抄检测)
_CONTENT = "甲" * 100
# 归纳复述摘要:35 字,处于 [MIN_SUMMARY_CHARS, MAX_SUMMARY_CHARS] 内,且不含「甲」
_SUMMARY = "本章讲述主角在异世界初次登场并与关键人物相遇局势由此展开的过程归纳复述"
_REFINED_JSON = json.dumps(
    {"chapter_summary": _SUMMARY, "in_world_time": "穿越当日下午"},
    ensure_ascii=False,
)


def _fake_db_facts():
    # refine_chapter 用一条 join 查询取标题/正文/facts 行 id;fake 返回同一行。
    return _Conn([{"content": _CONTENT, "title": "x", "fact_id": 1}])


def test_facts_refine_passes_no_think(monkeypatch):
    """refine_chapter 走 guarded 且 no_think=True 透传;返回能过 validate_refined。"""
    fake, captured = _make_fake([(_REFINED_JSON, {"output_tokens": 50})])
    monkeypatch.setattr(_harness, "call_agent_json", fake)

    out = facts_refine.refine_chapter(_fake_db_facts(), 7, 3, 1, "relay", "m")

    assert captured["no_think"] == [True]
    assert out and out["summary"] == _SUMMARY
    assert out["in_world_time"] == "穿越当日下午"


def test_facts_refine_empty_body_guard_expands_budget(monkeypatch):
    """第一跳空正文 → 护栏扩预算重试:max_tokens 序列 [800, 1600](max(2x,1200))。"""
    fake, captured = _make_fake([
        ("", {"reasoning_tokens": 300}),   # 第一跳空(思考吃光 300 预算)
        (_REFINED_JSON, {"output_tokens": 50}),  # 扩预算后拿到正文
    ])
    monkeypatch.setattr(_harness, "call_agent_json", fake)

    out = facts_refine.refine_chapter(_fake_db_facts(), 7, 3, 1, "relay", "m")

    assert captured["max_tokens"] == [800, 1600]
    assert captured["no_think"] == [True, True]
    assert out and out["summary"] == _SUMMARY


# ── 2. worldbook_enrich.enrich_script_worldbook ─────────────────────

# 世界书条目充实内容:150 字,处于 [MIN_CONTENT, MAX_CONTENT] 内
_WB_CONTENT = "乙" * 150
_WB_JSON = json.dumps({"content": _WB_CONTENT}, ensure_ascii=False)


def test_worldbook_enrich_passes_no_think(monkeypatch):
    """enrich 走 guarded 且 no_think=True;返回 entries 里 status=='ok'。"""
    import platform_app.db as pdb

    monkeypatch.setattr(pdb, "init_db", lambda *a, **k: None)
    monkeypatch.setattr(
        pdb, "connect",
        lambda *a, **k: _Conn([{"id": 1, "title": "力量·战姬", "content": "旧"}]),
    )
    # gather_material 是模块级函数:直接顶掉,返回 ≥200 字材料(过材料不足门槛)
    monkeypatch.setattr(worldbook_enrich, "gather_material",
                        lambda *a, **k: "丙" * 300)
    monkeypatch.setattr(recorder, "_resolve_recorder_api_and_model",
                        lambda *a: ("relay", "m"))

    fake, captured = _make_fake([(_WB_JSON, {"output_tokens": 80})])
    monkeypatch.setattr(_harness, "call_agent_json", fake)

    res = worldbook_enrich.enrich_script_worldbook(7, 1, pattern="战姬", apply=False)

    assert captured["no_think"] == [True]
    assert res["ok"] is True
    assert res["entries"] and res["entries"][0]["status"] == "ok"


# ── 3. world_key_backfill._make_llm_call_fn ─────────────────────────

def test_world_key_confirm_passes_no_think(monkeypatch):
    """_make_llm_call_fn 造的 call_fn 走 guarded 且 no_think=True;文本原样透传。"""
    monkeypatch.setattr(recorder, "_resolve_recorder_api_and_model",
                        lambda *a: ("relay", "m"))

    fake, captured = _make_fake([("判定文本透传", {"output_tokens": 20})])
    monkeypatch.setattr(_harness, "call_agent_json", fake)

    call_fn = world_key_backfill._make_llm_call_fn(1, None, None)
    assert call_fn is not None
    text = call_fn("sys", "user")

    assert captured["no_think"] == [True]
    assert text == "判定文本透传"
