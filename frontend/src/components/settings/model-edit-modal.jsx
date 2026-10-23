/* ModelEditModal — API 设置页“模型详情”里的单模型编辑弹窗。
 *
 * 只编辑两类东西：
 *   1. capabilities 能力标签（用户级覆盖）；
 *   2. reasoning 自定义 spec（内置方言映射或 custom_json 每档 JSON）。
 *
 * 保存走 POST /api/me/models/model/config，不碰 admin-only 的全局模型目录。
 */
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import Modal from '../Modal.jsx';
import { CAP_LABEL, getCaps } from '../catalog-helpers.js';
import { SetSelect } from './shared.jsx';

const LEVEL_LABELS = {
  auto: '自动',
  off: '关',
  low: '低',
  medium: '中',
  high: '高',
  extra: '极深',
  max: '最满',
};

const DEFAULT_BUDGET = { low: 1024, medium: 4096, high: 8192, extra: 16384, max: 24576 };

const DIALECTS = {
  openai_effort: {
    label: 'OpenAI · reasoning_effort',
    levels: ['auto', 'low', 'medium', 'high'],
    can_disable: false,
    kind: 'effort',
    map: { low: 'minimal', medium: 'medium', high: 'high' },
  },
  deepseek: {
    label: 'DeepSeek · reasoning_effort + thinking',
    levels: ['auto', 'off', 'low', 'medium', 'high', 'extra', 'max'],
    can_disable: true,
    kind: 'effort',
    map: { low: 'low', medium: 'medium', high: 'high', extra: 'xhigh', max: 'max' },
  },
  anthropic_budget: {
    label: 'Anthropic · budget_tokens',
    levels: ['auto', 'off', 'low', 'medium', 'high', 'extra', 'max'],
    can_disable: true,
    kind: 'budget',
    map: { ...DEFAULT_BUDGET },
  },
  gemini_budget: {
    label: 'Gemini · thinking_budget',
    levels: ['auto', 'off', 'low', 'medium', 'high', 'extra', 'max'],
    can_disable: true,
    kind: 'budget',
    map: { ...DEFAULT_BUDGET },
  },
  openrouter_reasoning: {
    label: 'OpenRouter · reasoning.effort',
    levels: ['auto', 'off', 'low', 'medium', 'high'],
    can_disable: true,
    kind: 'effort',
    map: { low: 'low', medium: 'medium', high: 'high' },
  },
  qwen_enable_thinking: {
    label: 'Qwen · enable_thinking + budget',
    levels: ['auto', 'off', 'low', 'medium', 'high', 'extra', 'max'],
    can_disable: true,
    kind: 'budget',
    map: { ...DEFAULT_BUDGET },
  },
  glm_thinking: {
    label: 'GLM · thinking.type',
    levels: ['auto', 'off', 'high'],
    can_disable: true,
    kind: 'toggle',
  },
  kimi_thinking: {
    label: 'Kimi · thinking.type',
    levels: ['auto', 'off', 'high'],
    can_disable: true,
    kind: 'toggle',
  },
  grok_effort: {
    label: 'Grok · reasoning_effort',
    levels: ['auto', 'low', 'high'],
    can_disable: false,
    kind: 'effort',
    map: { low: 'low', high: 'high' },
  },
  doubao_thinking: {
    label: '豆包 · thinking.type',
    levels: ['auto', 'off', 'high'],
    can_disable: true,
    kind: 'toggle',
  },
  mimo_thinking: {
    label: 'MiMo · thinking.type',
    levels: ['auto', 'off', 'high'],
    can_disable: true,
    kind: 'toggle',
  },
  vllm_chat_template: {
    label: '本地 vLLM · chat_template_kwargs',
    levels: ['auto', 'off', 'high'],
    can_disable: true,
    kind: 'toggle',
  },
  custom_json: {
    label: '自定义 JSON（每档 extra_body）',
    levels: ['auto', 'off', 'low', 'medium', 'high', 'extra', 'max'],
    can_disable: true,
    kind: 'json',
  },
};

const NATIVE_DIALECTS = {
  anthropic: ['anthropic_budget'],
  vertex_ai: ['gemini_budget'],
};

function dialectOptions(kind) {
  const native = NATIVE_DIALECTS[kind];
  if (native) return native;
  return Object.keys(DIALECTS).filter((k) => k !== 'anthropic_budget' && k !== 'gemini_budget');
}

function initialSpec(dialect = 'openai_effort') {
  const d = DIALECTS[dialect] || DIALECTS.openai_effort;
  return {
    enabled: true,
    supported: true,
    dialect,
    can_disable: !!d.can_disable,
    levels: [...d.levels],
    default_level: 'auto',
    effort_values: d.kind === 'effort' ? { ...(d.map || {}) } : {},
    budget_tokens: d.kind === 'budget' ? { ...(d.map || {}) } : {},
    params_by_level: {},
    reasoning_counts_in_output: d.kind === 'budget',
    output_reserve_tokens: 1024,
  };
}

function normalizeSpec(raw, dialect) {
  const base = initialSpec(dialect || raw?.dialect || 'openai_effort');
  const out = { ...base, ...(raw || {}) };
  out.enabled = true;
  out.dialect = DIALECTS[raw?.dialect || dialect || base.dialect]
    ? (raw?.dialect || dialect || base.dialect)
    : base.dialect;
  const active = DIALECTS[out.dialect] || base;
  out.levels = Array.isArray(out.levels) && out.levels.length ? [...out.levels] : [...active.levels];
  out.levels = active.levels.filter((lv) => out.levels.includes(lv));
  if (!out.levels.includes('auto')) out.levels.unshift('auto');
  out.default_level = out.levels.includes(out.default_level) ? out.default_level : 'auto';
  out.can_disable = !!out.can_disable && active.levels.includes('off');
  if (!out.can_disable) out.levels = out.levels.filter((lv) => lv !== 'off');
  if (!out.effort_values || typeof out.effort_values !== 'object') out.effort_values = {};
  if (!out.budget_tokens || typeof out.budget_tokens !== 'object') out.budget_tokens = {};
  // 缺省映射用当前方言默认值补齐:从 toggle 方言(custom_json/mimo 等)切到
  // effort/budget 方言后,旧 spec 里的空映射不该让保存直接报"缺少映射"。
  // 显式空串/0 仍保留(由保存时的校验提示用户填写)。
  out.effort_values = { ...(base.effort_values || {}), ...out.effort_values };
  out.budget_tokens = { ...(base.budget_tokens || {}), ...out.budget_tokens };
  if (!out.params_by_level || typeof out.params_by_level !== 'object') out.params_by_level = {};
  return out;
}

export default function ModelEditModal({ open, api, model, onClose, onSave }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useStatePL(false);
  const [loadFailed, setLoadFailed] = useStatePL(false);
  const [saving, setSaving] = useStatePL(false);
  const [mode, setMode] = useStatePL('auto');           // auto | custom
  const [capabilities, setCapabilities] = useStatePL([]);
  const [spec, setSpec] = useStatePL(initialSpec());
  const [jsonDrafts, setJsonDrafts] = useStatePL({});   // level -> JSON string
  const [error, setError] = useStatePL('');

  const kind = api?.kind || '';
  const isNative = !!NATIVE_DIALECTS[kind];
  const dialects = dialectOptions(kind);
  const activeDialect = DIALECTS[spec.dialect] || DIALECTS.openai_effort;

  useEffectPL(() => {
    if (!open || !api || !model) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setError('');
    setMode('auto');
    setSpec(initialSpec(isNative ? dialects[0] : 'openai_effort'));
    setJsonDrafts({});
    const currentCaps = getCaps(model);
    setCapabilities(currentCaps);
    (async () => {
      try {
        const res = await window.api.models.getModelConfig({
          api_id: api.id,
          real_name: model.real_name || model.id,
        });
        if (cancelled) return;
        if (Array.isArray(res?.capabilities)) setCapabilities(res.capabilities);
        if (res?.mode === 'custom' && res.override && typeof res.override === 'object') {
          let next = normalizeSpec(res.override);
          // 原生 provider 只允许对应原生方言；历史错误配置回落到第一个合法方言。
          if (!dialects.includes(next.dialect)) {
            next = normalizeSpec({ ...res.override, dialect: dialects[0] });
          }
          setMode('custom');
          setSpec(next);
          if (next.dialect === 'custom_json') {
            const drafts = {};
            for (const lv of next.levels) {
              if (lv === 'auto') continue;
              const val = (next.params_by_level && next.params_by_level[lv])
                || (lv === 'off' ? next.off_params : null);
              drafts[lv] = JSON.stringify(val || {}, null, 2);
            }
            setJsonDrafts(drafts);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setLoadFailed(true);
          setError(e?.message || '读取模型配置失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, api?.id, model?.id, isNative]);

  if (!open || !api || !model) return null;

  const setField = (k, v) => setSpec((s) => ({ ...s, [k]: v }));

  const pickDialect = (dialect) => {
    const d = DIALECTS[dialect] || DIALECTS.openai_effort;
    const base = initialSpec(dialect);
    const allowed = new Set(d.levels || []);
    // 换发送方式只收敛「新方言不支持的档位」,不能把用户已编辑的可用档位、
    // 默认档位、参数映射整体重置成模板默认值(否则看起来像自定义数据全丢了)。
    const keptLevels = (spec.levels || []).filter((lv) => allowed.has(lv));
    if (!keptLevels.includes('auto')) keptLevels.unshift('auto');
    const hasRealLevel = keptLevels.some((lv) => lv !== 'auto' && lv !== 'off');
    const levels = hasRealLevel ? d.levels.filter((lv) => keptLevels.includes(lv)) : [...d.levels];
    const finalLevels = d.can_disable ? levels : levels.filter((lv) => lv !== 'off');
    // 映射:新方言默认值打底,再覆盖用户原来的自定义值(仅保留新方言支持的档位)。
    const effortValues = { ...(base.effort_values || {}) };
    for (const [lv, v] of Object.entries(spec.effort_values || {})) {
      if (allowed.has(lv) && typeof v === 'string' && v.trim()) effortValues[lv] = v;
    }
    const budgetTokens = { ...(base.budget_tokens || {}) };
    for (const [lv, v] of Object.entries(spec.budget_tokens || {})) {
      const n = Number(v);
      if (allowed.has(lv) && Number.isFinite(n) && n > 0) budgetTokens[lv] = n;
    }
    // 当前是自定义 JSON 时,先把编辑框里尚未保存的草稿收进 params_by_level,
    // 否则切走再切回会丢掉刚输入但还没点保存的每档参数。
    const paramsByLevel = { ...(spec.params_by_level || {}) };
    if (DIALECTS[spec.dialect]?.kind === 'json') {
      for (const [lv, raw] of Object.entries(jsonDrafts || {})) {
        try {
          const val = JSON.parse(raw || '{}');
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            paramsByLevel[lv] = val;
          }
        } catch (_) { /* 非法 JSON 保留上一次已保存的值,保存时会提示错误 */ }
      }
    }
    const next = {
      ...base,
      supported: true,
      can_disable: !!d.can_disable,
      levels: finalLevels,
      default_level: finalLevels.includes(spec.default_level) ? spec.default_level : 'auto',
      effort_values: effortValues,
      budget_tokens: budgetTokens,
      // 自定义 JSON 的每档参数保留在 state 里:切走再切回时不至于丢光。
      params_by_level: paramsByLevel,
      off_params: paramsByLevel.off || spec.off_params,
      reasoning_counts_in_output: spec.reasoning_counts_in_output != null
        ? !!spec.reasoning_counts_in_output
        : base.reasoning_counts_in_output,
      output_reserve_tokens: spec.output_reserve_tokens != null
        ? (Number(spec.output_reserve_tokens) || 0)
        : base.output_reserve_tokens,
    };
    setSpec(next);
    if (d.kind === 'json') {
      const drafts = {};
      for (const lv of finalLevels) {
        if (lv === 'auto') continue;
        const val = (next.params_by_level && next.params_by_level[lv])
          || (lv === 'off' ? next.off_params : null);
        drafts[lv] = JSON.stringify(val || {}, null, 2);
      }
      setJsonDrafts(drafts);
    } else {
      setJsonDrafts({});
    }
  };

  const toggleLevel = (lv) => {
    if (lv === 'auto') return;
    setSpec((s) => {
      const has = s.levels.includes(lv);
      let levels = has ? s.levels.filter((x) => x !== lv) : [...s.levels, lv];
      const order = DIALECTS[s.dialect]?.levels || Object.keys(LEVEL_LABELS);
      levels = order.filter((x) => levels.includes(x));
      if (!levels.includes('auto')) levels.unshift('auto');
      let defaultLevel = s.default_level;
      if (!levels.includes(defaultLevel)) defaultLevel = 'auto';
      return { ...s, levels, default_level: defaultLevel };
    });
  };

  const setEffort = (lv, v) => setSpec((s) => ({
    ...s, effort_values: { ...s.effort_values, [lv]: v },
  }));
  const setBudget = (lv, v) => setSpec((s) => ({
    ...s, budget_tokens: { ...s.budget_tokens, [lv]: Number(v) || 0 },
  }));

  const buildReasoning = () => {
    if (mode === 'auto') return { reasoning: null, errors: [] };
    const errors = [];
    const levels = spec.levels.filter((lv) => lv !== 'auto');
    if (!spec.supported && levels.some((lv) => lv !== 'off')) {
      errors.push('关闭“支持思考”时不能保留低/中/高档位');
    }
    if (spec.supported && !levels.some((lv) => lv !== 'off')) {
      errors.push('支持思考时至少选择一个非 auto 档位');
    }
    const out = {
      enabled: true,
      supported: !!spec.supported,
      dialect: spec.dialect,
      can_disable: !!spec.can_disable,
      levels: [...spec.levels],
      default_level: spec.default_level,
      reasoning_counts_in_output: !!spec.reasoning_counts_in_output,
      output_reserve_tokens: Number(spec.output_reserve_tokens) || 0,
    };
    if (activeDialect.kind === 'effort') {
      out.effort_values = {};
      for (const lv of levels) {
        if (lv === 'off') continue;
        const v = String(spec.effort_values[lv] || '').trim();
        if (!v) errors.push(`档位 ${LEVEL_LABELS[lv] || lv} 缺少 reasoning_effort`);
        else out.effort_values[lv] = v;
      }
    } else if (activeDialect.kind === 'budget') {
      out.budget_tokens = {};
      for (const lv of levels) {
        if (lv === 'off') continue;
        const v = Number(spec.budget_tokens[lv] || 0);
        if (!v || v < 0) errors.push(`档位 ${LEVEL_LABELS[lv] || lv} 缺少预算 token`);
        else out.budget_tokens[lv] = v;
      }
    } else if (activeDialect.kind === 'json') {
      out.params_by_level = {};
      for (const lv of levels) {
        const raw = jsonDrafts[lv] == null ? '{}' : jsonDrafts[lv];
        try {
          const val = JSON.parse(raw || '{}');
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            errors.push(`档位 ${LEVEL_LABELS[lv] || lv} 必须是 JSON 对象`);
          } else {
            out.params_by_level[lv] = val;
          }
        } catch (_) {
          errors.push(`档位 ${LEVEL_LABELS[lv] || lv} JSON 格式错误`);
        }
      }
    }
    return { reasoning: errors.length ? null : out, errors };
  };

  const submit = async () => {
    if (saving || loadFailed) return;
    const { reasoning, errors } = buildReasoning();
    if (errors.length) {
      setError(errors.join('；'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        api,
        model,
        capabilities,
        reasoning,
      });
    } catch (e) {
      setError(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleCap = (cap) => setCapabilities((list) => (
    list.includes(cap) ? list.filter((x) => x !== cap) : [...list, cap]
  ));
  const knownCaps = Object.keys(CAP_LABEL);
  const extraCaps = capabilities.filter((c) => !knownCaps.includes(c));
  const mappingLevels = spec.levels.filter((lv) => lv !== 'auto');

  return (
    <Modal
      open
      eyebrow={`${api.name || api.id} / ${model.real_name || model.id}`}
      title={t('settings.model_edit.title', { defaultValue: '编辑模型' })}
      width={760}
      onClose={onClose}
      footer={<>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', width: '100%' }}>
          <button className="btn ghost" disabled={loadFailed}
            onClick={() => { setMode('auto'); setError(''); }}>
            {t('settings.model_edit.reset_auto', { defaultValue: '恢复自动识别' })}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={submit} disabled={saving || loading || loadFailed}>
              <Icon name="check" size={12} /> {t('settings.model_edit.save', { defaultValue: '保存' })}
            </button>
          </div>
        </div>
      </>}
    >
      {loading ? (
        <div className="muted" style={{ padding: 20 }}>{t('common.loading')}</div>
      ) : (
        <div className="pl-modal-form">
          {error && (
            <div style={{ padding: '8px 10px', borderRadius: 6, background: 'rgba(200,40,40,0.10)', color: 'var(--danger,#d44)', fontSize: 12 }}>
              {error}
            </div>
          )}

          <div className="pl-field">
            <label>{t('settings.model_edit.capabilities', { defaultValue: '能力标签' })}</label>
            <div className="pl-rules">
              {knownCaps.map((cap) => (
                <button key={cap} type="button"
                  className={`pl-rule-chip ${capabilities.includes(cap) ? 'active' : ''}`}
                  onClick={() => toggleCap(cap)}>
                  {CAP_LABEL[cap]}
                </button>
              ))}
              {extraCaps.map((cap) => (
                <button key={cap} type="button"
                  className="pl-rule-chip active"
                  onClick={() => toggleCap(cap)}>
                  {cap}
                </button>
              ))}
            </div>
          </div>

          <div className="pl-field">
            <label>{t('settings.model_edit.thinking', { defaultValue: '思考控制' })}</label>
            <div className="pl-rules" style={{ marginBottom: 8 }}>
              <button type="button" className={`pl-rule-chip ${mode === 'auto' ? 'active' : ''}`}
                onClick={() => setMode('auto')}>
                {t('settings.model_edit.follow_auto', { defaultValue: '跟随自动识别' })}
              </button>
              <button type="button" className={`pl-rule-chip ${mode === 'custom' ? 'active' : ''}`}
                onClick={() => setMode('custom')}>
                {t('settings.model_edit.custom', { defaultValue: '自定义' })}
              </button>
            </div>

            {mode === 'auto' ? (
              <div className="muted" style={{ fontSize: 12 }}>
                {model.reasoning?.supported
                  ? `自动识别：${model.reasoning.dialect || '—'} · ${(model.reasoning.levels || []).join(' / ')}`
                  : '当前模型未被自动识别为支持思考。可切到“自定义”手动配置。'}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={!!spec.supported}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setSpec((s) => ({
                          ...s,
                          supported: on,
                          levels: on
                            ? s.levels
                            : ['auto', ...(s.can_disable ? ['off'] : [])],
                          default_level: on ? s.default_level : 'auto',
                        }));
                      }} />
                    支持思考
                  </label>
                  {activeDialect.levels.includes('off') && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input type="checkbox" checked={!!spec.can_disable}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setField('can_disable', on);
                          if (!on) setSpec((s) => ({
                            ...s,
                            can_disable: false,
                            levels: s.levels.filter((lv) => lv !== 'off'),
                            default_level: s.default_level === 'off' ? 'auto' : s.default_level,
                          }));
                        }} />
                      允许关闭思考
                    </label>
                  )}
                </div>

                <div className="pl-field">
                  <label>{t('settings.model_edit.default_level', { defaultValue: '默认档位' })}</label>
                  <SetSelect
                    value={spec.default_level}
                    options={spec.levels.map((lv) => ({ value: lv, label: LEVEL_LABELS[lv] || lv }))}
                    onChange={(v) => setField('default_level', v)}
                    expandToViewport
                    ariaLabel={t('settings.model_edit.default_level', { defaultValue: '默认档位' })}
                  />
                </div>

                <div className="pl-field">
                  <label>{t('settings.model_edit.dialect', { defaultValue: '发送方式' })}</label>
                  <SetSelect
                    value={spec.dialect}
                    options={dialects.map((d) => ({ value: d, label: DIALECTS[d]?.label || d }))}
                    onChange={pickDialect}
                    expandToViewport
                    ariaLabel={t('settings.model_edit.dialect', { defaultValue: '发送方式' })}
                  />
                </div>

                <div className="pl-field">
                  <label>{t('settings.model_edit.levels', { defaultValue: '可用档位' })}</label>
                  <div className="pl-rules">
                    {(DIALECTS[spec.dialect]?.levels || Object.keys(LEVEL_LABELS)).map((lv) => (
                      <button key={lv} type="button"
                        className={`pl-rule-chip ${spec.levels.includes(lv) ? 'active' : ''}`}
                        disabled={lv === 'auto'}
                        onClick={() => toggleLevel(lv)}>
                        {LEVEL_LABELS[lv] || lv}
                      </button>
                    ))}
                  </div>
                </div>

                {activeDialect.kind !== 'toggle' && (
                  <div className="pl-field">
                    <label>{t('settings.model_edit.mapping', { defaultValue: '参数映射' })}</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {mappingLevels.map((lv) => {
                        if (lv === 'auto') return null;
                        if (lv === 'off' && activeDialect.kind !== 'json') {
                          return (
                            <div key={lv} className="muted" style={{ fontSize: 12 }}>
                              关：{activeDialect.kind === 'budget' ? 'thinking_budget=0 / 关闭思考' : '关闭思考'}
                            </div>
                          );
                        }
                        if (activeDialect.kind === 'effort') {
                          return (
                            <div key={lv} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={{ width: 38, fontSize: 12 }}>{LEVEL_LABELS[lv] || lv}</span>
                              <input className="pl-input mono" style={{ flex: 1 }}
                                value={spec.effort_values[lv] || ''}
                                onChange={(e) => setEffort(lv, e.target.value)}
                                placeholder="minimal / low / medium / high" />
                            </div>
                          );
                        }
                        if (activeDialect.kind === 'budget') {
                          return (
                            <div key={lv} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={{ width: 38, fontSize: 12 }}>{LEVEL_LABELS[lv] || lv}</span>
                              <input className="pl-input mono" style={{ flex: 1 }} type="number"
                                value={spec.budget_tokens[lv] ?? ''}
                                onChange={(e) => setBudget(lv, e.target.value)}
                                placeholder="1024" />
                            </div>
                          );
                        }
                        return (
                          <div key={lv} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span style={{ fontSize: 12 }}>{LEVEL_LABELS[lv] || lv}</span>
                            <textarea className="pl-input mono" rows={4}
                              value={jsonDrafts[lv] ?? '{}'}
                              onChange={(e) => setJsonDrafts((d) => ({ ...d, [lv]: e.target.value }))}
                              placeholder='{"reasoning_effort": "high"}' />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(activeDialect.kind === 'effort' || activeDialect.kind === 'budget') && (
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input type="checkbox" checked={!!spec.reasoning_counts_in_output}
                        onChange={(e) => setField('reasoning_counts_in_output', e.target.checked)} />
                      思考 token 占用输出上限
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      额外预留输出 token
                      <input className="pl-input" type="number" style={{ width: 100 }}
                        value={spec.output_reserve_tokens ?? 1024}
                        onChange={(e) => setField('output_reserve_tokens', Number(e.target.value) || 0)} />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
