/* 版本历史 Drawer(从 ScriptDetail.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import CSTable from '@cloudscape-design/components/table';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSBadge from '@cloudscape-design/components/badge';

/* ─── 版本历史 Drawer ────────────────────────────────────────────
   GET /api/scripts/{id}/commits?limit=30&cursor=X
   列出编辑记录(最新优先,cursor 翻页);head 行标 "current" badge。
   回退:章节类记录(带正文快照)接章节级「恢复到此前」(/chapters/{n}/restore,精确回退);
   其余类型(世界书/锚点/实体/fork)暂无按版本回退的端点 → 按钮禁用并说明原因
   (剧本级 checkout 回放引擎仍未实现,"整个剧本回滚到某版本"不在此列)。 */
function VersionHistoryDrawer({ script, currentUserId, onClose }) {
  const { t } = useTranslation();
  const [commits, setCommits] = useStatePL([]);
  const [loading, setLoading] = useStatePL(false);
  const [cursor, setCursor] = useStatePL(null);
  const [hasMore, setHasMore] = useStatePL(false);
  // 正在执行回退的 commit id(只锁该行,不锁整表)
  const [busyId, setBusyId] = useStatePL(null);

  const loadCommits = React.useCallback(async (c = null) => {
    if (!script) return;
    setLoading(true);
    try {
      const params = { limit: 30 };
      if (c) params.cursor = c;
      const r = await window.api.scripts.commits(script.id, params);
      const list = Array.isArray(r) ? r : (r?.items || r?.commits || []);
      if (c) setCommits((prev) => [...prev, ...list]);
      else setCommits(list);
      const nextCursor = r?.next_cursor ?? null;
      setCursor(nextCursor);
      setHasMore(!!nextCursor);
    } catch (_) {
      window.__apiToast?.(t('scripts.version.load_fail'), { kind: 'danger' });
    } finally {
      setLoading(false);
    }
  }, [script?.id]);

  useEffectPL(() => {
    if (script) loadCommits(null);
  }, [script?.id, loadCommits]);

  const isOwner = script && currentUserId && script.owner_id === currentUserId;

  // 只有章节类且带正文快照的记录有精确回退端点(后端 /chapters/{n}/restore 按章号校验)。
  const canRestore = (c) => !!(c && c.has_snapshot
    && (c.kind === 'chapter_edit' || c.kind === 'chapter_revert')
    && c.chapter_index != null);

  const kindLabel = (k) => {
    if (!k) return '—';
    return t(`scripts.version.kind.${k}`, { defaultValue: '' }) || k;
  };

  const onRestore = async (c) => {
    if (!await window.__confirm({
      title: t('scripts.version.restore_confirm', { n: c.chapter_index, id: String(c.id ?? '').slice(0, 8) }),
      danger: true,
      confirmText: t('scripts.version.restore_btn'),
    })) return;
    setBusyId(c.id);
    try {
      const r = await window.api.scripts.chapterRestore(script.id, c.chapter_index, c.id);
      if (r && r.ok === false) throw new Error(r.error || '');
      window.__apiToast?.(t('scripts.version.restore_ok', { n: c.chapter_index }), { kind: 'ok' });
      try { window.dispatchEvent(new CustomEvent('rpg-scripts-updated')); } catch (_) {}
      // 回退本身也会留一条记录 → 刷新列表;刻意不关抽屉,便于连续回退/核对。
      await loadCommits(null);
    } catch (e) {
      window.__apiToast?.(t('scripts.version.restore_fail'), { kind: 'danger', detail: e?.message });
    } finally {
      setBusyId(null);
    }
  };

  // ESC 关闭 + 点 backdrop 关闭
  useEffectPL(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!script) return null;

  return (
    <>
    {/* 半透明 backdrop:点击关闭 + 阻止鼠标事件穿透到下层主页面 */}
    <div onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.35)', zIndex: 899,
    }} />
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(920px, 94vw)',
      background: 'var(--panel, #1a1d22)', borderLeft: '1px solid var(--line-soft)',
      zIndex: 900, display: 'flex', flexDirection: 'column', overflowY: 'auto',
      boxShadow: '-4px 0 16px rgba(0,0,0,0.35)',
    }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <CSBox variant="h3" padding="n">{t('scripts.version.drawer_title')} · {script.title}</CSBox>
        <CSButton variant="normal" iconName="close" onClick={onClose}>{t('common.close')}</CSButton>
      </div>
      <div style={{ flex: 1, padding: '12px 16px' }}>
        <CSTable
          variant="embedded"
          loading={loading && commits.length === 0}
          loadingText={t('common.loading')}
          items={commits}
          trackBy="id"
          columnDefinitions={[
            {
              id: 'commit', header: t('scripts.version.col_commit'), width: 120,
              cell: (c) => (
                <CSSpaceBetween direction="horizontal" size="xxs" alignItems="center">
                  <span className="mono" style={{ fontSize: 12 }}>{String(c.id || '').slice(0, 8)}</span>
                  {script.head_commit_id && c.id === script.head_commit_id && (
                    <CSBadge color="green">{t('scripts.version.badge_current')}</CSBadge>
                  )}
                </CSSpaceBetween>
              ),
            },
            {
              id: 'message', header: t('scripts.version.col_message'), minWidth: 200,
              cell: (c) => <CSBox fontSize="body-s">{c.message || '—'}</CSBox>,
            },
            {
              id: 'kind', header: t('scripts.version.col_kind'), width: 130,
              cell: (c) => <CSBox fontSize="body-s" color="text-body-secondary">{kindLabel(c.kind)}</CSBox>,
            },
            {
              id: 'author', header: t('scripts.version.col_author'), width: 120,
              cell: (c) => (
                <CSBox fontSize="body-s" color="text-body-secondary">
                  {c.author_display_name || c.author_username || '—'}
                </CSBox>
              ),
            },
            {
              id: 'date', header: t('scripts.version.col_date'), width: 155,
              cell: (c) => <CSBox fontSize="body-s" color="text-body-secondary">{c.created_at ? new Date(c.created_at).toLocaleString() : '—'}</CSBox>,
            },
            {
              id: 'action', header: '', width: 120,
              cell: (c) => (canRestore(c) ? (
                <CSButton
                  variant="inline-link"
                  loading={busyId === c.id}
                  disabled={busyId != null && busyId !== c.id}
                  onClick={() => onRestore(c)}
                >{t('scripts.version.restore_btn')}</CSButton>
              ) : (
                <CSButton
                  variant="inline-link"
                  disabled
                  title={t('scripts.version.restore_unsupported')}
                >{t('scripts.version.restore_btn')}</CSButton>
              )),
            },
          ]}
          empty={<CSBox textAlign="center" padding={{ vertical: 'l' }} color="inherit">{t('scripts.version.empty')}</CSBox>}
        />
        {hasMore && (
          <div style={{ paddingTop: 12, textAlign: 'center' }}>
            <CSButton loading={loading} onClick={() => loadCommits(cursor)}>{t('common.load_more', { defaultValue: '加载更多' })}</CSButton>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export { VersionHistoryDrawer };
