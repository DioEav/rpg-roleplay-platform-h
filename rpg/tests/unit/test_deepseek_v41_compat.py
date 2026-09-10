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
    dated = "deepseek-v4.1-flash-expires-on-0910"
    caps = model_probe.get_capabilities("deepseek", dated)
    assert "reasoning" in caps and "tools" in caps
    # 价格也必须兜住 —— 此前 get_pricing 是精确匹配、没有前缀回退,同一族信息
    # 「能力有、价格 None」,是修 A 漏 B。
    p = model_probe.get_pricing("deepseek", dated)
    assert p is not None, "带日期后缀的变体必须走前缀回退拿到价格"
    assert (p["input"], p["output"]) == (_FLASH_IN, _FLASH_OUT)
    assert p["source"] == "static-prefix", "前缀命中要能与精确命中区分"


def test_exact_pricing_hit_still_marked_static():
    """回退不能污染精确命中的 source(admin/诊断按它判定价格来源)。"""
    assert model_probe.get_pricing("deepseek", "deepseek-flash")["source"] == "static"


def test_pricing_prefix_fallback_is_generic_not_deepseek_only():
    """同一个洞在 Gemini 的带日期变体上一模一样,回退必须是通用的。"""
    p = model_probe.get_pricing("vertex_ai", "gemini-3.8-flash-preview-09-01")
    assert p is not None and p["source"] == "static-prefix"
    assert p["input"] == model_probe.get_pricing("vertex_ai", "gemini-3.8-flash")["input"]


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


# ── 四、退参自愈:新发的 reasoning_effort 不能把中转站用户打崩 ────────────────
#
# 生产实况:67 个 deepseek 凭据里有 1 个把 base_url 指向中转站(literouter),另有 6 个
# 用户显式配过 deepseek 的 effort 档(其中 "extra"→官方 xhigh)。中转站未必认这些字段,
# 而它们纯属调优 —— 被 400 拒就该退参重试,绝不能让一轮对话因此崩掉。
class _Boom(Exception):
    pass


def _backend_with_fake_client(responses):
    """responses: 依次返回的对象;元素是 Exception 就抛出。返回 (backend, 记录的 kwargs 列表)。"""
    b = object.__new__(_OpenAICompatBackend)
    b.api_id, b.model_name, b.user_id = "deepseek", "deepseek-flash", 1
    b._fixed_temp_combos = set()
    calls = []

    def _create(**kw):
        calls.append(dict(kw))
        r = responses[len(calls) - 1]
        if isinstance(r, Exception):
            raise r
        return r

    b.client = type("C", (), {"chat": type("Ch", (), {"completions": type("Co", (), {"create": staticmethod(_create)})()})()})()
    return b, calls


def _bad_request(msg="unsupported parameter"):
    from openai import BadRequestError
    import httpx
    req = httpx.Request("POST", "https://api.deepseek.com/v1/chat/completions")
    return BadRequestError(msg, response=httpx.Response(400, request=req), body=None)


def test_tuning_rejected_retries_without_it():
    b, calls = _backend_with_fake_client([_bad_request(), "ok"])
    out = b._create(model="m", messages=[], temperature=0.9, reasoning_effort="xhigh",
                    extra_body={"top_k": 40})
    assert out == "ok"
    assert len(calls) == 2
    assert not ({"temperature", "reasoning_effort", "extra_body"} & set(calls[1])), \
        "重试必须把全部可选调参剥干净"
    assert b._fixed_temp_combos, "退参救回来了才记忆,下次直接不发"


def test_400_not_caused_by_tuning_does_not_poison_the_memo():
    """退参也没救回来 = 400 另有原因。此时若仍记忆,会白白吃掉该用户之后所有生成参数预设。"""
    b, calls = _backend_with_fake_client([_bad_request(), _bad_request("messages: invalid role")])
    try:
        b._create(model="m", messages=[], temperature=0.9)
    except Exception:
        pass
    else:
        raise AssertionError("第二次仍 400 应上抛")
    assert not b._fixed_temp_combos, "不能把与调参无关的 400 记成「该 combo 拒调参」"


def test_non_400_bubbles_up_untouched():
    """429/5xx/超时是瞬时或鉴权问题,不能当调参被拒来吞。"""
    b, calls = _backend_with_fake_client([_Boom("timeout")])
    try:
        b._create(model="m", messages=[], temperature=0.9)
    except _Boom:
        pass
    else:
        raise AssertionError("非 400 必须原样上抛")
    assert len(calls) == 1, "非 400 不该重试"
