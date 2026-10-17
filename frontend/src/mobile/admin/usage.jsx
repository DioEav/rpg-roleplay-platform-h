/* MobileAdmin — SectionUsage(admin-usage)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow, EmptyRow } from './shared.jsx';

/* ══════════════════════════════════════════
   Section: admin-usage
══════════════════════════════════════════ */
function SectionUsage({ nav }) {
  const { t } = useTranslation();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [days, setDays] = React.useState(30);

  const load = React.useCallback(async () => {
    setLoading(true); setErr(null);
    try { const r = await window.api.admin.globalUsage({ days }); setData(r); }
    catch (e) { setErr(e?.message || t('mobile.admin.load_failed')); }
    finally { setLoading(false); }
  }, [days]);

  React.useEffect(() => { load(); }, [load]);

  // 后端 /api/admin/usage 返回的键是 total(非 summary),字段是 requests/total_tokens/cost_usd。
  // 此前读 data?.summary / total_requests / total_cost 等臆造字段名,整页数字恒 0 或 "—"。
  const summary = data?.total || {};
  const byUser = data?.by_user || [];
  const byDay = data?.by_day || [];
  const maxDay = byDay.reduce((m, d) => Math.max(m, d.total_tokens || 0), 1);

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.usage')}</strong></div>
        <button className="pl-headbtn" onClick={load} disabled={loading}><Icon name="refresh" size={18} /></button>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          {/* 时间范围选择 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {[7, 14, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)}
                style={{ padding: '4px 14px', borderRadius: 999, fontSize: 12, border: '1px solid', borderColor: days === d ? 'var(--accent-edge)' : 'var(--line)', background: days === d ? 'var(--accent-soft)' : 'var(--panel-2)', color: days === d ? 'var(--accent)' : 'var(--muted)' }}>
                {t('mobile.admin.usage.days', { count: d })}
              </button>
            ))}
          </div>

          {loading ? <LoadingRow /> : err ? <ErrRow msg={err} onRetry={load} /> : !data ? <EmptyRow /> : (
            <>
              {/* 汇总卡片(成本卡已隐藏 2026-10,应要求;恢复 = 解注释 cost 项并改回 1fr 1fr 1fr) */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                {[
                  [t('mobile.admin.usage.requests'), (summary.requests || 0).toLocaleString()],
                  ['Tokens', (summary.total_tokens || 0).toLocaleString()],
                  // [t('mobile.admin.usage.cost'), typeof summary.cost_usd === 'number' ? `$${summary.cost_usd.toFixed(3)}` : '—'],
                ].map(([k, v]) => (
                  <div key={k} style={{ border: '1px solid var(--line-soft)', borderRadius: 10, background: 'var(--panel)', padding: '10px 8px', textAlign: 'center' }}>
                    <div style={{ fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-serif)' }}>{v}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 2 }}>{k}</div>
                  </div>
                ))}
              </div>

              {/* 每日柱状 */}
              {byDay.length > 0 && (
                <div className="pl-sec">
                  <div className="pl-sec-head"><h2>{t('mobile.admin.usage.daily_tokens')}</h2></div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    {byDay.slice(-14).map((d) => {
                      const pct = Math.max(2, Math.round((d.total_tokens || 0) / maxDay * 100));
                      return (
                        <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                          <span style={{ minWidth: 76, color: 'var(--muted-2)', fontFamily: 'var(--font-mono)' }}>{d.date?.slice(5)}</span>
                          <div style={{ flex: 1, height: 12, background: 'var(--panel-3)', borderRadius: 4, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--info)', borderRadius: 4 }} />
                          </div>
                          <span style={{ minWidth: 64, textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-quiet)' }}>{(d.total_tokens || 0).toLocaleString()}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 按用户 */}
              {byUser.length > 0 && (
                <div className="pl-sec">
                  <div className="pl-sec-head"><h2>{t('mobile.admin.usage.top_users')}</h2></div>
                  {byUser.slice(0, 10).map((u, i) => (
                    <div key={u.user_id || i} className="pl-row" style={{ cursor: 'default' }}>
                      <span className="pl-row-ic info" style={{ width: 24, height: 24, fontSize: 11, fontFamily: 'var(--font-mono)', display: 'grid', placeItems: 'center' }}>{i + 1}</span>
                      <span className="pl-row-tx">
                        <strong style={{ fontSize: 13 }}>{u.username || u.user_id || '—'}</strong>
                        <span className="mono">{(u.total_tokens || 0).toLocaleString()} tokens{/* 成本已隐藏(2026-10,应要求):恢复 = 接回 `{typeof u.cost_usd === 'number' ? ` · $${u.cost_usd.toFixed(3)}` : ''}` */}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

export { SectionUsage };
