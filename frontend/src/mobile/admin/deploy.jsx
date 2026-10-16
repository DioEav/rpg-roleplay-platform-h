/* MobileAdmin — SectionDeploy(admin-deploy)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow, EmptyRow } from './shared.jsx';

/* ══════════════════════════════════════════
   Section: admin-deploy
══════════════════════════════════════════ */
function SectionDeploy({ nav }) {
  const { t } = useTranslation();
  const [config, setConfig] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [testingSmtp, setTestingSmtp] = React.useState(false);
  const [draft, setDraft] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        const r = await window.api.admin.deploymentConfig();
        if (!cancelled) { setConfig(r); setDraft(JSON.parse(JSON.stringify(r))); }
      } catch (e) { if (!cancelled) setErr(e?.message || t('mobile.admin.load_failed')); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  function upd(key, val) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try { await window.api.admin.saveDeploymentConfig(draft); setConfig(draft); nav.toast(t('mobile.admin.save_success'), 'ok'); }
    catch (e) { nav.toast(t('mobile.admin.save_failed', { msg: e?.message || '' }), 'danger'); }
    finally { setSaving(false); }
  }

  async function testSmtp() {
    setTestingSmtp(true);
    try { await window.api.admin.smtpTest(); nav.toast(t('mobile.admin.deploy.smtp_test_sent'), 'ok'); }
    catch (e) { nav.toast(t('mobile.admin.deploy.smtp_test_failed', { msg: e?.message || '' }), 'danger'); }
    finally { setTestingSmtp(false); }
  }

  const d = draft || {};

  const textField = (label, key, placeholder, type = 'text') => (
    <div key={key}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <input type={type} value={d[key] || ''} onChange={(e) => upd(key, e.target.value)} placeholder={placeholder || ''}
        style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 10px', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
    </div>
  );

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.deploy')}</strong></div>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          <div style={{ fontSize: 12, color: 'var(--warn)', background: 'var(--warn-soft)', border: '1px solid rgba(212,179,102,0.4)', borderRadius: 10, padding: '10px 13px', marginBottom: 14 }}>
            {t('mobile.admin.deploy.simplified_notice')}
          </div>

          {loading ? <LoadingRow /> : err ? <ErrRow msg={err} /> : !draft ? <EmptyRow /> : (
            <>
              <div className="pl-sec">
                <div className="pl-sec-head"><h2>{t('mobile.admin.deploy.basic_heading')}</h2></div>
                <div style={{ display: 'grid', gap: 12 }}>
                  {textField(t('mobile.admin.deploy.site_name'), 'site_name', 'Meadhall')}
                  {textField(t('mobile.admin.deploy.site_url'), 'site_url', 'https://example.com')}
                  {textField(t('mobile.admin.deploy.contact_email'), 'contact_email', 'admin@example.com', 'email')}
                </div>
              </div>

              <div className="pl-sec" style={{ marginTop: 16 }}>
                <div className="pl-sec-head"><h2>{t('mobile.admin.deploy.smtp_heading')}</h2></div>
                <div style={{ display: 'grid', gap: 12 }}>
                  {textField('SMTP Host', 'smtp_host', 'smtp.example.com')}
                  {textField('SMTP Port', 'smtp_port', '587', 'number')}
                  {textField('SMTP User', 'smtp_user', 'user@example.com')}
                  {textField('SMTP Password', 'smtp_password', '••••••••', 'password')}
                </div>
                <button className="pl-btn-ghost" style={{ marginTop: 10, fontSize: 13 }} onClick={testSmtp} disabled={testingSmtp}>
                  {testingSmtp ? t('mobile.admin.deploy.smtp_sending') : t('mobile.admin.deploy.smtp_test_btn')}
                </button>
              </div>

              <button className="pl-btn-primary" style={{ width: '100%', marginTop: 18 }} onClick={save} disabled={saving}>
                {saving ? t('mobile.admin.saving') : t('mobile.admin.deploy.save_btn')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export { SectionDeploy };
