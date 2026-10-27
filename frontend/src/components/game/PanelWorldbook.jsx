/* 世界书面板(世界书 tab)—— 纯机械从 game-panels.jsx 搬出,零行为变化。 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import { WorldbookOverlaySection } from './WorldbookSections.jsx';
import { InlineEditField } from './InlineEditField.jsx';

function PanelWorldbook({ state }) {
  const { t } = useTranslation();
  // task 33：兜底 world / player / worldline.constraints 缺失
  const w = (state && state.world) || {};
  const p = (state && state.player) || {};
  const saveId = (state && state._raw && state._raw.save_id) || null;
  const tl = (w && w.timeline) || {};
  const constraints = Array.isArray(state && state.worldline && state.worldline.constraints)
    ? state.worldline.constraints : [];
  // 世界事件完整历史（本次展示增强）：state.world.known_events 只保留最近 100 条，
  // 更早事件在 KB kevtc；这里按需查服务端，支持搜索/分页。
  const knownEvents = Array.isArray(w.known_events) ? w.known_events : [];
  const [eventQuery, setEventQuery] = useState("");
  const [eventHistory, setEventHistory] = useState([]);
  const [eventOffset, setEventOffset] = useState(0);
  const [eventTotal, setEventTotal] = useState(0);
  const [eventHasMore, setEventHasMore] = useState(false);
  const [eventLoading, setEventLoading] = useState(false);
  const loadEventHistory = async (offset = 0) => {
    setEventLoading(true);
    const _offset = Math.max(0, Number(offset) || 0);
    try {
      const r = await window.api.game.knownEventsHistoryGet({
        query: eventQuery, offset: _offset, limit: 50,
      });
      setEventHistory((r && r.items) || []);
      setEventTotal((r && r.total) || 0);
      setEventOffset(_offset);
      setEventHasMore(Boolean(r && r.has_more));
    } catch (e) {
      window.__apiToast?.(t('game.worldbook.history_failed', { defaultValue: '历史事件加载失败' }),
        { kind: "danger", detail: e?.message });
    } finally {
      setEventLoading(false);
    }
  };
  // 切换存档时清掉上一个存档的完整历史结果，避免跨档 UI 泄漏。
  useEffect(() => {
    setEventHistory([]);
    setEventOffset(0);
    setEventTotal(0);
    setEventHasMore(false);
    setEventQuery("");
  }, [saveId]);
  // 任意字段写后由 dispatch_ui_tool 自动 _persist_runtime_checkpoint + 回 state;
  // 这里仅 toast 反馈,刷新由 game-state-refresh / state polling 处理(同 memory 模式)。
  const setField = (key, toastMsg) => async (value) => {
    await window.api.game.worldSet({ key, value });
    try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
    window.__apiToast?.(toastMsg + value, { kind: "ok", duration: 1800 });
  };
  return (
    <div className="gp-stack">
      <WorldbookOverlaySection saveId={saveId} />
      <div className="gp-section">
        <div className="section-head">
          <h3>{t('game.worldbook.location_time')}</h3>
          <span className="muted-2" style={{fontSize: 11}}>{t('game.worldbook.click_to_edit')}</span>
        </div>
        <div className="gp-kv">
          <div className="gp-row"><span className="gp-label">{t('game.worldbook.location_label')}</span>
            <InlineEditField value={p.current_location} emptyLabel="—"
              placeholder={t('game.worldbook.location_placeholder')}
              onSubmit={setField("location", t('game.status.location') + " → ")} /></div>
          <div className="gp-row"><span className="gp-label">{t('game.worldbook.time_label')}</span>
            <InlineEditField value={w.time} emptyLabel="—"
              placeholder={t('game.worldbook.time_placeholder')}
              onSubmit={setField("time", t('game.status.time') + " → ")} /></div>
          <div className="gp-row"><span className="gp-label">{t('game.worldbook.weather_label')}</span>
            <InlineEditField value={w.weather} emptyLabel="—"
              placeholder={t('game.worldbook.weather_placeholder')}
              onSubmit={setField("weather", t('game.status.weather') + " → ")} /></div>
          <div className="gp-row"><span className="gp-label">{t('game.worldbook.phase_label')}</span>
            <InlineEditField value={tl.current_phase} emptyLabel="—"
              placeholder={t('game.worldbook.phase_placeholder')}
              onSubmit={setField("phase", t('game.worldbook.phase_label') + " → ")} /></div>
        </div>
      </div>
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.worldbook.world_rules')}</h3><span className="muted-2" style={{fontSize: 11}}>{t('game.worldbook.constraints_count', { count: constraints.length })}</span></div>
        <ul className="gp-flat-list">
          {/* task 48：原代码 constraints.map 之后还硬加一行『灯塔不可在天黑前点燃』示例，
              在导入剧本里完全不相关。删掉。空 constraints 时显示空态。 */}
          {constraints.length === 0 && (
            <li><span className="muted-2">{t('game.worldbook.no_rules')}</span></li>
          )}
          {constraints.map((c, i) => (
            <li key={i}><span><Icon name="lock" size={12} style={{verticalAlign: "-2px", marginRight: 6}} />{typeof c === "string" ? c : (c?.text || c?.label || JSON.stringify(c))}</span></li>
          ))}
        </ul>
      </div>
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.worldbook.known_events')}</h3></div>
        {/* task 48：原硬编码 8 个 chip（雾港/残页/黑铁怀表/沈知微/韩司直/阿衡/北港/灯塔）
            完全不顾当前剧本/state。改为从 state.world.known_events 派生；空就空态。 */}
        <div className="gp-chips">
          {knownEvents.length > 0
            ? knownEvents.map((ev, i) => (
                <span key={i} className="gp-chip">{typeof ev === "string" ? ev : (ev?.label || ev?.text || JSON.stringify(ev))}</span>
              ))
            : <span className="muted-2" style={{fontSize: 12}}>{t('game.worldbook.known_events_empty')}</span>}
        </div>
        {knownEvents.length >= 100 && (
          <p className="muted-2" style={{fontSize: 11, margin: "6px 0 0"}}>
            {t('game.worldbook.known_events_capped', {
              defaultValue: '状态只保留最近 100 条；更早事件可查完整历史。',
            })}
          </p>
        )}
        <div style={{display: "flex", gap: 6, marginTop: 8}}>
          <input className="mono" value={eventQuery}
            placeholder={t('game.worldbook.event_search', { defaultValue: '搜索世界事件' })}
            onChange={(e) => { setEventQuery(e.target.value); setEventOffset(0); }}
            style={{flex: 1, padding: "4px 6px", fontSize: 12}} />
          <button className="btn ghost" style={{fontSize: 12, padding: "4px 8px"}}
            disabled={eventLoading} onClick={() => loadEventHistory(0)}>
            {t('game.worldbook.event_search_btn', { defaultValue: '查更早事件' })}
          </button>
        </div>
        {eventHistory.length > 0 && (
          <div style={{marginTop: 8}}>
            <div className="muted-2" style={{fontSize: 11, marginBottom: 4}}>
              {t('game.worldbook.event_history_count', {
                defaultValue: '完整历史（{{count}} 条）', count: eventTotal,
              })}
            </div>
            <ul className="gp-flat-list">
              {eventHistory.map((ev, i) => (
                <li key={`evh-${eventOffset}-${i}`}><span>{ev}</span></li>
              ))}
            </ul>
            {(eventOffset > 0 || eventHasMore) && (
              <div style={{display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, fontSize: 12}}>
                <button className="btn ghost" style={{padding: "2px 8px"}}
                  disabled={eventLoading || eventOffset <= 0}
                  onClick={() => loadEventHistory(Math.max(0, eventOffset - 50))}>‹</button>
                <span className="muted-2">{eventOffset + 1}-{eventOffset + eventHistory.length}</span>
                <button className="btn ghost" style={{padding: "2px 8px"}}
                  disabled={eventLoading || !eventHasMore}
                  onClick={() => loadEventHistory(eventOffset + 50)}>›</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { PanelWorldbook };
