/* Admin — AdminMaintenancePage — 维护模式。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSAlert from '@cloudscape-design/components/alert';
import CSToggle from '@cloudscape-design/components/toggle';
import CSFormField from '@cloudscape-design/components/form-field';
import CSTextarea from '@cloudscape-design/components/textarea';
import { fmtTime } from './shared.jsx';

/* ─────────────────────────────────────────────────────────────────
   页面 8：AdminMaintenancePage — 维护模式
   ───────────────────────────────────────────────────────────────── */
export function AdminMaintenancePage() {
  const { t } = useTranslation();
  const [config, setConfig] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [draft, setDraft] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await window.api.admin.maintenance();
        if (!cancelled) {
          setConfig(res);
          setDraft(JSON.parse(JSON.stringify(res)));
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || t('admin_page.common.load_fail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await window.api.admin.saveMaintenance(draft);
      // maintenance_since 由后端计算,保存后重新拉取以刷新显示;
      // 刷新失败不掩盖保存成功(draft 保留用户所见的值即可)
      let fresh = draft;
      try { fresh = await window.api.admin.maintenance(); } catch (_) {}
      setConfig(fresh);
      setDraft(fresh);
      window.toast?.(t('admin_page.maintenance.save_ok'), { kind: 'ok' });
    } catch (e) {
      window.toast?.(t('admin_page.maintenance.save_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  const d = draft || {};

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}

      <CSContainer header={<CSHeader variant="h2" description={t('admin_page.maintenance.mode_description')}>{t('admin_page.maintenance.mode_title')}</CSHeader>}>
        {loading
          ? <CSBox color="inherit">{t('admin_page.common.loading')}</CSBox>
          : !draft
            ? <CSBox textAlign="center" color="inherit">{t('admin_page.maintenance.empty')}</CSBox>
            : (
              <CSSpaceBetween size="m">
                {d.maintenance_mode && (
                  <CSAlert type="warning">{t('admin_page.maintenance.mode_warning')}</CSAlert>
                )}
                <CSFormField label={t('admin_page.maintenance.field_toggle')}>
                  <CSToggle
                    checked={!!d.maintenance_mode}
                    onChange={({ detail }) => setDraft((prev) => ({ ...prev, maintenance_mode: detail.checked }))}
                  >
                    {d.maintenance_mode ? t('admin_page.common.toggle_on') : t('admin_page.common.toggle_off')}
                  </CSToggle>
                </CSFormField>
                <CSFormField label={t('admin_page.maintenance.field_message')}>
                  <CSTextarea
                    value={d.announcement || ''}
                    onChange={({ detail }) => setDraft((prev) => ({ ...prev, announcement: detail.value }))}
                    rows={4}
                    placeholder={t('admin_page.maintenance.message_placeholder')}
                  />
                </CSFormField>
                {d.maintenance_since && (
                  <CSFormField label={t('admin_page.maintenance.field_started_at')}>
                    <CSBox color="text-body-secondary">{fmtTime(d.maintenance_since)}</CSBox>
                  </CSFormField>
                )}
                <CSBox float="right">
                  <CSButton variant="primary" loading={saving} onClick={save}>{t('common.save')}</CSButton>
                </CSBox>
              </CSSpaceBetween>
            )
        }
      </CSContainer>
    </CSSpaceBetween>
  );
}
