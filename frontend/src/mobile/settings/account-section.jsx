import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { useReactiveUser } from '../../platform-app.jsx';
import { Field as MField } from '../Field.jsx';
import { SetGroup, Toggle } from './shared.jsx';
import { ONLINE_BASE } from '../../lib/brand.js';

/* ────────────────────────────────────────────────────────────────── */
/* SECTION: 账户 (account)                                             */
/* ────────────────────────────────────────────────────────────────── */
function AccountSection({ nav }) {
  const { t } = useTranslation();
  const user = useReactiveUser();
  const isCoBuilder = user?.is_co_builder === true;
  const [cbChecked, setCbChecked] = useState(() => !user?.co_builder_opt_out);
  const [cbSaving, setCbSaving] = useState(false);

  useEffect(() => { setCbChecked(!user?.co_builder_opt_out); }, [user?.co_builder_opt_out]);

  const handleCoBuilder = async (v) => {
    setCbChecked(v); setCbSaving(true);
    try {
      await fetch('/api/me/profile', {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ co_builder_opt_out: !v }),
      });
      nav.toast(t('mobile.settings.account.co_builder_saved'), 'ok', 'check');
    } catch (e) {
      nav.toast(t('mobile.settings.account.save_failed'), 'danger', 'warn');
      setCbChecked(!v);
    } finally { setCbSaving(false); }
  };

  // API 用量(30天)
  const [usage, setUsage] = useState(null);
  useEffect(() => {
    window.api?.account?.usage?.(30).then(setUsage).catch(() => {});
  }, []);

  // 数据迁移
  const [est, setEst] = useState(null);
  const [includeChunks, setIncludeChunks] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importJob, setImportJob] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    window.api?.account?.migrateEstimate?.().then(setEst).catch(() => {});
  }, []);

  const doExport = () => {
    setExporting(true);
    try {
      const url = window.api.account.migrateExportUrl(includeChunks);
      const a = document.createElement('a'); a.href=url; a.rel='noopener';
      document.body.appendChild(a); a.click(); a.remove();
      nav.toast(t('mobile.settings.account.export_started'), 'ok', 'download');
    } catch (e) { nav.toast(t('mobile.settings.account.export_failed', { msg: e?.message||'' }), 'danger', 'warn'); }
    finally { setTimeout(() => setExporting(false), 800); }
  };

  const finishJob = async (jobId) => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current=null; }
    if (esRef.current) { try { esRef.current.close?.(); } catch {} esRef.current=null; }
    try {
      const s = await window.api.scripts.jobStatus(jobId);
      const job = s?.job || {};
      const summary = (job.usage_actual && job.usage_actual.summary) || {};
      setImportResult({ scripts: summary.scripts??0, saves: summary.saves??0, cards: summary.cards??0, warnings: job.warnings||[] });
      nav.toast(t('mobile.settings.account.import_done_toast', { scripts: summary.scripts??0, saves: summary.saves??0, cards: summary.cards??0 }), 'ok', 'check');
    } catch (e) { nav.toast(t('mobile.settings.account.import_failed', { msg: e?.message||'' }), 'danger', 'warn'); }
    finally { setImportJob(null); setImporting(false); }
  };

  const doImport = async () => {
    if (!importFile) return;
    setImporting(true); setImportResult(null); setImportJob({ stage:'scripts', stage_progress:0, stage_total:0 });
    let jobId=null;
    try {
      const r = await window.api.account.migrateImport(importFile);
      jobId = r?.job_id;
      if (!jobId) throw new Error(r?.error || t('mobile.settings.account.import_no_job_id'));
    } catch (e) {
      setImporting(false); setImportJob(null);
      nav.toast(t('mobile.settings.account.import_failed', { msg: e?.payload?.error || e?.message || '' }), 'danger', 'warn');
      return;
    }
    const isTerminal = (st) => ['done','done_with_errors','failed','cancelled'].includes(st);
    esRef.current = window.api.scripts.streamImport(jobId, {
      on_update: (jb) => { setImportJob(jb); if (isTerminal(jb.status)) finishJob(jobId); },
      on_done: () => finishJob(jobId),
      on_error: () => {
        if (pollRef.current) return;
        pollRef.current = setInterval(async () => {
          try {
            const s = await window.api.scripts.jobStatus(jobId);
            const j = s?.job; if (!j) return;
            setImportJob(j);
            if (isTerminal(j.status)) finishJob(jobId);
          } catch {}
        }, 2000);
      },
    });
  };

  useEffect(() => () => {
    if (esRef.current) { try { esRef.current.close?.(); } catch {} }
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // 在线剧本库联邦
  const [conn, setConn] = useState(null);
  const DEFAULT_ONLINE_BASE = ONLINE_BASE;
  const reloadConn = useCallback(async () => {
    try { setConn(await window.api.federation.connectorGet()); }
    catch { setConn({ connected: false, base_url: DEFAULT_ONLINE_BASE }); }
  }, []);
  useEffect(() => { reloadConn(); }, [reloadConn]);

  const [connBase, setConnBase] = useState(DEFAULT_ONLINE_BASE);
  const [connToken, setConnToken] = useState('');
  const [connBusy, setConnBusy] = useState(false);

  useEffect(() => { if (conn?.base_url) setConnBase(conn.base_url); }, [conn?.base_url]);

  const savePat = async () => {
    if (!connToken.trim()) { nav.toast(t('mobile.settings.account.pat_empty'), 'warn', 'key'); return; }
    setConnBusy(true);
    try {
      await window.api.federation.connectorSet(connBase.trim(), connToken.trim());
      nav.toast(t('mobile.settings.account.federation_connected'), 'ok', 'check');
      setConnToken(''); reloadConn();
    } catch (e) { nav.toast(t('mobile.settings.account.federation_connect_failed', { msg: e?.payload?.error||e?.message||'' }), 'danger', 'warn'); }
    finally { setConnBusy(false); }
  };

  const disconnect = async () => {
    setConnBusy(true);
    try { await window.api.federation.connectorSet(connBase.trim(), ''); nav.toast(t('mobile.settings.account.federation_disconnected'), 'ok', 'unlock'); reloadConn(); }
    catch (e) { nav.toast(t('mobile.settings.account.operation_failed'), 'danger', 'warn'); }
    finally { setConnBusy(false); }
  };

  const initial = (user?.display_name || '?').slice(0, 1);

  return (
    <>
      {/* 用户信息卡 */}
      <div style={{ display:'flex', gap:14, alignItems:'center', marginBottom:18 }}>
        <div style={{ width:60, height:60, borderRadius:18, background:'var(--accent)', color:'#fff8f3',
          display:'grid', placeItems:'center', font:'600 24px var(--font-serif)', flexShrink:0 }}>
          {initial}
        </div>
        <div>
          <div style={{ fontSize:17, fontFamily:'var(--font-serif)', color:'var(--text)' }}>
            {user?.display_name || '—'}
          </div>
          <div style={{ fontSize:12, color:'var(--muted)' }}>
            @{user?.username || '—'} · {user?.role || 'user'}
          </div>
        </div>
      </div>

      {/* 30 天用量 */}
      {usage && (
        <div className="pl-sec" style={{ marginBottom: 18 }}>
          <div className="pl-sec-head"><h2>{t('mobile.settings.account.api_usage')}</h2></div>
          <div className="pl-stats">
            <div className="pl-stat">
              <span className="n accent">{(usage.total_tokens||0).toLocaleString()}</span>
              <div className="l">{t('mobile.settings.account.total_tokens')}</div>
            </div>
            <div className="pl-stat">
              <span className="n">{(usage.total_calls||0).toLocaleString()}</span>
              <div className="l">{t('mobile.settings.account.total_calls')}</div>
            </div>
            <div className="pl-stat">
              <span className="n">{(usage.cache_hit_rate != null ? `${Math.round(usage.cache_hit_rate*100)}%` : '—')}</span>
              <div className="l">{t('mobile.settings.account.cache_hit')}</div>
            </div>
          </div>
        </div>
      )}

      {/* Co-Builder 计划 */}
      <SetGroup title={t('mobile.settings.account.account_settings')}>
        <div className="pl-setrow">
          <div className="pl-setrow-tx">
            <strong>{t('mobile.settings.account.co_builder_title')}</strong>
            <span>{isCoBuilder ? t('mobile.settings.account.co_builder_active') : t('mobile.settings.account.co_builder_inactive')}</span>
          </div>
          {isCoBuilder ? (
            <Toggle on={cbChecked} onChange={handleCoBuilder} />
          ) : (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('mobile.settings.account.co_builder_unavailable')}</span>
          )}
        </div>
      </SetGroup>

      {/* 数据迁移 */}
      <div className="pl-sec" style={{ marginTop: 18 }}>
        <div className="pl-sec-head"><h2>{t('mobile.settings.account.data_migration')}</h2></div>
        <div className="pl-card" style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
            {t('mobile.settings.account.data_migration_desc')}
            {est && (
              <div style={{ marginTop: 6, color: 'var(--text-quiet)' }}>
                {t('mobile.settings.account.data_migration_est', { scripts: est.scripts??0, saves: est.saves??0, cards: est.cards??0, model_entries: est.model_entries??0 })}
              </div>
            )}
          </div>

          {/* 包含切片 */}
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <Toggle on={includeChunks} onChange={setIncludeChunks} />
            <span style={{ fontSize: 12.5, color: 'var(--text-quiet)' }}>{t('mobile.settings.account.include_chunks')}</span>
          </div>

          <button className="pl-btn-primary" disabled={exporting} onClick={doExport}>
            <Icon name="download" size={16} /> {exporting ? t('mobile.settings.account.export_preparing') : t('mobile.settings.account.export_btn')}
          </button>

          {/* 导入 */}
          <div>
            <label style={{ fontSize: 12.5, color: 'var(--text-quiet)', display: 'block', marginBottom: 8 }}>
              {t('mobile.settings.account.import_label')}
            </label>
            <input
              ref={fileRef} type="file" accept=".zip,application/zip"
              onChange={(e) => { setImportFile(e.target.files?.[0]||null); setImportResult(null); }}
              style={{ fontSize: 13, color: 'var(--text-quiet)', marginBottom: 8 }}
            />
            <button className="pl-btn-ghost" disabled={!importFile||importing} onClick={doImport}>
              <Icon name="upload" size={14} /> {importing ? t('mobile.settings.account.importing') : t('mobile.settings.account.import_btn')}
            </button>
          </div>

          {/* 导入进度 */}
          {importJob && (
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-quiet)', marginBottom: 6 }}>
                {{ scripts: t('mobile.settings.account.stage_scripts'), saves: t('mobile.settings.account.stage_saves'), cards: t('mobile.settings.account.stage_cards'), done: t('mobile.settings.account.stage_done') }[importJob.stage] || importJob.stage || t('mobile.settings.account.stage_processing')}
                {importJob.stage_total ? ` ${importJob.stage_progress||0}/${importJob.stage_total}` : '...'}
              </div>
              <div style={{ height:5, background:'var(--panel-3)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', background:'var(--accent)', borderRadius:3,
                  width: `${importJob.stage_total ? Math.round(100*(importJob.stage_progress||0)/importJob.stage_total) : 30}%`,
                  transition:'width .3s' }} />
              </div>
            </div>
          )}

          {/* 导入结果 */}
          {importResult && (
            <div style={{ padding:12, borderRadius:10, border:'1px solid var(--line)',
              background: importResult.warnings?.length ? 'var(--warn-soft)' : 'var(--ok-soft)',
              fontSize: 12.5, color: 'var(--text-quiet)' }}>
              <div style={{ fontWeight:600, marginBottom:4 }}>{t('mobile.settings.account.import_done')}</div>
              <div>{t('mobile.settings.account.import_result', { scripts: importResult.scripts, saves: importResult.saves, cards: importResult.cards })}</div>
              {importResult.warnings?.length > 0 && (
                <ul style={{ margin:'6px 0 0', paddingLeft:16, fontSize:11.5 }}>
                  {importResult.warnings.slice(0,10).map((w,i) => <li key={i}>{w}</li>)}
                  {importResult.warnings.length>10 && <li>{t('mobile.settings.account.import_more_warnings', { n: importResult.warnings.length-10 })}</li>}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 在线剧本库联邦 */}
      <div className="pl-sec" style={{ marginTop: 18 }}>
        <div className="pl-sec-head"><h2>{t('mobile.settings.account.online_library')}</h2></div>
        <div className="pl-card" style={{ display: 'grid', gap: 14 }}>
          {conn?.connected ? (
            <>
              <div style={{ fontSize: 13, color: 'var(--ok)' }}>
                ✓ {t('mobile.settings.account.connected_to', { url: conn.base_url })}
              </div>
              <button className="pl-btn-ghost" disabled={connBusy} onClick={disconnect}>
                <Icon name="unlock" size={14} /> {t('mobile.settings.account.disconnect')}
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {t('mobile.settings.account.online_library_desc')}
              </div>
              <MField label={t('mobile.settings.account.service_url')}>
                <input className="pl-input" value={connBase}
                  onChange={(e) => setConnBase(e.target.value)}
                  placeholder={DEFAULT_ONLINE_BASE} />
              </MField>
              <MField label={t('mobile.settings.account.pat_label')} desc={t('mobile.settings.account.pat_desc')}>
                <input className="pl-input" type="password" value={connToken}
                  onChange={(e) => setConnToken(e.target.value)}
                  placeholder="rpgpat_…" />
              </MField>
              <button className="pl-btn-primary" disabled={connBusy} onClick={savePat}>
                <Icon name="link" size={15} /> {connBusy ? t('mobile.settings.account.connecting') : t('mobile.settings.account.save_and_connect')}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export { AccountSection };
