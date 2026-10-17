/* MobileAdmin — SectionMaintenance(admin-maintenance)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow, EmptyRow, fmtTime } from './shared.jsx';

/* ══════════════════════════════════════════
   Section: admin-maintenance
══════════════════════════════════════════ */
function SectionMaintenance({ nav }) {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try { const r = await window.api.admin.maintenance(); if (!cancelled) setDraft(JSON.parse(JSON.stringify(r))); }
      catch (e) { if (!cancelled) setErr(e?.message || t('mobile.admin.load_failed')); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await window.api.admin.saveMaintenance(draft);
      // maintenance_since 由后端计算,保存后重新拉取以刷新显示;
      // 刷新失败不掩盖保存成功
      let fresh = draft;
      try { fresh = await window.api.admin.maintenance(); } catch (_) {}
      setDraft(fresh);
      nav.toast(t('mobile.admin.save_success'), 'ok');
    }
    catch (e) { nav.toast(t('mobile.admin.save_failed', { msg: e?.message || '' }), 'danger'); }
    finally { setSaving(false); }
  }

  const d = draft || {};

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.maintenance')}</strong></div>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          {loading ? <LoadingRow /> : err ? <ErrRow msg={err} /> : !draft ? <EmptyRow /> : (
            <>
              {d.maintenance_mode && (
                <div style={{ padding: '10px 13px', borderRadius: 10, background: 'var(--warn-soft)', border: '1px solid rgba(212,179,102,0.4)', fontSize: 13, color: 'var(--warn)', marginBottom: 12 }}>
                  {t('mobile.admin.maintenance.active_notice')}
                </div>
              )}
              <div className="pl-row" style={{ cursor: 'pointer' }} onClick={() => setDraft((prev) => ({ ...prev, maintenance_mode: !prev.maintenance_mode }))}>
                <span className={`pl-row-ic ${d.maintenance_mode ? 'warn' : ''}`}><Icon name={d.maintenance_mode ? 'lock' : 'unlock'} size={17} /></span>
                <span className="pl-row-tx"><strong style={{ fontSize: 13.5 }}>{t('mobile.admin.section.maintenance')}</strong></span>
                <span style={{ fontSize: 12, color: d.maintenance_mode ? 'var(--warn)' : 'var(--muted)' }}>{d.maintenance_mode ? t('mobile.admin.maintenance.on') : t('mobile.admin.maintenance.off')}</span>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{t('mobile.admin.maintenance.message_label')}</div>
                <textarea
                  value={d.announcement || ''}
                  onChange={(e) => setDraft((prev) => ({ ...prev, announcement: e.target.value }))}
                  rows={3}
                  placeholder={t('mobile.admin.maintenance.message_placeholder')}
                  style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
                />
              </div>

              {d.maintenance_since && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>{t('mobile.admin.maintenance.started_at')}{fmtTime(d.maintenance_since)}</div>}

              <button className="pl-btn-primary" style={{ width: '100%', marginTop: 14 }} onClick={save} disabled={saving}>
                {saving ? t('mobile.admin.saving') : t('mobile.admin.maintenance.save_btn')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export { SectionMaintenance };
