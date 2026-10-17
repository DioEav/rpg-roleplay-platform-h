/* Admin — AdminAupActionsPage — AUP 暂停/解封/终止。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSTable from '@cloudscape-design/components/table';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSAlert from '@cloudscape-design/components/alert';
import CSInput from '@cloudscape-design/components/input';
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';
import CSModal from '@cloudscape-design/components/modal';
import CSFormField from '@cloudscape-design/components/form-field';
import CSTextarea from '@cloudscape-design/components/textarea';

/* ─────────────────────────────────────────────────────────────────
   页面 12：AdminAupActionsPage — AUP 账户暂停 / 解封 / 终止
   ───────────────────────────────────────────────────────────────── */
export function AdminAupActionsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState('');
  const [users, setUsers] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [suspendModal, setSuspendModal] = React.useState(null); // user
  const [suspendForm, setSuspendForm] = React.useState({ reason: '', duration_days: '' });
  const [suspendBusy, setSuspendBusy] = React.useState(false);
  const [unsuspendModal, setUnsuspendModal] = React.useState(null); // user
  const [unsuspendBusy, setUnsuspendBusy] = React.useState(false);
  const [terminateModal, setTerminateModal] = React.useState(null); // user
  const [terminateReason, setTerminateReason] = React.useState('');
  const [terminateBusy, setTerminateBusy] = React.useState(false);

  async function doSearch() {
    if (!search.trim()) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await window.api.admin.users({ search, limit: 20 });
      setUsers(res.users || []);
    } catch (e) {
      setErr(e?.message || t('admin_page.aup.search_fail'));
    } finally {
      setLoading(false);
    }
  }

  async function doSuspend() {
    if (!suspendModal) return;
    setSuspendBusy(true);
    try {
      const body = { reason: suspendForm.reason };
      if (suspendForm.duration_days) body.duration_days = Number(suspendForm.duration_days);
      await window.api.admin.suspendUser(suspendModal.id, body);
      window.toast?.(t('admin_page.aup.suspend_ok'), { kind: 'ok' });
      setSuspendModal(null);
      setSuspendForm({ reason: '', duration_days: '' });
      doSearch();
    } catch (e) {
      window.toast?.(t('admin_page.common.op_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setSuspendBusy(false);
    }
  }

  async function doUnsuspend() {
    if (!unsuspendModal) return;
    setUnsuspendBusy(true);
    try {
      await window.api.admin.unsuspendUser(unsuspendModal.id);
      window.toast?.(t('admin_page.aup.unsuspend_ok'), { kind: 'ok' });
      setUnsuspendModal(null);
      doSearch();
    } catch (e) {
      window.toast?.(t('admin_page.common.op_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setUnsuspendBusy(false);
    }
  }

  async function doTerminate() {
    if (!terminateModal) return;
    setTerminateBusy(true);
    try {
      await window.api.admin.terminateUser(terminateModal.id, { reason: terminateReason });
      window.toast?.(t('admin_page.aup.terminate_ok'), { kind: 'ok', duration: 6000 });
      setTerminateModal(null);
      setTerminateReason('');
      doSearch();
    } catch (e) {
      window.toast?.(t('admin_page.common.op_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setTerminateBusy(false);
    }
  }

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.aup.error_title')}>{err}</CSAlert>}

      <CSContainer
        header={
          <CSHeader variant="h2" description={t('admin_page.aup.description')}>
            {t('admin_page.aup.title')}
          </CSHeader>
        }
      >
        <CSSpaceBetween size="m">
          <CSAlert type="info">{t('admin_page.aup.info')}</CSAlert>
          <CSSpaceBetween direction="horizontal" size="xs">
            <CSInput
              placeholder={t('admin_page.aup.search_placeholder')}
              value={search}
              onChange={({ detail }) => setSearch(detail.value)}
              onKeyDown={({ detail }) => { if (detail.key === 'Enter') doSearch(); }}
              type="search"
            />
            <CSButton onClick={doSearch} loading={loading}>{t('admin_page.aup.search_btn')}</CSButton>
          </CSSpaceBetween>

          {users.length > 0 && (
            <CSTable
              loading={loading}
              loadingText={t('admin_page.common.loading')}
              trackBy="id"
              items={users}
              empty={<CSBox textAlign="center" color="inherit">{t('admin_page.aup.no_results')}</CSBox>}
              columnDefinitions={[
                { id: 'username', header: t('admin_page.aup.col_username'), cell: (u) => u.username },
                { id: 'display_name', header: t('admin_page.aup.col_display_name'), cell: (u) => u.display_name || '—' },
                {
                  id: 'status', header: t('admin_page.aup.col_status'),
                  cell: (u) => u.pending_deletion
                    ? <CSStatusIndicator type="error">{t('admin_page.aup.status_terminated')}</CSStatusIndicator>
                    : u.deactivated_at
                      ? <CSStatusIndicator type="stopped">{t('admin_page.aup.status_suspended')}</CSStatusIndicator>
                      : <CSStatusIndicator type="success">{t('admin_page.aup.status_active')}</CSStatusIndicator>,
                },
                { id: 'ban_reason', header: t('admin_page.aup.col_ban_reason'), cell: (u) => u.ban_reason || '—' },
                {
                  id: 'actions', header: t('admin_page.common.actions'),
                  cell: (u) => (
                    <CSSpaceBetween direction="horizontal" size="xs">
                      {!u.deactivated_at && !u.pending_deletion && (
                        <CSButton
                          variant="inline-link"
                          onClick={() => { setSuspendModal(u); setSuspendForm({ reason: '', duration_days: '' }); }}
                        >
                          {t('admin_page.aup.btn_suspend')}
                        </CSButton>
                      )}
                      {u.deactivated_at && !u.pending_deletion && (
                        <CSButton variant="inline-link" onClick={() => setUnsuspendModal(u)}>{t('admin_page.aup.btn_unsuspend')}</CSButton>
                      )}
                      {!u.pending_deletion && (
                        <CSButton
                          variant="inline-link"
                          onClick={() => { setTerminateModal(u); setTerminateReason(''); }}
                        >
                          {t('admin_page.aup.btn_terminate')}
                        </CSButton>
                      )}
                    </CSSpaceBetween>
                  ),
                },
              ]}
            />
          )}
        </CSSpaceBetween>
      </CSContainer>

      {/* suspend modal */}
      {suspendModal && (
        <CSModal
          visible
          onDismiss={() => !suspendBusy && setSuspendModal(null)}
          header={t('admin_page.aup.suspend_modal_title', { name: suspendModal.username })}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={suspendBusy} onClick={() => setSuspendModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={suspendBusy} disabled={!suspendForm.reason} onClick={doSuspend}>{t('admin_page.aup.suspend_confirm_btn')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSSpaceBetween size="m">
            <CSFormField label={t('admin_page.aup.suspend_reason_label')}>
              <CSTextarea
                value={suspendForm.reason}
                onChange={({ detail }) => setSuspendForm((f) => ({ ...f, reason: detail.value }))}
                rows={3}
                placeholder={t('admin_page.aup.suspend_reason_placeholder')}
              />
            </CSFormField>
            <CSFormField label={t('admin_page.aup.suspend_days_label')}>
              <CSInput
                type="number"
                value={suspendForm.duration_days}
                onChange={({ detail }) => setSuspendForm((f) => ({ ...f, duration_days: detail.value }))}
                placeholder={t('admin_page.aup.suspend_days_placeholder')}
              />
            </CSFormField>
          </CSSpaceBetween>
        </CSModal>
      )}

      {/* unsuspend modal */}
      {unsuspendModal && (
        <CSModal
          visible
          onDismiss={() => !unsuspendBusy && setUnsuspendModal(null)}
          header={t('admin_page.aup.unsuspend_modal_title', { name: unsuspendModal.username })}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={unsuspendBusy} onClick={() => setUnsuspendModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={unsuspendBusy} onClick={doUnsuspend}>{t('admin_page.aup.unsuspend_confirm_btn')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSBox>{t('admin_page.aup.unsuspend_confirm', { name: unsuspendModal.username })}</CSBox>
        </CSModal>
      )}

      {/* terminate modal */}
      {terminateModal && (
        <CSModal
          visible
          onDismiss={() => !terminateBusy && setTerminateModal(null)}
          header={t('admin_page.aup.terminate_modal_title', { name: terminateModal.username })}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={terminateBusy} onClick={() => setTerminateModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={terminateBusy} disabled={!terminateReason} onClick={doTerminate}>{t('admin_page.aup.terminate_confirm_btn')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSSpaceBetween size="m">
            <CSAlert type="error">{t('admin_page.aup.terminate_warning')}</CSAlert>
            <CSFormField label={t('admin_page.aup.terminate_reason_label')}>
              <CSTextarea
                value={terminateReason}
                onChange={({ detail }) => setTerminateReason(detail.value)}
                rows={3}
                placeholder={t('admin_page.aup.terminate_reason_placeholder')}
              />
            </CSFormField>
          </CSSpaceBetween>
        </CSModal>
      )}
    </CSSpaceBetween>
  );
}
