/* Admin — AdminGlobalUsagePage — 全局用量。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSTable from '@cloudscape-design/components/table';
import CSBox from '@cloudscape-design/components/box';
import CSAlert from '@cloudscape-design/components/alert';
import CSSelect from '@cloudscape-design/components/select';
import CSKeyValuePairs from '@cloudscape-design/components/key-value-pairs';

/* ─────────────────────────────────────────────────────────────────
   页面 2：AdminGlobalUsagePage — 全局用量
   ───────────────────────────────────────────────────────────────── */
export function AdminGlobalUsagePage() {
  const { t } = useTranslation();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [days, setDays] = React.useState({ value: '30', label: t('admin_page.usage.days_30') });

  const daysOptions = [
    { value: '7', label: t('admin_page.usage.days_7') },
    { value: '14', label: t('admin_page.usage.days_14') },
    { value: '30', label: t('admin_page.usage.days_30') },
    { value: '90', label: t('admin_page.usage.days_90') },
  ];

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await window.api.admin.globalUsage({ days: Number(days.value) });
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) setErr(e?.message || t('admin_page.common.load_fail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [days.value]);

  // 后端 /api/admin/usage 返回的键是 total(非 summary),字段是 requests/total_tokens/cost_usd。
  // 此前读 data?.summary / total_requests / total_cost 等臆造字段名,整页数字恒 0 或 "—"。
  const summary = data?.total || {};
  const byUser = data?.by_user || [];
  const byApi = data?.by_api || [];
  const byDay = data?.by_day || [];
  const maxDayTokens = byDay.reduce((m, d) => Math.max(m, d.total_tokens || 0), 1);

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}

      <CSContainer
        header={
          <CSHeader
            variant="h2"
            description={t('admin_page.usage.description')}
            actions={
              <CSSelect
                selectedOption={days}
                options={daysOptions}
                onChange={({ detail }) => setDays(detail.selectedOption)}
              />
            }
          >
            {t('admin_page.usage.title')}
          </CSHeader>
        }
      >
        {loading
          ? <CSBox color="inherit">{t('admin_page.common.loading')}</CSBox>
          : !data
            ? <CSBox color="inherit" textAlign="center">{t('admin_page.usage.empty')}</CSBox>
            : (
              // 成本卡片已隐藏(2026-10,应要求):恢复 = 解注释下方 cost 项并改回 columns={3}。
              <CSKeyValuePairs
                columns={2}
                items={[
                  { label: t('admin_page.usage.kv_requests'), value: (summary.requests || 0).toLocaleString() },
                  { label: t('admin_page.usage.kv_tokens'), value: (summary.total_tokens || 0).toLocaleString() },
                  // { label: t('admin_page.usage.kv_cost'), value: typeof summary.cost_usd === 'number' ? `$${summary.cost_usd.toFixed(4)}` : '—' },
                ]}
              />
            )
        }
      </CSContainer>

      <CSContainer header={<CSHeader variant="h2">{t('admin_page.usage.by_user')}</CSHeader>}>
        <CSTable
          loading={loading}
          loadingText={t('admin_page.common.loading')}
          trackBy="user_id"
          items={byUser}
          empty={<CSBox textAlign="center" color="inherit">{t('admin_page.usage.empty_generic')}</CSBox>}
          columnDefinitions={[
            { id: 'rank', header: t('admin_page.usage.col_rank'), cell: (_, idx) => idx + 1, width: 50 },
            { id: 'username', header: t('admin_page.usage.col_username'), cell: (u) => u.username || u.user_id || '—' },
            { id: 'tokens', header: t('admin_page.usage.col_tokens'), cell: (u) => (u.total_tokens || 0).toLocaleString() },
            // 成本列已隐藏(2026-10,应要求):恢复 = 解注释本行(按用户表)。
            // { id: 'cost', header: t('admin_page.usage.col_cost'), cell: (u) => typeof u.cost_usd === 'number' ? `$${u.cost_usd.toFixed(4)}` : '—' },
            {
              id: 'pct', header: t('admin_page.usage.col_pct'),
              cell: (u) => {
                const pct = summary.total_tokens > 0 ? Math.round((u.total_tokens / summary.total_tokens) * 100) : 0;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 6, background: 'var(--panel-2)', borderRadius: 3 }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--ok-soft)', borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 12, minWidth: 30 }}>{pct}%</span>
                  </div>
                );
              },
            },
          ]}
        />
      </CSContainer>

      <CSContainer header={<CSHeader variant="h2">{t('admin_page.usage.by_api')}</CSHeader>}>
        <CSTable
          loading={loading}
          loadingText={t('admin_page.common.loading')}
          trackBy="api_id"
          items={byApi}
          empty={<CSBox textAlign="center" color="inherit">{t('admin_page.usage.empty_generic')}</CSBox>}
          columnDefinitions={[
            { id: 'api_id', header: t('admin_page.usage.col_api'), cell: (a) => a.api_id || a.api || '—' },
            { id: 'tokens', header: t('admin_page.usage.col_token'), cell: (a) => (a.total_tokens || 0).toLocaleString() },
            // 成本列已隐藏(2026-10,应要求):恢复 = 解注释本行(按 API 表)。
            // { id: 'cost', header: t('admin_page.usage.col_cost'), cell: (a) => typeof a.cost_usd === 'number' ? `$${a.cost_usd.toFixed(4)}` : '—' },
          ]}
        />
      </CSContainer>

      <CSContainer header={<CSHeader variant="h2">{t('admin_page.usage.by_day')}</CSHeader>}>
        {loading
          ? <CSBox color="inherit">{t('admin_page.common.loading')}</CSBox>
          : byDay.length === 0
            ? <CSBox textAlign="center" color="inherit">{t('admin_page.usage.empty_generic')}</CSBox>
            : (
              <CSSpaceBetween size="xs">
                {byDay.map((d) => {
                  const barPct = Math.max(2, Math.round((d.total_tokens || 0) / maxDayTokens * 100));
                  return (
                    <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                      <span style={{ minWidth: 90, color: 'var(--muted)' }}>{d.date}</span>
                      <div style={{ flex: 1, height: 14, background: 'var(--panel-2)', borderRadius: 3 }}>
                        <div style={{ width: `${barPct}%`, height: '100%', background: 'var(--info)', borderRadius: 3 }} />
                      </div>
                      <span style={{ minWidth: 80, textAlign: 'right' }}>{(d.total_tokens || 0).toLocaleString()}</span>
                    </div>
                  );
                })}
              </CSSpaceBetween>
            )
        }
      </CSContainer>
    </CSSpaceBetween>
  );
}
