/* MobileAdmin — SectionAupActions(admin-aup-actions)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow } from './shared.jsx';
import { ConfirmSheet, InputSheet } from './sheets.jsx';

/* ══════════════════════════════════════════
   Section: admin-aup-actions
══════════════════════════════════════════ */
function SectionAupActions({ nav }) {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState('');
  const [users, setUsers] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [sheet, setSheet] = React.useState(null); // { action, user }
  const [busy, setBusy] = React.useState(false);

  async function doSearch() {
    if (!search.trim()) return;
    setLoading(true); setErr(null);
    try { const r = await window.api.admin.users({ search, limit: 20 }); setUsers(r.users || []); }
    catch (e) { setErr(e?.message || t('mobile.admin.search_failed')); }
    finally { setLoading(false); }
  }

  async function doAction(vals) {
    if (!sheet) return;
    setBusy(true);
    try {
      const { action, user } = sheet;
      if (action === 'suspend') await window.api.admin.suspendUser(user.id, { reason: vals?.reason || '', duration_days: vals?.duration_days ? Number(vals.duration_days) : undefined });
      else if (action === 'unsuspend') await window.api.admin.unsuspendUser(user.id);
      else if (action === 'terminate') await window.api.admin.terminateUser(user.id, { reason: vals?.reason || '' });
      nav.toast(t('mobile.admin.action_success'), 'ok');
      setSheet(null);
      doSearch();
    } catch (e) { nav.toast(t('mobile.admin.action_failed', { msg: e?.message || '' }), 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.aup_actions')}</strong></div>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          <div style={{ padding: '10px 13px', borderRadius: 10, background: 'var(--info-soft)', border: '1px solid rgba(122,166,194,0.3)', fontSize: 12.5, color: 'var(--info)', marginBottom: 12 }}>
            {t('mobile.admin.aup.notice')}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              type="search" placeholder={t('mobile.admin.users.search_placeholder')} value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
              style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit' }}
            />
            <button className="pl-btn-primary" style={{ padding: '0 14px', height: 38 }} onClick={doSearch} disabled={loading}>{t('mobile.admin.search')}</button>
          </div>

          {loading ? <LoadingRow /> : err ? <ErrRow msg={err} /> : users.length === 0 ? null : (
            <div className="pl-sec">
              {users.map((u) => (
                <div key={u.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 12, background: 'var(--panel)', marginBottom: 8, overflow: 'hidden' }}>
                  <div style={{ padding: '11px 13px' }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>@{u.username}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 2 }}>
                      {u.pending_deletion
                        ? <span style={{ color: 'var(--danger)' }}>{t('mobile.admin.aup.status_terminated')}</span>
                        : u.deactivated_at
                          ? <span style={{ color: 'var(--danger)' }}>{t('mobile.admin.users.status_deactivated')}</span>
                          : <span style={{ color: 'var(--ok)' }}>{t('mobile.admin.users.status_active')}</span>}
                      {u.ban_reason && <span> · {u.ban_reason}</span>}
                    </div>
                  </div>
                  {!u.pending_deletion && (
                    <div style={{ display: 'flex', borderTop: '1px solid var(--line-soft)' }}>
                      {!u.deactivated_at && (
                        <button style={{ flex: 1, padding: '9px 4px', fontSize: 12, color: 'var(--warn)', borderRight: '1px solid var(--line-soft)' }}
                          onClick={() => setSheet({ action: 'suspend', user: u })}>{t('mobile.admin.aup.suspend_btn')}</button>
                      )}
                      {u.deactivated_at && (
                        <button style={{ flex: 1, padding: '9px 4px', fontSize: 12, color: 'var(--ok)', borderRight: '1px solid var(--line-soft)' }}
                          onClick={() => setSheet({ action: 'unsuspend', user: u })}>{t('mobile.admin.aup.unsuspend_btn')}</button>
                      )}
                      <button style={{ flex: 1, padding: '9px 4px', fontSize: 12, color: 'var(--danger)' }}
                        onClick={() => setSheet({ action: 'terminate', user: u })}>{t('mobile.admin.aup.terminate_btn')}</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {sheet?.action === 'suspend' && (
        <InputSheet
          title={t('mobile.admin.aup.suspend_sheet_title', { username: sheet.user.username })}
          fields={[
            { key: 'reason', label: t('mobile.admin.aup.reason_label'), multiline: true, placeholder: t('mobile.admin.aup.suspend_reason_placeholder') },
            { key: 'duration_days', label: t('mobile.admin.aup.duration_label'), type: 'number', placeholder: t('mobile.admin.aup.duration_placeholder') },
          ]}
          busy={busy} onConfirm={doAction} onCancel={() => setSheet(null)}
        />
      )}
      {sheet?.action === 'unsuspend' && (
        <ConfirmSheet
          title={t('mobile.admin.aup.unsuspend_sheet_title', { username: sheet.user.username })} body={t('mobile.admin.aup.unsuspend_body')}
          busy={busy} onConfirm={() => doAction({})} onCancel={() => setSheet(null)}
        />
      )}
      {sheet?.action === 'terminate' && (
        <InputSheet
          title={t('mobile.admin.aup.terminate_sheet_title', { username: sheet.user.username })}
          fields={[{ key: 'reason', label: t('mobile.admin.aup.terminate_reason_label'), multiline: true, placeholder: t('mobile.admin.aup.terminate_reason_placeholder') }]}
          busy={busy} onConfirm={doAction} onCancel={() => setSheet(null)}
        />
      )}
    </>
  );
}

export { SectionAupActions };
