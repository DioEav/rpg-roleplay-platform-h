"""离线单测:每回合确定性「世界线锚点」兜底判定器 gm_serving.anchor_reconcile。

全部 mock,不连真 DB / 不调真 LLM。验证:
  - 命中 → 确定性 UPDATE pending→occurred/variant + advance_progress(max-only)
  - 不命中 / 低置信空 → 零写入
  - 无模型降级(judge 抛/返空)→ 静默 0,不破回合
  - 窗口外 anchor_key 命中 → 拒绝(防剧透,绝不跳远未来)
  - judge 编造 anchor_key(不在 pending 列表)→ 拒绝
  - fatal 锚点确实到达 → 允许标记(反映已发生)
  - drift 阈值:>=0.15 → variant,<0.15 → occurred(与 mark_anchor_satisfied 一致)
  - 异常不破回合(get_progress_window 抛 → 返 0)
  - 成本门控:窗口内无 pending → 零 LLM 调用(judge 不被调)
  - env RPG_ANCHOR_AUTO_RECONCILE=0 → 完全跳过
  - 已非 pending(GM 本轮自调过)→ UPDATE ... where status='pending' 返 None → 不计数
  - 单回合标记上限(_MAX_MARK_PER_TURN)
  - 节奏兜底累计器跨回合存活(不被每回合 worldline 整列重写清零)
"""
import os
import re
import unittest
from unittest import mock

from agents.anchor_seed_agent import ANCHOR_BEHIND_GRACE_CHAPTERS
from gm_serving import anchor_reconcile as ar


# ────────────────────────────────────────────────────────────
#  Fake DB:记录 execute 调用,按 SQL 关键词返回预置 row
# ────────────────────────────────────────────────────────────
class _FakeResult:
    def __init__(self, row=None, rows=None):
        self._row = row
        self._rows = rows or []

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class FakeDB:
    """最小 psycopg 连接替身:
    - select max(turn_index) → {"t": <turn>}
    - update save_anchor_states ... returning → 命中 set 里的 key 才返 row,否则 None
    """
    def __init__(self, *, max_turn=42, pending_keys=None, src_chapter=12, occurred_max=0,
                 progress_pc=None, script_id_val=None, chapter_rows=None, pace_accum=0,
                 pace_setting="on"):
        self.max_turn = max_turn
        # 仍 pending(可被本兜底 UPDATE 命中)的 anchor_key 集合
        self.pending_keys = set(pending_keys if pending_keys is not None else [])
        self.src_chapter = src_chapter
        # 已确认锚点最大原著章(_apply_estimate 算 ceiling 的 floor 真源)
        self.occurred_max = occurred_max
        # _load_estimate_context 备料用:进度/剧本/章节地图
        self.progress_pc = progress_pc
        self.script_id_val = script_id_val
        self.chapter_rows = chapter_rows or []
        # 叙事节奏兜底累计器(progress_pace_accum)。可变,跨调用累积。
        self.pace_accum = pace_accum
        # 存档级「自动节奏推进」设置(auto_pace_advance),默认 on。
        self.pace_setting = pace_setting
        self.accum_writes = []  # 每次 accum 落库的新值
        self.expired_calls = []  # 回看宽限收束 update 的 params(desc, save_id, threshold)
        self.updates = []  # (anchor_key, new_status, drift)
        self.calls = []    # 原始 (sql, params)

    # _load_estimate_context 用 `with connect() as db`,需上下文管理器协议
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        s = " ".join(sql.split())
        if "max(turn_index)" in s:
            return _FakeResult(row={"t": self.max_turn})
        # 叙事节奏兜底:先于 progress_chapter 分支(该 SQL 同时含 progress_chapter + progress_pace_accum)
        if "progress_pace_accum" in s:
            if s.lower().startswith("update"):
                # params: (new_accum, save_id)
                self.pace_accum = int(params[0])
                self.accum_writes.append(self.pace_accum)
                return _FakeResult(row=None)
            pc = self.progress_pc if self.progress_pc is not None else 1
            return _FakeResult(row={"pc": int(pc), "ac": int(self.pace_accum)})
        if "progress_chapter" in s and "game_sessions" in s:
            return _FakeResult(row={"pc": self.progress_pc})
        if "auto_pace_advance" in s:
            return _FakeResult(row={"v": self.pace_setting})
        if "script_id" in s and "game_saves" in s:
            return _FakeResult(row={"script_id": self.script_id_val})
        if "from chapter_facts" in s:
            return _FakeResult(rows=self.chapter_rows)
        if "max(source_chapter)" in s:
            return _FakeResult(row={"c": self.occurred_max})
        if s.startswith("update save_anchor_states"):
            if "status = 'superseded'" in s and "source_chapter <" in s:
                # 回看宽限收束(expire_behind_anchors): params=(desc, save_id, threshold)
                self.expired_calls.append(params)
                return _FakeResult(rows=[{"id": 1}])
            # params: (new_status, desc, occurred_turn, drift, save_id, anchor_key)
            new_status, _desc, _turn, drift, _sid, anchor_key = params
            if anchor_key in self.pending_keys:
                self.updates.append((anchor_key, new_status, drift))
                # 模拟 "returning id, source_chapter"
                return _FakeResult(row={"id": 999, "source_chapter": self.src_chapter})
            # 已非 pending(GM 本轮自调过 / 并发已标)→ returning 返 None
            return _FakeResult(row=None)
        return _FakeResult(row=None)


def _pending(*keys, fatal_keys=()):
    return [
        {"anchor_key": k, "summary": f"概要 {k}", "is_fatal": (k in fatal_keys),
         "chapter": 12}
        for k in keys
    ]


def _judge_returns(*hits):
    """构造一个固定返回 hits 的注入判定器(避开 E731 lambda)。"""
    def _judge(user_id, turn_text, pending, **kw):
        return list(hits)
    return _judge


def _judge_raises(exc):
    def _judge(*a, **k):
        raise exc
    return _judge


def _judge_dict(reached=(), estimated=None):
    """新式判定器:返回 {reached, estimated_chapter}(测有界叙事章估计)。"""
    def _judge(user_id, turn_text, pending, **kw):
        return {"reached": list(reached), "estimated_chapter": estimated}
    return _judge


def _judge_dict_motion(reached=(), estimated=None, motion=None):
    """带 progress_motion 的判定器(测叙事节奏兜底)。"""
    def _judge(user_id, turn_text, pending, **kw):
        return {"reached": list(reached), "estimated_chapter": estimated, "progress_motion": motion}
    return _judge


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        # 默认开启
        os.environ["RPG_ANCHOR_AUTO_RECONCILE"] = "1"
        # 这些估章/ceiling 用例针对【非限速】基线写就(pace 现已默认开,会叠加 +2 cap)。
        # 显式钉死 pace=off 以隔离测 ceiling 数学;限速 +2 的覆盖见 test_apply_estimate_pace_cap。
        os.environ["RPG_ANCHOR_PACE"] = "0"
        # advance_progress 记录调用,不连库
        self.adv_calls = []
        self._adv_patch = mock.patch(
            "gm_serving.settings.advance_progress",
            side_effect=lambda db, sid, ch: self.adv_calls.append((sid, ch)),
        )
        self._adv_patch.start()
        self.addCleanup(self._adv_patch.stop)

    def tearDown(self):
        os.environ.pop("RPG_ANCHOR_AUTO_RECONCILE", None)
        os.environ.pop("RPG_ANCHOR_PACE", None)

    # 统一 patch 窗口 + pending,judge / db 用注入
    def _run(self, *, pending, judge, db, win=None):
        win = win or {"chapter_min": 11, "chapter_max": 60, "source": "satisfied"}
        with mock.patch.object(ar, "get_progress_window", return_value=win), \
             mock.patch.object(ar, "list_pending_for_phase", return_value=pending):
            return ar.reconcile_anchors_for_turn(
                1, 7, "本回合 GM 正文……", db=db, _judge=judge,
            )

    # ── 命中:variant 落库 + 进度推进 ──────────────────────────
    def test_hit_marks_variant_and_advances(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"}, src_chapter=12)
        judge = _judge_returns({"anchor_key": "chapter:12:event:0", "drift_score": 0.3})
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 1)
        self.assertEqual(db.updates, [("chapter:12:event:0", "variant", 0.3)])
        self.assertEqual(self.adv_calls, [(1, 12)])

    # ── drift < 0.15 → occurred ───────────────────────────────
    def test_hit_low_drift_marks_occurred(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_returns({"anchor_key": "chapter:12:event:0", "drift_score": 0.0})
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 1)
        self.assertEqual(db.updates[0][1], "occurred")

    # ── 不命中 / 低置信空数组 → 零写入 ────────────────────────
    def test_no_hit_writes_nothing(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_returns()  # 判定器保守判空
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(db.updates, [])
        self.assertEqual(self.adv_calls, [])

    # ── 无模型降级:judge 抛 → 静默 0,不破回合 ────────────────
    def test_judge_raises_swallowed(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_raises(RuntimeError("无可用 BYOK 模型"))
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(db.updates, [])

    # ── 默认判定器:无 key(harness 抛)→ 静默返空契约 dict ──────
    _EMPTY_JUDGE = {"reached": [], "estimated_chapter": None}

    def test_default_judge_no_key_silent(self):
        with mock.patch(
            "agents._harness.resolve_api_and_model",
            side_effect=RuntimeError("no BYOK"),
        ):
            out = ar._default_judge(7, "正文", _pending("chapter:12:event:0"))
        self.assertEqual(out, self._EMPTY_JUDGE)

    def test_default_judge_call_fails_silent(self):
        with mock.patch(
            "agents._harness.resolve_api_and_model",
            return_value=("anthropic", "claude-haiku-4-5"),
        ), mock.patch(
            "agents._harness.call_agent_json",
            side_effect=RuntimeError("401 no credentials"),
        ):
            out = ar._default_judge(7, "正文", _pending("chapter:12:event:0"))
        self.assertEqual(out, self._EMPTY_JUDGE)

    # ── 窗口外 anchor_key 命中 → 拒绝(防剧透,绝不跳远未来)──
    def test_out_of_window_key_rejected(self):
        db = FakeDB(pending_keys={"chapter:99:event:0"})  # 即便 DB 里 pending
        # 窗口内 pending 只含早章;judge 却命中远未来章
        judge = _judge_returns({"anchor_key": "chapter:99:event:0", "drift_score": 0.0})
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(db.updates, [])

    # ── judge 编造 anchor_key(不在 pending 列表)→ 拒绝 ──────
    def test_fabricated_key_rejected(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_returns({"anchor_key": "made:up:key", "drift_score": 0.5})
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)

    # ── fatal 锚点确实到达 → 允许标记 ─────────────────────────
    def test_fatal_anchor_can_be_marked(self):
        db = FakeDB(pending_keys={"chapter:12:death:0"})
        judge = _judge_returns({"anchor_key": "chapter:12:death:0", "drift_score": 0.2})
        n = self._run(
            pending=_pending("chapter:12:death:0", fatal_keys=("chapter:12:death:0",)),
            judge=judge, db=db,
        )
        self.assertEqual(n, 1)
        self.assertEqual(db.updates[0][1], "variant")

    # ── 异常不破回合:窗口查询抛 → 返 0 ───────────────────────
    def test_progress_window_raises_swallowed(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_returns({"anchor_key": "chapter:12:event:0", "drift_score": 0.0})
        with mock.patch.object(ar, "get_progress_window", side_effect=RuntimeError("DB down")), \
             mock.patch.object(ar, "list_pending_for_phase", return_value=_pending("chapter:12:event:0")):
            n = ar.reconcile_anchors_for_turn(1, 7, "正文", db=db, _judge=judge)
        self.assertEqual(n, 0)

    # ── 成本门控:窗口内无 pending + 估章关 → 零 LLM 调用 ──────
    #    (Bug B 后:无 pending 但估章开会为估章发 1 次调用,设计 §73;故此处显式关估章验成本闸仍在)
    def test_no_pending_estimate_off_zero_llm_call(self):
        os.environ["RPG_PROGRESS_NARRATIVE_ESTIMATE"] = "0"
        try:
            db = FakeDB()
            called = {"n": 0}
            def judge(*a, **k):
                called["n"] += 1
                return []
            n = self._run(pending=[], judge=judge, db=db)
            self.assertEqual(n, 0)
            self.assertEqual(called["n"], 0)  # 估章关 + 无 pending → judge 绝不被调
        finally:
            os.environ.pop("RPG_PROGRESS_NARRATIVE_ESTIMATE", None)

    # ── Bug B §73:窗口内无 pending 但估章开 → 仍跑判定器只估章并推进(根治 >50 章空白段冻结)──
    def test_no_pending_estimate_still_runs(self):
        db = FakeDB(occurred_max=0)
        called = {"n": 0}
        def judge(user_id, turn_text, pending, **kw):
            called["n"] += 1
            return {"reached": [], "estimated_chapter": 6}
        n = self._run(pending=[], judge=judge, db=db)
        self.assertEqual(n, 0, "无 pending → 无锚点标记")
        self.assertEqual(called["n"], 1, "估章开 → 判定器仍被调一次只估章")
        self.assertEqual(self.adv_calls, [(1, 6)], "无 pending 也能靠估章推进")

    # ── env 关闭 → 完全跳过(judge 不调) ─────────────────────
    def test_env_disabled_skips(self):
        os.environ["RPG_ANCHOR_AUTO_RECONCILE"] = "0"
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        called = {"n": 0}
        def judge(*a, **k):
            called["n"] += 1
            return [{"anchor_key": "chapter:12:event:0", "drift_score": 0.0}]
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(called["n"], 0)

    # ── 已非 pending(GM 本轮自调过)→ UPDATE 返 None → 不计数 ─
    def test_already_marked_not_double_counted(self):
        # judge 命中,但 DB 里该 key 已非 pending(pending_keys 不含)
        db = FakeDB(pending_keys=set())
        judge = _judge_returns({"anchor_key": "chapter:12:event:0", "drift_score": 0.0})
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(self.adv_calls, [])  # 没真标 → 不推进

    # ── 单回合标记上限 ────────────────────────────────────────
    def test_per_turn_cap(self):
        keys = [f"chapter:12:event:{i}" for i in range(10)]
        db = FakeDB(pending_keys=set(keys))
        judge = _judge_returns(*[{"anchor_key": k, "drift_score": 0.0} for k in keys])
        n = self._run(pending=_pending(*keys), judge=judge, db=db)
        self.assertEqual(n, ar._MAX_MARK_PER_TURN)
        self.assertEqual(len(db.updates), ar._MAX_MARK_PER_TURN)

    # ── 重复 key 去重 ─────────────────────────────────────────
    def test_duplicate_keys_deduped(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_returns(
            {"anchor_key": "chapter:12:event:0", "drift_score": 0.0},
            {"anchor_key": "chapter:12:event:0", "drift_score": 0.5},
        )
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 1)
        self.assertEqual(len(db.updates), 1)

    # ── 空 turn_text / 缺 save_id → 早退 0 ────────────────────
    def test_empty_inputs_early_return(self):
        db = FakeDB(pending_keys={"chapter:12:event:0"})
        judge = _judge_returns({"anchor_key": "chapter:12:event:0", "drift_score": 0.0})
        with mock.patch.object(ar, "get_progress_window") as gpw:
            self.assertEqual(ar.reconcile_anchors_for_turn(1, 7, "", db=db, _judge=judge), 0)
            self.assertEqual(ar.reconcile_anchors_for_turn(0, 7, "x", db=db, _judge=judge), 0)
            self.assertEqual(ar.reconcile_anchors_for_turn(1, 0, "x", db=db, _judge=judge), 0)
            gpw.assert_not_called()  # 早退在窗口查询之前

    # ══ Bug B 有界叙事章估计 ══════════════════════════════════════

    # ── 无锚点命中也能靠估章推进(save 139 的核心场景)──────────
    def test_estimate_advances_without_anchor_hit(self):
        # 注入 _judge → 不走真实备料(prev 默认 1);floor=0 → ceiling=1+12=13;est=6 → 推到 6。
        db = FakeDB(pending_keys=set(), occurred_max=0)
        judge = _judge_dict(reached=[], estimated=6)
        n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0, "无锚点命中 → 标记数 0")
        self.assertEqual(db.updates, [], "无锚点 UPDATE")
        self.assertEqual(self.adv_calls, [(1, 6)], "估章把进度从 1 推到 6")

    # ── 估章超上限被 clamp 到 ceiling(防 ch77 乱跳)────────────
    def test_estimate_clamped_to_ceiling(self):
        db = FakeDB(pending_keys=set(), occurred_max=0)
        judge = _judge_dict(reached=[], estimated=99)
        n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(self.adv_calls, [(1, 13)], "prev=1,floor=0,CAP=12 → 钳到 13")

    # ── 锚点命中 + 估章同回合都推进 ─────────────────────────────
    def test_estimate_with_anchor_hit_both_advance(self):
        db = FakeDB(pending_keys={"chapter:9:event:0"}, src_chapter=9, occurred_max=0)
        judge = _judge_dict(
            reached=[{"anchor_key": "chapter:9:event:0", "drift_score": 0.0}],
            estimated=6,
        )
        n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(n, 1, "锚点标记 1 个")
        # 锚点 advance(9) + 估章 advance(6) 都调用(advance_progress 自身 max-only 兜底)
        self.assertIn((1, 9), self.adv_calls)
        self.assertIn((1, 6), self.adv_calls)

    # ── env 关闭 → 不估章 ───────────────────────────────────────
    def test_estimate_env_off(self):
        os.environ["RPG_PROGRESS_NARRATIVE_ESTIMATE"] = "0"
        try:
            db = FakeDB(pending_keys=set(), occurred_max=0)
            judge = _judge_dict(reached=[], estimated=6)
            n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
            self.assertEqual(n, 0)
            self.assertEqual(self.adv_calls, [], "开关关 → 不推进")
        finally:
            os.environ.pop("RPG_PROGRESS_NARRATIVE_ESTIMATE", None)

    # ── _apply_estimate clamp 直测(各边界)─────────────────────
    def test_apply_estimate_clamp_unit(self):
        # 区间内
        self.adv_calls.clear()
        out = ar._apply_estimate(FakeDB(occurred_max=0), 1, prev_progress=5, estimated_chapter=8)
        self.assertEqual(out, 8)
        self.assertEqual(self.adv_calls, [(1, 8)])
        # 超 ceiling = max(floor=0,prev=5)+12 = 17 → 钳 17
        self.adv_calls.clear()
        out = ar._apply_estimate(FakeDB(occurred_max=0), 1, prev_progress=5, estimated_chapter=99)
        self.assertEqual(out, 17)
        self.assertEqual(self.adv_calls, [(1, 17)])
        # 低于 prev → 不推进(回退是 rewind 的职责)
        self.adv_calls.clear()
        out = ar._apply_estimate(FakeDB(occurred_max=0), 1, prev_progress=5, estimated_chapter=3)
        self.assertEqual(out, 0)
        self.assertEqual(self.adv_calls, [])
        # floor(已确认锚点)抬高 ceiling:floor=20 → ceiling=32 → est=99 钳 32
        self.adv_calls.clear()
        out = ar._apply_estimate(FakeDB(occurred_max=20), 1, prev_progress=5, estimated_chapter=99)
        self.assertEqual(out, 32)
        self.assertEqual(self.adv_calls, [(1, 32)])

    # ── _apply_estimate 限速(pace on,默认):每回合进度最多 +_PACE_CAP 章 ──
    def test_apply_estimate_pace_cap(self):
        os.environ["RPG_ANCHOR_PACE"] = "1"  # 覆盖 setUp 的 off,测限速层
        self.adv_calls.clear()
        # prev=5, est=99, floor=0:非限速会钳到 ceiling=17;限速叠加 → min(17, prev+_PACE_CAP)=5+2=7
        out = ar._apply_estimate(FakeDB(occurred_max=0), 1, prev_progress=5, estimated_chapter=99)
        self.assertEqual(out, 5 + ar._PACE_CAP, "pace on → 每回合最多 +_PACE_CAP 章")
        self.assertEqual(self.adv_calls, [(1, 5 + ar._PACE_CAP)])

    # ── _normalize_judge_result 兼容新旧返回 ────────────────────
    def test_normalize_judge_result(self):
        # 新式 dict
        self.assertEqual(
            ar._normalize_judge_result({"reached": [{"anchor_key": "a"}], "estimated_chapter": 7}),
            ([{"anchor_key": "a"}], 7),
        )
        # 旧式裸 list → 无估章
        self.assertEqual(ar._normalize_judge_result([{"anchor_key": "a"}]), ([{"anchor_key": "a"}], None))
        # est < 1 / 非法 → None
        self.assertEqual(ar._normalize_judge_result({"reached": [], "estimated_chapter": 0}), ([], None))
        self.assertEqual(ar._normalize_judge_result({"reached": [], "estimated_chapter": "x"}), ([], None))
        # 垃圾 → 空
        self.assertEqual(ar._normalize_judge_result(None), ([], None))
        self.assertEqual(ar._normalize_judge_result("nope"), ([], None))

    # ── 关估章不连累锚点兜底(env=0 + 真锚点命中仍标记)──────────
    def test_estimate_off_anchor_still_marks(self):
        os.environ["RPG_PROGRESS_NARRATIVE_ESTIMATE"] = "0"
        try:
            db = FakeDB(pending_keys={"chapter:12:event:0"}, src_chapter=12, occurred_max=0)
            judge = _judge_dict(
                reached=[{"anchor_key": "chapter:12:event:0", "drift_score": 0.0}],
                estimated=6,
            )
            n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
            self.assertEqual(n, 1, "关估章不影响锚点标记")
            self.assertEqual(self.adv_calls, [(1, 12)], "只有锚点推进(12),无估章推进(6)")
        finally:
            os.environ.pop("RPG_PROGRESS_NARRATIVE_ESTIMATE", None)

    # ── _load_estimate_context 备料:列映射 + [max(floor,prev), +CAP] 边界 ──
    def test_load_estimate_context(self):
        fake = FakeDB(progress_pc="5", script_id_val=143, occurred_max=2,
                      chapter_rows=[{"chapter": 5, "label": "活下去", "summary": "S5"},
                                    {"chapter": 6, "label": "激光", "summary": "S6"}])
        with mock.patch("platform_app.db.connect", return_value=fake), \
             mock.patch("platform_app.db.init_db"):
            ctx = ar._load_estimate_context(99)
        self.assertEqual(ctx["prev"], 5)
        self.assertEqual(ctx["floor"], 2)
        self.assertEqual(ctx["script_id"], 143)
        self.assertEqual([c["chapter"] for c in ctx["window_chapters"]], [5, 6])
        self.assertEqual(ctx["window_chapters"][0]["label"], "活下去")
        # 章节地图边界 = [max(1,floor=2,prev=5), +CAP] = [5, 17]
        cf_call = next(c for c in fake.calls if "from chapter_facts" in " ".join(c[0].split()))
        self.assertEqual(cf_call[1], (143, 5, 5 + ar._LOOKAHEAD_CAP))

    # ── 无 script_id → 备料返 None(本回合关估章)────────────────
    def test_load_estimate_context_no_script(self):
        fake = FakeDB(progress_pc="3", script_id_val=None)
        with mock.patch("platform_app.db.connect", return_value=fake), \
             mock.patch("platform_app.db.init_db"):
            self.assertIsNone(ar._load_estimate_context(99))

    # ══ 叙事节奏兜底(progress_motion):发散play对不上原著章号时仍确定性推进 ══

    # ── _apply_pace_fallback 直测:累计够 1 章才推进,单调,限速,motion 0/None 不动 ──
    def test_pace_fallback_unit(self):
        PTS = ar._PACE_FALLBACK_POINTS_PER_CHAPTER  # 默认 3
        # motion=None / 0 → 立即返 0,不读不写
        self.adv_calls.clear()
        self.assertEqual(ar._apply_pace_fallback(FakeDB(progress_pc="1", pace_accum=0), 1, None), 0)
        self.assertEqual(ar._apply_pace_fallback(FakeDB(progress_pc="1", pace_accum=0), 1, 0), 0)
        self.assertEqual(self.adv_calls, [])
        # accum 不足一章 → 只累计不推进
        self.adv_calls.clear()
        db = FakeDB(progress_pc="1", pace_accum=0)
        out = ar._apply_pace_fallback(db, 1, 1)
        self.assertEqual(out, 0, "1<PTS → 不推进")
        self.assertEqual(db.accum_writes, [1])
        self.assertEqual(self.adv_calls, [])
        # accum 够一章 → 推进 +1、扣点
        self.adv_calls.clear()
        db = FakeDB(progress_pc="1", pace_accum=PTS - 1)  # 再 +1 motion 即满
        out = ar._apply_pace_fallback(db, 1, 1)
        self.assertEqual(out, 2, "prev=1 +1 章 → 2")
        self.assertEqual(self.adv_calls, [(1, 2)])
        self.assertEqual(db.accum_writes, [0], "扣掉一章的点数")
        # 限速:大 accum + motion=2 → 最多 +_PACE_CAP 章
        self.adv_calls.clear()
        db = FakeDB(progress_pc="5", pace_accum=PTS * 5)  # 够 5 章
        out = ar._apply_pace_fallback(db, 5, 2)
        self.assertEqual(out, 5 + ar._PACE_CAP, "限速每回合最多 +_PACE_CAP 章")
        self.assertEqual(self.adv_calls, [(5, 5 + ar._PACE_CAP)])

    # ── 回归(save=205):每回合 worldline 整列重写不得清零节奏累计器 ──
    def test_pace_accumulator_survives_per_turn_worldline_rewrite(self):
        """生产 bug:save=205 连续多回合 motion=1,但 progress_pace_accum 每回合被
        record_context_run 的 worldline 整列重写抹掉 → 永远攒不到 3 点 → 卡同一章。

        这里用 _PRESERVE_SETTINGS_SQL 的白名单键模拟「回合开始:新 state worldline
        覆盖旧值,仅白名单键保留」,连跑 3 个 motion=1 回合,应触发一次 +1 章。
        """
        from platform_app.knowledge._session_repo import _PRESERVE_SETTINGS_SQL
        preserved = set(re.findall(r"'([a-z_]+)'", _PRESERVE_SETTINGS_SQL))
        self.assertIn(
            "progress_pace_accum", preserved,
            "累计器必须在 worldline 整列重写的保留白名单里,否则每回合被清零。",
        )
        worldline = {"progress_chapter": 1, "progress_pace_accum": 0}
        for _ in range(ar._PACE_FALLBACK_POINTS_PER_CHAPTER):
            # 回合开始:record_context_run → ensure_game_session → _db_upsert_game_session
            # 用新 state 的 worldline 整列覆盖,只把白名单键从旧行叠回来。
            worldline = {
                "user_variables": {},
                **{k: v for k, v in worldline.items() if k in preserved},
            }
            # 回合末:史官估章失败(发散/日常),只有 motion=1 的节奏兜底。
            db = FakeDB(
                progress_pc=str(worldline.get("progress_chapter") or 1),
                pace_accum=int(worldline.get("progress_pace_accum") or 0),
            )
            ar._apply_pace_fallback(db, 1, 1)
            worldline["progress_pace_accum"] = db.pace_accum
        self.assertEqual(
            self.adv_calls, [(1, 2)],
            "3 个 motion=1 回合后应推进 1 章;累计器被清零则不会推进。",
        )

    # ── 回看宽限收束:有 pending 候选时按 progress-grace 阈值跑一次 ──
    def test_reconcile_expires_behind_anchors_beyond_grace(self):
        db = FakeDB(pending_keys=set(), occurred_max=0, progress_pc="20", pace_accum=0)
        judge = _judge_dict_motion(reached=[], estimated=None, motion=1)
        self._run(pending=_pending("chapter:18:event:0"), judge=judge, db=db)
        self.assertTrue(db.expired_calls, "有 pending 候选时应跑回看宽限收束")
        _desc, _sid, threshold, _limit = db.expired_calls[-1]
        self.assertEqual(threshold, 20 - ANCHOR_BEHIND_GRACE_CHAPTERS)

    # ── 命中锚点的当回合不再叠加节奏兜底(防双推进)──
    def test_reconcile_pace_fallback_skipped_when_anchor_marked(self):
        PTS = ar._PACE_FALLBACK_POINTS_PER_CHAPTER
        db = FakeDB(pending_keys={"chapter:12:event:0"}, src_chapter=12,
                    occurred_max=0, progress_pc="1", pace_accum=PTS - 1)
        judge = _judge_dict_motion(
            reached=[{"anchor_key": "chapter:12:event:0", "drift_score": 0.0}],
            estimated=None, motion=1)
        n = self._run(pending=_pending("chapter:12:event:0"), judge=judge, db=db)
        self.assertEqual(n, 1, "本回合命中 1 个锚点")
        self.assertEqual(self.adv_calls, [(1, 12)], "只走锚点推进,不叠加 pace")
        self.assertEqual(db.accum_writes, [], "命中锚点当回合不应写节奏累计器")

    # ── 存档级开关:off 时只停节奏兜底,不碰锚点/估章 ──
    def test_pace_fallback_skipped_when_save_setting_off(self):
        PTS = ar._PACE_FALLBACK_POINTS_PER_CHAPTER
        db = FakeDB(pending_keys=set(), occurred_max=0, progress_pc="1",
                    pace_accum=PTS - 1, pace_setting="off")
        judge = _judge_dict_motion(reached=[], estimated=None, motion=1)
        self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(self.adv_calls, [], "存档开关 off → 不跑节奏兜底")
        self.assertEqual(db.accum_writes, [], "off 时累计器不应被写")

    def test_auto_pace_advance_enabled_reads_values(self):
        from gm_serving.settings import auto_pace_advance_enabled
        cases = [(None, True), ("on", True), ("off", False),
                 ("0", False), ("false", False), ("", True)]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                self.assertEqual(
                    auto_pace_advance_enabled(FakeDB(pace_setting=raw), 1), expected)

    # ── 集成:估章给 None(对不上原著)但 motion≥1 → 靠兜底推进 ──
    def test_reconcile_pace_fallback_advances_when_estimate_null(self):
        # 估章 None(发散对不上),motion=1,accum 预置到差 1 点即满 → 本回合推进
        db = FakeDB(pending_keys=set(), occurred_max=0, progress_pc="1",
                    pace_accum=ar._PACE_FALLBACK_POINTS_PER_CHAPTER - 1)
        judge = _judge_dict_motion(reached=[], estimated=None, motion=1)
        n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0, "无锚点命中 → 标记 0")
        self.assertEqual(self.adv_calls, [(1, 2)], "估章 None 但 motion 兜底把进度推到 2")

    # ── 集成:估章已推进(贴原著play)→ 不再叠加兜底(防双推进)──
    def test_reconcile_pace_fallback_skipped_when_estimate_advances(self):
        db = FakeDB(pending_keys=set(), occurred_max=0, progress_pc="1",
                    pace_accum=ar._PACE_FALLBACK_POINTS_PER_CHAPTER - 1)
        judge = _judge_dict_motion(reached=[], estimated=6, motion=2)
        n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        # 估章推进到 6;兜底被跳过(accum 不应被写)
        self.assertEqual(self.adv_calls, [(1, 6)], "只有估章推进,无兜底叠加")
        self.assertEqual(db.accum_writes, [], "估章推进时兜底不触发,accum 不变")

    # ── 集成:motion=0(原地踏步)→ 不推进 ──
    def test_reconcile_pace_fallback_no_motion_no_advance(self):
        db = FakeDB(pending_keys=set(), occurred_max=0, progress_pc="1", pace_accum=2)
        judge = _judge_dict_motion(reached=[], estimated=None, motion=0)
        n = self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
        self.assertEqual(n, 0)
        self.assertEqual(self.adv_calls, [], "原地踏步 → 进度不动")

    # ── kill switch:RPG_PACE_FALLBACK=0 → 完全不兜底 ──
    def test_pace_fallback_env_off(self):
        os.environ["RPG_PACE_FALLBACK"] = "0"
        try:
            db = FakeDB(pending_keys=set(), occurred_max=0, progress_pc="1",
                        pace_accum=ar._PACE_FALLBACK_POINTS_PER_CHAPTER - 1)
            judge = _judge_dict_motion(reached=[], estimated=None, motion=2)
            self._run(pending=_pending("chapter:9:event:0"), judge=judge, db=db)
            self.assertEqual(self.adv_calls, [], "kill switch 关 → 不兜底推进")
        finally:
            os.environ.pop("RPG_PACE_FALLBACK", None)

    # ── _motion_from_raw 解析 ──
    def test_motion_from_raw(self):
        self.assertIsNone(ar._motion_from_raw({"x": 1}))          # 无字段
        self.assertIsNone(ar._motion_from_raw({"progress_motion": None}))
        self.assertIsNone(ar._motion_from_raw({"progress_motion": "x"}))
        self.assertIsNone(ar._motion_from_raw([1, 2]))            # 非 dict
        self.assertEqual(ar._motion_from_raw({"progress_motion": 0}), 0)
        self.assertEqual(ar._motion_from_raw({"progress_motion": 1}), 1)
        self.assertEqual(ar._motion_from_raw({"progress_motion": 5}), 2)  # 钳到 2


if __name__ == "__main__":
    unittest.main()
