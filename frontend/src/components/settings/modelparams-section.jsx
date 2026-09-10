// 模型参数区(ModelParamsSection + ParamSlider + 参数默认/预设常量)。纯机械搬出,零行为变化。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoSave } from '../../platform-app.jsx';
import { readScopedPref, readNumberPref } from '../../lib/prefs.js';
import { SetGroup, SetRow, SetSelect } from './shared.jsx';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSInput from '@cloudscape-design/components/input';
import CSButton from '@cloudscape-design/components/button';
import CSToggle from '@cloudscape-design/components/toggle';

const MODEL_PARAM_DEFAULTS = {
  temperature: 0.78,
  top_p: 0.92,
  top_k: 40,
  repetition_penalty: 1.15,
  frequency_penalty: 0.20,
  presence_penalty: 0.10,
  max_tokens: 4096,
  context_size: 16384,
  seed: -1,
  mirostat_mode: "off",
  mirostat_tau: 5.0,
  mirostat_eta: 0.10,
  stop: "",
};

const MODEL_PARAM_PRESET_VALUES = {
  conservative: { temperature: 0.4, top_p: 0.85, repetition_penalty: 1.05, frequency_penalty: 0.1, presence_penalty: 0.0 },
  balanced: { temperature: 0.78, top_p: 0.92, repetition_penalty: 1.15, frequency_penalty: 0.2, presence_penalty: 0.1 },
  creative: { temperature: 1.0, top_p: 0.98, repetition_penalty: 1.2, frequency_penalty: 0.3, presence_penalty: 0.2 },
  deterministic: { temperature: 0.1, top_p: 0.5, repetition_penalty: 1.0, frequency_penalty: 0.0, presence_penalty: 0.0 },
};

// readScopedPref / readNumberPref 上提到 lib/prefs.js(语义统一 #24);见顶部 import。

function ModelParamsSection() {
  const { t } = useTranslation();
  const PRESETS = [
    { key: "balanced",     label: t('settings.modelparams.preset_balanced') },
    { key: "conservative", label: t('settings.modelparams.preset_conservative') },
    { key: "creative",     label: t('settings.modelparams.preset_creative') },
    { key: "deterministic",label: t('settings.modelparams.preset_deterministic') },
    { key: "custom",       label: t('settings.modelparams.preset_custom') },
  ];
  const [preset, setPreset] = useStatePL("balanced");
  const save = useAutoSave(t('settings.modelparams.title'), "settings");
  const [nsfw, setNsfw] = useStatePL({
    mode: "soft",
    intensity: 0.5,
    extra_prompt: "",
  });
  const [reasoningEffort, setReasoningEffort] = useStatePL("medium");
  // 请求超时(秒):settings.request_timeout。空=自动(本地/桌面 1800s 给慢的本地大模型,服务器 300s)。
  const [reqTimeout, setReqTimeout] = useStatePL("");
  // 从 catalog 获取当前选中模型的 capabilities,用于条件展示 reasoning_effort
  const [selectedModelCaps, setSelectedModelCaps] = useStatePL([]);
  // task 141: Extended Thinking toggle — 读 model_effort 偏好,按当前模型展示开关
  const [selectedModelKey, setSelectedModelKey] = useStatePL("");
  const [thinkingEnabled, setThinkingEnabled] = useStatePL(false);
  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const models = await window.api.models.list().catch(() => ({}));
        if (cancelled) return;
        const sel = models?.models?.selected ?? models?.selected ?? null;
        // 构建 model_effort 字典键: "{api_id}:{real_name}"
        const apiId = sel?.api_id || "";
        const modelId = sel?.real_name || sel?.model_id || sel?.id || "";
        const effKey = apiId && modelId ? `${apiId}:${modelId}` : "";
        if (sel) {
          // sel.capabilities 可能是 array 或 object
          const caps = Array.isArray(sel.capabilities)
            ? sel.capabilities
            : (sel.capabilities ? Object.keys(sel.capabilities) : []);
          setSelectedModelCaps(caps);
        }
        if (effKey) setSelectedModelKey(effKey);
        // 读取当前模型 thinking 偏好
        const profile = await window.api.account.profile().catch(() => null);
        if (cancelled) return;
        const prefs = (profile && profile.preferences) || {};
        const modelEffort = prefs.model_effort || {};
        const cur = (modelEffort[effKey] || "").toString().toLowerCase();
        // 与后端 _effort.resolve_effort 对齐:未配置 = DEFAULT_EFFORT("high")= 开;
        // 只有显式 "off" 才是关(空串当关会让新用户看到「已关闭」而后端实际在 thinking)。
        setThinkingEnabled(cur === "" ? true : (cur !== "off" && cur !== "0"));
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);
  const showReasoningEffort = selectedModelCaps.includes("reasoning");
  const [params, setParams] = useStatePL(MODEL_PARAM_DEFAULTS);
  const [advanced, setAdvanced] = useStatePL(false);
  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const prefs = (r && r.preferences) || {};
        const nextParams = { ...MODEL_PARAM_DEFAULTS };
        for (const key of Object.keys(MODEL_PARAM_DEFAULTS)) {
          if (typeof MODEL_PARAM_DEFAULTS[key] === "number") {
            nextParams[key] = readNumberPref(prefs, key, MODEL_PARAM_DEFAULTS[key]);
          } else {
            nextParams[key] = String(readScopedPref(prefs, key, MODEL_PARAM_DEFAULTS[key]) ?? "");
          }
        }
        const nextPreset = String(readScopedPref(prefs, "preset", "balanced") || "balanced");
        if (PRESETS.some((p) => p.key === nextPreset)) setPreset(nextPreset);
        setParams(nextParams);
        setAdvanced(nextParams.mirostat_mode !== "off");

        const legacyNsfw = readScopedPref(prefs, "nsfw", null) || {};
        const nsfwMode = String(readScopedPref(prefs, "nsfw_mode", legacyNsfw.mode || "soft") || "soft");
        const nsfwIntensity = Number(readScopedPref(prefs, "nsfw_intensity", legacyNsfw.intensity ?? 0.5));
        setNsfw({
          mode: ["block", "soft", "open", "explicit"].includes(nsfwMode) ? nsfwMode : "soft",
          intensity: Number.isFinite(nsfwIntensity) ? nsfwIntensity : 0.5,
          extra_prompt: String(readScopedPref(prefs, "nsfw_extra_prompt", legacyNsfw.extra_prompt || legacyNsfw.extra || "") || ""),
        });

        const effort = String(readScopedPref(prefs, "reasoning_effort", "medium") || "medium");
        if (["low", "medium", "high"].includes(effort)) setReasoningEffort(effort);
        setReqTimeout(String(readScopedPref(prefs, "request_timeout", "") ?? ""));
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);
  // task 51 fix: 之前 `save(k)` 只传 1 个参数,useAutoSave 收到 val===undefined
  // 走 toast-only 分支 → 用户改 temperature/top_p/max_tokens 等全无效,刷新即丢。
  // 必须传 v,让 backend 真的落库 user_preferences。
  const u = (k, v) => { setParams(p => ({ ...p, [k]: v })); save(k, v); };

  const applyPreset = (name) => {
    setPreset(name);
    save("preset", name);
    const values = MODEL_PARAM_PRESET_VALUES[name];
    if (values) {
      setParams(p => ({ ...p, ...values }));
      Object.entries(values).forEach(([k, v]) => save(k, v));
    }
  };

  const updateNsfw = (patch) => {
    setNsfw(n => ({ ...n, ...patch }));
    if (Object.prototype.hasOwnProperty.call(patch, "mode")) save("nsfw_mode", patch.mode);
    if (Object.prototype.hasOwnProperty.call(patch, "intensity")) save("nsfw_intensity", patch.intensity);
    if (Object.prototype.hasOwnProperty.call(patch, "extra_prompt")) save("nsfw_extra_prompt", patch.extra_prompt);
  };

  // task 141: Extended Thinking 开关 — 写 model_effort[{api_id}:{model_id}] = "high" | "off"
  const toggleThinking = async (on) => {
    setThinkingEnabled(on);
    if (!selectedModelKey) return;
    const effort = on ? "high" : "off";
    try {
      const profileR = await window.api.account.profile();
      const existing = ((profileR && profileR.preferences && profileR.preferences.model_effort) || {});
      const next = { ...existing, [selectedModelKey]: effort };
      await window.api.account.preferences({ preferences: { model_effort: next } });
      window.__apiToast?.(on ? t('settings.modelparams.thinking_saved_on') : t('settings.modelparams.thinking_saved_off'), { kind: 'ok', duration: 1800 });
    } catch (e) {
      setThinkingEnabled(!on);  // 回滚
      window.__apiToast?.(t('settings.modelparams.thinking_save_failed'), { kind: 'danger', detail: e?.message });
    }
  };

  return (
    <SetGroup title={t('settings.modelparams.title')} description={t('settings.modelparams.description')}>
      <SetRow label={t('settings.modelparams.preset')} description={t('settings.modelparams.preset_desc')}>
        <CSSpaceBetween direction="horizontal" size="xs">
          {PRESETS.map(p => (
            <CSButton key={p.key} variant={preset === p.key ? "primary" : "normal"} onClick={() => applyPreset(p.key)}>{p.label}</CSButton>
          ))}
        </CSSpaceBetween>
      </SetRow>

      <ParamSlider label="Temperature" desc="Higher = more random; 0 = most deterministic; recommended 0.4–1.0"
        value={params.temperature} min={0} max={2} step={0.05} unit=""
        onChange={(v) => { setPreset("custom"); u("temperature", v); }} />

      {showReasoningEffort && (
        <SetRow label={t('settings.modelparams.reasoning_effort')} description={t('settings.modelparams.reasoning_desc')}>
          <CSSpaceBetween direction="horizontal" size="xs">
            {["low", "medium", "high"].map(lv => (
              <CSButton key={lv} variant={reasoningEffort === lv ? "primary" : "normal"}
                onClick={() => { setReasoningEffort(lv); save("reasoning_effort", lv); }}>
                {lv === "low" ? t('settings.modelparams.effort_low') : lv === "medium" ? t('settings.modelparams.effort_medium') : t('settings.modelparams.effort_high')}
              </CSButton>
            ))}
          </CSSpaceBetween>
        </SetRow>
      )}

      {/* task 141: Extended Thinking 开关 — 只对真正消费 model_effort 的 provider 显示:
          anthropic/vertex_ai 走 budget_tokens(backends/anthropic.py、vertex.py),
          openai 走 reasoning_effort、deepseek 走 reasoning_effort + thinking.type
          (均在 openai_compat.py 的 _reasoning_param 里按 api_id 分方言)。
          其余 provider(Qwen/Hunyuan/中转/本地)后端静默忽略该偏好,显示开关=「已启用」谎报。 */}
      {selectedModelKey && ["anthropic", "vertex_ai", "openai", "deepseek"].includes(selectedModelKey.split(":")[0]) && (
        <SetRow label={t('settings.modelparams.extended_thinking')}
          description={t('settings.modelparams.extended_thinking_desc')}>
          <CSToggle checked={thinkingEnabled} onChange={({ detail }) => toggleThinking(detail.checked)}>
            {thinkingEnabled
              ? t('settings.modelparams.thinking_on')
              : t('settings.modelparams.thinking_off')}
          </CSToggle>
        </SetRow>
      )}

      <ParamSlider label="Top-p" desc="Cumulative probability cutoff; 0.9–0.95 is typical"
        value={params.top_p} min={0} max={1} step={0.01} unit=""
        onChange={(v) => { setPreset("custom"); u("top_p", v); }} />

      <ParamSlider label="Top-k" desc="Sample only from the top K tokens; 0 = disabled"
        value={params.top_k} min={0} max={200} step={1} unit=""
        onChange={(v) => { setPreset("custom"); u("top_k", v); }} />

      <ParamSlider label="Repetition Penalty" desc="Suppresses recently used tokens; 1.0 = no effect; 1.15–1.2 typical"
        value={params.repetition_penalty} min={1} max={2} step={0.01} unit=""
        onChange={(v) => { setPreset("custom"); u("repetition_penalty", v); }} />

      <ParamSlider label="Frequency Penalty" desc="OpenAI-style: adjusts based on token frequency so far"
        value={params.frequency_penalty} min={-2} max={2} step={0.05} unit=""
        onChange={(v) => { setPreset("custom"); u("frequency_penalty", v); }} />

      <ParamSlider label="Presence Penalty" desc="OpenAI-style: adjusts based on whether token has appeared"
        value={params.presence_penalty} min={-2} max={2} step={0.05} unit=""
        onChange={(v) => { setPreset("custom"); u("presence_penalty", v); }} />

      <SetRow label={t('settings.modelparams.max_tokens')} description={t('settings.modelparams.max_tokens_desc')}>
        <CSInput type="number" value={String(params.max_tokens)}
          onChange={({ detail }) => { setPreset("custom"); u("max_tokens", Number(detail.value)); }} />
      </SetRow>

      <SetRow label={t('settings.modelparams.request_timeout', { defaultValue: '请求超时(秒)' })}
        description={t('settings.modelparams.request_timeout_desc', { defaultValue: '本地大模型(如自己电脑跑千问/Qwen,纯内存/CPU 很慢)等待时间不够会被切断。留空=自动(桌面 1800 秒 / 在线 300 秒);需要更久就填大一点,如 3600。' })}>
        <CSInput type="number" value={reqTimeout} placeholder={t('settings.modelparams.request_timeout_auto', { defaultValue: '自动' })}
          onChange={({ detail }) => { const v = detail.value; setReqTimeout(v); save("request_timeout", v === "" ? "" : Number(v)); }} />
      </SetRow>

      <SetRow label={t('settings.modelparams.context_size')} description={t('settings.modelparams.context_size_desc')}>
        <SetSelect
          value={String(params.context_size)}
          options={[
            { value: "4096",    label: "4K" },
            { value: "8192",    label: "8K" },
            { value: "16384",   label: "16K" },
            { value: "32768",   label: "32K" },
            { value: "65536",   label: "64K" },
            { value: "131072",  label: "128K" },
            { value: "1048576", label: "1M" },
          ]}
          onChange={(val) => u("context_size", Number(val))}
        />
      </SetRow>

      <SetRow label={t('settings.modelparams.seed')} description={t('settings.modelparams.seed_desc')}>
        <CSInput type="number" value={String(params.seed)}
          onChange={({ detail }) => u("seed", Number(detail.value))}
          placeholder="-1" />
      </SetRow>

      <SetRow label={t('settings.modelparams.stop')} description={t('settings.modelparams.stop_desc')}>
        {/* stop 以竖线分隔串存入 user_preferences(如 "player:|system:")。
            Preview JSON 仅展示拆分后的数组形态;后端当前不消费此字段(尚未接入 LLM call),
            存储格式保持竖线串,待后端接入时在 app.py 里 split("|") 转数组传给模型。 */}
        <CSInput value={params.stop} onChange={({ detail }) => u("stop", detail.value)}
          placeholder="player:|system:" />
      </SetRow>

      <SetRow label={t('settings.modelparams.nsfw')} description={t('settings.modelparams.nsfw_desc')}>
        <CSSpaceBetween direction="horizontal" size="xs">
          <CSButton variant={nsfw.mode === "block" ? "primary" : "normal"} onClick={() => updateNsfw({ mode: "block" })}>{t('settings.modelparams.nsfw_block')}</CSButton>
          <CSButton variant={nsfw.mode === "soft" ? "primary" : "normal"} onClick={() => updateNsfw({ mode: "soft" })}>{t('settings.modelparams.nsfw_soft')}</CSButton>
          <CSButton variant={nsfw.mode === "open" ? "primary" : "normal"} onClick={() => updateNsfw({ mode: "open" })}>{t('settings.modelparams.nsfw_open')}</CSButton>
          <CSButton variant={nsfw.mode === "explicit" ? "primary" : "normal"} onClick={() => updateNsfw({ mode: "explicit" })}>{t('settings.modelparams.nsfw_explicit')}</CSButton>
        </CSSpaceBetween>
      </SetRow>

      {nsfw.mode !== "block" && (
        <ParamSlider label={t('settings.modelparams.nsfw_intensity')} desc={t('settings.modelparams.nsfw_intensity_desc')}
          value={nsfw.intensity} min={0} max={1} step={0.05} unit=""
          onChange={(v) => updateNsfw({ intensity: v })} />
      )}

      <SetRow label={t('settings.modelparams.nsfw_extra')} description={t('settings.modelparams.nsfw_extra_desc')}>
        <CSInput value={nsfw.extra_prompt}
          onChange={({ detail }) => updateNsfw({ extra_prompt: detail.value })}
          placeholder="All characters must be 18+ · No extreme gore" />
      </SetRow>

      <SetRow label={t('settings.modelparams.mirostat')} description={t('settings.modelparams.mirostat_desc')}>
        <CSToggle checked={advanced} onChange={({ detail }) => setAdvanced(detail.checked)}>
          {advanced ? t('settings.modelparams.mirostat_on') : t('settings.modelparams.mirostat_off')}
        </CSToggle>
      </SetRow>

      {advanced && (
        <>
          <SetRow label={t('settings.modelparams.mirostat_mode')} description={t('settings.modelparams.mirostat_mode_desc')}>
            <CSSpaceBetween direction="horizontal" size="xs">
              {["off", "v1", "v2"].map(m => (
                <CSButton key={m} variant={params.mirostat_mode === m ? "primary" : "normal"}
                  onClick={() => u("mirostat_mode", m)}>{m === "off" ? t('settings.modelparams.mirostat_off_btn') : m}</CSButton>
              ))}
            </CSSpaceBetween>
          </SetRow>
          <ParamSlider label="Mirostat τ (tau)" desc="Target perplexity; 5 is a common value" value={params.mirostat_tau} min={0} max={10} step={0.1} unit="" onChange={(v) => u("mirostat_tau", v)} />
          <ParamSlider label="Mirostat η (eta)" desc="Learning rate" value={params.mirostat_eta} min={0} max={1} step={0.01} unit="" onChange={(v) => u("mirostat_eta", v)} />
        </>
      )}

      <SetRow label={t('settings.modelparams.preview_json')} description={t('settings.modelparams.preview_json_desc')}>
        <pre className="mono" style={{
          margin: 0, padding: "10px 12px",
          background: "var(--bg-deep)", border: "1px solid var(--line-soft)",
          borderRadius: "var(--r-2)", fontSize: 11, lineHeight: 1.6, color: "var(--text-quiet)",
          overflow: "auto", maxHeight: 180,
        }}>
{JSON.stringify({
  temperature: params.temperature,
  top_p: params.top_p,
  top_k: params.top_k,
  repetition_penalty: params.repetition_penalty,
  frequency_penalty: params.frequency_penalty,
  presence_penalty: params.presence_penalty,
  max_tokens: params.max_tokens,
  context_size: params.context_size,
  seed: params.seed,
  stop: params.stop.split("|").filter(Boolean),
  nsfw: nsfw.mode === "block" ? null : { mode: nsfw.mode, intensity: nsfw.intensity, extra: nsfw.extra_prompt },
  ...(advanced ? { mirostat_mode: params.mirostat_mode, mirostat_tau: params.mirostat_tau, mirostat_eta: params.mirostat_eta } : {})
}, null, 2)}
        </pre>
      </SetRow>
    </SetGroup>
  );
}

function ParamSlider({ label, desc, value, min, max, step, unit, onChange }) {
  return (
    <SetRow label={label} description={desc}>
      <div style={{display: "flex", alignItems: "center", gap: 8}}>
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{flex: 1, minWidth: 120}} />
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="mono" style={{width: 70, textAlign: "right"}} />
      </div>
    </SetRow>
  );
}

export {
  ModelParamsSection,
  ParamSlider,
};
