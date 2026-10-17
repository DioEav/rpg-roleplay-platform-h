/* Admin — AdminDmcaTakedownsPage / AdminDmcaStrikesPage — DMCA 下架队列 + Strike 管理。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { LANDING_BASE } from '../../lib/brand.js';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSTable from '@cloudscape-design/components/table';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSBadge from '@cloudscape-design/components/badge';
import CSAlert from '@cloudscape-design/components/alert';
import CSInput from '@cloudscape-design/components/input';
import CSSelect from '@cloudscape-design/components/select';
import CSModal from '@cloudscape-design/components/modal';
import CSFormField from '@cloudscape-design/components/form-field';
import CSTextarea from '@cloudscape-design/components/textarea';
import { fmtTime } from './shared.jsx';

/* ─────────────────────────────────────────────────────────────────
   页面 9：AdminDmcaTakedownsPage — DMCA 下架队列
   ───────────────────────────────────────────────────────────────── */
export function AdminDmcaTakedownsPage() {
  const { t } = useTranslation();
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [statusFilter, setStatusFilter] = React.useState({ value: 'open', label: t('admin_page.dmca_takedowns.status_open') });
  const [actionModal, setActionModal] = React.useState(null); // { item, action }
  const [actionReason, setActionReason] = React.useState('');
  const [actionBusy, setActionBusy] = React.useState(false);
  const [createModal, setCreateModal] = React.useState(false);
  const [createForm, setCreateForm] = React.useState({
    complainant_name: '', complainant_email: '', infringing_url: '', original_work_desc: '',
  });
  const [creating, setCreating] = React.useState(false);
  const [counterModal, setCounterModal] = React.useState(null); // item
  const [counterNotes, setCounterNotes] = React.useState('');
  const [counterBusy, setCounterBusy] = React.useState(false);

  const statusOptions = [
    { value: 'open', label: t('admin_page.dmca_takedowns.status_open') },
    { value: 'counter_received', label: t('admin_page.dmca_takedowns.status_counter') },
    { value: 'closed', label: t('admin_page.dmca_takedowns.status_closed') },
    { value: 'restored', label: t('admin_page.dmca_takedowns.status_restored') },
    { value: 'rejected', label: t('admin_page.dmca_takedowns.status_rejected') },
    { value: 'all', label: t('admin_page.dmca_takedowns.status_all') },
  ];

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await window.api.admin.dmcaTakedowns.list({ status: statusFilter.value });
      setItems(res.takedowns || res || []);
    } catch (e) {
      setErr(e?.message || t('admin_page.common.load_fail'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter.value]);

  React.useEffect(() => { load(); }, [load]);

  async function doAction() {
    if (!actionModal) return;
    setActionBusy(true);
    try {
      await window.api.admin.dmcaTakedowns.action(actionModal.item.id, {
        action: actionModal.action, reason: actionReason,
      });
      window.toast?.(t('admin_page.dmca_takedowns.op_ok'), { kind: 'ok' });
      setActionModal(null);
      setActionReason('');
      load();
    } catch (e) {
      window.toast?.(t('admin_page.dmca_takedowns.op_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setActionBusy(false);
    }
  }

  async function doCreate() {
    setCreating(true);
    try {
      await window.api.admin.dmcaTakedowns.create(createForm);
      window.toast?.(t('admin_page.dmca_takedowns.create_ok'), { kind: 'ok' });
      setCreateModal(false);
      setCreateForm({ complainant_name: '', complainant_email: '', infringing_url: '', original_work_desc: '' });
      load();
    } catch (e) {
      window.toast?.(t('admin_page.dmca_takedowns.create_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setCreating(false);
    }
  }

  async function doCounter() {
    if (!counterModal) return;
    setCounterBusy(true);
    try {
      await window.api.admin.dmcaTakedowns.counter(counterModal.id, { notes: counterNotes });
      window.toast?.(t('admin_page.dmca_takedowns.counter_ok'), { kind: 'ok' });
      setCounterModal(null);
      setCounterNotes('');
      load();
    } catch (e) {
      window.toast?.(t('admin_page.common.op_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setCounterBusy(false);
    }
  }

  function statusBadge(s) {
    const map = {
      open: ['red', t('admin_page.dmca_takedowns.status_open')],
      counter_received: ['blue', t('admin_page.dmca_takedowns.status_counter')],
      closed: ['grey', t('admin_page.dmca_takedowns.status_closed')],
      restored: ['green', t('admin_page.dmca_takedowns.status_restored')],
      rejected: ['severity-low', t('admin_page.dmca_takedowns.status_rejected')],
    };
    const [color, label] = map[s] || ['grey', s];
    return <CSBadge color={color}>{label}</CSBadge>;
  }

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}
      <CSContainer
        header={
          <CSHeader
            variant="h2"
            description={t('admin_page.dmca_takedowns.description')}
            actions={
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSSelect
                  selectedOption={statusFilter}
                  options={statusOptions}
                  onChange={({ detail }) => setStatusFilter(detail.selectedOption)}
                />
                <CSButton variant="primary" onClick={() => setCreateModal(true)}>{t('admin_page.dmca_takedowns.create_btn')}</CSButton>
                <CSButton iconName="refresh" onClick={load} loading={loading}>{t('admin_page.common.refresh')}</CSButton>
              </CSSpaceBetween>
            }
          >
            {t('admin_page.dmca_takedowns.title')}
          </CSHeader>
        }
      >
        <CSTable
          loading={loading}
          loadingText={t('admin_page.common.loading')}
          trackBy="id"
          items={items}
          empty={<CSBox textAlign="center" color="inherit">{t('admin_page.dmca_takedowns.empty')}</CSBox>}
          columnDefinitions={[
            { id: 'id', header: t('admin_page.dmca_takedowns.col_id'), cell: (r) => `#${r.id}`, width: 60 },
            { id: 'complainant', header: t('admin_page.dmca_takedowns.col_complainant'), cell: (r) => `${r.complainant_name || '—'} <${r.complainant_email || '—'}>` },
            { id: 'url', header: t('admin_page.dmca_takedowns.col_url'), cell: (r) => <a href={r.infringing_url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: 'break-all' }}>{r.infringing_url}</a> },
            { id: 'status', header: t('admin_page.dmca_takedowns.col_status'), cell: (r) => statusBadge(r.status) },
            { id: 'restore_after', header: t('admin_page.dmca_takedowns.col_restore_after'), cell: (r) => r.restore_after ? fmtTime(r.restore_after) : '—' },
            { id: 'created_at', header: t('admin_page.dmca_takedowns.col_created_at'), cell: (r) => fmtTime(r.created_at) },
            {
              id: 'actions', header: t('admin_page.common.actions'),
              cell: (r) => (
                <CSSpaceBetween direction="horizontal" size="xs">
                  {r.status === 'open' && (
                    <CSButton key="takedown" variant="inline-link" onClick={() => { setActionModal({ item: r, action: 'takedown' }); setActionReason(''); }}>{t('admin_page.dmca_takedowns.btn_takedown')}</CSButton>
                  )}
                  {r.status === 'open' && (
                    <CSButton key="reject" variant="inline-link" onClick={() => { setActionModal({ item: r, action: 'reject' }); setActionReason(''); }}>{t('admin_page.dmca_takedowns.btn_reject')}</CSButton>
                  )}
                  {r.status === 'closed' && (
                    <CSButton key="counter" variant="inline-link" onClick={() => { setCounterModal(r); setCounterNotes(''); }}>{t('admin_page.dmca_takedowns.btn_counter')}</CSButton>
                  )}
                  {r.status === 'counter_received' && r.restore_after && new Date(r.restore_after) <= new Date() && (
                    <CSButton key="restore" variant="inline-link" onClick={() => { setActionModal({ item: r, action: 'restore' }); setActionReason(t('admin_page.dmca_takedowns.restore_default_reason')); }}>{t('admin_page.dmca_takedowns.btn_restore')}</CSButton>
                  )}
                </CSSpaceBetween>
              ),
            },
          ]}
        />
      </CSContainer>

      {/* create notice modal */}
      {createModal && (
        <CSModal
          visible
          onDismiss={() => !creating && setCreateModal(false)}
          header={t('admin_page.dmca_takedowns.create_modal_title')}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={creating} onClick={() => setCreateModal(false)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={creating} onClick={doCreate}>{t('admin_page.common.submit')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSSpaceBetween size="m">
            <CSFormField label={t('admin_page.dmca_takedowns.field_complainant_name')}>
              <CSInput value={createForm.complainant_name} onChange={({ detail }) => setCreateForm((f) => ({ ...f, complainant_name: detail.value }))} />
            </CSFormField>
            <CSFormField label={t('admin_page.dmca_takedowns.field_complainant_email')}>
              <CSInput value={createForm.complainant_email} onChange={({ detail }) => setCreateForm((f) => ({ ...f, complainant_email: detail.value }))} type="email" />
            </CSFormField>
            <CSFormField label={t('admin_page.dmca_takedowns.field_infringing_url')}>
              <CSInput value={createForm.infringing_url} onChange={({ detail }) => setCreateForm((f) => ({ ...f, infringing_url: detail.value }))} placeholder={`${LANDING_BASE}/...`} />
            </CSFormField>
            <CSFormField label={t('admin_page.dmca_takedowns.field_original_work')}>
              <CSTextarea value={createForm.original_work_desc} onChange={({ detail }) => setCreateForm((f) => ({ ...f, original_work_desc: detail.value }))} rows={3} />
            </CSFormField>
          </CSSpaceBetween>
        </CSModal>
      )}

      {/* action modal */}
      {actionModal && (
        <CSModal
          visible
          onDismiss={() => !actionBusy && setActionModal(null)}
          header={t('admin_page.dmca_takedowns.action_modal_title', { action: actionModal.action === 'takedown' ? t('admin_page.dmca_takedowns.action_takedown_label') : actionModal.action === 'restore' ? t('admin_page.dmca_takedowns.action_restore_label') : t('admin_page.dmca_takedowns.action_reject_label') })}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={actionBusy} onClick={() => setActionModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={actionBusy} onClick={doAction}>{t('admin_page.common.confirm')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSSpaceBetween size="m">
            <CSBox>{t('admin_page.dmca_takedowns.action_record_label', { id: actionModal.item.id, url: actionModal.item.infringing_url })}</CSBox>
            <CSFormField label={t('admin_page.dmca_takedowns.action_reason_label')}>
              <CSTextarea value={actionReason} onChange={({ detail }) => setActionReason(detail.value)} rows={3} placeholder={t('admin_page.dmca_takedowns.action_reason_placeholder')} />
            </CSFormField>
          </CSSpaceBetween>
        </CSModal>
      )}

      {/* counter notice modal */}
      {counterModal && (
        <CSModal
          visible
          onDismiss={() => !counterBusy && setCounterModal(null)}
          header={t('admin_page.dmca_takedowns.counter_modal_title')}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={counterBusy} onClick={() => setCounterModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={counterBusy} onClick={doCounter}>{t('admin_page.common.submit')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSSpaceBetween size="m">
            <CSAlert type="info">{t('admin_page.dmca_takedowns.counter_info')}</CSAlert>
            <CSFormField label={t('admin_page.dmca_takedowns.counter_notes_label')}>
              <CSTextarea value={counterNotes} onChange={({ detail }) => setCounterNotes(detail.value)} rows={3} placeholder={t('admin_page.dmca_takedowns.counter_notes_placeholder')} />
            </CSFormField>
          </CSSpaceBetween>
        </CSModal>
      )}
    </CSSpaceBetween>
  );
}

/* ─────────────────────────────────────────────────────────────────
   页面 10：AdminDmcaStrikesPage — Strike 管理
   ───────────────────────────────────────────────────────────────── */
export function AdminDmcaStrikesPage() {
  const { t } = useTranslation();
  const [users, setUsers] = React.useState([]);
  const [threshold, setThreshold] = React.useState(3); // 终止阈值,以后端返回为准
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [strikeModal, setStrikeModal] = React.useState(null); // { user_id, username }
  const [strikeReason, setStrikeReason] = React.useState('');
  const [strikeBusy, setStrikeBusy] = React.useState(false);
  const [expanded, setExpanded] = React.useState(null); // user_id

  const load = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await window.api.admin.dmcaStrikes.list();
      setUsers(res.users || []);
      setThreshold(res.threshold || 3);
    } catch (e) {
      setErr(e?.message || t('admin_page.common.load_fail'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  async function doStrike() {
    if (!strikeModal) return;
    setStrikeBusy(true);
    try {
      const res = await window.api.admin.dmcaStrikes.increment(strikeModal.user_id, { reason: strikeReason });
      if (res.terminate) {
        window.toast?.(t('admin_page.dmca_strikes.strike_added_terminated', { count: res.strike_count }), { kind: 'danger', duration: 8000 });
      } else {
        window.toast?.(t('admin_page.dmca_strikes.strike_added_ok', { count: res.strike_count }), { kind: 'ok' });
      }
      setStrikeModal(null);
      setStrikeReason('');
      load();
    } catch (e) {
      window.toast?.(t('admin_page.dmca_strikes.op_fail') + ': ' + (e?.message || ''), { kind: 'danger' });
    } finally {
      setStrikeBusy(false);
    }
  }

  function strikeBadgeColor(count, limit) {
    if (count >= limit) return 'red';
    if (count === limit - 1) return 'severity-medium';
    return 'severity-low';
  }

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}
      <CSContainer
        header={
          <CSHeader
            variant="h2"
            description={t('admin_page.dmca_strikes.description')}
            actions={<CSButton iconName="refresh" onClick={load} loading={loading}>{t('admin_page.common.refresh')}</CSButton>}
          >
            {t('admin_page.dmca_strikes.title')}
          </CSHeader>
        }
      >
        <CSTable
          loading={loading}
          loadingText={t('admin_page.common.loading')}
          trackBy="user_id"
          items={users}
          empty={<CSBox textAlign="center" color="inherit">{t('admin_page.dmca_strikes.empty')}</CSBox>}
          columnDefinitions={[
            { id: 'username', header: t('admin_page.dmca_strikes.col_username'), cell: (u) => u.username || `uid:${u.user_id}` },
            {
              id: 'count', header: t('admin_page.dmca_strikes.col_count'),
              cell: (u) => (
                <CSSpaceBetween direction="horizontal" size="xs">
                  <CSBadge color={strikeBadgeColor(u.strike_count, threshold)}>{u.strike_count} / {threshold}</CSBadge>
                  {u.terminated_at && <CSBadge color="red">{t('admin_page.dmca_strikes.terminated')}</CSBadge>}
                </CSSpaceBetween>
              ),
            },
            {
              id: 'history', header: t('admin_page.dmca_strikes.col_history'),
              cell: (u) => {
                const isExp = expanded === u.user_id;
                return (
                  <div>
                    <CSButton variant="inline-link" onClick={() => setExpanded(isExp ? null : u.user_id)}>
                      {isExp ? t('admin_page.common.collapse') : t('admin_page.common.expand')}
                    </CSButton>
                    {isExp && (
                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12 }}>
                        {(u.strikes || []).map((s, i) => (
                          <li key={i}>
                            <code>{fmtTime(s.created_at)}</code>
                            {' — '}
                            {s.terminate ? `[${t('admin_page.dmca_strikes.terminated')}] ` : ''}{s.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              },
            },
            {
              id: 'actions', header: t('admin_page.common.actions'),
              cell: (u) => u.strike_count < threshold && (
                <CSButton
                  variant="inline-link"
                  onClick={() => { setStrikeModal({ user_id: u.user_id, username: u.username }); setStrikeReason(''); }}
                >
                  {t('admin_page.dmca_strikes.btn_add')}
                </CSButton>
              ),
            },
          ]}
        />
      </CSContainer>

      {strikeModal && (
        <CSModal
          visible
          onDismiss={() => !strikeBusy && setStrikeModal(null)}
          header={t('admin_page.dmca_strikes.strike_modal_title', { name: strikeModal.username })}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={strikeBusy} onClick={() => setStrikeModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={strikeBusy} onClick={doStrike}>{t('admin_page.dmca_strikes.strike_confirm_btn')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSSpaceBetween size="m">
            <CSAlert type="warning">{t('admin_page.dmca_strikes.strike_warning')}</CSAlert>
            <CSFormField label={t('admin_page.dmca_strikes.strike_reason_label')}>
              <CSTextarea
                value={strikeReason}
                onChange={({ detail }) => setStrikeReason(detail.value)}
                rows={3}
                placeholder={t('admin_page.dmca_strikes.strike_reason_placeholder')}
              />
            </CSFormField>
          </CSSpaceBetween>
        </CSModal>
      )}
    </CSSpaceBetween>
  );
}
