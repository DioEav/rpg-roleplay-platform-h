/* 角色卡网格(卡面 + 每卡「更多」菜单:导出 / 复制 / 转用户卡 / 发布 / 删除)—— 从 pages/cards.jsx 拆出,逐字节不变。 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import AvatarImg from '../AvatarImg.jsx';
import CSCards from '@cloudscape-design/components/cards';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSBox from '@cloudscape-design/components/box';
import CSBadge from '@cloudscape-design/components/badge';
import CSButton from '@cloudscape-design/components/button';
import CSButtonDropdown from '@cloudscape-design/components/button-dropdown';
import { clampLines, npcToUserCardBody } from './helpers.js';
import { copyText } from '../../lib/clipboard.js';

function CardGrid({ cards, onEdit, kind, filter, empty, onDeleted, onDuplicate, onPromoteToUser }) {
  const { t } = useTranslation();
  // task 50：每张卡片的「更多」走 Cloudscape ButtonDropdown,
  // 内含 导出 PNG / 导出 SillyTavern JSON / 复制 ID / 转用户卡 / 复制为新卡 / 删除。
  const handleDelete = async (c) => {
    if (!await window.__confirm({ title: t('cards.confirm.delete_title'), message: t('cards.confirm.delete_message', { name: c.name }), danger: true, confirmText: t('cards.confirm.delete_btn') })) return;
    try {
      if (kind === "npc") {
        const sid = c.script_id || c._raw?.script_id;
        if (!sid) throw new Error(t('cards.toast.npc_script_required'));
        await window.api.cards.scriptDelete(sid, c.id);
      } else {
        await window.api.cards.myDelete(c.id);
      }
      window.__apiToast?.(t('cards.toast.deleted', { name: c.name }), { kind: "ok" });
      onDeleted && onDeleted(c);
    } catch (e) {
      window.__apiToast?.(t('cards.toast.delete_fail'), { kind: "danger", detail: e?.message });
    }
  };
  const copyId = async (c) => {
    const ok = await copyText(String(c.id));
    if (ok) window.__apiToast?.(t('cards.toast.id_copied'), { kind: "ok", duration: 1500 });
    else window.__apiToast?.(t('cards.toast.copy_fail'), { kind: "danger" });
  };

  // NPC 卡 → user_card 一键迁移。body 走共用 npcToUserCardBody(剧本编辑器同款),避免 shape 漂移。
  const promoteNpcToUserCard = async (c) => {
    const body = npcToUserCardBody(c, { fromNpcTag: t('cards.list.tag_from_npc'), unnamed: t('cards.detail.unnamed') });
    try {
      const r = await window.api.cards.myUpsert(body);
      if (r && r.ok === false) throw new Error(r.error || r.detail || t('cards.toast.promote_fail'));
      window.__apiToast?.(t('cards.toast.promoted', { name: body.name }),
        { kind: "ok", duration: 2200, detail: t('cards.toast.promoted_detail') });
      if (onPromoteToUser) onPromoteToUser(r?.card || body);
    } catch (e) {
      window.__apiToast?.(t('cards.toast.promote_fail'), { kind: "danger", detail: e?.message || String(e) });
    }
  };

  const menuItems = (c) => {
    if (kind === 'npc') {
      return [
        { id: 'promote', text: t('cards.list.menu_promote'), iconName: 'add-plus' },
        { id: 'copyid', text: t('cards.list.menu_copy_id'), iconName: 'copy' },
        { id: 'delete', text: t('cards.list.menu_delete'), iconName: 'remove' },
      ];
    }
    const isPub = !!(c._raw?.is_public ?? c.is_public);
    return [
      { id: 'png', text: t('cards.list.menu_export_png'), href: window.api.cards.exportPng(c.id), external: true, iconName: 'file' },
      { id: 'tavern', text: t('cards.list.menu_export_tavern'), href: window.api.cards.exportTavern(c.id), external: true, iconName: 'download' },
      { id: 'copyid', text: t('cards.list.menu_copy_id'), iconName: 'copy' },
      ...(onDuplicate ? [{ id: 'dup', text: t('cards.list.menu_duplicate'), iconName: 'copy' }] : []),
      isPub
        ? { id: 'unpublish', text: t('cards.list.menu_unpublish', { defaultValue: '取消公开' }), iconName: 'lock-private' }
        : { id: 'publish', text: t('cards.list.menu_publish', { defaultValue: '发布到在线库' }), iconName: 'share' },
      { id: 'delete', text: t('cards.list.menu_delete'), iconName: 'remove' },
    ];
  };
  const setPublic = async (c, pub) => {
    try {
      await window.api.cards.setPublic(c.id, pub);
      window.__apiToast?.(pub
        ? t('cards.toast.published', { defaultValue: '已发布到在线角色卡库', name: c.name })
        : t('cards.toast.unpublished', { defaultValue: '已取消公开', name: c.name }), { kind: 'ok' });
      onDeleted && onDeleted(c);  // 复用 reload 信号刷新列表
    } catch (e) {
      window.__apiToast?.(t('cards.toast.publish_fail', { defaultValue: '操作失败' }), { kind: 'danger', detail: e?.message || String(e) });
    }
  };
  const onMenu = (c, id) => {
    if (id === 'copyid') copyId(c);
    else if (id === 'dup') onDuplicate?.(c);
    else if (id === 'delete') handleDelete(c);
    else if (id === 'promote') promoteNpcToUserCard(c);
    else if (id === 'publish') setPublic(c, true);
    else if (id === 'unpublish') setPublic(c, false);
    // png / tavern 由 ButtonDropdown href 自动打开新标签,无需 onMenu 处理
  };

  return (
    <CSCards
      items={cards}
      trackBy="id"
      filter={filter}
      empty={empty}
      cardsPerRow={[{ cards: 1 }, { minWidth: 420, cards: 2 }, { minWidth: 820, cards: 3 }]}
      cardDefinition={{
        header: (c) => (
          <CSSpaceBetween direction="horizontal" size="xs" alignItems="center">
            <AvatarImg src={(c._raw?.avatar_path) || c.avatar_path || null} name={c.name} size={56} shape="rounded" zoomable />
            <CSBox key="name" variant="h3" padding="n">{c.name}</CSBox>
            {(c._raw?.is_public ?? c.is_public) && kind !== 'npc' && (
              <CSBadge key="pub" color="green">{t('cards.list.published', { defaultValue: '已公开' })}</CSBadge>
            )}
          </CSSpaceBetween>
        ),
        sections: [
          { id: 'meta', content: (c) => (
            <CSSpaceBetween direction="horizontal" size="xs">
              {c.role && c.role !== '—' && <CSBadge key="role">{c.role}</CSBadge>}
              {c.tone && c.tone !== '—' && <CSBadge key="tone" color="grey">{c.tone}</CSBadge>}
            </CSSpaceBetween>
          ) },
          { id: 'bio', content: (c) => <div style={{ ...clampLines(3), fontSize: 13, color: 'var(--text-quiet, #968f85)' }}>{c.bio || '—'}</div> },
          { id: 'tags', content: (c) => (c.tags?.length
            ? <CSSpaceBetween direction="horizontal" size="xxs">{c.tags.map((tg) => <CSBadge key={tg}>{tg}</CSBadge>)}</CSSpaceBetween>
            : null) },
          { id: 'foot', content: (c) => (
            <CSBox fontSize="body-s" color="text-status-inactive">
              {(kind === 'npc' ? c.save : c.origin)} · {c.updated}
            </CSBox>
          ) },
          { id: 'actions', content: (c) => (
            <CSSpaceBetween direction="horizontal" size="xs">
              <CSButton variant="inline-link" iconName="edit" onClick={() => onEdit(c)}>{t('cards.list.btn_edit')}</CSButton>
              <CSButtonDropdown variant="inline-icon" ariaLabel={t('cards.list.more_actions')} expandToViewport
                items={menuItems(c)} onItemClick={({ detail }) => onMenu(c, detail.id)} />
            </CSSpaceBetween>
          ) },
        ],
      }}
    />
  );
}

export { CardGrid };
