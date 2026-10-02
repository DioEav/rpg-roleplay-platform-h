"""Phase G W4 — extract.budget 预算估算器(确定性,无 DB 用 fake db)。"""
from extract.budget import MODEL_PRICING, cheapest_models, estimate


class _FakeDB:
    def __init__(self, n): self.n = n
    def execute(self, sql, params=None):
        self._n = self.n
        return self
    def fetchone(self):
        return {"c": self._n}


def test_estimate_scales_with_chapters_and_model():
    db = _FakeDB(866)
    flash = estimate(db, 1, model="gemini-3.5-flash")
    assert flash["ok"] and flash["chapters"] == 866
    assert 0.3 < flash["est_usd"] < 2.0  # 全书 flash 合理区间
    haiku = estimate(db, 1, model="claude-haiku-4-5")
    assert haiku["est_usd"] > flash["est_usd"]  # haiku 更贵
    assert haiku["model_tier"] == "haiku"
    batch = estimate(db, 1, model="gemini-3.5-flash", batch_discount=True)
    assert abs(batch["est_usd"] - flash["est_usd"] * 0.5) < 0.01  # 五折


def test_sample_chapters_caps():
    db = _FakeDB(866)
    s80 = estimate(db, 1, model="gemini-3.5-flash", sample_chapters=80)
    assert s80["chapters"] == 80 and s80["total_extractable"] == 866
    assert s80["est_usd"] < estimate(db, 1, model="gemini-3.5-flash")["est_usd"]


def test_zero_chapters():
    assert estimate(_FakeDB(0), 1)["ok"] is False


def test_cheapest_excludes_frontier():
    cm = cheapest_models()
    assert all(MODEL_PRICING[m]["tier"] != "frontier" for m in cm)


if __name__ == "__main__":
    test_estimate_scales_with_chapters_and_model(); test_sample_chapters_caps()
    test_zero_chapters(); test_cheapest_excludes_frontier(); print("OK")


# ── 输入侧动态化 + 输出侧自校准(2026-10)────────────────────────────────────
class _FakeDB2:
    """支持字数统计与 token_usage 校准查询的 fake。

    n=可提取章数;avg_chars=平均章长(字);measured_out=历史弧输出记账均值
    (None=无记录);samples=记账条数(不足 MIN_SAMPLES 时估算应退回先验)。
    """

    def __init__(self, n, avg_chars=0, measured_out=None, samples=60):
        self.n = n
        self.avg_chars = avg_chars
        self.measured_out = measured_out
        self.samples = samples

    def execute(self, sql, params=None):
        if "token_usage" in sql:
            if self.measured_out is None:
                return _Row({"avg_out": None, "n": 0})
            return _Row({"avg_out": self.measured_out, "n": self.samples})
        return _Row({"c": self.n, "chars": self.n * self.avg_chars})

    def fetchone(self):
        return self._row


class _Row(dict):
    def __init__(self, d):
        super().__init__(d)

    def fetchone(self):
        return self


def test_input_scales_with_chapter_length():
    """短章书:弧输入 = 3×章长+词表;长章书:被执行侧 2500 截断帽封顶。"""
    short = estimate(_FakeDB2(866, avg_chars=1000), 1, model="gemini-3.5-flash", algorithm="arc")
    assert short["arc_input_per_call"] == 3 * 1000 + 500  # 3500,不再用静态 8000 高估
    long_b = estimate(_FakeDB2(866, avg_chars=6000), 1, model="gemini-3.5-flash", algorithm="arc")
    assert long_b["arc_input_per_call"] == 3 * 2500 + 500  # 8000,截断帽封顶
    assert short["est_input_tokens"] < long_b["est_input_tokens"]
    # 种子输入同步动态:短章书 min(1000,4000)=1000+300
    assert short["est_input_tokens"] == short["arcs"] * 3500 + 12 * 1300


def test_output_calibration_uses_measured_history():
    """同用户同剧本有足够记账 → 用实测均值替代先验 9000。"""
    e0 = estimate(_FakeDB2(1487, avg_chars=3263), 1, model="deepseek-v4-flash", algorithm="arc")
    assert e0["arc_output_per_call"] == 9000 and e0["output_calibrated"] is False
    db = _FakeDB2(1487, avg_chars=3263, measured_out=4000)
    e = estimate(db, 1, model="deepseek-v4-flash", algorithm="arc", user_id=7)
    assert e["arc_output_per_call"] == 4000 and e["output_calibrated"] is True
    assert e["est_output_tokens"] < e0["est_output_tokens"]
    assert "校准" in e["note"]


def test_output_calibration_insufficient_samples_falls_back():
    """记账样本不足(刚换模型/没跑过)→ 退回先验 9000,不用小样本噪声。"""
    db = _FakeDB2(1487, avg_chars=3263, measured_out=4000, samples=3)
    e = estimate(db, 1, model="deepseek-v4-flash", algorithm="arc", user_id=7)
    assert e["arc_output_per_call"] == 9000 and e["output_calibrated"] is False


def test_no_user_id_skips_calibration_query():
    """不传 user_id:行为与旧版一致(先验 9000),且不应发起 token_usage 查询。"""
    db = _FakeDB2(1487, avg_chars=3263, measured_out=4000)
    e = estimate(db, 1, model="deepseek-v4-flash", algorithm="arc")
    assert e["arc_output_per_call"] == 9000 and e["output_calibrated"] is False


def test_degenerate_zero_wordcount_falls_back_to_standard():
    """word_count 全 0 的异常数据 → 平均章长退回 2500 标准假设,输入不塌缩到词表预算。"""
    e = estimate(_FakeDB2(866, avg_chars=0), 1, model="gemini-3.5-flash", algorithm="arc")
    assert e["arc_input_per_call"] == 3 * 2500 + 500
