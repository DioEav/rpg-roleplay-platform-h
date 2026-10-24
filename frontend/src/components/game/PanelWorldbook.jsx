/* 世界书面板(世界书 tab)—— 纯机械从 game-panels.jsx 搬出,零行为变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import { WorldbookOverlaySection } from './WorldbookSections.jsx';
import { InlineEditField } from './InlineEditField.jsx';

function PanelWorldbook({ state }) {
  const { t } = useTranslation();
  // task 33：兜底 world / player / worldline.constraints 缺失
  const w = (state && state.world) || {};
  const p = (state && state.player) || {};
  const tl = (w && w.timeline) || {};
  const constraints = Array.isArray(state && state.worldline && state.worldline.constraints)
    ? state.worldline.constraints : [];
  // 任意字段写后由 dispatch_ui_tool 自动 _persist_runtime_checkpoint + 回 state;
  // 这里仅 toast 反馈,刷新由 game-state-refresh / state polling 处理(同 memory 模式)。
  const setField = (key, toastMsg) => async (value) => {
    await window.api.game.worldSet({ key, value });
    try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
    window.__apiToast?.(toastMsg + value, { kind: "ok", duration: 1800 });
  };
  return (
    <div className="gp-stack">
      <WorldbookOverlaySection />
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
          {Array.isArray(w.known_events) && w.known_events.length > 0
            ? w.known_events.map((ev, i) => (
                <span key={i} className="gp-chip">{typeof ev === "string" ? ev : (ev?.label || ev?.text || JSON.stringify(ev))}</span>
              ))
            : <span className="muted-2" style={{fontSize: 12}}>{t('game.worldbook.known_events_empty')}</span>}
        </div>
      </div>
    </div>
  );
}

export { PanelWorldbook };
