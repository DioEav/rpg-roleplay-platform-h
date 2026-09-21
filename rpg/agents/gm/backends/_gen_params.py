"""_gen_params.py — 把用户「生成参数预设」偏好接进各 provider 的 LLM 调用。

背景(反馈#93):设置页早有生成参数 UI(temperature/top_p/top_k/惩罚项 + 保守/均衡/创意/精确
四档预设),值落 user_preferences.preferences,但**过去从没被后端读取** → 预设是摆设。
这里补上单一来源的 resolver,各 backend(anthropic/vertex/openai_compat)在**叙事**调用时读它。

键名(2026-09 修复):前端写的是 **`settings.<key>`** 点号扁平键,本模块原只查裸 `<key>` →
**整套采样参数静默失效**:不报错、界面照常回显"已保存",只有实际请求里没有这些参数。
现在经 core.user_prefs.scoped_pref 做 `settings.<key>` → 裸 `<key>` 回退,与前端
lib/prefs.js::readScopedPref 及其它后端读取点(app.py 的 settings.max_tokens、
core/config.py 的 settings.request_timeout)同语义。

关键安全语义:**只返回用户显式设过的键**(pref 里存在该键才返回)。用户从没动过参数 → 返回 {}
→ 后端沿用各自既有默认(temperature 0.9 等),**零行为变化**。这样接线不会惊动未配置的存量用户,
只有主动调过预设/参数的用户才让它生效。

映射到各 provider(调用方按能力取子集):
- openai_compat:temperature/top_p/frequency_penalty/presence_penalty/seed/stop(标准顶层字段)
  + top_k/repetition_penalty 走 extra_body(部分中转/本地支持);provider 拒绝时 backend 有自愈
  (剥采样参数退默认,见 openai_compat._create)。seed/stop 也必须在那份"可剥"名单里 ——
  o3/o4-mini 官方就不支持 stop,不剥会整轮失败。
- anthropic:temperature/top_p/top_k/stop_sequences(不支持 frequency/presence penalty,
  也没有 seed 字段;thinking 开启时整组跳过)。
- vertex/gemini:temperature/top_p/top_k/seed/stop_sequences。
"""
from __future__ import annotations

import logging
import math
from typing import Any

from core.user_prefs import scoped_pref

log = logging.getLogger(__name__)

# 数值键 → (下限, 上限, 是否取整)
_RANGES: dict[str, tuple[float, float, bool]] = {
    "temperature": (0.0, 2.0, False),
    "top_p": (0.0, 1.0, False),
    "top_k": (0.0, 500.0, True),
    "frequency_penalty": (-2.0, 2.0, False),
    "presence_penalty": (-2.0, 2.0, False),
    "repetition_penalty": (0.0, 2.0, False),
}

# stop 最多 4 条(OpenAI SDK 文档:"Up to 4 sequences where the API will stop generating")
_STOP_MAX_SEQUENCES = 4
# seed 上限:OpenAI 侧是 int32 量级;超出没有意义,夹一下免得把非法值发出去
_SEED_MAX = 2**31 - 1


def _resolve_stop(raw: Any) -> list[str]:
    """界面把多条停用词写成 `|` 分隔的单字符串(见设置页预览的 stop.split("|"))。

    这里同样切分、去空白、丢空项、截到 4 条;也容忍已经是数组的存量值。
    非字符串/数组的脏值(数字、对象…)一律忽略 —— 否则 str() 会把一个数字变成
    一条荒谬的停用词,而停用词命中的后果是「每轮回复在任意位置被截断」。
    """
    if isinstance(raw, (list, tuple)):
        items = [x.strip() for x in raw if isinstance(x, str)]
    elif isinstance(raw, str):
        items = [s.strip() for s in raw.split("|")]
    else:
        return []
    return [s for s in items if s][:_STOP_MAX_SEQUENCES]


def resolve_gen_params(user_id: int | None) -> dict[str, Any]:
    """返回**用户显式设过**的生成参数(已校验/夹取);未配置或读失败 → {}。"""
    if not user_id:
        return {}
    from core.user_prefs import read_user_prefs

    prefs = read_user_prefs(user_id)
    if not prefs:
        return {}

    out: dict[str, Any] = {}
    for key, (lo, hi, as_int) in _RANGES.items():
        raw = scoped_pref(prefs, key, None)
        if raw is None or isinstance(raw, bool):
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            continue
        # NaN/±inf 必须在夹取**之前**挡掉:Python 的 min/max 在比较为假时保留原值,
        # min(2.0, nan) 会返回 2.0 —— 一个坏值会被静默夹成"最随机"那一端,正好是反方向。
        if not math.isfinite(v):
            continue
        v = max(lo, min(hi, v))
        out[key] = int(v) if as_int else v

    # seed:整数。-1 是界面上「每次随机」的哨兵值,负数一律当作"未设置" —— 直接把 -1 发给
    # provider 会被当非法参数拒(400),而"随机"本来就是不传该字段。
    seed_raw = scoped_pref(prefs, "seed", None)
    if seed_raw is not None and not isinstance(seed_raw, bool):
        try:
            seed = int(float(seed_raw))
        except (TypeError, ValueError, OverflowError):
            # OverflowError 来自 inf / 1e400(POST /api/me/preference 收任意 JSON,没有值白名单)。
            # 漏掉它会让本函数整个抛出 → 三个 backend 的 except Exception 把它吞掉 →
            # **全部**采样参数一起失效(正是本模块在修的那类静默失败)。
            seed = -1
        if seed >= 0:
            out["seed"] = min(seed, _SEED_MAX)

    # stop:停用词序列
    stop_raw = scoped_pref(prefs, "stop", None)
    if stop_raw is not None and not isinstance(stop_raw, bool):
        seqs = _resolve_stop(stop_raw)
        if seqs:
            out["stop"] = seqs

    return out
