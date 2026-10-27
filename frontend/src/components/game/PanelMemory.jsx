/* 记忆面板(记忆 tab)。原为 game-panels.jsx 机械搬出;
   现新增:「本轮实际注入」标注 / 历史概要区 / 已归档事实计数。
   注入标注依据 memory.last_memory_injection —— 后端 MemoryProvider.collect 每轮
   把「长期记忆」层实际注入原文(含预算/深度裁剪后真正进 prompt 的行)写入该字段。
   面板展示的桶是全量,与实际注入不必一致 —— 徽章就是为了把这个差补上。
   ⚠️不能读 memory.last_retrieval:那是小说检索层(novel_retrieval/RAG)的文本,
   从不含记忆层行(模组场景甚至是空串),拿它当数据源徽章/计数恒为 0。
   注意:pinned/notes/facts 各自独立渲染路径(历史病灶),逐字复制,勿统一。 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import { ForcedSetSection } from './ForcedSetSection.jsx';

function PanelMemory({ state, density }) {
  const { t } = useTranslation();
  const m = state.memory;
  // 本存档记忆设置（本次记忆修复）: GET /api/memory/settings 返回 global/overrides/effective。
  // 表单只提交 dirty 字段——没改的字段继续保持「跟随全局」，不会被本存档冻结。
  const [saveSettings, setSaveSettings] = useState(null);
  const [settingsForm, setSettingsForm] = useState({});
  const [settingsDirty, setSettingsDirty] = useState({});
  const [settingsSaving, setSettingsSaving] = useState(false);
  // 本次记忆修复：非法值不再静默回弹，后端把 {字段: 原因} 回给前端逐项展示。
  const [settingsErrors, setSettingsErrors] = useState({});
  // 历史记忆面板（本次记忆修复）：搜索 + 状态筛选 + 分页。数据来自 state，
  // 纯前端过滤，不再一次性把上千条历史全渲染出来。
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");
  const [historyPage, setHistoryPage] = useState(0);
  // 冷归档搜索（本次记忆修复）：热历史只在 state 里保留最近 1000 条，更早的
  // 需要走服务端 /api/memory/history 查 KB afactc。
  const [coldHistory, setColdHistory] = useState([]);
  const [coldTotal, setColdTotal] = useState(0);
  const [coldOffset, setColdOffset] = useState(0);
  const [coldHasMore, setColdHasMore] = useState(false);
  const [coldLoading, setColdLoading] = useState(false);
  const HISTORY_PAGE_SIZE = 10;
  const loadSettings = async () => {
    try {
      const r = await window.api.game.memorySettingsGet();
      setSaveSettings(r || null);
      setSettingsForm((r && r.effective) || {});
      setSettingsDirty({});
      setSettingsErrors({});
    } catch (_) {
      setSaveSettings(null);
    }
  };
  useEffect(() => { loadSettings(); }, []);
  const updateSetting = (key, value) => {
    setSettingsForm((prev) => ({ ...prev, [key]: value }));
    setSettingsDirty((prev) => ({ ...prev, [key]: true }));
    setSettingsErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  const _applySettingsResponse = (r) => {
    setSaveSettings(r || null);
    setSettingsForm((r && r.effective) || {});
    setSettingsDirty({});
    setSettingsErrors((r && r.errors) || {});
  };
  const saveSettingsPatch = async () => {
    const patch = {};
    Object.keys(settingsDirty).forEach((k) => { patch[k] = settingsForm[k]; });
    if (!Object.keys(patch).length) return;
    setSettingsSaving(true);
    try {
      const r = await window.api.game.memorySettingsSet({ settings: patch });
      _applySettingsResponse(r);
      const errs = (r && r.errors) || {};
      const errKeys = Object.keys(errs);
      if (errKeys.length) {
        window.__apiToast?.(
          t('game.memory.settings_partial', {
            defaultValue: '部分设置未保存：{{items}}',
            items: errKeys.map((k) => `${k}: ${errs[k]}`).join('；'),
          }),
          { kind: 'danger', detail: errKeys.join(', ') },
        );
      } else {
        window.__apiToast?.(t('game.memory.settings_saved', { defaultValue: '已保存到本存档' }), { kind: 'ok' });
      }
    } catch (e) {
      window.__apiToast?.(t('game.memory.settings_failed', { defaultValue: '记忆设置保存失败' }), { kind: 'danger', detail: e?.message });
    } finally {
      setSettingsSaving(false);
    }
  };
  const resetField = async (key) => {
    setSettingsSaving(true);
    try {
      const r = await window.api.game.memorySettingsSet({ unset: [key] });
      _applySettingsResponse(r);
      window.__apiToast?.(
        t('game.memory.settings_follow_global_done', { defaultValue: '该字段已恢复跟随全局' }),
        { kind: 'ok' },
      );
    } catch (e) {
      window.__apiToast?.(t('game.memory.settings_failed', { defaultValue: '记忆设置保存失败' }), { kind: 'danger', detail: e?.message });
    } finally {
      setSettingsSaving(false);
    }
  };
  const resetSettings = async () => {
    setSettingsSaving(true);
    try {
      const r = await window.api.game.memorySettingsSet({ reset: true });
      _applySettingsResponse(r);
      window.__apiToast?.(t('game.memory.settings_reset_done', { defaultValue: '已恢复为跟随全局' }), { kind: 'ok' });
    } catch (e) {
      window.__apiToast?.(t('game.memory.settings_failed', { defaultValue: '记忆设置保存失败' }), { kind: 'danger', detail: e?.message });
    } finally {
      setSettingsSaving(false);
    }
  };
  const lastInjection = m.last_memory_injection || "";
  const isInjected = (txt) => !!txt && lastInjection.includes(txt);
  const restoreMemory = async (body) => {
    try {
      let r = await window.api.game.memoryRestore(body);
      if (r && r.needs_confirmation) {
        // 本次记忆修复：恢复会与当前版本冲突时，先让用户确认；确认后把当前
        // 相似/直接替代版本标 superseded，避免两个矛盾事实同时 active。
        const conflicts = (r.conflicts || []).map((c) => `· ${c.text}`).join('\n');
        const ok = await window.__confirm({
          message: t('game.memory.restore_conflict_confirm', {
            defaultValue: '恢复这条旧事实会取代当前相似版本：\n{{items}}\n\n继续？',
            items: conflicts,
          }),
          danger: true,
        });
        if (!ok) return;
        r = await window.api.game.memoryRestore({ ...body, supersede_conflicts: true });
      }
      try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
      const n = (r && r.superseded_conflicts) || 0;
      window.__apiToast?.(
        n
          ? t('game.memory.restore_done_with_conflicts', {
            defaultValue: '已恢复，并取代 {{count}} 条当前版本', count: n,
          })
          : t('game.memory.restore_done', { defaultValue: '已恢复到当前记忆' }),
        { kind: 'ok' },
      );
    } catch (e) {
      window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message });
    }
  };
  const searchColdHistory = async (offset = 0) => {
    setColdLoading(true);
    const _offset = Math.max(0, Number(offset) || 0);
    try {
      const r = await window.api.game.memoryHistoryGet({
        query: historyQuery,
        status: historyFilter === "all" ? "" : historyFilter,
        offset: _offset,
        limit: 50,
      });
      setColdHistory((r && r.items) || []);
      setColdTotal((r && r.cold_total) || 0);
      setColdOffset(_offset);
      setColdHasMore(Boolean(r && r.has_more));
    } catch (e) {
      window.__apiToast?.(t('game.memory.action_failed'), { kind: 'danger', detail: e?.message });
    } finally {
      setColdLoading(false);
    }
  };
  // 「已注入」徽章:绿色对勾,悬停看说明。行内字符不改动条目布局(三条渲染路径共用)。
  const InjectedBadge = () => (
    <span data-tip={t('game.memory.injected_tip', { defaultValue: '本轮实际注入给 GM 的上下文中' })}
      data-tip-pos="left" aria-label={t('game.memory.injected_badge', { defaultValue: '已注入' })}
      style={{ color: "var(--ok, #7eb88e)", fontSize: 11, marginLeft: 4, whiteSpace: "nowrap", flexShrink: 0 }}>
      ✓
    </span>
  );
  // 检索区计数 = 本轮注入的「长期记忆」行数,按记忆行前缀过滤
  // (last_memory_injection 就是记忆层自己的文本,过滤只为排除占位行)。
  const _MEM_LINE_PREFIXES = [
    "固定记忆：", "概要：", "事实：", "笔记：", "能力：", "资源：",
    "相关记忆：", "相关笔记：", "主线：", "当前目标：", "篇章：", "未确认推测：", "【记忆优先级",
  ];
  const injectedCount = lastInjection
    ? lastInjection.split("\n").filter((l) => _MEM_LINE_PREFIXES.some((p) => l.startsWith(p))).length
    : 0;
  // 已归档事实计数：优先用 archived_facts 索引（本次记忆修复：归档原文保留在
  // 远期存档里，可经「长局相关往事召回」找回）；旧存档回退 items 的 archived 计数。
  const archivedFactsCount = (m.archived_facts || []).length || (m.items || []).filter(
    (it) => it && typeof it === "object" && it.legacy_bucket === "facts" && it.archived
  ).length;
  // 历史记忆（本次记忆修复）：面板可查看并恢复已归档/已取代条目。只展示事实类
  // runtime_fact，不把 confirmed/rejected 的推测链混进来（避免把废案恢复成事实）。
  const _HISTORY_BUCKETS = new Set(["facts", "notes", "pinned", "abilities", "resources"]);
  const _historyItems = (m.items || []).filter(
    (it) => it && typeof it === "object"
      && _HISTORY_BUCKETS.has(it.legacy_bucket)
      && it.kind === "runtime_fact"
  );
  const supersededItems = _historyItems
    .filter((it) => !it.archived && it.status === "superseded")
    .reverse();
  const archivedItems = _historyItems
    .filter((it) => it.archived)
    .reverse();
  // 去重要用“全部 archived item 文本”，不能用仅展示的最近 20 条；否则更早的
  // archived item 会又被 archived_facts 索引重复列一遍。
  const _archivedItemTexts = new Set(
    _historyItems.filter((it) => it.archived).map((it) => it.text)
  );
  const archivedIndexOnly = (m.archived_facts || [])
    .filter((txt) => txt && !_archivedItemTexts.has(txt))
    .reverse();
  const _historyEntries = [
    ...supersededItems.map((it) => ({
      kind: "superseded", id: it.id, text: it.text,
      turn: it.superseded_at_turn, payload: { id: it.id },
    })),
    ...archivedItems.map((it) => ({
      kind: "archived", id: it.id, text: it.text,
      turn: it.turn, payload: { id: it.id },
    })),
    ...archivedIndexOnly.map((txt) => ({
      kind: "archived", id: null, text: txt, turn: null,
      payload: { bucket: "facts", text: txt },
    })),
  ];
  const _historyQ = historyQuery.trim().toLowerCase();
  const _filteredHistory = _historyEntries.filter((e) => {
    if (historyFilter !== "all" && e.kind !== historyFilter) return false;
    if (_historyQ && !String(e.text || "").toLowerCase().includes(_historyQ)) return false;
    return true;
  });
  const _historyTotal = _filteredHistory.length;
  const _historyPageCount = Math.max(1, Math.ceil(_historyTotal / HISTORY_PAGE_SIZE));
  const _historyPageSafe = Math.min(historyPage, _historyPageCount - 1);
  const _historyPageItems = _filteredHistory.slice(
    _historyPageSafe * HISTORY_PAGE_SIZE,
    (_historyPageSafe + 1) * HISTORY_PAGE_SIZE,
  );
  const _historyTextSet = new Set(_historyEntries.map((e) => e.text));
  const _coldOnly = coldHistory.filter((e) => e && !_historyTextSet.has(e.text));
  const summaries = m.summaries || [];
  return (
    <div className="gp-stack">
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.memory.current_objective')}</h3><span className="pill">{t('game.memory.main_quest_pill')}</span></div>
        <p className="serif gp-quest">{m.main_quest}</p>
        <p className="muted" style={{fontSize: 13, marginTop: 6}}>{m.current_objective}</p>
      </div>

      <ForcedSetSection state={state} />

      {saveSettings && (
        <div className="gp-section">
          <div className="section-head">
            <h3>{t('game.memory.settings_title', { defaultValue: '本存档记忆设置' })}
              <span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>
                {t('game.memory.settings_subtitle', { defaultValue: '未改的项跟随全局' })}
              </span>
            </h3>
            {Object.keys(saveSettings.overrides || {}).length > 0 && (
              <span className="pill mono">{Object.keys(saveSettings.overrides || {}).length}</span>
            )}
          </div>
          <div style={{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8}}>
            {[
              ["recall_depth", t('game.memory.settings_recall_depth', { defaultValue: '召回深度' }), 1, 20],
              ["token_budget", t('game.memory.settings_token_budget', { defaultValue: '每轮 token' }), 200, 5000],
              ["token_estimate_factor", t('game.memory.settings_token_factor', { defaultValue: 'token 估算系数' }), 0.5, 3, 0.1],
              ["pinned_max", t('game.memory.settings_pinned_max', { defaultValue: '固定记忆上限' }), 5, 100],
              ["summary_window", t('game.memory.settings_summary_window', { defaultValue: '归档扫描周期' }), 1, 50],
              ["auto_archive_after_turns", t('game.memory.settings_auto_archive', { defaultValue: '自动归档轮数' }), 10, 200],
              ["facts_soft_limit", t('game.memory.settings_facts_soft_limit', { defaultValue: '事实软上限' }), 20, 500],
            ].map(([key, label, min, max, step]) => (
              <label key={key} style={{fontSize: 12, display: "flex", flexDirection: "column", gap: 4}}>
                <span className="muted-2" style={{display: "flex", alignItems: "center", gap: 4}}>
                  {label}
                  {saveSettings?.overrides && saveSettings.overrides[key] !== undefined && (
                    <button type="button" className="iconbtn"
                      data-tip={t('game.memory.settings_follow_global', { defaultValue: '跟随全局' })}
                      aria-label={t('game.memory.settings_follow_global', { defaultValue: '跟随全局' })}
                      disabled={settingsSaving}
                      onClick={() => resetField(key)}>↺</button>
                  )}
                </span>
                <input type="number" className="mono" min={min} max={max} step={step || 1}
                  value={settingsForm[key] ?? ""}
                  onChange={(e) => updateSetting(key, e.target.value === "" ? "" : Number(e.target.value))}
                  style={{width: "100%", padding: "4px 6px"}} />
                {settingsErrors[key] && (
                  <span style={{color: "var(--danger, #c66)", fontSize: 11}}>{settingsErrors[key]}</span>
                )}
              </label>
            ))}
          </div>
          <div style={{display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, fontSize: 12}}>
            {[
              ["bucket_pinned_enabled", t('game.memory.settings_bucket_pinned', { defaultValue: '固定记忆桶' })],
              ["bucket_world_enabled", t('game.memory.settings_bucket_world', { defaultValue: '世界记忆桶' })],
              ["bucket_character_enabled", t('game.memory.settings_bucket_character', { defaultValue: '角色记忆桶' })],
              ["summary_llm_enabled", t('game.memory.settings_summary_llm', { defaultValue: 'LLM 精修摘要' })],
            ].map(([key, label]) => (
              <label key={key} style={{display: "flex", alignItems: "center", gap: 4}}>
                <input type="checkbox" checked={!!settingsForm[key]}
                  onChange={(e) => updateSetting(key, e.target.checked)} />
                <span>{label}</span>
                {saveSettings?.overrides && saveSettings.overrides[key] !== undefined && (
                  <button type="button" className="iconbtn"
                    data-tip={t('game.memory.settings_follow_global', { defaultValue: '跟随全局' })}
                    aria-label={t('game.memory.settings_follow_global', { defaultValue: '跟随全局' })}
                    disabled={settingsSaving}
                    onClick={() => resetField(key)}>↺</button>
                )}
                {settingsErrors[key] && (
                  <span style={{color: "var(--danger, #c66)", fontSize: 11}}>{settingsErrors[key]}</span>
                )}
              </label>
            ))}
          </div>
          <div style={{display: "flex", gap: 8, marginTop: 8}}>
            <button className="btn ghost" style={{fontSize: 12, padding: "4px 10px"}}
              disabled={settingsSaving || !Object.keys(settingsDirty).length}
              onClick={saveSettingsPatch}>
              {t('game.memory.settings_save', { defaultValue: '保存到本存档' })}
            </button>
            <button className="btn ghost" style={{fontSize: 12, padding: "4px 10px"}}
              disabled={settingsSaving || !Object.keys(saveSettings.overrides || {}).length}
              onClick={resetSettings}>
              {t('game.memory.settings_reset', { defaultValue: '恢复跟随全局' })}
            </button>
          </div>
        </div>
      )}

      <div className="gp-section">
        <div className="section-head">
          <h3>{t('game.memory.pinned')}<span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>{t('game.memory.pinned_subtitle')}</span></h3>
          <button className="iconbtn" data-tip={t('game.memory.add_pinned_tip')} data-tip-pos="below" aria-label={t('game.memory.add_pinned_tip')}
            onClick={async () => {
              const txt = await window.__prompt({ title: t('game.memory.add_pinned_prompt') });
              if (!txt) return;
              // bucket=pinned(后端 Pydantic 字段名,旧版误用 kind 被 extra='ignore' 吞掉
              // 实际全落 notes 桶,等于固定记忆按钮一直在加到笔记 — 现修)
              try { await window.api.game.memoryAdd({ bucket: "pinned", text: txt }); try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {} window.__apiToast?.(t('game.memory.added_ok'), { kind: "ok" }); }
              catch (e) { window.__apiToast?.(t('game.memory.add_failed'), { kind: "danger", detail: e?.message }); }
            }}>
            <Icon name="plus" />
          </button>
        </div>
        <ul className="gp-pin-list">
          {(m.pinned || []).map((item, i) => (
            <li key={i}>
              <span className="gp-pin-mark"><Icon name="pin" size={12} /></span>
              <span className="serif">{item}{isInjected(item) && <InjectedBadge />}</span>
              <button className="iconbtn" data-tip={t('game.memory.unpin_tip')} aria-label={t('game.memory.unpin_tip')}
                onClick={async () => {
                  if (!await window.__confirm({ message: t('game.memory.unpin_confirm'), danger: true })) return;
                  try { await window.api.game.memoryRemove({ bucket: "pinned", index: i }); try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {} window.__apiToast?.(t('game.memory.unpinned_ok'), { kind: "ok" }); }
                  catch (e) { window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message }); }
                }}>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {summaries.length > 0 && (
        <div className="gp-section">
          <div className="section-head"><h3>{t('game.memory.summaries', { defaultValue: '历史概要' })}<span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>{t('game.memory.summaries_subtitle', { defaultValue: '已归档事实的压缩版 · 仍会注入' })}</span></h3></div>
          <ul className="gp-flat-list">
            {summaries.map((s, i) => (<li key={i}><span className="muted-2">{s}</span></li>))}
          </ul>
        </div>
      )}

      <div className="gp-section">
        <div className="section-head"><h3>{t('game.memory.facts')}<span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>{t('game.memory.facts_subtitle')}</span></h3></div>
        <ul className="gp-flat-list">
          {(m.facts || []).map((item, i) => (
            <li key={i} style={{display: "flex", alignItems: "center", gap: 6}}>
              <span style={{flex: 1}}>{item}{isInjected(item) && <InjectedBadge />}</span>
              <button className="iconbtn" data-tip={t('game.memory.pin_fact_tip', { defaultValue: '固定为长期记忆' })}
                aria-label={t('game.memory.pin_fact_tip', { defaultValue: '固定为长期记忆' })}
                onClick={async () => {
                  try {
                    await window.api.game.memoryAdd({ bucket: "pinned", text: item });
                    try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
                    window.__apiToast?.(t('game.memory.pinned_ok', { defaultValue: '已固定' }), { kind: "ok" });
                  } catch (e) {
                    window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message });
                  }
                }}>
                <Icon name="pin" size={12} />
              </button>
              <button className="iconbtn" data-tip={t('game.memory.edit_fact_tip', { defaultValue: '编辑这条事实' })}
                aria-label={t('game.memory.edit_fact_tip', { defaultValue: '编辑这条事实' })}
                onClick={async () => {
                  const txt = await window.__prompt({
                    title: t('game.memory.edit_fact_prompt', { defaultValue: '编辑事实' }),
                    default: item,
                  });
                  if (txt == null || !txt.trim() || txt === item) return;
                  try {
                    await window.api.game.memoryUpdate({ bucket: "facts", index: i, text: txt });
                    try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
                    window.__apiToast?.(t('game.memory.saved_ok', { defaultValue: '已保存' }), { kind: "ok" });
                  } catch (e) {
                    window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message });
                  }
                }}>
                <Icon name="edit" size={12} />
              </button>
              <button className="iconbtn" data-tip={t('game.memory.delete_fact_tip', { defaultValue: '删除这条事实' })}
                aria-label={t('game.memory.delete_fact_tip', { defaultValue: '删除这条事实' })}
                onClick={async () => {
                  if (!await window.__confirm({
                    message: t('game.memory.delete_fact_confirm', { defaultValue: '删除这条事实？' }),
                    danger: true,
                  })) return;
                  try {
                    await window.api.game.memoryRemove({ bucket: "facts", index: i });
                    try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
                    window.__apiToast?.(t('game.memory.deleted_ok'), { kind: "ok" });
                  } catch (e) {
                    window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message });
                  }
                }}>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
        {archivedFactsCount > 0 && (
          <p className="muted-2" style={{fontSize: 12, margin: "6px 0 0"}}>{t('game.memory.archived_note', { count: archivedFactsCount, defaultValue: '另有 {{count}} 条早期事实已自动归档（保存在存档中，不再注入）' })}</p>
        )}
      </div>

      {(_historyEntries.length > 0 || archivedFactsCount > 0 || coldHistory.length > 0) && (
        <div className="gp-section">
          <div className="section-head">
            <h3>{t('game.memory.history_title', { defaultValue: '历史记忆' })}
              <span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>
                {t('game.memory.history_subtitle', { defaultValue: '已归档 / 已取代，不会再注入；可恢复' })}
              </span>
            </h3>
            <span className="pill mono">{_historyTotal}</span>
          </div>
          <div style={{display: "flex", gap: 6, marginBottom: 8}}>
            <input className="mono" value={historyQuery}
              placeholder={t('game.memory.history_search', { defaultValue: '搜索历史记忆' })}
              onChange={(e) => { setHistoryQuery(e.target.value); setHistoryPage(0); }}
              style={{flex: 1, padding: "4px 6px", fontSize: 12}} />
            <select className="mono" value={historyFilter} disabled={settingsSaving}
              onChange={(e) => { setHistoryFilter(e.target.value); setHistoryPage(0); }}
              style={{padding: "4px 6px", fontSize: 12}}>
              <option value="all">{t('game.memory.history_filter_all', { defaultValue: '全部' })}</option>
              <option value="superseded">{t('game.memory.history_superseded', { defaultValue: '已取代' })}</option>
              <option value="archived">{t('game.memory.history_archived', { defaultValue: '已归档' })}</option>
            </select>
            <button className="btn ghost" style={{fontSize: 12, padding: "4px 8px"}}
              disabled={coldLoading}
              onClick={() => searchColdHistory(0)}>
              {t('game.memory.history_cold_search', { defaultValue: '查更早归档' })}
            </button>
          </div>
          <ul className="gp-flat-list">
            {_historyPageItems.map((e, i) => (
              <li key={`${e.kind}-${e.id || e.text}-${i}`} style={{display: "flex", alignItems: "center", gap: 6}}>
                <span style={{flex: 1}}>
                  <span className="muted-2" style={{fontSize: 11, marginRight: 4}}>
                    {e.kind === "superseded"
                      ? t('game.memory.history_superseded', { defaultValue: '已取代' })
                      : t('game.memory.history_archived', { defaultValue: '已归档' })}
                    {e.turn ? ` · T${e.turn}` : ""}
                  </span>
                  {e.text}
                </span>
                <button className="iconbtn" data-tip={t('game.memory.restore_tip', { defaultValue: '恢复为当前事实' })}
                  aria-label={t('game.memory.restore_tip', { defaultValue: '恢复为当前事实' })}
                  onClick={() => restoreMemory(e.payload)}>
                  <Icon name="refresh" size={12} />
                </button>
              </li>
            ))}
          </ul>
          {_historyTotal === 0 && (
            <p className="muted-2" style={{fontSize: 12, margin: "4px 0 0"}}>
              {t('game.memory.history_no_match', { defaultValue: '没有匹配的历史记忆' })}
            </p>
          )}
          {_historyPageCount > 1 && (
            <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, fontSize: 12}}>
              <button className="btn ghost" style={{padding: "2px 8px"}}
                disabled={_historyPageSafe <= 0}
                onClick={() => setHistoryPage(Math.max(0, _historyPageSafe - 1))}>‹</button>
              <span className="muted-2">{_historyPageSafe + 1} / {_historyPageCount}</span>
              <button className="btn ghost" style={{padding: "2px 8px"}}
                disabled={_historyPageSafe >= _historyPageCount - 1}
                onClick={() => setHistoryPage(Math.min(_historyPageCount - 1, _historyPageSafe + 1))}>›</button>
            </div>
          )}
          {_coldOnly.length > 0 && (
            <div style={{marginTop: 10}}>
              <div className="muted-2" style={{fontSize: 11, marginBottom: 4}}>
                {t('game.memory.history_cold_results', {
                  defaultValue: '更早的冷归档（KB · {{count}} 条）', count: coldTotal,
                })}
              </div>
              <ul className="gp-flat-list">
                {_coldOnly.map((e, i) => (
                  <li key={`cold-${e.id || e.text}-${i}`} style={{display: "flex", alignItems: "center", gap: 6}}>
                    <span style={{flex: 1}}>
                      <span className="muted-2" style={{fontSize: 11, marginRight: 4}}>
                        {t('game.memory.history_cold', { defaultValue: '冷归档' })}
                      </span>
                      {e.text}
                    </span>
                    <button className="iconbtn" data-tip={t('game.memory.restore_tip', { defaultValue: '恢复为当前事实' })}
                      aria-label={t('game.memory.restore_tip', { defaultValue: '恢复为当前事实' })}
                      onClick={() => restoreMemory(e.id ? { id: e.id } : { bucket: "facts", text: e.text })}>
                      <Icon name="refresh" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
              {(coldOffset > 0 || coldHasMore) && (
                <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, fontSize: 12}}>
                  <button className="btn ghost" style={{padding: "2px 8px"}}
                    disabled={coldLoading || coldOffset <= 0}
                    onClick={() => searchColdHistory(Math.max(0, coldOffset - 50))}>‹</button>
                  <span className="muted-2">
                    {coldOffset + 1}-{coldOffset + coldHistory.length}
                  </span>
                  <button className="btn ghost" style={{padding: "2px 8px"}}
                    disabled={coldLoading || !coldHasMore}
                    onClick={() => searchColdHistory(coldOffset + 50)}>›</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="gp-section">
        <div className="section-head"><h3>{t('game.memory.notes')}</h3>
          <button className="iconbtn" data-tip={t('game.memory.add_note_tip')} data-tip-pos="below"
            onClick={async () => {
              const txt = await window.__prompt({ title: t('game.memory.add_note_prompt') });
              if (!txt) return;
              try { await window.api.game.memoryAdd({ bucket: "notes", text: txt }); try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {} window.__apiToast?.(t('game.memory.added_ok'), { kind: "ok" }); }
              catch (e) { window.__apiToast?.(t('game.memory.add_failed'), { kind: "danger", detail: e?.message }); }
            }}>
            <Icon name="plus" />
          </button>
        </div>
        <ul className="gp-flat-list">
          {(m.notes || []).map((item, i) => (
            <li key={i} style={{display: "flex", alignItems: "center", gap: 6}}>
              <span style={{flex: 1}}>{item}{isInjected(item) && <InjectedBadge />}</span>
              <button className="iconbtn" data-tip={t('game.memory.edit_note_tip', { defaultValue: '编辑这条' })}
                onClick={async () => {
                  // 就地编辑(原来只能删了重加 — 群反馈 行者无疆):预填当前文本,改完直接覆盖该条。
                  const txt = await window.__prompt({ title: t('game.memory.edit_note_prompt', { defaultValue: '编辑笔记' }), default: item });
                  if (txt == null || !txt.trim() || txt === item) return;
                  try { await window.api.game.memoryUpdate({ bucket: "notes", index: i, text: txt }); try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {} window.__apiToast?.(t('game.memory.saved_ok', { defaultValue: '已保存' }), { kind: "ok" }); }
                  catch (e) { window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message }); }
                }}>
                <Icon name="edit" size={12} />
              </button>
              <button className="iconbtn" data-tip={t('game.memory.delete_note_tip')}
                onClick={async () => {
                  if (!await window.__confirm({ message: t('game.memory.delete_note_confirm'), danger: true })) return;
                  try { await window.api.game.memoryRemove({ bucket: "notes", index: i }); try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {} window.__apiToast?.(t('game.memory.deleted_ok'), { kind: "ok" }); }
                  catch (e) { window.__apiToast?.(t('game.memory.action_failed'), { kind: "danger", detail: e?.message }); }
                }}>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="gp-section">
        <div className="section-head">
          <h3>{t('game.memory.retrieval')}<span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>{t('game.memory.retrieval_subtitle')}</span></h3>
          <span className="pill mono">{t('game.memory.retrieval_chunks', { count: injectedCount })}</span>
        </div>
        <pre className="gp-quote">{lastInjection || t('game.memory.retrieval_empty')}</pre>
      </div>
    </div>
  );
}

export { PanelMemory };
