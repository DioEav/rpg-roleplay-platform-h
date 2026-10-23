"""设置页价格/上下文/来源字段的回归。

背景:详情表三列读 input_cost_per_million / context_window / source。
- 前端曾把它们从 mapModel 白名单里丢掉 → 恒显示「—」;
- /api/models/remote/sync 返回的模型只有 id/real_name/capabilities,
  前端同步后整体替换列表 → 即使前端透传,三列也会再次变空。

本文件锁死:
- 已知 provider 继续用自家静态价表;
- 自建中转站(api_id 不在价表里)按模型名推断,并标 static-inferred;
- 已知 provider 缺失的模型不跨表借用;
- sync 响应补齐三列,并标来源 LiveApi。
"""
from __future__ import annotations

from model_probe import get_pricing_for_display
from routes.models import _enrich_synced_models


def test_known_provider_uses_own_static_pricing():
    p = get_pricing_for_display("deepseek", "deepseek-flash")
    assert p is not None
    assert (p["input"], p["output"]) == (0.15, 0.60)
    assert p["context"] == 1_000_000
    assert p["source"] == "static"


def test_custom_relay_infers_pricing_by_model_name():
    """自建中转站没有自己的价格表,但模型名能命中官方表。"""
    p = get_pricing_for_display("funhpc", "deepseek-flash")
    assert p is not None
    assert (p["input"], p["output"]) == (0.15, 0.60)
    assert p["context"] == 1_000_000
    assert p["source"] == "static-inferred"


def test_custom_relay_strips_vendor_prefix_before_inference():
    """openai/gpt-5.6 这类聚合站写法应命中原厂价,而不是 OpenRouter 加价表。"""
    p = get_pricing_for_display("funhpc", "openai/gpt-5.6")
    assert p is not None
    assert (p["input"], p["output"]) == (4.0, 20.0)
    assert p["source"] == "static-inferred"


def test_known_provider_missing_model_does_not_borrow_other_prices():
    """OpenAI 表里没有 claude-opus-5,不能拿 Anthropic 的价格冒充。"""
    assert get_pricing_for_display("openai", "claude-opus-5") is None


def test_sync_response_enriched_and_marked_live_api():
    out = _enrich_synced_models("deepseek", [
        {"id": "deepseek-flash", "real_name": "deepseek-flash"},
    ])
    assert out[0]["input_cost_per_million"] == 0.15
    assert out[0]["output_cost_per_million"] == 0.60
    assert out[0]["context_window"] == 1_000_000
    assert out[0]["source"] == "LiveApi"


def test_sync_response_custom_relay_uses_inferred_pricing():
    out = _enrich_synced_models("funhpc", [
        {"id": "gpt-5.6", "real_name": "gpt-5.6"},
    ])
    assert out[0]["input_cost_per_million"] == 4.0
    assert out[0]["output_cost_per_million"] == 20.0
    assert out[0]["context_window"] == 1_050_000
    assert out[0]["source"] == "LiveApi"
