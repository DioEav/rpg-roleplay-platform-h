// 记忆设置区(MemorySection)。纯机械搬出,零行为变化。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutoSave } from '../../platform-app.jsx';
import { SetGroup, SetRow } from './shared.jsx';
import { MEMORY_PRESETS, MEMORY_PRESET_FIELDS, matchMemoryPreset } from '../../lib/memory-presets.js';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSInput from '@cloudscape-design/components/input';
import CSToggle from '@cloudscape-design/components/toggle';

function MemorySection() {
  const { t } = useTranslation();
  // A6.2: useAutoSave namespace 改为 "memory" 让 save(k, v) 写 memory.k
  const save = useAutoSave(t('settings.nav.memory'), "memory");

  // ── 召回行为字段 ──
  // 初始值 = MemorySettings schema 默认(rpg/schemas/memory.py)。本次记忆修复起
  // recall_depth 5→8、token_budget 800→1600：旧默认装不下 2-3 条 600 字归档摘要，
  // facts/notes 会被摘要挤掉。未保存过偏好时，界面显示必须与后端实际生效值一致。
  const [recallDepth, setRecallDepth] = useStatePL(8);
  const [summaryWindow, setSummaryWindow] = useStatePL(10);
  const [tokenBudget, setTokenBudget] = useStatePL(1600);
  const [autoArchiveAfter, setAutoArchiveAfter] = useStatePL(50);
  // 本次修复：新增两个全局参数，和 per-save 面板保持一致。
  const [tokenEstimateFactor, setTokenEstimateFactor] = useStatePL(1.0);
  const [factsSoftLimit, setFactsSoftLimit] = useStatePL(80);

  // ── 记忆桶配置字段 ──
  const [pinnedMax, setPinnedMax] = useStatePL(20);
  const [bucketPinnedEnabled, setBucketPinnedEnabled] = useStatePL(true);
  const [bucketWorldEnabled, setBucketWorldEnabled] = useStatePL(true);
  const [bucketCharacterEnabled, setBucketCharacterEnabled] = useStatePL(true);
  const [summaryLlmEnabled, setSummaryLlmEnabled] = useStatePL(true);

  // A6.2: loadOrFallback — 读新 key 优先,不存在再读旧 key
  const loadOrFallback = (p, newKey, oldKey) => {
    if (p[newKey] !== undefined && p[newKey] !== null) return p[newKey];
    if (oldKey && p[oldKey] !== undefined && p[oldKey] !== null) return p[oldKey];
    return undefined;
  };

  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const p = (r && r.preferences) || {};
        // A6.2: 读新 key，兼容旧中文 key
        const rd = loadOrFallback(p, "memory.recall_depth", "settings.召回深度");
        if (rd !== undefined) setRecallDepth(Number(rd));
        const sw = loadOrFallback(p, "memory.summary_window", "settings.摘要窗口");
        if (sw !== undefined) setSummaryWindow(Number(sw));
        // pinned_max 同时对应旧 "settings.固定记忆上限"
        const pm = loadOrFallback(p, "memory.pinned_max", "settings.固定记忆上限");
        if (pm !== undefined) setPinnedMax(Number(pm));
        // 新字段 — 无旧 key
        if (p["memory.token_budget"] !== undefined) setTokenBudget(Number(p["memory.token_budget"]));
        if (p["memory.auto_archive_after_turns"] !== undefined) setAutoArchiveAfter(Number(p["memory.auto_archive_after_turns"]));
        // 本次修复：全局也读取/保存两个新参数。
        if (p["memory.token_estimate_factor"] !== undefined) setTokenEstimateFactor(Number(p["memory.token_estimate_factor"]));
        if (p["memory.facts_soft_limit"] !== undefined) setFactsSoftLimit(Number(p["memory.facts_soft_limit"]));
        if (typeof p["memory.bucket_pinned_enabled"] === "boolean") setBucketPinnedEnabled(p["memory.bucket_pinned_enabled"]);
        if (typeof p["memory.bucket_world_enabled"] === "boolean") setBucketWorldEnabled(p["memory.bucket_world_enabled"]);
        if (typeof p["memory.bucket_character_enabled"] === "boolean") setBucketCharacterEnabled(p["memory.bucket_character_enabled"]);
        if (typeof p["memory.summary_llm_enabled"] === "boolean") setSummaryLlmEnabled(p["memory.summary_llm_enabled"]);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const currentPreset = matchMemoryPreset({
    token_budget: tokenBudget,
    token_estimate_factor: tokenEstimateFactor,
    facts_soft_limit: factsSoftLimit,
    summary_window: summaryWindow,
    auto_archive_after_turns: autoArchiveAfter,
    recall_depth: recallDepth,
  });
  const applyPreset = (key) => {
    const p = MEMORY_PRESETS[key];
    if (!p) return;
    setRecallDepth(p.recall_depth);
    setSummaryWindow(p.summary_window);
    setTokenBudget(p.token_budget);
    setAutoArchiveAfter(p.auto_archive_after_turns);
    setTokenEstimateFactor(p.token_estimate_factor);
    setFactsSoftLimit(p.facts_soft_limit);
    MEMORY_PRESET_FIELDS.forEach((field) => save(field, p[field]));
  };

  return (
    <CSSpaceBetween size="l">
      {/* A6.3 — 组 1: 召回行为 */}
      <SetGroup title={t('settings.memory.title_recall')}>
        <SetRow label={t('settings.memory.preset')} description={t('settings.memory.preset_desc')}>
          <div style={{display: "flex", flexWrap: "wrap", gap: 6}}>
            {Object.keys(MEMORY_PRESETS).map((key) => (
              <button key={key} type="button"
                className={`btn ${currentPreset === key ? "" : "ghost"}`}
                style={{fontSize: 12, padding: "4px 10px"}}
                onClick={() => applyPreset(key)}>
                {t(`settings.memory.preset_${key}`)}
              </button>
            ))}
            {currentPreset === "custom" && (
              <span className="muted-2" style={{fontSize: 12, alignSelf: "center"}}>
                {t('settings.memory.preset_custom')}
              </span>
            )}
          </div>
        </SetRow>
        <details style={{marginTop: 6}}>
          <summary className="muted-2" style={{cursor: "pointer", fontSize: 12, padding: "4px 0"}}>
            {t('settings.memory.advanced', { defaultValue: '高级参数' })}
          </summary>
        <SetRow label={t('settings.memory.recall_depth')} description={t('settings.memory.recall_depth_desc')}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <input type="range" min={1} max={20} step={1} value={recallDepth}
              onChange={(e) => setRecallDepth(Number(e.target.value))}
              onMouseUp={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 20) save("recall_depth", n); }}
              onTouchEnd={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 20) save("recall_depth", n); }}
              style={{flex: 1, minWidth: 120}} />
            <input type="number" min={1} max={20} step={1} value={recallDepth}
              onChange={(e) => setRecallDepth(Number(e.target.value))}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 20) save("recall_depth", n); }}
              className="mono" style={{width: 70, textAlign: "right"}} />
          </div>
        </SetRow>
        <SetRow label={t('settings.memory.summary_window')} description={t('settings.memory.summary_window_desc')}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <input type="range" min={1} max={50} step={1} value={summaryWindow}
              onChange={(e) => setSummaryWindow(Number(e.target.value))}
              onMouseUp={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 50) save("summary_window", n); }}
              onTouchEnd={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 50) save("summary_window", n); }}
              style={{flex: 1, minWidth: 120}} />
            <input type="number" min={1} max={50} step={1} value={summaryWindow}
              onChange={(e) => setSummaryWindow(Number(e.target.value))}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 1 && n <= 50) save("summary_window", n); }}
              className="mono" style={{width: 70, textAlign: "right"}} />
          </div>
        </SetRow>
        <SetRow label={t('settings.memory.token_budget')} description={t('settings.memory.token_budget_desc')}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <input type="range" min={200} max={5000} step={50} value={tokenBudget}
              onChange={(e) => setTokenBudget(Number(e.target.value))}
              onMouseUp={(e) => { const n = Number(e.target.value); if (n >= 200 && n <= 5000) save("token_budget", n); }}
              onTouchEnd={(e) => { const n = Number(e.target.value); if (n >= 200 && n <= 5000) save("token_budget", n); }}
              style={{flex: 1, minWidth: 120}} />
            <input type="number" min={200} max={5000} step={50} value={tokenBudget}
              onChange={(e) => setTokenBudget(Number(e.target.value))}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 200 && n <= 5000) save("token_budget", n); }}
              className="mono" style={{width: 70, textAlign: "right"}} />
          </div>
        </SetRow>
        <SetRow label={t('settings.memory.auto_archive')} description={t('settings.memory.auto_archive_desc')}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <input type="range" min={10} max={200} step={5} value={autoArchiveAfter}
              onChange={(e) => setAutoArchiveAfter(Number(e.target.value))}
              onMouseUp={(e) => { const n = Number(e.target.value); if (n >= 10 && n <= 200) save("auto_archive_after_turns", n); }}
              onTouchEnd={(e) => { const n = Number(e.target.value); if (n >= 10 && n <= 200) save("auto_archive_after_turns", n); }}
              style={{flex: 1, minWidth: 120}} />
            <input type="number" min={10} max={200} step={5} value={autoArchiveAfter}
              onChange={(e) => setAutoArchiveAfter(Number(e.target.value))}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 10 && n <= 200) save("auto_archive_after_turns", n); }}
              className="mono" style={{width: 70, textAlign: "right"}} />
          </div>
        </SetRow>
        {/* 本次修复：记忆相关层 token 估算系数；默认 1.0 = 旧 chars//2 行为。 */}
        <SetRow label={t('settings.memory.token_estimate_factor')} description={t('settings.memory.token_estimate_factor_desc')}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <input type="range" min={0.5} max={3} step={0.1} value={tokenEstimateFactor}
              onChange={(e) => setTokenEstimateFactor(Number(e.target.value))}
              onMouseUp={(e) => { const n = Number(e.target.value); if (n >= 0.5 && n <= 3) save("token_estimate_factor", n); }}
              onTouchEnd={(e) => { const n = Number(e.target.value); if (n >= 0.5 && n <= 3) save("token_estimate_factor", n); }}
              style={{flex: 1, minWidth: 120}} />
            <input type="number" min={0.5} max={3} step={0.1} value={tokenEstimateFactor}
              onChange={(e) => setTokenEstimateFactor(Number(e.target.value))}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 0.5 && n <= 3) save("token_estimate_factor", n); }}
              className="mono" style={{width: 70, textAlign: "right"}} />
          </div>
        </SetRow>
        {/* 本次修复：active facts 压力归档软上限。 */}
        <SetRow label={t('settings.memory.facts_soft_limit')} description={t('settings.memory.facts_soft_limit_desc')}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <input type="range" min={20} max={500} step={10} value={factsSoftLimit}
              onChange={(e) => setFactsSoftLimit(Number(e.target.value))}
              onMouseUp={(e) => { const n = Number(e.target.value); if (n >= 20 && n <= 500) save("facts_soft_limit", n); }}
              onTouchEnd={(e) => { const n = Number(e.target.value); if (n >= 20 && n <= 500) save("facts_soft_limit", n); }}
              style={{flex: 1, minWidth: 120}} />
            <input type="number" min={20} max={500} step={10} value={factsSoftLimit}
              onChange={(e) => setFactsSoftLimit(Number(e.target.value))}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 20 && n <= 500) save("facts_soft_limit", n); }}
              className="mono" style={{width: 70, textAlign: "right"}} />
          </div>
        </SetRow>
        </details>
      </SetGroup>

      {/* A6.3 — 组 2: 记忆桶配置 */}
      <SetGroup title={t('settings.memory.title_buckets')}>
        <SetRow label={t('settings.memory.pinned_max')} description={t('settings.memory.pinned_max_desc')}>
          <CSInput type="number" value={String(pinnedMax)}
            onChange={({ detail }) => {
              setPinnedMax(detail.value);
              const n = Number(detail.value);
              if (detail.value !== '' && n >= 5 && n <= 100) save("pinned_max", n);
            }} />
        </SetRow>
        <SetRow label={t('settings.memory.bucket_pinned')} description={t('settings.memory.bucket_pinned_desc')}>
          <CSToggle checked={bucketPinnedEnabled}
            onChange={({ detail }) => { setBucketPinnedEnabled(detail.checked); save("bucket_pinned_enabled", detail.checked); }}>
            {bucketPinnedEnabled ? t('common.enabled') : t('common.disabled')}
          </CSToggle>
        </SetRow>
        <SetRow label={t('settings.memory.bucket_world')} description={t('settings.memory.bucket_world_desc')}>
          <CSToggle checked={bucketWorldEnabled}
            onChange={({ detail }) => { setBucketWorldEnabled(detail.checked); save("bucket_world_enabled", detail.checked); }}>
            {bucketWorldEnabled ? t('common.enabled') : t('common.disabled')}
          </CSToggle>
        </SetRow>
        <SetRow label={t('settings.memory.bucket_character')} description={t('settings.memory.bucket_character_desc')}>
          <CSToggle checked={bucketCharacterEnabled}
            onChange={({ detail }) => { setBucketCharacterEnabled(detail.checked); save("bucket_character_enabled", detail.checked); }}>
            {bucketCharacterEnabled ? t('common.enabled') : t('common.disabled')}
          </CSToggle>
        </SetRow>
        <SetRow label={t('settings.memory.summary_llm')} description={t('settings.memory.summary_llm_desc')}>
          <CSToggle checked={summaryLlmEnabled}
            onChange={({ detail }) => { setSummaryLlmEnabled(detail.checked); save("summary_llm_enabled", detail.checked); }}>
            {summaryLlmEnabled ? t('common.enabled') : t('common.disabled')}
          </CSToggle>
        </SetRow>
      </SetGroup>
    </CSSpaceBetween>
  );
}

export {
  MemorySection,
};
