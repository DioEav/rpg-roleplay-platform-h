/* MobileAdmin — SectionAudit(admin-audit)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow, EmptyRow, fmtTime } from './shared.jsx';

/* ══════════════════════════════════════════
   Section: admin-audit
══════════════════════════════════════════ */
function SectionAudit({ nav }) {
  const { t } = useTranslation();
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [page, setPage] = React.useState(1);
  const [actionFilter, setActionFilter] = React.useState('');
  const LIMIT = 50;

  const load = React.useCallback(async (p = 1) => {
    setLoading(true); setErr(null);
    try {
      // 后端契约:筛选参数 action_type(非 action_prefix),响应 { entries, total }(非 items/logs)。
      const params = { page: p, limit: LIMIT };
      if (actionFilter) params.action_type = actionFilter;
      const res = await window.api.admin.auditLog(params);
      setItems(res.entries || []);
      setPage(p);
    } catch (e) { setErr(e?.message || t('mobile.admin.load_failed')); }
    finally { setLoading(false); }
  }, [actionFilter]);

  React.useEffect(() => { load(1); }, [actionFilter]);

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.audit')}</strong></div>
        <button className="pl-headbtn" onClick={() => load(page)} disabled={loading}><Icon name="refresh" size={18} /></button>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {[['', t('common.all')], ['user', 'user.*'], ['config', 'config.*'], ['maintenance', 'maintenance.*'], ['invite', 'invite.*']].map(([v, l]) => (
              <button key={v} onClick={() => setActionFilter(v)}
                style={{ padding: '4px 12px', borderRadius: 999, fontSize: 12, border: '1px solid', borderColor: actionFilter === v ? 'var(--accent-edge)' : 'var(--line)', background: actionFilter === v ? 'var(--accent-soft)' : 'var(--panel-2)', color: actionFilter === v ? 'var(--accent)' : 'var(--muted)' }}>
                {l}
              </button>
            ))}
          </div>

          {loading ? <LoadingRow /> : err ? <ErrRow msg={err} onRetry={() => load(page)} /> : items.length === 0 ? <EmptyRow /> : (
            <div className="pl-sec">
              {items.map((item, i) => (
                <div key={item.id || i} style={{ padding: '10px 0', borderBottom: '1px solid var(--line-soft)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)', background: 'var(--accent-soft)', padding: '2px 7px', borderRadius: 6, border: '1px solid var(--accent-edge)' }}>{item.action || '—'}</span>
                    <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>{item.actor_username || item.actor_id || '—'}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--muted-3)', marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>{fmtTime(item.created_at)}</span>
                  </div>
                  {item.target_type && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', paddingLeft: 4 }}>{item.target_type}{item.target_id ? ` #${item.target_id}` : ''}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!loading && !err && items.length > 0 && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              <button className="pl-btn-ghost" disabled={page <= 1} onClick={() => load(page - 1)} style={{ padding: '6px 16px', fontSize: 13 }}>{t('mobile.admin.prev_page')}</button>
              <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: '34px' }}>{t('mobile.admin.page_n', { n: page })}</span>
              <button className="pl-btn-ghost" disabled={items.length < LIMIT} onClick={() => load(page + 1)} style={{ padding: '6px 16px', fontSize: 13 }}>{t('mobile.admin.next_page')}</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export { SectionAudit };
