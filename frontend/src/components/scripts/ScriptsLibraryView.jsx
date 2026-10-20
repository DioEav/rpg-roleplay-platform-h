/* 在线剧本库 ScriptsLibraryView(从 ScriptsList.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import AvatarImg from '../AvatarImg.jsx';
import { parseImportedDesc } from '../../lib/script-desc.js';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSBadge from '@cloudscape-design/components/badge';
import CSCards from '@cloudscape-design/components/cards';
import CSTextFilter from '@cloudscape-design/components/text-filter';

/* 在线剧本库 — 浏览并导入其他用户公开分享的剧本。
   GET /api/scripts/public · POST /api/scripts/public/{id}/clone */
function ScriptsLibraryView() {
  const { t } = useTranslation();
  const [items, setItems] = useStatePL([]);
  const [loading, setLoading] = useStatePL(true);
  const [q, setQ] = useStatePL("");
  const [cloningId, setCloningId] = useStatePL(null);
  const [importedIds, setImportedIds] = useStatePL({}); // 本会话内已导入的 source id

  const reload = React.useCallback(async (query) => {
    setLoading(true);
    try {
      const r = await window.api.scripts.publicList(query ? { q: query } : undefined);
      setItems(Array.isArray(r?.items) ? r.items : []);
    } catch (e) {
      window.__apiToast?.(t('scripts.public.load_fail'), { kind: "danger", detail: e?.message });
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffectPL(() => { reload(""); }, [reload]);

  const onSearch = () => reload(q);

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
        counter={`(${items.length})`}
        description={t('scripts.public.description')}
        actions={<CSButton iconName="refresh" onClick={() => reload(q)}>{t('common.refresh')}</CSButton>}
      >{t('scripts.public.title')}</CSHeader>

      <CSCards
        items={items}
        loading={loading}
        loadingText={t('scripts.public.loading')}
        trackBy="id"
        cardsPerRow={[{ cards: 1 }, { minWidth: 480, cards: 2 }, { minWidth: 920, cards: 3 }]}
        filter={
          <div style={{ minWidth: 320 }}>
            <CSTextFilter filteringText={q} filteringPlaceholder={t('scripts.public.search_placeholder')}
              onChange={({ detail }) => setQ(detail.filteringText)}
              onDelayedChange={onSearch} />
          </div>
        }
        empty={<CSBox textAlign="center" color="inherit" padding={{ vertical: 'l' }}>
          {loading ? t('common.loading') : (q ? t('scripts.public.empty_search') : t('scripts.public.empty'))}
        </CSBox>}
        cardDefinition={{
            header: (s) => (
              <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
                <CSBox key="t" variant="h3" padding="n">{s.title}</CSBox>
                {(s.mine || s.imported || importedIds[s.id]) && <CSBadge key="b" color="green">{s.mine ? t('scripts.public.mine_badge') : t('scripts.public.imported_badge')}</CSBadge>}
              </CSSpaceBetween>
            ),
          sections: [
            { id: 'cover', content: (s) => s.cover_image_url ? (
              <AvatarImg
                src={s.cover_image_url}
                name={s.title}
                size={140}
                shape="rounded"
                aspectRatio="16/9"
                zoomable
              />
            ) : null },
            { id: 'author', content: (s) => (
              <CSBox fontSize="body-s" color="text-body-secondary">{t('scripts.public.shared_by', { author: s.author || s.author_username || t('scripts.public.anon') })}</CSBox>
            ) },
            { id: 'stats', content: (s) => (
              <CSSpaceBetween direction="horizontal" size="xs">
                <CSBadge key="ch">{t('scripts.public.stat_chapters', { n: (s.chapter_count || 0).toLocaleString() })}</CSBadge>
                <CSBadge key="wd">{t('scripts.public.stat_words', { n: ((s.word_count || 0) / 10000).toFixed(0) })}</CSBadge>
                <CSBadge key="cl" color="grey">{t('scripts.public.stat_clones', { n: s.clone_count || 0 })}</CSBadge>
              </CSSpaceBetween>
            ) },
            { id: 'desc', content: (s) => {
              // 自动生成的导入描述按界面语言本地化(与首页 Hero 同一解析),用户自写描述原样显示
              const imp = parseImportedDesc(s.description);
              return s.description
                ? <CSBox color="text-body-secondary">
                    {imp ? t('scripts.public.imported_desc', { n: imp.n, defaultValue: `导入剧本 · ${imp.n}章` }) : s.description}
                  </CSBox> : null;
            } },
            { id: 'actions', content: (s) => (
              (s.mine || s.imported || importedIds[s.id])
                ? <CSButton disabled iconName="check">{s.mine ? t('scripts.public.is_mine') : t('scripts.public.imported_badge')}</CSButton>
                : <CSButton variant="primary" iconName="download"
                    loading={cloningId === s.id} disabled={!!cloningId}
                    onClick={() => onClone(s)}>{t('scripts.public.import_btn')}</CSButton>
            ) },
          ],
        }}
      />
    </CSSpaceBetween>
  );
}

export { ScriptsLibraryView };
