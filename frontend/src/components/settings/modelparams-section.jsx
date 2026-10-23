// 模型参数区(ModelParamsSection + ParamSlider + 参数默认/预设常量)。纯机械搬出,零行为变化。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoSave } from '../../platform-app.jsx';
import { readScopedPref, readNumberPref } from '../../lib/prefs.js';
import { SetGroup, SetRow, SetSelect } from './shared.jsx';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSBox from '@cloudscape-design/components/box';
import CSInput from '@cloudscape-design/components/input';
import CSButton from '@cloudscape-design/components/button';

// 内容尺度档位白名单 —— 必须与后端 agents/gm/content_policy.MODES 一字不差。
// 漏一档的后果不是"显示不对"而是"行为与显示不一致":存过该档的用户下次打开会被静默换档。
const NSFW_MODES = ["block", "soft", "open", "explicit", "none"];

const MODEL_PARAM_DEFAULTS = {  temperature: 0.78,
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

// 高级:自建中转站的模型名不一定能自动识别。这里让用户手动指定 wire 方言,
// 写入 user_preferences.reasoning_model_overrides["api:model"];后端 model_reasoning
// 会在解析 spec 时合并它。标准 provider 不显示这行,避免普通用户误改。
const STANDARD_REASONING_PROVIDERS = new Set([
  "openai", "anthropic", "vertex_ai", "openrouter", "deepseek", "xai",
  "dashscope", "doubao", "ark_agent_plan", "siliconflow", "xiaomi_mimo",
]);
const REASONING_DIALECT_OPTIONS = [
  { label: "自动（不覆盖）", value: "auto" },
  { label: "OpenAI · reasoning_effort", value: "openai_effort" },
  { label: "DeepSeek · reasoning_effort + thinking", value: "deepseek" },
  { label: "OpenRouter · reasoning.effort", value: "openrouter_reasoning" },
  { label: "Qwen · enable_thinking + budget", value: "qwen_enable_thinking" },
  { label: "GLM · thinking.type", value: "glm_thinking" },
  { label: "Kimi · thinking.type", value: "kimi_thinking" },
  { label: "Grok · reasoning_effort", value: "grok_effort" },
  { label: "豆包 · thinking.type", value: "doubao_thinking" },
  { label: "MiMo · thinking.type", value: "mimo_thinking" },
  { label: "本地 vLLM · chat_template_kwargs", value: "vllm_chat_template" },
  // 模型编辑里可选的「自定义 JSON」也必须能被这行下拉展示;否则当前值是
  // custom_json 时下拉会显示为空,看起来像"自动匹配"。
  { label: "自定义 JSON · 每档 extra_body", value: "custom_json" },
];
// 原生 backend 只认自己的方言(与 model-edit-modal 的 NATIVE_DIALECTS 一致):
// anthropic / vertex_ai 显示这两个,避免用户在这里选了对方言、后端却完全不发字段。
const NATIVE_DIALECT_OPTIONS = {
  anthropic: [{ label: "Anthropic · budget_tokens", value: "anthropic_budget" }],
  vertex_ai: [{ label: "Gemini · thinking_budget", value: "gemini_budget" }],
};

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
  // task 141 / 2026-10: 思考控制 — 能力驱动,读 /api/models 的 model.reasoning。
  const [selectedModelKey, setSelectedModelKey] = useStatePL("");
  const [selectedReasoning, setSelectedReasoning] = useStatePL(null);
  const [selectedApiKind, setSelectedApiKind] = useStatePL("");
  const [thinkingLevel, setThinkingLevel] = useStatePL("auto");
  const [dialectOverride, setDialectOverride] = useStatePL("auto");
  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const models = await window.api.models.list().catch(() => ({}));
        if (cancelled) return;
        // ⚠️ 优先顶层 selected(当前真正生效的模型:存档 session_model > GM 偏好),
        // 而不是 models.models.selected —— 后者是 /api/models 里 catalog 自带的
        // selected(全局默认 / 用户第一个有凭证的模型),常用于展示兜底。两者可能
        // 不是同一个模型:用错会让本页的思考档位跟着另一个模型走(用户反馈:
        // 编辑了 mimo-v2.6-flash 的可用档位,设置页按钮不变)。
        const sel = models?.selected ?? models?.models?.selected ?? null;
        // 构建 model_effort 字典键: "{api_id}:{real_name}"
        const apiId = sel?.api_id || "";
        const modelId = sel?.real_name || sel?.model_id || sel?.id || "";
        const effKey = apiId && modelId ? `${apiId}:${modelId}` : "";
        // 必须在 if 块外声明:后面读 specDefault 时 m 不能是块级作用域。
        let modelSpec = null;
        if (sel) {
          // sel.capabilities 可能是 array 或 object
          const caps = Array.isArray(sel.capabilities)
            ? sel.capabilities
            : (sel.capabilities ? Object.keys(sel.capabilities) : []);
          setSelectedModelCaps(caps);
          // /api/models 已在每个 model 上附加 reasoning;selected 只有投影,需要在 apis 里找回。
          const api = (models?.models?.apis || []).find((a) => a.id === apiId);
          setSelectedApiKind((api && (api.kind || api.api_kind)) || "");
          const m = ((api && api.models) || []).find(
            (mm) => (mm.real_name || mm.id) === modelId || mm.id === modelId);
          modelSpec = (m && m.reasoning) || null;
          setSelectedReasoning(modelSpec);
        }
        if (effKey) setSelectedModelKey(effKey);
        // 读取当前模型 thinking 偏好
        const profile = await window.api.account.profile().catch(() => null);
        if (cancelled) return;
        const prefs = (profile && profile.preferences) || {};
        const modelEffort = prefs.model_effort || {};
        // 四家老 provider 未配置时后端默认 high;spec.default_level 已把 legacy 默认
        // 透出,这里必须跟它对齐,否则设置页显示 Auto 而实际在跑 High。
        const specDefault = (modelSpec && modelSpec.default_level) || "auto";
        const cur = (modelEffort[effKey] || specDefault).toString().toLowerCase();
        setThinkingLevel(cur);
        const overrides = prefs.reasoning_model_overrides || {};
        const ov = overrides[effKey];
        setDialectOverride((ov && ov.dialect) ? String(ov.dialect) : "auto");
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);
  const showReasoningEffort = selectedModelCaps.includes("reasoning");
  // Reasoning Effort 已整体隐藏(2026-09):它写 settings.reasoning_effort,后端没有任何读取者(未接线),
  // 真正管思考深度的是下方 per-model 控件。恢复显示 / 接线时把 false 改回 true。
  const SHOW_REASONING_EFFORT = false;
  // 能力驱动门槛:模型 spec 声明 supported 才显示;能否关闭/有哪些档位由 spec 决定。
  const reasoningLevels = (selectedReasoning && selectedReasoning.levels) || [];
  const showThinkingControl = !!selectedReasoning && !!selectedReasoning.supported
    && reasoningLevels.filter((x) => x !== "auto").length > 0;
  // 旧偏好值(如只有开/关的模型存过 medium)不在 levels 里 → 用默认档位高亮,
  // 避免显示成一排全未选中。
  const effectiveThinkingLevel = reasoningLevels.includes(thinkingLevel)
    ? thinkingLevel
    : (reasoningLevels.includes(selectedReasoning && selectedReasoning.default_level)
      ? selectedReasoning.default_level
      : "auto");
  const [params, setParams] = useStatePL(MODEL_PARAM_DEFAULTS);
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

        const legacyNsfw = readScopedPref(prefs, "nsfw", null) || {};
        // 档位归一与后端 content_policy.resolve_content_policy 同规则(认不出的值一律不放宽):
        //   · 整组三个键都没设过 → none:「不介入」是当前真实行为(后端什么都不发)
        //   · 设过但没写 mode     → soft:界面历史上的显示默认
        //   · 写了 mode 但认不出  → none:绝不假装某个档位在生效
        const nsfwGroupTouched =
          ["nsfw_mode", "nsfw_intensity", "nsfw_extra_prompt"].some((k) => readScopedPref(prefs, k, undefined) !== undefined)
          || Object.keys(legacyNsfw).length > 0;
        const rawNsfwMode = String(readScopedPref(prefs, "nsfw_mode", legacyNsfw.mode ?? "") ?? "").trim().toLowerCase();
        const nsfwMode = NSFW_MODES.includes(rawNsfwMode)
          ? rawNsfwMode
          : (rawNsfwMode ? "none" : (nsfwGroupTouched ? "soft" : "none"));
        const nsfwIntensity = Number(readScopedPref(prefs, "nsfw_intensity", legacyNsfw.intensity ?? 0.5));
        setNsfw({
          mode: nsfwMode,
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

  // 2026-10: 设置页写用户级 model_effort(所有对话共享);对话框里写存档级。
  const saveThinkingLevel = async (level) => {
    if (!selectedModelKey) return;
    const prev = thinkingLevel;
    setThinkingLevel(level);
    try {
      await window.api.models.reasoning({
        api_id: selectedModelKey.slice(0, selectedModelKey.indexOf(':')),
        model_id: selectedModelKey.slice(selectedModelKey.indexOf(':') + 1),
        level,
      });
      // 不要一律弹「已启用」:点 Off / Auto 也必须给出对应文案。
      const toastKey = level === 'off' || level === '0'
        ? 'settings.modelparams.thinking_saved_off'
        : level === 'auto'
          ? 'settings.modelparams.thinking_saved_auto'
          : 'settings.modelparams.thinking_saved_on';
      window.__apiToast?.(t(toastKey), { kind: 'ok', duration: 1800 });
    } catch (e) {
      setThinkingLevel(prev);  // 回滚
      window.__apiToast?.(t('settings.modelparams.thinking_save_failed'), { kind: 'danger', detail: e?.message });
    }
  };

  // 高级:手动指定中转站方言。保存后重新拉 /api/models,让新的 reasoning spec 立即生效。
  const saveDialect = async (dialect) => {
    if (!selectedModelKey) return;
    const prev = dialectOverride;
    setDialectOverride(dialect);
    try {
      const profile = await window.api.account.profile();
      const existing = { ...((profile && profile.preferences
        && profile.preferences.reasoning_model_overrides) || {}) };
      if (dialect === "auto") delete existing[selectedModelKey];
      else existing[selectedModelKey] = {
        ...(existing[selectedModelKey] || {}),
        dialect,
        supported: true,
      };
      await window.api.account.preferences({
        preferences: { reasoning_model_overrides: existing },
      });
      const models = await window.api.models.list().catch(() => null);
      const colon = selectedModelKey.indexOf(":");
      const apiId = selectedModelKey.slice(0, colon);
      const modelId = selectedModelKey.slice(colon + 1);
      const api = ((models && models.models && models.models.apis) || [])
        .find((a) => a.id === apiId);
      const m = ((api && api.models) || []).find(
        (mm) => (mm.real_name || mm.id) === modelId || mm.id === modelId);
      setSelectedReasoning((m && m.reasoning) || null);
      window.__apiToast?.(t('settings.modelparams.reasoning_dialect_saved', {
        defaultValue: '思考发送方式已保存',
      }), { kind: 'ok', duration: 1800 });
    } catch (e) {
      setDialectOverride(prev);
      window.__apiToast?.(t('settings.modelparams.thinking_save_failed'), { kind: 'danger', detail: e?.message });
    }
  };

  const selectedApiId = selectedModelKey ? selectedModelKey.split(":")[0] : "";
  const showDialectEditor = !!selectedApiId && (
    !STANDARD_REASONING_PROVIDERS.has(selectedApiId)
    || (selectedReasoning && selectedReasoning.confidence !== "verified")
  );

  return (
    <SetGroup title={t('settings.modelparams.title')} description={t('settings.modelparams.description')}>
      <SetRow label={t('settings.modelparams.preset')} description={t('settings.modelparams.preset_desc')}>
        <CSSpaceBetween direction="horizontal" size="xs">
          {PRESETS.map(p => (
            <CSButton key={p.key} variant={preset === p.key ? "primary" : "normal"} onClick={() => applyPreset(p.key)}>{p.label}</CSButton>
          ))}
        </CSSpaceBetween>
      </SetRow>

      {/* 2026-10: 能力驱动的思考控件,放在温度上方(用户要求的顺序)。
          供应商白名单已删除 —— GLM/Kimi/Qwen/Grok/中转只要 model.reasoning
          声明 supported 就显示;未知模型整体隐藏。 */}
      {showThinkingControl && (
        <SetRow label={t('settings.modelparams.extended_thinking')}
          description={t('settings.modelparams.extended_thinking_desc')}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
            <CSSpaceBetween direction="horizontal" size="xs">
              {reasoningLevels.map((lv) => (
                <CSButton key={lv} variant={effectiveThinkingLevel === lv ? "primary" : "normal"}
                  onClick={() => saveThinkingLevel(lv)}>
                  {lv === "auto"
                    ? t('game.composer.effort_auto', { defaultValue: "Auto" })
                    : lv === "off"
                      ? t('settings.modelparams.thinking_off')
                      : lv}
                </CSButton>
              ))}
            </CSSpaceBetween>
          </div>
        </SetRow>
      )}

      {showDialectEditor && (
        <SetRow
          label={t('settings.modelparams.reasoning_dialect', { defaultValue: "思考发送方式（高级）" })}
          description={t('settings.modelparams.reasoning_dialect_desc', {
            defaultValue: "自建中转站的模型名无法自动识别时，在这里指定它接受的参数格式。自动 = 不覆盖。",
          })}>
          <SetSelect value={dialectOverride}
            options={NATIVE_DIALECT_OPTIONS[selectedApiKind] || REASONING_DIALECT_OPTIONS}
            onChange={saveDialect} />
        </SetRow>
      )}

      <ParamSlider label={t('settings.modelparams.temperature')} desc={t('settings.modelparams.temperature_desc')}
        value={params.temperature} min={0} max={2} step={0.05} unit=""
        onChange={(v) => { setPreset("custom"); u("temperature", v); }} />

      {SHOW_REASONING_EFFORT && showReasoningEffort && (
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

      <ParamSlider label={t('settings.modelparams.top_p')} desc={t('settings.modelparams.top_p_desc')}
        value={params.top_p} min={0} max={1} step={0.01} unit=""
        onChange={(v) => { setPreset("custom"); u("top_p", v); }} />

      <ParamSlider label={t('settings.modelparams.top_k')} desc={t('settings.modelparams.top_k_desc')}
        value={params.top_k} min={0} max={200} step={1} unit=""
        onChange={(v) => { setPreset("custom"); u("top_k", v); }} />

      <ParamSlider label={t('settings.modelparams.repetition_penalty')} desc={t('settings.modelparams.repetition_penalty_desc')}
        value={params.repetition_penalty} min={1} max={2} step={0.01} unit=""
        onChange={(v) => { setPreset("custom"); u("repetition_penalty", v); }} />

      <ParamSlider label={t('settings.modelparams.frequency_penalty')} desc={t('settings.modelparams.frequency_penalty_desc')}
        value={params.frequency_penalty} min={-2} max={2} step={0.05} unit=""
        onChange={(v) => { setPreset("custom"); u("frequency_penalty", v); }} />

      <ParamSlider label={t('settings.modelparams.presence_penalty')} desc={t('settings.modelparams.presence_penalty_desc')}
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
          {/* 第 5 档:平台完全不介入 —— 不发提示词块,也不动 provider 的安全过滤,
              GM 内容完全由模型默认决定(所以适用于任何模型)。也是「从未设置过」的默认语义。 */}
          <CSButton variant={nsfw.mode === "none" ? "primary" : "normal"} onClick={() => updateNsfw({ mode: "none" })}>{t('settings.modelparams.nsfw_none')}</CSButton>
        </CSSpaceBetween>
      </SetRow>

      {nsfw.mode === "none" ? (
        <CSBox color="text-body-secondary" fontSize="body-s">{t('settings.modelparams.nsfw_none_hint')}</CSBox>
      ) : (
        <>
          {/* 强度实际是二值语义(后端按 >0.5 二选一措辞),用滑块会让人以为 0.3/0.45 有区别。
              按钮写规范值 0/1;历史存值按同一阈值自动落到对应按钮。 */}
          {nsfw.mode !== "block" && (
            <SetRow label={t('settings.modelparams.nsfw_intensity')} description={t('settings.modelparams.nsfw_intensity_desc')}>
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant={nsfw.intensity > 0.5 ? "normal" : "primary"} onClick={() => updateNsfw({ intensity: 0 })}>{t('settings.modelparams.nsfw_intensity_low')}</CSButton>
                <CSButton variant={nsfw.intensity > 0.5 ? "primary" : "normal"} onClick={() => updateNsfw({ intensity: 1 })}>{t('settings.modelparams.nsfw_intensity_high')}</CSButton>
              </CSSpaceBetween>
            </SetRow>
          )}

          <SetRow label={t('settings.modelparams.nsfw_extra')} description={t('settings.modelparams.nsfw_extra_desc')}>
            <CSInput value={nsfw.extra_prompt}
              onChange={({ detail }) => updateNsfw({ extra_prompt: detail.value })}
              placeholder="All characters must be 18+ · No extreme gore" />
          </SetRow>
        </>
      )}

      {/* Mirostat 控件已整段移除(2026-09):它在平台从加载起就没有任何后端读者,且 OpenAI 兼容
          协议不透传 mirostat 字段 —— 界面曾经承诺「对部分本地模型有效」是不成立的(本地模型也走
          OpenAI 兼容层)。历史存过 mirostat_* 偏好的用户:键仍在库里,无任何效果,无需清理。
          若将来接 llama.cpp / Ollama 原生直连通道,i18n 键(mirostat*)仍保留可复用。 */}

      <SetRow label={t('settings.modelparams.preview_json')} description={t('settings.modelparams.preview_json_desc')}>
        <div>
          {/* 分组不是装饰:同一页里的参数去向完全不同 —— 有的真进请求体,有的只改本站行为,
              有的走提示词,还有的在本架构里根本没有通道。此前一个扁平 JSON 把它们混在一起,
              配上「发送给 API 的实际采样参数」这句说明,等于对用户撒谎。 */}
          <PreviewGroup title={t('settings.modelparams.preview_sent')} note={t('settings.modelparams.preview_sent_note')} data={{
            temperature: params.temperature,
            top_p: params.top_p,
            top_k: params.top_k,
            repetition_penalty: params.repetition_penalty,
            frequency_penalty: params.frequency_penalty,
            presence_penalty: params.presence_penalty,
            seed: params.seed >= 0 ? params.seed : null,
            stop: params.stop.split("|").filter(Boolean),
          }} />
          <PreviewGroup title={t('settings.modelparams.preview_local')} data={{
            max_tokens: params.max_tokens,
            context_size: params.context_size,
            request_timeout: reqTimeout,
          }} />
          <PreviewGroup title={t('settings.modelparams.preview_prompt')} data={{
            mode: nsfw.mode,
            intensity: nsfw.intensity,
            extra_prompt: nsfw.extra_prompt,
          }} />
        </div>
      </SetRow>
    </SetGroup>
  );
}

function PreviewGroup({ title, data, note }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-quiet)", marginBottom: 4 }}>{title}</div>
      <pre className="mono" style={{
        margin: 0, padding: "10px 12px",
        background: "var(--bg-deep)", border: "1px solid var(--line-soft)",
        borderRadius: "var(--r-2)", fontSize: 11, lineHeight: 1.6, color: "var(--text-quiet)",
        overflow: "auto", maxHeight: 180,
      }}>
{JSON.stringify(data, null, 2)}
      </pre>
      {note ? <div style={{ fontSize: 11, color: "var(--text-quiet)", marginTop: 4 }}>{note}</div> : null}
    </div>
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
