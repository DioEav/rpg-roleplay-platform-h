/* MobileAdmin — SectionHealth(admin-health)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { LoadingRow, ErrRow } from './shared.jsx';

/* ══════════════════════════════════════════
   Section: admin-health
══════════════════════════════════════════ */
function SectionHealth({ nav }) {
  const { t } = useTranslation();
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);

  const load = React.useCallback(async () => {
    setLoading(true); setErr(null);
    try { const r = await window.api.admin.health(); setData(r); }
    catch (e) { setErr(e?.message || t('mobile.admin.load_failed')); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  // 后端契约:{ db, process:{pid,uptime_s,memory_rss_mb}, disk:{percent_used} }。
  // 此前读 data?.memory 与 disk.used_percent(后端无此键/字段),内存/磁盘两行恒 "—"。
  const db = data?.database || data?.db || {};
  const disk = data?.disk || {};
  const proc = data?.process || data?.proc || {};

  const rows = data ? [
    { key: t('mobile.admin.health.database'), ok: db.ok !== false, val: db.ok !== false ? `online${typeof db.latency_ms === 'number' ? ` · ${db.latency_ms}ms` : ''}` : t('mobile.admin.health.offline'), icon: 'cpu' },
    { key: t('mobile.admin.health.memory'), ok: typeof proc.memory_rss_mb === 'number', val: typeof proc.memory_rss_mb === 'number' ? `RSS ${proc.memory_rss_mb} MB` : '—', icon: 'layers' },
    { key: t('mobile.admin.health.disk'), ok: (disk.percent_used || 0) < 90, val: disk.percent_used != null ? t('mobile.admin.health.disk_used', { pct: disk.percent_used }) : '—', icon: 'folder' },
    { key: t('mobile.admin.health.process'), ok: !!proc.pid, val: proc.pid ? `PID ${proc.pid}${proc.uptime_s ? ` · ${Math.round(proc.uptime_s / 60)}min` : ''}` : '—', icon: 'plug' },
  ] : [];

  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.go('admin')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.section.health')}</strong></div>
        <button className="pl-headbtn" onClick={load} disabled={loading}><Icon name="refresh" size={18} /></button>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          {loading && !data ? <LoadingRow /> : err ? <ErrRow msg={err} onRetry={load} /> : (
            <div className="pl-sec">
              {rows.map((r) => (
                <div key={r.key} className="pl-row" style={{ cursor: 'default' }}>
                  <span className={`pl-row-ic ${r.ok ? 'ok' : 'warn'}`}><Icon name={r.icon} size={17} /></span>
                  <span className="pl-row-tx">
                    <strong style={{ fontSize: 13.5 }}>{r.key}</strong>
                    <span className="mono">{r.val}</span>
                  </span>
                  <span style={{ fontSize: 11, color: r.ok ? 'var(--ok)' : 'var(--danger)', fontFamily: 'var(--font-mono)' }}>{r.ok ? 'OK' : 'FAIL'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export { SectionHealth };
