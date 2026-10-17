/* MobileAdmin — SectionLogs(admin-logs)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow, EmptyRow } from './shared.jsx';

/* ══════════════════════════════════════════
   Section: admin-logs
══════════════════════════════════════════ */
function SectionLogs({ nav }) {
  const { t } = useTranslation();
  const [lines, setLines] = React.useState([]);
  const [source, setSource] = React.useState('file');
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [lineCount, setLineCount] = React.useState(100);
  const [levelFilter, setLevelFilter] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      // level 走后端服务端过滤(logs.py 已支持);此前纯前端过滤只覆盖已拉取的尾部。
      const r = await window.api.admin.logs({ lines: lineCount, level: levelFilter });
      setLines(r.lines || []); setSource(r.source || 'file');
    }
    catch (e) { setErr(e?.message || t('mobile.admin.load_failed')); }
    finally { setLoading(false); }
  }, [lineCount, levelFilter]);

  React.useEffect(() => { load(); }, [load]);

  function lineColor(line) {
    const s = String(line);
    if (s.includes('ERROR')) return 'var(--danger)';
    if (s.includes('WARN')) return 'var(--warn)';
    return 'var(--text-quiet)';
  }

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.logs')}</strong></div>
        <button className="pl-headbtn" onClick={load} disabled={loading}><Icon name="refresh" size={18} /></button>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            {[50, 100, 200].map((n) => (
              <button key={n} onClick={() => setLineCount(n)}
                style={{ padding: '4px 12px', borderRadius: 999, fontSize: 12, border: '1px solid', borderColor: lineCount === n ? 'var(--accent-edge)' : 'var(--line)', background: lineCount === n ? 'var(--accent-soft)' : 'var(--panel-2)', color: lineCount === n ? 'var(--accent)' : 'var(--muted)' }}>
                {t('mobile.admin.logs.lines', { count: n })}
              </button>
            ))}
            {[['', t('common.all')], ['ERROR', 'ERROR'], ['WARN', 'WARN']].map(([v, l]) => (
              <button key={v} onClick={() => setLevelFilter(v)}
                style={{ padding: '4px 12px', borderRadius: 999, fontSize: 12, border: '1px solid', borderColor: levelFilter === v ? 'var(--accent-edge)' : 'var(--line)', background: levelFilter === v ? 'var(--accent-soft)' : 'var(--panel-2)', color: levelFilter === v ? 'var(--accent)' : 'var(--muted)' }}>
                {l}
              </button>
            ))}
          </div>

          {loading ? <LoadingRow /> : err ? <ErrRow msg={err} onRetry={load} /> : source === 'none' ? (
            <div style={{ border: '1px solid var(--line-soft)', borderRadius: 10, background: 'var(--panel)', padding: '12px 14px', fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
              {t('mobile.admin.logs.no_file_hint')}
            </div>
          ) : lines.length === 0 ? <EmptyRow text={t('mobile.admin.logs.empty')} /> : (
            <div style={{ background: 'var(--bg-deep)', borderRadius: 10, border: '1px solid var(--line-soft)', padding: '10px 12px', maxHeight: '60vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
              {lines.map((line, i) => (
                <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7, color: lineColor(line), wordBreak: 'break-all' }}>{String(line)}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export { SectionLogs };
