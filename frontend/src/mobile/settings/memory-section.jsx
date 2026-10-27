import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { SetGroup, MSlider, Toggle, usePrefSave } from './shared.jsx';
import { MEMORY_PRESETS, MEMORY_PRESET_FIELDS, matchMemoryPreset } from '../../lib/memory-presets.js';

/* ────────────────────────────────────────────────────────────────── */
/* SECTION: 记忆 (memory)                                              */
/* ────────────────────────────────────────────────────────────────── */
function MemorySection() {
  const { t } = useTranslation();
  const save = usePrefSave('memory');
  // 初始值 = MemorySettings schema 默认(rpg/schemas/memory.py),与后端实际生效值一致。
  // 本次记忆修复: recall_depth 5→8、token_budget 800→1600（旧预算装不下 2-3 条归档摘要）。
  const [recallDepth, setRecallDepth] = useState(8);
  const [summaryWindow, setSummaryWindow] = useState(10);
  const [tokenBudget, setTokenBudget] = useState(1600);
  const [autoArchive, setAutoArchive] = useState(50);
  // 本轮优化：与桌面端对齐，移动端也读写这两个参数（此前只有桌面设置面板能改，
  // 移动用户会一直使用 schema 默认值，行为与桌面不一致）。
  const [tokenEstimateFactor, setTokenEstimateFactor] = useState(1.0);
  const [factsSoftLimit, setFactsSoftLimit] = useState(80);
  const [pinnedMax, setPinnedMax] = useState(20);
  const [bucketPinned, setBucketPinned] = useState(true);
  const [bucketWorld, setBucketWorld] = useState(true);
  const [bucketChar, setBucketChar] = useState(true);
  const [summaryLlm, setSummaryLlm] = useState(true);

  const loadOr = (p, nk, ok) => {
    if (p[nk]!==undefined && p[nk]!==null) return p[nk];
    if (ok && p[ok]!==undefined && p[ok]!==null) return p[ok];
    return undefined;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const p = (r && r.preferences) || {};
        const rd = loadOr(p, 'memory.recall_depth', 'settings.召回深度');
        if (rd !== undefined) setRecallDepth(Number(rd));
        const sw = loadOr(p, 'memory.summary_window', 'settings.摘要窗口');
        if (sw !== undefined) setSummaryWindow(Number(sw));
        const pm = loadOr(p, 'memory.pinned_max', 'settings.固定记忆上限');
        if (pm !== undefined) setPinnedMax(Number(pm));
        if (p['memory.token_budget'] !== undefined) setTokenBudget(Number(p['memory.token_budget']));
        if (p['memory.auto_archive_after_turns'] !== undefined) setAutoArchive(Number(p['memory.auto_archive_after_turns']));
        if (p['memory.token_estimate_factor'] !== undefined) setTokenEstimateFactor(Number(p['memory.token_estimate_factor']));
        if (p['memory.facts_soft_limit'] !== undefined) setFactsSoftLimit(Number(p['memory.facts_soft_limit']));
        if (typeof p['memory.bucket_pinned_enabled'] === 'boolean') setBucketPinned(p['memory.bucket_pinned_enabled']);
        if (typeof p['memory.bucket_world_enabled'] === 'boolean') setBucketWorld(p['memory.bucket_world_enabled']);
        if (typeof p['memory.bucket_character_enabled'] === 'boolean') setBucketChar(p['memory.bucket_character_enabled']);
        if (typeof p['memory.summary_llm_enabled'] === 'boolean') setSummaryLlm(p['memory.summary_llm_enabled']);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const currentPreset = matchMemoryPreset({
    token_budget: tokenBudget,
    token_estimate_factor: tokenEstimateFactor,
    facts_soft_limit: factsSoftLimit,
    summary_window: summaryWindow,
    auto_archive_after_turns: autoArchive,
    recall_depth: recallDepth,
  });
  const applyPreset = (key) => {
    const p = MEMORY_PRESETS[key];
    if (!p) return;
    setRecallDepth(p.recall_depth);
    setSummaryWindow(p.summary_window);
    setTokenBudget(p.token_budget);
    setAutoArchive(p.auto_archive_after_turns);
    setTokenEstimateFactor(p.token_estimate_factor);
    setFactsSoftLimit(p.facts_soft_limit);
    // usePrefSave 会把同一批 6 个 key 合并成一次 preferences PATCH。
    MEMORY_PRESET_FIELDS.forEach((field) => save(field, p[field]));
  };

  return (
    <>
      <SetGroup title={t('mobile.settings.memory.recall_behavior')}>
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div className="pl-setrow-tx">
            <strong>{t('settings.memory.preset')}</strong>
            <span>{t('settings.memory.preset_desc')}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {Object.keys(MEMORY_PRESETS).map((key) => (
              <button key={key} type="button"
                className="pl-btn-ghost"
                style={{
                  height: 32, fontSize: 12, padding: '0 10px',
                  // .pl-btn-ghost 默认 width:100%（给整行操作按钮用的），预设按钮
                  // 必须显式覆盖成自适应宽度，否则每个档位独占一行。
                  width: 'auto', flex: '0 0 auto',
                  ...(currentPreset === key
                    ? { background: 'var(--accent)', color: '#fff8f3', borderColor: 'transparent' }
                    : {}),
                }}
                onClick={() => applyPreset(key)}>
                {t(`settings.memory.preset_${key}`)}
              </button>
            ))}
            {currentPreset === 'custom' && (
              <span style={{ fontSize: 12, color: 'var(--muted-2)', alignSelf: 'center' }}>
                {t('settings.memory.preset_custom')}
              </span>
            )}
          </div>
        </div>
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <MSlider label={t('mobile.settings.memory.recall_depth_label', { n: recallDepth })} desc={t('mobile.settings.memory.recall_depth_desc')}
            value={recallDepth} min={2} max={20} step={1}
            onChange={(v) => setRecallDepth(v)} />
          <button className="pl-btn-ghost" style={{ height:36, fontSize:13 }}
            onClick={() => { const n=Math.max(2,Math.min(20,recallDepth)); save('recall_depth',n); }}>
            <Icon name="save" size={14} /> {t('common.save')}
          </button>
        </div>
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <MSlider label={t('mobile.settings.memory.summary_window_label', { n: summaryWindow })} desc={t('mobile.settings.memory.summary_window_desc')}
            value={summaryWindow} min={3} max={20} step={1}
            onChange={(v) => setSummaryWindow(v)} />
          <button className="pl-btn-ghost" style={{ height:36, fontSize:13 }}
            onClick={() => { const n=Math.max(3,Math.min(20,summaryWindow)); save('summary_window',n); }}>
            <Icon name="save" size={14} /> {t('common.save')}
          </button>
        </div>
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <MSlider label={t('mobile.settings.memory.token_budget_label', { n: tokenBudget })} desc={t('mobile.settings.memory.token_budget_desc')}
            value={tokenBudget} min={200} max={5000} step={50}
            onChange={(v) => setTokenBudget(v)} />
          <button className="pl-btn-ghost" style={{ height:36, fontSize:13 }}
            onClick={() => { const n=Math.max(200,Math.min(5000,tokenBudget)); save('token_budget',n); }}>
            <Icon name="save" size={14} /> {t('common.save')}
          </button>
        </div>
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <MSlider label={t('mobile.settings.memory.auto_archive_label', { n: autoArchive })} desc={t('mobile.settings.memory.auto_archive_desc')}
            value={autoArchive} min={10} max={200} step={5}
            onChange={(v) => setAutoArchive(v)} />
          <button className="pl-btn-ghost" style={{ height:36, fontSize:13 }}
            onClick={() => { const n=Math.max(10,Math.min(200,autoArchive)); save('auto_archive_after_turns',n); }}>
            <Icon name="save" size={14} /> {t('common.save')}
          </button>
        </div>
        {/* 本轮优化：与桌面端对齐的两个参数。 */}
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <MSlider label={t('settings.memory.token_estimate_factor')} desc={t('settings.memory.token_estimate_factor_desc')}
            value={tokenEstimateFactor} min={0.5} max={3} step={0.1}
            onChange={(v) => setTokenEstimateFactor(v)} />
          <button className="pl-btn-ghost" style={{ height:36, fontSize:13 }}
            onClick={() => { const n=Math.max(0.5,Math.min(3,tokenEstimateFactor)); save('token_estimate_factor',n); }}>
            <Icon name="save" size={14} /> {t('common.save')}
          </button>
        </div>
        <div className="pl-setrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <MSlider label={t('settings.memory.facts_soft_limit')} desc={t('settings.memory.facts_soft_limit_desc')}
            value={factsSoftLimit} min={20} max={500} step={10}
            onChange={(v) => setFactsSoftLimit(v)} />
          <button className="pl-btn-ghost" style={{ height:36, fontSize:13 }}
            onClick={() => { const n=Math.max(20,Math.min(500,factsSoftLimit)); save('facts_soft_limit',n); }}>
            <Icon name="save" size={14} /> {t('common.save')}
          </button>
        </div>
      </SetGroup>

      <SetGroup title={t('mobile.settings.memory.buckets')}>
        <div className="pl-setrow">
          <div className="pl-setrow-tx"><strong>{t('mobile.settings.memory.pinned_max')}</strong><span>{t('mobile.settings.memory.pinned_max_desc')}</span></div>
          <input
            type="number" min={5} max={100} value={pinnedMax}
            onChange={(e) => setPinnedMax(Number(e.target.value))}
            onBlur={(e) => { const n=Math.max(5,Math.min(100,Number(e.target.value))); setPinnedMax(n); save('pinned_max',n); }}
            style={{ width:72, fontSize:15, textAlign:'center', padding:'6px', border:'1px solid var(--line)', borderRadius:8, background:'var(--bg-deep)', color:'var(--text)' }}
          />
        </div>
        <div className="pl-setrow">
          <div className="pl-setrow-tx"><strong>{t('mobile.settings.memory.bucket_pinned')}</strong><span>{t('mobile.settings.memory.bucket_pinned_desc')}</span></div>
          <Toggle on={bucketPinned} onChange={(v) => { setBucketPinned(v); save('bucket_pinned_enabled',v); }} />
        </div>
        <div className="pl-setrow">
          <div className="pl-setrow-tx"><strong>{t('mobile.settings.memory.bucket_world')}</strong><span>{t('mobile.settings.memory.bucket_world_desc')}</span></div>
          <Toggle on={bucketWorld} onChange={(v) => { setBucketWorld(v); save('bucket_world_enabled',v); }} />
        </div>
        <div className="pl-setrow">
          <div className="pl-setrow-tx"><strong>{t('mobile.settings.memory.bucket_char')}</strong><span>{t('mobile.settings.memory.bucket_char_desc')}</span></div>
          <Toggle on={bucketChar} onChange={(v) => { setBucketChar(v); save('bucket_character_enabled',v); }} />
        </div>
        <div className="pl-setrow">
          <div className="pl-setrow-tx"><strong>{t('mobile.settings.memory.summary_llm')}</strong><span>{t('mobile.settings.memory.summary_llm_desc')}</span></div>
          <Toggle on={summaryLlm} onChange={(v) => { setSummaryLlm(v); save('summary_llm_enabled',v); }} />
        </div>
      </SetGroup>
    </>
  );
}

export { MemorySection };
