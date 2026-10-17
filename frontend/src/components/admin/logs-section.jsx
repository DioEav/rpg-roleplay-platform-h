/* Admin — AdminLogsPage — 系统日志。从 pages/admin.jsx 纯机械拆出,JSX / props / fetch 路径零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSAlert from '@cloudscape-design/components/alert';
import CSSelect from '@cloudscape-design/components/select';
import { downloadBlob } from '../../lib/download.js';

/* ─────────────────────────────────────────────────────────────────
   页面 5：AdminLogsPage — 系统日志
   ───────────────────────────────────────────────────────────────── */
export function AdminLogsPage() {
  const { t } = useTranslation();
  const [lines, setLines] = React.useState([]);
  const [source, setSource] = React.useState('file');
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [linesCount, setLinesCount] = React.useState({ value: '100', label: t('admin_page.logs.lines_100') });
  const [levelFilter, setLevelFilter] = React.useState({ value: '', label: t('admin_page.logs.level_all') });

  const linesOptions = [
    { value: '50', label: t('admin_page.logs.lines_50') },
    { value: '100', label: t('admin_page.logs.lines_100') },
    { value: '200', label: t('admin_page.logs.lines_200') },
    { value: '500', label: t('admin_page.logs.lines_500') },
  ];
  const levelOptions = [
    { value: '', label: t('admin_page.logs.level_all') },
    { value: 'ERROR', label: 'ERROR' },
    { value: 'WARN', label: 'WARN' },
    { value: 'INFO', label: 'INFO' },
  ];

  const fetchLogs = React.useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // level 走后端服务端过滤(logs.py 已支持);此前纯前端过滤只覆盖已拉取的尾部。
      const res = await window.api.admin.logs({ lines: Number(linesCount.value), level: levelFilter.value });
      setLines(res.lines || []);
      setSource(res.source || 'file');
    } catch (e) {
      setErr(e?.message || t('admin_page.common.load_fail'));
    } finally {
      setLoading(false);
    }
  }, [linesCount.value, levelFilter.value]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await window.api.admin.logs({ lines: Number(linesCount.value), level: levelFilter.value });
        if (!cancelled) {
          setLines(res.lines || []);
          setSource(res.source || 'file');
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || t('admin_page.common.load_fail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [linesCount.value, levelFilter.value]);

  function handleDownload() {
    const content = (lines || []).join('\n');
    downloadBlob(content, `system-logs-${Date.now()}.log`, 'text/plain');
  }

  function lineColor(line) {
    const s = typeof line === 'string' ? line : String(line);
    if (s.includes('ERROR')) return '#f87171';
    if (s.includes('WARN')) return '#fb923c';
    return undefined;
  }

  return (
    <CSSpaceBetween size="l">
      {err && <CSAlert type="error" header={t('admin_page.common.load_fail')}>{err}</CSAlert>}
      <CSContainer
        header={
          <CSHeader
            variant="h2"
            description={t('admin_page.logs.description')}
            actions={
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSSelect
                  selectedOption={linesCount}
                  options={linesOptions}
                  onChange={({ detail }) => setLinesCount(detail.selectedOption)}
                />
                <CSSelect
                  selectedOption={levelFilter}
                  options={levelOptions}
                  onChange={({ detail }) => setLevelFilter(detail.selectedOption)}
                />
                <CSButton iconName="download" onClick={handleDownload} disabled={!lines.length}>{t('admin_page.common.download')}</CSButton>
                <CSButton iconName="refresh" onClick={fetchLogs} loading={loading}>{t('admin_page.common.refresh')}</CSButton>
              </CSSpaceBetween>
            }
          >
            {t('admin_page.logs.title')}
          </CSHeader>
        }
      >
        {loading
          ? <CSBox color="inherit">{t('admin_page.common.loading')}</CSBox>
          : source === 'none'
            ? (
              <CSAlert type="info">
                {t('admin_page.logs.no_file_hint')}
              </CSAlert>
            )
            : lines.length === 0
              ? <CSBox textAlign="center" color="inherit">{t('admin_page.logs.empty')}</CSBox>
              : (
                  <pre style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, height: 500, overflowY: 'auto', margin: 0, padding: 8, background: 'var(--panel)', borderRadius: 4 }}>
                    {lines.map((line, i) => {
                      const s = typeof line === 'string' ? line : String(line);
                      const color = lineColor(s);
                      return (
                        <span key={i} style={color ? { color, display: 'block' } : { display: 'block' }}>
                          {s}
                        </span>
                      );
                    })}
                  </pre>
                )
        }
      </CSContainer>
    </CSSpaceBetween>
  );
}
