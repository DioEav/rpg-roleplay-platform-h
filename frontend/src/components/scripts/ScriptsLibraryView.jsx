/* 在线剧本库 ScriptsLibraryView(从 ScriptsList.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import AvatarImg from '../AvatarImg.jsx';
import { Icon } from '../../game-icons.jsx';
import { homeFbClass } from '../platform/ProfilePage.jsx';
import TablePagination from '../TablePagination.jsx';
import { parseImportedDesc } from '../../lib/script-desc.js';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSTextFilter from '@cloudscape-design/components/text-filter';

/* 在线剧本库 — 浏览并导入其他用户公开分享的剧本。
   GET /api/scripts/public · POST /api/scripts/public/{id}/clone */
function ScriptsLibraryView() {
  const { t } = useTranslation();
  const [items, setItems] = useStatePL([]);
  const [loading, setLoading] = useStatePL(true);
  const [q, setQ] = useStatePL("");           // 已应用的搜索词(服务端过滤,延迟提交)
  const [qInput, setQInput] = useStatePL(""); // 搜索框受控值
  const [page, setPage] = useStatePL(1);
  const [pageSize, setPageSize] = useStatePL(10);
  const [total, setTotal] = useStatePL(0);
  const [cloningId, setCloningId] = useStatePL(null);
  const [importedIds, setImportedIds] = useStatePL({}); // 本会话内已导入的 source id

  // 服务端分页 + q 过滤(标题/简介)
  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.api.scripts.publicList({
        q: q || undefined, limit: pageSize, offset: (page - 1) * pageSize,
      });
      const list = Array.isArray(r?.items) ? r.items : [];
      // 当前页被删空/搜索收窄后停在越界页时回退一页
      if (!list.length && page > 1) { setPage(page - 1); return; }
      setItems(list);
      setTotal(r?.total ?? list.length);
    } catch (e) {
      window.__apiToast?.(t('scripts.public.load_fail'), { kind: "danger", detail: e?.message });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, t]);
  useEffectPL(() => { reload(); }, [reload]);

  const onClone = async (s) => {
    setCloningId(s.id);
    try {
      const r = await window.api.scripts.cloneFromPublic(s.id);
      if (r && r.ok === false) throw new Error(r.error || t('scripts.toast.import_fail'));
      setImportedIds((m) => ({ ...m, [s.id]: true }));
      if (r?.already_imported) {
        // 之前已导入过(后端订阅指针已存在):不再谎报导入成功,也不重复累加热度。
        window.toast?.(t('scripts.public.already_imported', '该剧本已在你的剧本库中'), {
          kind: "info", detail: s.title, duration: 2600,
        });
      } else {
        window.toast?.(t('scripts.public.clone_ok'), {
          kind: "ok",
          detail: `${s.title} · script #${r?.script_id ?? "?"}`,
          duration: 3000,
        });
        setItems((arr) => arr.map((x) => x.id === s.id ? { ...x, clone_count: (x.clone_count || 0) + 1 } : x));
      }
      try { window.dispatchEvent(new CustomEvent("rpg-scripts-updated")); } catch (_) {}
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.import_fail'), { kind: "danger", detail: e?.message || String(e) });
    } finally {
      setCloningId(null);
    }
  };

  return (
    <CSSpaceBetween size="l">
      <CSHeader
        variant="h1"
        description={t('scripts.public.description')}
        actions={<CSButton iconName="refresh" onClick={() => reload()}>{t('common.refresh')}</CSButton>}
      >{t('scripts.public.title')}</CSHeader>

      {/* 搜索框(服务端过滤,延迟提交) */}
      <div style={{ minWidth: 320, maxWidth: 460 }}>
        <CSTextFilter filteringText={qInput} filteringPlaceholder={t('scripts.public.search_placeholder')}
          onChange={({ detail }) => setQInput(detail.filteringText)}
          onDelayedChange={({ detail }) => { setQ(detail.filteringText || ''); setPage(1); }} />
      </div>

      {loading ? (
        <div className="pl-home-skel" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
      ) : items.length === 0 ? (
        <CSBox textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
          {q ? t('scripts.public.empty_search') : t('scripts.public.empty')}
        </CSBox>
      ) : (
        /* 大图封面卡片:与首页热门剧本同构(.pl-home-card),封面整宽置顶,
           悬停整卡浮起 + 封面放大提亮(动效统一在 platform.css)。 */
        <div className="pl-home-grid pl-lib-grid">
          {items.map((s) => {
            const owned = !!(s.mine || s.imported || importedIds[s.id]);
            return (
              <article className="pl-home-card" key={s.id}>
                <div className={`pl-home-cover${s.cover_image_url ? '' : ` ${homeFbClass(s.id)}`}`}>
                  <AvatarImg src={s.cover_image_url || null} name={s.title} className="pl-home-cover-img" zoomable />
                  <span className="pl-home-cov-chip"><Icon name="download" size={11} /> {s.clone_count || 0}</span>
                </div>
                <div className="pl-home-card-body">
                  <div className="pl-home-card-title">
                    {s.title}
                    {owned && <span className="pill accent">{s.mine ? t('scripts.public.mine_badge') : t('scripts.public.imported_badge')}</span>}
                  </div>
                  <div className="pl-home-card-meta">
                    {t('scripts.public.stat_chapters', { n: (s.chapter_count || 0).toLocaleString() })}
                    {' · '}
                    {t('scripts.public.stat_words', { n: ((s.word_count || 0) / 10000).toFixed(0) })}
                  </div>
                  {s.description && (() => {
                    // 自动生成的导入描述按界面语言本地化(与首页 Hero 同一解析),用户自写描述原样显示
                    const imp = parseImportedDesc(s.description);
                    return (
                      <div className="pl-lib-desc">
                        {imp ? t('scripts.public.imported_desc', { n: imp.n, defaultValue: `导入剧本 · ${imp.n}章` }) : s.description}
                      </div>
                    );
                  })()}
                  <div className="pl-home-card-foot">
                    <span className="pl-home-by">by {s.author || s.author_username || t('scripts.public.anon')}</span>
                    {owned ? (
                      <CSButton disabled iconName="check">{s.mine ? t('scripts.public.is_mine') : t('scripts.public.imported_badge')}</CSButton>
                    ) : (
                      <CSButton variant="primary" iconName="download"
                        loading={cloningId === s.id} disabled={!!cloningId}
                        onClick={() => onClone(s)}>{t('scripts.public.import_btn')}</CSButton>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <TablePagination
        total={total} page={page} pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(1); }} />
    </CSSpaceBetween>
  );
}

export { ScriptsLibraryView };
