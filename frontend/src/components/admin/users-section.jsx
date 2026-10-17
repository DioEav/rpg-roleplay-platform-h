/* Admin — AdminUsersPage — 用户管理。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
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
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';
import CSModal from '@cloudscape-design/components/modal';
import { fmtTime } from './shared.jsx';

/* ─────────────────────────────────────────────────────────────────
   页面 1：AdminUsersPage — 用户管理
   ───────────────────────────────────────────────────────────────── */
export function AdminUsersPage() {
  const { t } = useTranslation();
  const [users, setUsers] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [page, setPage] = React.useState(1);
  const limit = 20;
  const [search, setSearch] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState({ value: '', label: t('admin_page.users.role_all') });
  const [statusFilter, setStatusFilter] = React.useState({ value: '', label: t('admin_page.users.status_all') });

  // 确认 modal 状态
  const [confirmModal, setConfirmModal] = React.useState(null); // { action, user, title, body }
  const [actionBusy, setActionBusy] = React.useState(false);

  const me = window.RPG_AUTH && window.RPG_AUTH.user;

  const load = React.useCallback(async (p = page) => {
    setLoading(true);
    setErr(null);
    let cancelled = false;
    try {
      const params = { page: p, limit };
      if (search) params.search = search;
      if (roleFilter.value) params.role = roleFilter.value;
      if (statusFilter.value) params.status = statusFilter.value;
      const res = await window.api.admin.users(params);
      if (!cancelled) {
        setUsers(res.users || res.items || res || []);
        setTotal(res.total || (res.users || res.items || res || []).length);
      }
    } catch (e) {
      if (!cancelled) setErr(e?.message || t('admin_page.common.load_fail'));
    } finally {
      if (!cancelled) setLoading(false);
    }
    return () => { cancelled = true; };
  }, [page, search, roleFilter.value, statusFilter.value]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const params = { page, limit };
        if (search) params.search = search;
        if (roleFilter.value) params.role = roleFilter.value;
        if (statusFilter.value) params.status = statusFilter.value;
        const res = await window.api.admin.users(params);
        if (!cancelled) {
          setUsers(res.users || res.items || res || []);
          setTotal(res.total || (res.users || res.items || res || []).length);
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || t('admin_page.common.load_fail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [page, roleFilter.value, statusFilter.value]);

  async function doAction() {
    if (!confirmModal) return;
    setActionBusy(true);
    try {
      const { action, user } = confirmModal;
      if (action === 'deactivate') await window.api.admin.deactivateUser(user.id);
      else if (action === 'reactivate') await window.api.admin.reactivateUser(user.id);
      else if (action === 'force-logout') await window.api.admin.forceLogout(user.id);
      else if (action === 'set-admin') await window.api.admin.updateUser(user.id, { role: 'admin' });
      else if (action === 'set-user') await window.api.admin.updateUser(user.id, { role: 'user' });
      window.toast?.(t('admin_page.common.op_ok'), { kind: 'ok' });
      setConfirmModal(null);
      load(page);
    } catch (e) {
      window.toast?.(t('admin_page.common.op_fail') + ': ' + (e?.message || t('common.unknown')), { kind: 'danger' });
    } finally {
      setActionBusy(false);
    }
  }

  const roleOptions = [
    { value: '', label: t('admin_page.users.role_all') },
    { value: 'admin', label: t('admin_page.users.role_admin') },
    { value: 'user', label: t('admin_page.users.role_user') },
  ];
  const statusOptions = [
    { value: '', label: t('admin_page.users.status_all') },
    { value: 'active', label: t('admin_page.users.status_active') },
    { value: 'deactivated', label: t('admin_page.users.status_deactivated') },
  ];

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}
      <CSContainer
        header={
          <CSHeader
            variant="h2"
            description={t('admin_page.users.description')}
            actions={
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton iconName="refresh" onClick={() => load(page)} loading={loading}>{t('admin_page.common.refresh')}</CSButton>
              </CSSpaceBetween>
            }
          >
            {t('admin_page.users.title')}
          </CSHeader>
        }
      >
        <CSSpaceBetween size="m">
          <CSSpaceBetween direction="horizontal" size="xs">
            <CSInput
              placeholder={t('admin_page.users.search_placeholder')}
              value={search}
              onChange={({ detail }) => setSearch(detail.value)}
              onKeyDown={({ detail }) => { if (detail.key === 'Enter') { setPage(1); load(1); } }}
              type="search"
            />
            <CSSelect
              selectedOption={roleFilter}
              options={roleOptions}
              onChange={({ detail }) => { setRoleFilter(detail.selectedOption); setPage(1); }}
            />
            <CSSelect
              selectedOption={statusFilter}
              options={statusOptions}
              onChange={({ detail }) => { setStatusFilter(detail.selectedOption); setPage(1); }}
            />
          </CSSpaceBetween>
          <CSTable
            loading={loading}
            loadingText={t('admin_page.common.loading')}
            trackBy="id"
            items={users}
            empty={
              <CSBox textAlign="center" color="inherit">
                <CSBox padding={{ bottom: 's' }} variant="p" color="inherit">{t('admin_page.users.empty')}</CSBox>
              </CSBox>
            }
            columnDefinitions={[
              { id: 'username', header: t('admin_page.users.col_username'), cell: (u) => u.username || u.name || '—' },
              { id: 'display_name', header: t('admin_page.users.col_display_name'), minWidth: 80, cell: (u) => u.display_name || '—' },
              {
                id: 'role', header: t('admin_page.users.col_role'), minWidth: 120,
                cell: (u) => u.role === 'admin'
                  ? <CSBadge color="severity-medium">{t('admin_page.users.role_admin')}</CSBadge>
                  : <CSBadge color="grey">{t('admin_page.users.role_user')}</CSBadge>,
              },
              {
                id: 'status', header: t('admin_page.users.col_status'), minWidth: 100,
                cell: (u) => u.deactivated_at
                  ? <CSStatusIndicator type="stopped">{t('admin_page.users.status_stopped')}</CSStatusIndicator>
                  : <CSStatusIndicator type="success">{t('admin_page.users.status_active_label')}</CSStatusIndicator>,
              },
              { id: 'last_login', header: t('admin_page.users.col_last_login'), cell: (u) => fmtTime(u.last_login_at || u.last_login) },
              {
                id: 'token_30d', header: t('admin_page.users.col_token_30d'),
                cell: (u) => typeof u.usage_tokens_30d === 'number' ? u.usage_tokens_30d.toLocaleString() : '—',
              },
              {
                id: 'sessions', header: t('admin_page.users.col_sessions'),
                cell: (u) => typeof u.session_count === 'number' ? u.session_count : '—',
              },
              {
                id: 'actions', header: t('admin_page.common.actions'), minWidth: 200,
                cell: (u) => {
                  const isSelf = me && (me.id === u.id || me.username === u.username);
                  return (
                    <CSSpaceBetween direction="horizontal" size="xs">
                      {!u.deactivated_at && (
                        <CSButton
                          variant="inline-link"
                          disabled={isSelf}
                          onClick={() => setConfirmModal({
                            action: 'deactivate', user: u,
                            title: t('admin_page.users.confirm_deactivate_title', { name: u.username }),
                            body: t('admin_page.users.confirm_deactivate_body'),
                          })}
                        >{t('admin_page.users.deactivate')}</CSButton>
                      )}
                      {u.deactivated_at && (
                        <CSButton
                          variant="inline-link"
                          onClick={() => setConfirmModal({
                            action: 'reactivate', user: u,
                            title: t('admin_page.users.confirm_reactivate_title', { name: u.username }),
                            body: t('admin_page.users.confirm_reactivate_body'),
                          })}
                        >{t('admin_page.users.reactivate')}</CSButton>
                      )}
                      <CSButton
                        variant="inline-link"
                        onClick={() => setConfirmModal({
                          action: 'force-logout', user: u,
                          title: t('admin_page.users.confirm_force_logout_title', { name: u.username }),
                          body: t('admin_page.users.confirm_force_logout_body'),
                        })}
                      >{t('admin_page.users.force_logout')}</CSButton>
                      {u.role === 'user' && !isSelf && (
                        <CSButton
                          variant="inline-link"
                          onClick={() => setConfirmModal({
                            action: 'set-admin', user: u,
                            title: t('admin_page.users.confirm_set_admin_title', { name: u.username }),
                            body: t('admin_page.users.confirm_set_admin_body'),
                          })}
                        >{t('admin_page.users.set_admin')}</CSButton>
                      )}
                      {u.role === 'admin' && !isSelf && (
                        <CSButton
                          variant="inline-link"
                          onClick={() => setConfirmModal({
                            action: 'set-user', user: u,
                            title: t('admin_page.users.confirm_set_user_title', { name: u.username }),
                            body: t('admin_page.users.confirm_set_user_body'),
                          })}
                        >{t('admin_page.users.set_user')}</CSButton>
                      )}
                    </CSSpaceBetween>
                  );
                },
              },
            ]}
            pagination={
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('admin_page.common.prev_page')}</CSButton>
                <CSBox padding="xs">{t('admin_page.common.page_info', { page, total: Math.ceil(total / limit) })}</CSBox>
                <CSButton disabled={users.length < limit} onClick={() => setPage(p => p + 1)}>{t('admin_page.common.next_page')}</CSButton>
              </CSSpaceBetween>
            }
          />
        </CSSpaceBetween>
      </CSContainer>

      {confirmModal && (
        <CSModal
          visible
          onDismiss={() => !actionBusy && setConfirmModal(null)}
          header={confirmModal.title}
          footer={
            <CSBox float="right">
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton variant="link" disabled={actionBusy} onClick={() => setConfirmModal(null)}>{t('admin_page.common.cancel')}</CSButton>
                <CSButton variant="primary" loading={actionBusy} onClick={doAction}>{t('admin_page.common.confirm')}</CSButton>
              </CSSpaceBetween>
            </CSBox>
          }
        >
          <CSBox>{confirmModal.body}</CSBox>
        </CSModal>
      )}
    </CSSpaceBetween>
  );
}
