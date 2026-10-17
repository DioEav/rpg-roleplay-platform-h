/* MobileCards 在线卡库视图 OnlineView —— 从 pages/MobileCards.jsx 拆出,逐字节不变。 */
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { SubHead, Tag } from './shared.jsx';
import { clamp2 } from './helpers.js';

/* ═══════════════════════════════════════════════════════════════════
   在线卡库视图
   ═══════════════════════════════════════════════════════════════════ */
function OnlineView({ nav }) {
  const { t } = useTranslation();
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState({});
  const [selected, setSelected] = useState(null); // 在线卡详情

  const load = useCallback(async (query) => {
    setLoading(true); setError('');
    try {
      const r = await window.api.cards.publicList(query ? { q: query } : undefined);
      setItems((r && r.items) || []);
    } catch (e) {
      setError(e?.message || t('mobile.cards.online.load_fail'));
      setItems([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(''); }, [load]);

  const doImport = async (c) => {
    setImporting((p) => ({ ...p, [c.id]: true }));
    try {
      const r = await window.api.cards.cloneFromPublic(c.id);
      if (r && r.already_imported) {
        // 与桌面端一致:已导入过只提示,不重复报成功。
        nav.toast(t('mobile.cards.online.already_imported', { name: c.name }), 'info', 'check');
      } else {
        nav.toast(t('mobile.cards.online.imported', { name: c.name }), 'ok', 'download');
      }
      try { window.dispatchEvent(new CustomEvent('rpg-user-cards-updated')); } catch (_) {}
      load(q);
    } catch (e) {
      nav.toast(t('mobile.cards.online.import_fail', { msg: e?.payload?.error || e?.message || '' }), 'danger', 'warn');
    } finally {
      setImporting((p) => ({ ...p, [c.id]: false }));
    }
  };

  // 已导入(或本人发布)的卡:统一显示不可再导入的状态
  const isOwned = (c) => !!(c.mine || c.imported);

  // 在线卡详情
  if (selected) {
    const c = selected;
    const tags = c.tags || [];
    return (
      <>
        <SubHead
          title={c.name || t('mobile.cards.unnamed')}
          sub={t('mobile.cards.online.detail_sub', { author: c.owner_name || t('mobile.cards.online.anon') })}
          onBack={() => setSelected(null)}
        />
        <div className="pl-body tabbed">
          <div className="pl-pad">
            {/* 封面块 */}
            <div style={{ height: 108, borderRadius: 16, marginBottom: 16, background: 'linear-gradient(135deg, rgba(201,100,66,0.28), rgba(201,100,66,0.05))', position: 'relative', display: 'flex', alignItems: 'flex-end', padding: '12px 16px' }}>
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, background: 'var(--accent)', opacity: 0.6, borderRadius: '16px 0 0 16px' }} />
              <div style={{ position: 'relative' }}>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 600, color: 'var(--text)' }}>{c.name}</div>
                {c.identity && <div style={{ fontSize: 12, color: 'var(--text-quiet)', marginTop: 3 }}>{String(c.identity).slice(0, 50)}</div>}
              </div>
            </div>

            <p style={{ margin: '0 0 16px', fontSize: 13.5, color: 'var(--text-quiet)', lineHeight: 1.75, fontFamily: 'var(--font-serif)' }}>
              {c.personality || c.background || c.appearance || t('mobile.cards.online.no_desc')}
            </p>

            <div className="pl-kvgrid" style={{ marginBottom: 16 }}>
              {[
                [t('mobile.cards.online.kv_author'), c.owner_name || t('mobile.cards.online.anon')],
                [t('mobile.cards.online.kv_imports'), String(c.clone_count || 0)],
                [t('mobile.cards.online.kv_tags'), String((c.tags || []).length)],
                [t('mobile.cards.online.kv_identity'), c.identity ? String(c.identity).slice(0, 30) : '—'],
              ].map(([k, v]) => (
                <div key={k} className="pl-kv"><div className="k">{k}</div><div className="v">{v}</div></div>
              ))}
            </div>

            {tags.length > 0 && (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 18 }}>
                {tags.map((tg) => <Tag key={tg} label={tg} />)}
              </div>
            )}

            <button className="pl-btn-primary" onClick={() => doImport(c)} disabled={!!importing[c.id] || isOwned(c)}
              style={{ opacity: (importing[c.id] || isOwned(c)) ? 0.6 : 1 }}>
              <Icon name={isOwned(c) ? 'check' : 'download'} size={16} />
              {isOwned(c) ? t('mobile.cards.online.already_imported_short', '已导入')
                : (importing[c.id] ? t('mobile.cards.online.importing') : t('mobile.cards.online.btn_import'))}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pl-head">
        <div className="pl-head-title">
          <strong style={{ fontFamily: 'var(--font-serif)', fontSize: 20 }}>{t('mobile.cards.online.title')}</strong>
        </div>
        <div className="pl-head-actions">
          <button className="pl-headbtn" onClick={() => load(q)} aria-label={t('common.refresh')}>
            <Icon name="refresh" size={17} />
          </button>
        </div>
      </div>

      {/* 搜索 */}
      <div className="pl-toolbar">
        <div className="pl-search">
          <Icon name="search" size={15} style={{ flexShrink: 0 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(q); }}
            placeholder={t('mobile.cards.online.search_placeholder')} />
        </div>
        <button className="pl-headbtn" onClick={() => load(q)} aria-label={t('mobile.cards.online.btn_search')}>
          <Icon name="search" size={16} />
        </button>
      </div>

      <div className="pl-body tabbed">
        <div className="pl-pad" style={{ paddingTop: 4 }}>
          <div className="pl-note" style={{ marginBottom: 16 }}>
            {t('mobile.cards.online.browse_hint')}
          </div>

          {error && (
            <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: 13, marginBottom: 14 }}>
              <Icon name="warn" size={13} style={{ marginRight: 6 }} />{error}
            </div>
          )}

          {loading && items == null && <div className="pl-empty">{t('mobile.cards.online.loading')}</div>}
          {!loading && items?.length === 0 && (
            <div className="pl-empty">{t('mobile.cards.online.empty')}</div>
          )}

          <div style={{ display: 'grid', gap: 12 }}>
            {(items || []).map((c) => (
              <button key={c.id} className="pl-row" onClick={() => setSelected(c)}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                  display: 'grid', placeItems: 'center',
                  font: '600 20px var(--font-serif)',
                  background: 'linear-gradient(140deg, rgba(201,100,66,0.2), rgba(201,100,66,0.04))',
                  color: 'var(--accent)',
                }}>
                  {(c.name || '?').slice(0, 1)}
                </div>
                <div className="pl-row-tx">
                  <strong className="serif">{c.name || t('mobile.cards.unnamed')}</strong>
                  <span style={{ color: 'var(--accent)', fontSize: 11.5 }}>
                    {c.identity ? String(c.identity).slice(0, 36) : ''}
                  </span>
                  <span style={{ ...clamp2, fontSize: 11, color: 'var(--muted)' }}>
                    {(c.personality || c.background || c.appearance || '').slice(0, 80)}
                  </span>
                  <span style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginTop: 3 }}>
                    {(c.tags || []).slice(0, 3).map((tg) => <Tag key={tg} label={tg} />)}
                    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted-2)' }}>
                      by {c.owner_name || t('mobile.cards.online.anon')} · ♥ {c.clone_count || 0}
                    </span>
                  </span>
                </div>
                <button className="pl-headbtn accent" style={{ height: 36, width: 60, borderRadius: 10, fontSize: 12.5 }}
                  onClick={(e) => { e.stopPropagation(); doImport(c); }}
                  disabled={!!importing[c.id] || isOwned(c)}>
                  {isOwned(c) ? t('mobile.cards.online.already_imported_short', '已导入')
                    : (importing[c.id] ? '…' : t('mobile.cards.online.btn_import_short'))}
                </button>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export { OnlineView };
