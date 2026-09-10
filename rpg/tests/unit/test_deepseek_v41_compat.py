"""DeepSeek V4.1 适配守卫(2026-09-10,依据官方 api-docs「Models & Pricing」+「Thinking Mode」)。

官方现状:
- 现役 ID 只有 `deepseek-flash`(= DeepSeek-V4.1-Flash)和 `deepseek-v4-pro`;
  `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 是**已退役的旧别名**,请求实际
  由 V4.1-Flash 服务、按 Flash 价($0.15/$0.6 off-peak)计费。
- 两个型号**思考模式默认开、默认 effort=high**;OpenAI 格式下用 `reasoning_effort` 调档、
  `extra_body.thinking.type` 开关。
- **带 tools 的请求必须把 reasoning_content 原样回传**,否则 API 返 400。

这三条各自对应下面三组断言。
"""
import model_probe
from agents.gm.backends.openai_compat import (
    _EFFORT_TO_DEEPSEEK,
    _merge_tuning,
    _OpenAICompatBackend,
)

_FLASH_IN, _FLASH_OUT = 0.15, 0.60


# ── 一、定价:现役 ID 在表内,三个旧别名按 Flash 价 ────────────────────────────
def test_deepseek_flash_priced_at_official_offpeak():
    p = model_probe.get_pricing("deepseek", "deepseek-flash")
    assert p is not None, "deepseek-flash(V4.1 现役 ID)必须在静态价表里"
    assert (p["input"], p["output"]) == (_FLASH_IN, _FLASH_OUT)
    assert p["context"] == 1_000_000


def test_retired_aliases_billed_at_flash_price():
    """旧别名请求由 V4.1-Flash 承接并按 Flash 价计费 —— 表里记老 V4-Flash 价就是失真。"""
    for alias in ("deepseek-v4-flash", "deepseek-v4-flash-vision-exp"):
        p = model_probe.get_pricing("deepseek", alias)
        assert p is not None, f"{alias} 缺价"
        assert (p["input"], p["output"]) == (_FLASH_IN, _FLASH_OUT), \
            f"{alias} 实际按 Flash 价计费,不是老 V4-Flash 价"


# ── 二、能力:V4.1-Flash 有 vision + 默认思考;带日期后缀的变体靠前缀回退 ──────
def test_flash_family_has_vision_and_reasoning():
    for name in ("deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"):
        caps = model_probe.get_capabilities("deepseek", name)
        assert "image_input" in caps, f"{name} 实为 V4.1-Flash,官方能力矩阵有 vision"
        assert "reasoning" in caps, f"{name} 思考模式默认开"
        assert {"tools", "json_mode"} <= set(caps)


def test_dated_preview_variant_falls_back_by_prefix():
    """生产实测存在 `deepseek-v4.1-flash-expires-on-0910` 这类带日期后缀的预览别名。
    前缀回退必须兜住,否则这批用户「有型号、没价格、没能力标签」。"""
    caps = model_probe.get_capabilities("deepseek", "deepseek-v4.1-flash-expires-on-0910")
    assert "reasoning" in caps and "tools" in caps
    p = model_probe.get_pricing("deepseek", "deepseek-v4.1-flash")
    assert p and (p["input"], p["output"]) == (_FLASH_IN, _FLASH_OUT)


def test_seed_catalog_offers_current_flash_id():
    """未 sync 的实例读 config/model_catalog.json 兜底 —— 现役 ID 不在里面就等于选不到。"""
    import json
    from pathlib import Path
    cat = json.loads((Path(model_probe.__file__).parent / "config" / "model_catalog.json").read_text("utf-8"))
    apis = cat.get("apis") or cat.get("providers") or []
    ds = next(a for a in apis if a.get("id") == "deepseek")
    assert "deepseek-flash" in {m["real_name"] for m in ds["models"]}


# ── 三、运行时:思考开关接线 + extra_body 深合并 + tools 回传 reasoning_content ──
def _stub_backend(api_id: str, effort: str) -> _OpenAICompatBackend:
    """绕开 __init__(要真 key / 真 client),只装 _reasoning_param 用到的字段。"""
    b = object.__new__(_OpenAICompatBackend)
    b.api_id = api_id
    b.model_name = "deepseek-flash"
    b.user_id = 1
    import agents.gm.backends._effort as _e
    _e.resolve_effort = lambda *a, **k: effort          # noqa: ARG005
    _e.resolve_openai_reasoning = lambda *a, **k: effort  # noqa: ARG005
    return b


def test_deepseek_effort_off_actually_disables_thinking():
    """此前非 openai 一律返 {} → 用户在 UI 里关思考,后端整段丢弃(UI 存在≠生效)。"""
    assert _stub_backend("deepseek", "off")._reasoning_param() == {
        "extra_body": {"thinking": {"type": "disabled"}}
    }


def test_deepseek_effort_levels_map_to_official_names():
    for ours, theirs in _EFFORT_TO_DEEPSEEK.items():
        assert _stub_backend("deepseek", ours)._reasoning_param() == {"reasoning_effort": theirs}
    # 官方 api-docs 的 effort 名单;"extra" 是本仓枚举,必须映射到官方认得的名字
    assert set(_EFFORT_TO_DEEPSEEK.values()) <= {"minimal", "low", "medium", "high", "xhigh", "max"}


def test_unknown_provider_still_sends_nothing():
    """Qwen/Hunyuan/中转/本地没有权威开关字段,乱传只会 400。"""
    assert _stub_backend("dashscope", "high")._reasoning_param() == {}


def test_merge_tuning_deep_merges_extra_body():
    """采样参数的 top_k 和 thinking 开关都住 extra_body;浅合并会互相覆盖,
    两份各自 ** 展开进 create() 则直接 TypeError(multiple values for 'extra_body')。"""
    merged = _merge_tuning(
        {"temperature": 0.9, "extra_body": {"top_k": 40}},
        {"extra_body": {"thinking": {"type": "disabled"}}},
    )
    assert merged["temperature"] == 0.9
    assert merged["extra_body"] == {"top_k": 40, "thinking": {"type": "disabled"}}


def test_tools_loop_echoes_reasoning_content():
    """官方硬要求:带 tools 的后续请求必须回传 reasoning_content,否则 400。
    这里跑一整轮 fake 流:第 1 跳吐 reasoning + tool_call,断言装回的 assistant 消息带上它。"""
    b = _stub_backend("deepseek", "high")
    b.last_usage = {}
    sent: list[list[dict]] = []

    def _fake_create(**kw):
        sent.append([dict(m) for m in kw["messages"]])
        if len(sent) == 1:
            return _fake_stream(reasoning="先查一下天气", tool_call=True)
        return _fake_stream(text="好的。")

    b._create = _fake_create
    b._sampling_kwargs = lambda _t: {}
    b._capture_usage = lambda *a, **k: None

    events = list(b.stream_with_mcp_loop(
        system="s", messages=[{"role": "user", "content": "hi"}],
        mcp_tools=[{"server_id": "srv", "name": "get_weather", "schema": {"type": "object", "properties": {}}}],
        max_iterations=3, max_tokens=256,
        mcp_call=lambda *a, **k: {"ok": True, "result": "晴"},
    ))

    assert any(e["type"] == "reasoning" for e in events)
    assert len(sent) == 2, "工具结果必须触发第二跳"
    assistant = [m for m in sent[1] if m.get("role") == "assistant"][-1]
    assert assistant.get("reasoning_content") == "先查一下天气", \
        "第二跳的 assistant 消息缺 reasoning_content → DeepSeek 思考模式下必 400"


class _D:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def _fake_stream(*, reasoning: str = "", text: str = "", tool_call: bool = False):
    """最小 OpenAI 流式 chunk 序列(只带被读到的字段)。"""
    chunks = []
    if reasoning:
        chunks.append(_D(usage=None, choices=[_D(delta=_D(reasoning_content=reasoning, content=None,
                                                         tool_calls=None), finish_reason=None)]))
    if text:
        chunks.append(_D(usage=None, choices=[_D(delta=_D(reasoning_content=None, content=text,
                                                         tool_calls=None), finish_reason="stop")]))
    if tool_call:
        tc = _D(index=0, id="call_1", function=_D(name="srv__get_weather", arguments='{}'))
        chunks.append(_D(usage=None, choices=[_D(delta=_D(reasoning_content=None, content=None,
                                                         tool_calls=[tc]), finish_reason="tool_calls")]))
    return iter(chunks)
