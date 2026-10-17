/* Admin — AdminAuditPage — 审计日志。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
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
import CSSelect from '@cloudscape-design/components/select';
import { fmtTime } from './shared.jsx';

/* ─────────────────────────────────────────────────────────────────
   页面 3：AdminAuditPage — 审计日志
   ───────────────────────────────────────────────────────────────── */
export function AdminAuditPage() {
  const { t } = useTranslation();
  const [items, setItems] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [page, setPage] = React.useState(1);
  const limit = 50;
  const [actionFilter, setActionFilter] = React.useState({ value: '', label: t('admin_page.audit.filter_all') });
  const [expandedDetail, setExpandedDetail] = React.useState(null);

  const actionOptions = [
    { value: '', label: t('admin_page.audit.filter_all') },
    { value: 'user', label: 'user.*' },
    { value: 'config', label: 'config.*' },
    { value: 'maintenance', label: 'maintenance.*' },
    { value: 'invite', label: 'invite.*' },
  ];

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        // 后端 /api/admin/audit 契约:筛选参数名是 action_type(前缀匹配 action 列),
        // 响应为 { entries, total, page, limit },行字段 actor_username/action/target_type/target_id/details/ip/created_at。
        // 此前发 action_prefix、读 res.items/res.logs、列读 operator/target/detail 等臆造字段,筛选失效且多数列恒 "—"。
        const params = { page, limit };
        if (actionFilter.value) params.action_type = actionFilter.value;
        const res = await window.api.admin.auditLog(params);
        if (!cancelled) {
          setItems(res.entries || []);
          setTotal(res.total || 0);
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || t('admin_page.common.load_fail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [page, actionFilter.value]);

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}
      <CSContainer
        header={
          <CSHeader
            variant="h2"
            description={t('admin_page.audit.description')}
            actions={
              <CSSelect
                selectedOption={actionFilter}
                options={actionOptions}
                onChange={({ detail }) => { setActionFilter(detail.selectedOption); setPage(1); }}
              />
            }
          >
            {t('admin_page.audit.title')}
          </CSHeader>
        }
      >
        <CSSpaceBetween size="m">
          <CSTable
            loading={loading}
            loadingText={t('admin_page.common.loading')}
            trackBy="id"
            items={items}
            empty={<CSBox textAlign="center" color="inherit">{t('admin_page.audit.empty')}</CSBox>}
            columnDefinitions={[
              { id: 'created_at', header: t('admin_page.audit.col_time'), cell: (r) => fmtTime(r.created_at || r.timestamp) },
              { id: 'operator', header: t('admin_page.audit.col_operator'), cell: (r) => r.actor_username || '—' },
              {
                id: 'action_type', header: t('admin_page.audit.col_action_type'),
                cell: (r) => <CSBadge color="blue">{r.action_type || r.action || '—'}</CSBadge>,
              },
              { id: 'target', header: t('admin_page.audit.col_target'), cell: (r) => (r.target_type ? `${r.target_type}${r.target_id ? ` #${r.target_id}` : ''}` : '—') },
              {
                id: 'detail', header: t('admin_page.audit.col_detail'),
                cell: (r) => {
                  const key = r.id || r.created_at;
                  const raw = r.details;
                  if (!raw) return '—';
                  const str = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
                  const isExpanded = expandedDetail === key;
                  return (
                    <div>
                      <CSButton variant="inline-link" onClick={() => setExpandedDetail(isExpanded ? null : key)}>
                        {isExpanded ? t('admin_page.common.collapse') : t('admin_page.common.expand')}
                      </CSButton>
                      {isExpanded && <pre style={{ fontSize: 11, maxWidth: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0 0' }}>{str}</pre>}
                    </div>
                  );
                },
              },
              { id: 'ip', header: t('admin_page.audit.col_ip'), cell: (r) => r.ip || r.ip_address || '—' },
            ]}
            pagination={
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSButton disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('admin_page.common.prev_page')}</CSButton>
                <CSBox padding="xs">{t('admin_page.common.page_simple', { page })}</CSBox>
                <CSButton disabled={items.length < limit} onClick={() => setPage(p => p + 1)}>{t('admin_page.common.next_page')}</CSButton>
              </CSSpaceBetween>
            }
          />
        </CSSpaceBetween>
      </CSContainer>
    </CSSpaceBetween>
  );
}
