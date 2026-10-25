/* Game Console 历史回顾 / 搜索本档抽屉(HistoryDrawer / SearchDrawer)——
   纯机械从 game-app.jsx 搬出,DOM/视觉/行为零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useState as useStateA, useMemo as useMemoA } from 'react';
import { Icon } from '../../game-icons.jsx';
import { stripNarrativeOps } from '../../narrative-strip.js';

// ---------------------- 历史回顾 / 搜索本档 抽屉 -------------------------
// task 9：之前 TopBar 两个按钮一个空实现、一个 state 设了但没渲染。
// 这里用同一套 pl-modal-backdrop 风格做两个 portal-mount 抽屉。
// 数据源：history（来自 setHistory）、state.memory、state.world，本地纯前端检索。
// 后续后端给出全文搜索接口时，可在 SearchDrawer 内挂 await 调用替换 localSearch。

function HistoryDrawer({ open, history, onClose }) {
  const { t } = useTranslation();
  // Esc 关闭
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const items = Array.isArray(history) ? history : [];
  const node = (
    <div className="pl-modal-backdrop" onClick={onClose} role="dialog" aria-label={t('game.app.history.aria_label')}>
      <div className="pl-modal" onClick={(e) => e.stopPropagation()} style={{width: "min(720px, 100%)", maxHeight: "80vh", display: "flex", flexDirection: "column"}}>
        <header className="pl-modal-head">
          <div>
            <div className="pl-modal-eyebrow">{t('game.app.history.eyebrow', { count: items.length })}</div>
            <h2 className="pl-modal-title">{t('game.app.history.title')}</h2>
          </div>
          <button className="iconbtn" onClick={onClose} data-tip={t('common.close')} aria-label={t('common.close')}><Icon name="close" size={14} /></button>
        </header>
        <div className="pl-modal-form" style={{overflow: "auto", paddingTop: 8}}>
          {items.length === 0 ? (
            <div className="muted" style={{padding: "32px 8px", textAlign: "center", fontSize: 13}}>
              {t('game.app.history.empty')}
            </div>
          ) : items.map((h, i) => (
            <div key={`hist-${i}`} className="pl-setting-row" style={{alignItems: "flex-start", gap: 12, padding: "10px 4px", borderBottom: "1px solid var(--line-soft, #eee)"}}>
              <div style={{minWidth: 64, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted-2, #999)"}}>
                {h && h.ts ? h.ts : `#${i + 1}`}
              </div>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontSize: 11, color: "var(--muted, #777)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em"}}>
                  {h && h.role === "assistant" ? "GM" : (h && h.role === "user" ? t('game.app.narrative.player') : (h && h.role) || "—")}
                </div>
                <div className="serif" style={{fontSize: 13, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word"}}>
                  {/* 展示层 strip JSON ops fence — state.history 原文保留(后端 apply_structured_updates 已落库) */}
                  {stripNarrativeOps((h && h.content) || "")}
                </div>
              </div>
            </div>
          ))}
        </div>
        <footer className="pl-modal-foot">
          <span className="muted-2" style={{fontSize: 11.5}}>
            {t('game.app.history.footer_hint')}
          </span>
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </footer>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

function SearchDrawer({ open, history, state, onClose }) {
  const { t } = useTranslation();
  const [q, setQ] = useStateA("");
  const inputRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    setQ("");
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => { try { inputRef.current?.focus(); } catch (_) {} }, 30);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [open, onClose]);

  const results = useMemoA(() => {
    const term = (q || "").trim().toLowerCase();
    if (!term) return [];
    const out = [];
    const push = (group, label, value, meta) => {
      // pinned / known_events 可能是对象或数字;旧代码只 String() 做大小写转换,却对原值
      // 调 .slice → 查询命中 "[object Object]" 时直接 TypeError。统一先归一成字符串。
      const text = typeof value === "string"
        ? value
        : (value == null ? "" : (typeof value === "object"
          ? (value.text || value.label || value.title || JSON.stringify(value))
          : String(value)));
      const lc = text.toLowerCase();
      const idx = lc.indexOf(term);
      if (idx < 0) return;
      const start = Math.max(0, idx - 24);
      const end = Math.min(text.length, idx + term.length + 60);
      out.push({ group, label, snippet: (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : ""), meta });
    };
    (Array.isArray(history) ? history : []).forEach((h, i) => {
      const role = h && h.role === "assistant" ? "GM" : (h && h.role === "user" ? t('game.app.narrative.player') : "—");
      // 搜索 index 走干净文本,避免搜 "op"/"set" 命中 JSON 而不是叙事
      push(t('game.app.search.group_dialog'), `${role} · #${i + 1}`, stripNarrativeOps((h && h.content) || ""), { i });
    });
    const mem = (state && state.memory) || {};
    if (mem.main_quest) push(t('game.app.search.group_memory'), t('game.app.search.main_quest'), mem.main_quest, {});
    if (mem.current_objective) push(t('game.app.search.group_memory'), t('game.app.search.current_objective'), mem.current_objective, {});
    (Array.isArray(mem.pinned) ? mem.pinned : []).forEach((pinItem, i) => push(t('game.app.search.group_memory'), t('game.app.search.pinned_n', { n: i + 1 }), pinItem, {}));
    const world = (state && state.world) || {};
    (Array.isArray(world.known_events) ? world.known_events : []).forEach((evItem, i) => push(t('game.app.search.group_world'), t('game.app.search.known_event_n', { n: i + 1 }), evItem, {}));
    return out.slice(0, 40);
  }, [q, history, state, t]);

  if (!open) return null;
  const node = (
    <div className="pl-modal-backdrop" onClick={onClose} role="dialog" aria-label={t('game.app.search.aria_label')}>
      <div className="pl-modal" onClick={(e) => e.stopPropagation()} style={{width: "min(640px, 100%)", maxHeight: "80vh", display: "flex", flexDirection: "column"}}>
        <header className="pl-modal-head">
          <div style={{flex: 1}}>
            <div className="pl-modal-eyebrow">{t('game.app.search.eyebrow')}</div>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('game.app.search.placeholder')}
              aria-label={t('game.app.search.input_aria')}
              style={{width: "100%", marginTop: 6, padding: "8px 10px", fontSize: 14,
                      border: "1px solid var(--line, #ddd)", borderRadius: 6, background: "var(--bg, #fff)"}}
            />
          </div>
          <button className="iconbtn" onClick={onClose} data-tip={t('common.close')} aria-label={t('common.close')}><Icon name="close" size={14} /></button>
        </header>
        <div className="pl-modal-form" style={{overflow: "auto", paddingTop: 8}}>
          {!q.trim() ? (
            <div className="muted" style={{padding: "24px 8px", textAlign: "center", fontSize: 13}}>
              {t('game.app.search.empty_hint')}
            </div>
          ) : results.length === 0 ? (
            <div className="muted" style={{padding: "24px 8px", textAlign: "center", fontSize: 13}}>
              {t('game.app.search.no_results_prefix')}"<span style={{color: "var(--text, #333)"}}>{q}</span>"{t('game.app.search.no_results_suffix')}
            </div>
          ) : results.map((r, i) => (
            <div key={`sr-${i}`} className="pl-setting-row" style={{alignItems: "flex-start", gap: 10, padding: "8px 4px", borderBottom: "1px solid var(--line-soft, #eee)"}}>
              <span className="pill" style={{flexShrink: 0, fontSize: 11}}>{r.group}</span>
              <div style={{flex: 1, minWidth: 0}}>
                <div style={{fontSize: 11, color: "var(--muted, #777)", marginBottom: 2}}>{r.label}</div>
                <div style={{fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word"}}>{r.snippet}</div>
              </div>
            </div>
          ))}
        </div>
        <footer className="pl-modal-foot">
          <span className="muted-2" style={{fontSize: 11.5}}>
            {q.trim() ? t('game.app.search.result_count', { count: results.length }) : t('game.app.search.esc_hint')}
          </span>
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </footer>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

export { HistoryDrawer, SearchDrawer };
