/* MobileScripts —— 移动端剧本区路由壳(scripts / scripts-import / scripts-library)。
   对应电脑端 src/pages/scripts.jsx 的 ScriptsListView / ScriptsImportView / ScriptsLibraryView。
   页面主体已按职责拆到 ../scripts/*(纯机械搬家,DOM / 视觉 / 行为零变化)。
   铁律:
   - 无任何 CS* / Cloudscape / game-app / game-panels / pages/*.jsx UI 组件导入
   - 移动端自包含:绝不复用桌面 components/scripts/,子模块住 mobile/scripts/
   - 数据层复用 window.api.* + usePlatformData
   - 样式只用 mobile.css 已有 class + inline style */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { usePlatformData } from '../../platform-app.jsx';
import { fmtN, fmtWan, isPlayBlocked, ACTIVE_STATUSES } from '../scripts/helpers.js';
import { splitModeLabel } from '../../lib/split-mode.js';
import { EmptyState } from '../scripts/EmptyState.jsx';
import { ScriptDetailView } from '../scripts/ScriptDetailView.jsx';
import { ImportView } from '../scripts/ImportView.jsx';
import { LibraryView } from '../scripts/LibraryView.jsx';

/* ─── 主组件 ────────────────────────────────── */
export function MobileScripts({ nav }) {
  const { t } = useTranslation();
  const platform = usePlatformData();
  const { saves: platSaves = [] } = platform;

  const [scripts, setScripts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // all / ready / importing / public
  const [embedStatus, setEmbedStatus] = useState({});
  const [selectedScript, setSelectedScript] = useState(null);
  const [view, setView] = useState('list'); // list / import / library

  const currentUserId = window.RPG_AUTH?.user_id ?? null;

  const reload = useCallback(async () => {
    try {
      const r = await window.api.scripts.list();
      const list = Array.isArray(r) ? r : (r?.items || r?.scripts || []);
      const normed = list.map(window.__normalizeScript || (x => x));
      setScripts(normed);
      // 拉 embed 状态（非阻塞）
      Promise.all(normed.map(async s => {
        try {
          const sr = await fetch(`${window.__API_BASE || ''}/api/scripts/${s.id}/embed/status`, { credentials: 'include' });
          const sj = await sr.json();
          if (sj.ok && sj.status) setEmbedStatus(es => ({ ...es, [s.id]: sj.status }));
        } catch (_) {}
      })).catch(() => {});
    } catch (_) { setScripts([]); }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    reload();
    const refresh = () => reload();
    window.addEventListener('rpg:scripts:changed', refresh);
    window.addEventListener('rpg-scripts-updated', refresh);
    return () => {
      window.removeEventListener('rpg:scripts:changed', refresh);
      window.removeEventListener('rpg-scripts-updated', refresh);
    };
  }, [reload]);

  // 处理路由区分
  useEffect(() => {
    if (nav?.pageId === 'scripts-import') setView('import');
    else if (nav?.pageId === 'scripts-library') setView('library');
    else setView('list');
  }, [nav?.pageId]);

  const FILTERS = [
    { id: 'all', label: t('common.all') },
    { id: 'ready', label: t('mobile.scripts.filter.ready') },
    { id: 'importing', label: t('mobile.scripts.filter.importing') },
    { id: 'public', label: t('mobile.scripts.filter.public') },
  ];

  const visibleScripts = scripts.filter(s => {
    const matchQ = !query.trim() || (`${s.title} ${s.uid}`).toLowerCase().includes(query.toLowerCase());
    let matchF = true;
    if (filter === 'ready') matchF = !isPlayBlocked(s);
    else if (filter === 'importing') matchF = !!s.import_status && ACTIVE_STATUSES.has(String(s.import_status).toLowerCase());
    else if (filter === 'public') matchF = !!s.is_public;
    return matchQ && matchF;
  });

  if (view === 'import') {
    return <ImportView onBack={() => { setView('list'); reload(); }} nav={nav} />;
  }

  if (view === 'library') {
    return <LibraryView onBack={() => setView('list')} nav={nav} />;
  }

  if (selectedScript) {
    return (
      <ScriptDetailView
        script={selectedScript}
        saves={platSaves}
        embedStatus={embedStatus}
        currentUserId={currentUserId}
        onBack={() => setSelectedScript(null)}
        onRefresh={() => { reload(); }}
        nav={nav}
      />
    );
  }

  // 列表视图
  return (
    <>
      <div className="pl-head">
        <div className="pl-head-title">
          <strong style={{ fontSize: 19, fontFamily: 'var(--font-serif)' }}>{t('mobile.scripts.list.title')}</strong>
        </div>
        <div className="pl-head-actions">
          <button className="pl-headbtn" title={t('mobile.scripts.library.title')} onClick={() => setView('library')}>
            <Icon name="globe" size={18} />
          </button>
          <button className="pl-headbtn" style={{ color: 'var(--accent)', border: '1px solid var(--accent-edge)', background: 'var(--accent-soft)' }} onClick={() => setView('import')}>
            <Icon name="plus" size={20} />
          </button>
        </div>
      </div>

      <div className="pl-toolbar">
        <div className="pl-search">
          <Icon name="search" size={16} />
          <input
            placeholder={t('mobile.scripts.list.search_placeholder')}
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && <button onClick={() => setQuery('')}><Icon name="close" size={15} /></button>}
        </div>
      </div>

      <div className="pl-seg-scroll">
        {FILTERS.map(f => (
          <button
            key={f.id}
            className={'pl-pill' + (filter === f.id ? ' active' : '')}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="pl-body tabbed">
        <div className="pl-pad" style={{ paddingTop: 4 }}>
          {!loaded && (
            <div className="muted" style={{ fontSize: 13, padding: '20px 0' }}>{t('common.loading')}</div>
          )}
          {loaded && visibleScripts.length === 0 && (
            <EmptyState
              icon="book_open"
              title={query ? t('mobile.scripts.list.no_results') : t('mobile.scripts.list.empty_title')}
              desc={query ? t('mobile.scripts.list.try_other_keyword') : t('mobile.scripts.list.empty_desc')}
              action={!query && (
                <button className="pl-btn-primary" style={{ marginTop: 16 }} onClick={() => setView('import')}>
                  <Icon name="upload" size={18} /> {t('mobile.scripts.list.import_btn')}
                </button>
              )}
            />
          )}

          {visibleScripts.map(s => {
            const es = embedStatus[s.id];
            const embedDone = es && !es.running && (es.chunks?.done || 0) >= (es.chunks?.total || 1) && (es.chunks?.total || 0) > 0;
            const embedRunning = es?.running;
            const block = isPlayBlocked(s);
            const isInternal = typeof s.title === 'string' && s.title.startsWith('[内部]');
            const savesCount = platSaves.filter(sv => sv.script_id === s.id).length;

            return (
              <button
                key={s.id}
                className="pl-cover-card"
                style={{ marginBottom: 13 }}
                onClick={() => setSelectedScript(s)}
              >
                <div className="pl-cover">
                  <span className="pl-cover-spine" />
                  <h3>{s.title}</h3>
                  {isInternal && (
                    <span className="pill" style={{ position: 'absolute', top: 8, right: 10, height: 18, fontSize: 9.5 }}>{t('mobile.scripts.detail.coming_soon')}</span>
                  )}
                  {s.is_public && !isInternal && (
                    <span className="pill ok" style={{ position: 'absolute', top: 8, right: 10, height: 18, fontSize: 9.5 }}>
                      <span className="dot ok" />{t('mobile.scripts.list.is_public')}
                    </span>
                  )}
                  {s.forked_from_script_id && (
                    <span className="pill info" style={{ position: 'absolute', top: isInternal || s.is_public ? 32 : 8, right: 10, height: 18, fontSize: 9.5 }}>fork</span>
                  )}
                </div>
                <div className="pl-cover-body">
                  {/* UID + 更新时间 */}
                  <div className="mono muted-2" style={{ fontSize: 10.5 }}>
                    {s.uid}
                    {s.updated_at && <span> · {s.updated_at}</span>}
                  </div>
                  <div className="pl-cover-meta">
                    <Icon name="book_open" size={11} />
                    {fmtN(s.chapter_count || 0)} {t('mobile.scripts.unit.chapter')}
                    <span className="sep">·</span>
                    {fmtWan(s.word_count)}
                    {savesCount > 0 && (
                      <><span className="sep">·</span><Icon name="save" size={11} />{savesCount} {t('mobile.scripts.list.saves_unit')}</>
                    )}
                    <span style={{ flex: 1 }} />
                    {embedRunning
                      ? <span className="pill warn" style={{ height: 18, fontSize: 9.5 }}><span className="dot warn" />{t('mobile.scripts.list.indexing')}</span>
                      : embedDone
                        ? <span className="pill ok" style={{ height: 18, fontSize: 9.5 }}><span className="dot ok" />{t('mobile.scripts.list.ready')}</span>
                        : block
                          ? <span className="pill" style={{ height: 18, fontSize: 9.5 }}>{t('mobile.scripts.list.not_ready')}</span>
                          : null}
                  </div>
                  {(s.import_report?.mode || s.import_report?.mode_label) && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>
                      {splitModeLabel(s.import_report, t)}
                      {s.import_report.confidence != null && (
                        <span className="mono" style={{ marginLeft: 5 }}>
                          {Math.round(s.import_report.confidence * 100)}%
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            );
          })}

          {/* 统计条 */}
          {loaded && scripts.length > 0 && (
            <div style={{ textAlign: 'center', padding: '14px 0 4px', fontSize: 11.5, color: 'var(--muted-2)' }}>
              {t('mobile.scripts.list.total', { n: scripts.length })}
              {visibleScripts.length !== scripts.length && ` · ${t('mobile.scripts.list.showing', { n: visibleScripts.length })}`}
            </div>
          )}
        </div>
      </div>

      {/* FAB 快捷导入 */}
      <button className="pl-fab" onClick={() => setView('import')} title={t('mobile.scripts.list.fab_title')}>
        <Icon name="upload" size={22} />
      </button>
    </>
  );
}

export default MobileScripts;
