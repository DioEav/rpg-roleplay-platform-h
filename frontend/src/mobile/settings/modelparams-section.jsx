import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { Field as MField } from '../Field.jsx';
import { readScopedPref, readNumberPref } from '../../lib/prefs.js';
import { MSlider, Seg, Toggle, usePrefSave } from './shared.jsx';

/* ────────────────────────────────────────────────────────────────── */
/* SECTION: 模型参数 (modelparams)                                     */
/* ────────────────────────────────────────────────────────────────── */
const MP_DEFAULTS = {
  temperature: 0.78, top_p: 0.92, top_k: 40,
  repetition_penalty: 1.15, frequency_penalty: 0.20, presence_penalty: 0.10,
  max_tokens: 4096, context_size: 16384, seed: -1,
  mirostat_mode: 'off', mirostat_tau: 5.0, mirostat_eta: 0.10, stop: '',
};
const MP_PRESETS = {
  conservative: { temperature:0.4, top_p:0.85, repetition_penalty:1.05, frequency_penalty:0.1, presence_penalty:0.0 },
  balanced:     { temperature:0.78, top_p:0.92, repetition_penalty:1.15, frequency_penalty:0.2, presence_penalty:0.1 },
  creative:     { temperature:1.0, top_p:0.98, repetition_penalty:1.2, frequency_penalty:0.3, presence_penalty:0.2 },
  deterministic:{ temperature:0.1, top_p:0.5, repetition_penalty:1.0, frequency_penalty:0.0, presence_penalty:0.0 },
};

// readPref / readNumPref 复用 lib/prefs.js 规范实现(语义统一 #24);保留短名薄别名,调用点零变化。
const readPref = readScopedPref;
const readNumPref = readNumberPref;

// 内容尺度档位白名单 —— 必须与后端 agents/gm/content_policy.MODES 一字不差。
const NSFW_MODES = ['block', 'soft', 'open', 'explicit', 'none'];

// 推理强度已整体隐藏(2026-09):reasoning_effort 后端未接线(无读取者);恢复显示时改回 true。
const SHOW_REASONING_EFFORT = false;

function ModelParamsSection() {
  const { t } = useTranslation();
  const save = usePrefSave('settings');
  const [preset, setPreset] = useState('balanced');
  const [params, setParams] = useState(MP_DEFAULTS);
  const [nsfw, setNsfw] = useState({ mode:'soft', intensity:0.5, extra_prompt:'' });
  const [effort, setEffort] = useState('medium');
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const prefs = (r && r.preferences) || {};
        const next = { ...MP_DEFAULTS };
        for (const key of Object.keys(MP_DEFAULTS)) {
          if (typeof MP_DEFAULTS[key] === 'number') next[key] = readNumPref(prefs, key, MP_DEFAULTS[key]);
          else next[key] = String(readPref(prefs, key, MP_DEFAULTS[key]) ?? '');
        }
        const p = String(readPref(prefs, 'preset', 'balanced') || 'balanced');
        if (['balanced','conservative','creative','deterministic','custom'].includes(p)) setPreset(p);
        setParams(next);
        const legacyNsfw = readPref(prefs, 'nsfw', null) || {};   // 旧版嵌套对象;可能存成 null
        // 与桌面端 / 后端 content_policy.resolve_content_policy 同规则(见那里的说明)
        const nsfwGroupTouched =
          ['nsfw_mode','nsfw_intensity','nsfw_extra_prompt'].some((k) => readPref(prefs, k, undefined) !== undefined)
          || Object.keys(legacyNsfw).length > 0;
        const rawNsfwMode = String(readPref(prefs, 'nsfw_mode', legacyNsfw.mode ?? '') ?? '').trim().toLowerCase();
        const nsfwMode = NSFW_MODES.includes(rawNsfwMode)
          ? rawNsfwMode
          : (rawNsfwMode ? 'none' : (nsfwGroupTouched ? 'soft' : 'none'));
        const nsfwIntensity = Number(readPref(prefs,'nsfw_intensity', legacyNsfw.intensity ?? 0.5));
        setNsfw({
          mode: nsfwMode,
          intensity: Number.isFinite(nsfwIntensity) ? nsfwIntensity : 0.5,
          extra_prompt: String(readPref(prefs,'nsfw_extra_prompt','') || ''),
        });
        const eff = String(readPref(prefs,'reasoning_effort','medium') || 'medium');
        if (['low','medium','high'].includes(eff)) setEffort(eff);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const u = (k, v) => { setParams(p => ({ ...p, [k]: v })); save(k, v); };
  const applyPreset = (name) => {
    setPreset(name); save('preset', name);
    const vals = MP_PRESETS[name];
    if (vals) { setParams(p => ({ ...p, ...vals })); Object.entries(vals).forEach(([k,v]) => save(k,v)); }
  };
  const updateNsfw = (patch) => {
    setNsfw(n => ({ ...n, ...patch }));
    if ('mode' in patch) save('nsfw_mode', patch.mode);
    if ('intensity' in patch) save('nsfw_intensity', patch.intensity);
    if ('extra_prompt' in patch) save('nsfw_extra_prompt', patch.extra_prompt);
  };

  return (
    <>
      {/* 预设 */}
      <MField label={t('mobile.settings.modelparams.preset')} desc={t('mobile.settings.modelparams.preset_desc')}>
        <Seg
          options={[['balanced',t('mobile.settings.modelparams.preset_balanced')],['conservative',t('mobile.settings.modelparams.preset_conservative')],['creative',t('mobile.settings.modelparams.preset_creative')],['deterministic',t('mobile.settings.modelparams.preset_deterministic')],['custom',t('mobile.settings.modelparams.preset_custom')]]}
          value={preset}
          onChange={applyPreset}
        />
      </MField>

      <MSlider label="Temperature" desc={t('mobile.settings.modelparams.temperature_desc')}
        value={params.temperature} min={0} max={2} step={0.05}
        onChange={(v) => { setPreset('custom'); u('temperature', v); }} />

      {/* 推理强度 — 已隐藏(2026-09):后端未接线,思考深度由「每模型思考开关」管 */}
      {SHOW_REASONING_EFFORT && (
        <MField label={t('mobile.settings.modelparams.reasoning_effort')} desc={t('mobile.settings.modelparams.reasoning_effort_desc')}>
          <Seg
            options={[['low',t('mobile.settings.modelparams.effort_low')],['medium',t('mobile.settings.modelparams.effort_medium')],['high',t('mobile.settings.modelparams.effort_high')]]}
            value={effort}
            onChange={(v) => { setEffort(v); save('reasoning_effort', v); }}
          />
        </MField>
      )}

      <MSlider label="Top-p" desc={t('mobile.settings.modelparams.top_p_desc')}
        value={params.top_p} min={0} max={1} step={0.01}
        onChange={(v) => { setPreset('custom'); u('top_p', v); }} />

      <MSlider label="Top-k" desc={t('mobile.settings.modelparams.top_k_desc')}
        value={params.top_k} min={0} max={200} step={1}
        onChange={(v) => { setPreset('custom'); u('top_k', v); }} />

      <MSlider label={t('mobile.settings.modelparams.rep_penalty')} desc={t('mobile.settings.modelparams.rep_penalty_desc')}
        value={params.repetition_penalty} min={1} max={2} step={0.01}
        onChange={(v) => { setPreset('custom'); u('repetition_penalty', v); }} />

      <MSlider label="Frequency Penalty" desc={t('mobile.settings.modelparams.freq_penalty_desc')}
        value={params.frequency_penalty} min={-2} max={2} step={0.05}
        onChange={(v) => { setPreset('custom'); u('frequency_penalty', v); }} />

      <MSlider label="Presence Penalty" desc={t('mobile.settings.modelparams.presence_penalty_desc')}
        value={params.presence_penalty} min={-2} max={2} step={0.05}
        onChange={(v) => { setPreset('custom'); u('presence_penalty', v); }} />

      {/* 数值输入 */}
      <MField label={t('mobile.settings.modelparams.max_tokens')} desc={t('mobile.settings.modelparams.max_tokens_desc')}>
        <input className="pl-input" type="number" value={params.max_tokens}
          onChange={(e) => { setPreset('custom'); u('max_tokens', Number(e.target.value)); }} />
      </MField>

      <MField label={t('mobile.settings.modelparams.context_size')} desc={t('mobile.settings.modelparams.context_size_desc')}>
        <select className="pl-input" value={String(params.context_size)}
          onChange={(e) => u('context_size', Number(e.target.value))}>
          {[['4096','4K'],['8192','8K'],['16384','16K'],['32768','32K'],['65536','64K'],['131072','128K'],['1048576','1M']].map(([v,l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </MField>

      <MField label={t('mobile.settings.modelparams.seed')} desc={t('mobile.settings.modelparams.seed_desc')}>
        <input className="pl-input" type="number" value={params.seed}
          onChange={(e) => u('seed', Number(e.target.value))} placeholder="-1" />
      </MField>

      <MField label={t('mobile.settings.modelparams.stop')} desc={t('mobile.settings.modelparams.stop_desc')}>
        <input className="pl-input" value={params.stop}
          onChange={(e) => u('stop', e.target.value)} placeholder="player:|system:" />
      </MField>

      {/* NSFW */}
      <MField label={t('mobile.settings.modelparams.content_filter')}>
        <Seg
          options={[['block',t('mobile.settings.modelparams.nsfw_block')],['soft',t('mobile.settings.modelparams.nsfw_soft')],['open',t('mobile.settings.modelparams.nsfw_open')],['explicit',t('mobile.settings.modelparams.nsfw_explicit')],['none',t('mobile.settings.modelparams.nsfw_none')]]}
          value={nsfw.mode}
          onChange={(v) => updateNsfw({ mode: v })}
        />
      </MField>

      {nsfw.mode === 'none' ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
          {t('mobile.settings.modelparams.nsfw_none_hint')}
        </div>
      ) : (
        <>
          {/* 强度实际是二值语义(后端按 >0.5 二选一措辞) → 分段按钮而非滑块;写规范值 0/1 */}
          {nsfw.mode !== 'block' && (
            <MField label={t('mobile.settings.modelparams.nsfw_intensity')} desc={t('mobile.settings.modelparams.nsfw_intensity_desc')}>
              <Seg
                options={[['low',t('mobile.settings.modelparams.nsfw_intensity_low')],['high',t('mobile.settings.modelparams.nsfw_intensity_high')]]}
                value={nsfw.intensity > 0.5 ? 'high' : 'low'}
                onChange={(v) => updateNsfw({ intensity: v === 'high' ? 1 : 0 })} />
            </MField>
          )}

          <MField label={t('mobile.settings.modelparams.nsfw_extra_prompt')} desc={t('mobile.settings.modelparams.nsfw_extra_prompt_desc')}>
            <input className="pl-input" value={nsfw.extra_prompt}
              onChange={(e) => updateNsfw({ extra_prompt: e.target.value })}
              placeholder="All characters must be 18+" />
          </MField>
        </>
      )}

      {/* Mirostat 控件已整段移除(2026-09):平台从加载起就没有任何后端读者,且 OpenAI 兼容
          协议不透传 mirostat 字段 —— 「对部分本地模型有效」的旧文案不成立。历史存过 mirostat_*
          偏好的键仍在库里,无任何效果。i18n 键(mirostat*)保留,便于将来接原生直连通道复用。 */}

      {/* JSON 预览 */}
      <div style={{ marginTop: 8 }}>
        <button className="pl-btn-ghost" style={{ height: 38, fontSize: 13 }} onClick={() => setShowJson(v => !v)}>
          <Icon name={showJson ? 'chevron_up' : 'chevron_down'} size={14} /> {showJson ? t('mobile.settings.common.collapse') : t('mobile.settings.modelparams.view_json')}
        </button>
        {showJson && (
          <div>
            {/* 按真正去向分组,而不是一个扁平 JSON —— 见桌面端同处的说明。 */}
            <MobilePreviewGroup title={t('mobile.settings.modelparams.preview_sent')} note={t('mobile.settings.modelparams.preview_sent_note')} data={{
              temperature: params.temperature, top_p: params.top_p, top_k: params.top_k,
              repetition_penalty: params.repetition_penalty, frequency_penalty: params.frequency_penalty,
              presence_penalty: params.presence_penalty,
              seed: params.seed >= 0 ? params.seed : null,
              stop: params.stop.split('|').filter(Boolean),
            }} />
            <MobilePreviewGroup title={t('mobile.settings.modelparams.preview_local')} data={{
              max_tokens: params.max_tokens, context_size: params.context_size,
            }} />
            <MobilePreviewGroup title={t('mobile.settings.modelparams.preview_prompt')} data={{
              mode: nsfw.mode, intensity: nsfw.intensity, extra_prompt: nsfw.extra_prompt,
            }} />
          </div>
        )}
      </div>
    </>
  );
}

/* 预览里的一个分组(标题 + 该组 JSON)。分组与桌面端 components/settings/modelparams-section.jsx
   的 PreviewGroup 同构:同一页参数的去向不同(发请求 / 改本站行为 / 走提示词 / 不适用),
   混在一个 JSON 里会让人以为它们都会发给模型。 */
function MobilePreviewGroup({ title, data, note }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--muted-2)', marginBottom: 4 }}>{title}</div>
      <pre className="quote mono" style={{ fontSize: 11, marginTop: 0, overflowX: 'auto' }}>
        {JSON.stringify(data, null, 2)}
      </pre>
      {note ? <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 4 }}>{note}</div> : null}
    </div>
  );
}

export { ModelParamsSection };
