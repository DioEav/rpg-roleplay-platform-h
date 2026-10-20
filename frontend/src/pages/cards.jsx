/* Cards page shell —— 路由入口(用户卡 / NPC 卡 / 在线卡库)。
   页面主体已按职责拆到 ../components/cards/*(纯机械搬家,DOM / 视觉 / 行为零变化)。
   具名 export 全部保留转发,外部(entries/platform · tavern · scripts · saves · mobile)引用面不变。 */

import React from 'react';
import { useState as useStatePL } from 'react';
import { useTranslation } from 'react-i18next';
import CSTabs from '@cloudscape-design/components/tabs';
import { OnlineCardsView, UserCardsView, NpcCardsView, PersonasView } from '../components/cards/CardViews.jsx';
import { CardGrid } from '../components/cards/CardGrid.jsx';
import { CardEditModal } from '../components/cards/CardEditModal.jsx';
import { TavernImportModal } from '../components/cards/TavernImportModal.jsx';
import { CardSheet, CardEditFields } from '../components/cards/CardFields.jsx';
import { cardSnippet, cardFormInit, cardFormPayload, npcToUserCardBody } from '../components/cards/helpers.js';

/* 统一角色卡库 hub(2026-10-20):页内 tab 合并「角色卡(PC)」与「我的角色卡(persona,
   原酒馆抽屉编辑区)」—— 两者同表 character_cards、同套 CardEditFields 表单。
   本页为独立整页(无左栏,见 platform-app standalone),tab 即页内导航。 */
function CardsPage({ subPage = "user" }) {
  const { t } = useTranslation();
  const [tab, setTab] = useStatePL('cards');
  if (subPage === "npc") return <div className="pl-stack"><NpcCardsView /></div>;
  if (subPage === "online") return <div className="pl-stack"><OnlineCardsView /></div>;
  return (
    <div className="pl-stack">
      <CSTabs
        activeTabId={tab}
        onChange={({ detail }) => setTab(detail.activeTabId)}
        tabs={[
          { id: 'cards', label: t('cards.hub.tab_cards'), content: <UserCardsView /> },
          { id: 'personas', label: t('cards.hub.tab_personas'), content: <PersonasView /> },
        ]}
      />
    </div>
  );
}

export { CardsPage, CardGrid, UserCardsView, NpcCardsView, CardEditModal, TavernImportModal, CardSheet, cardSnippet, CardEditFields, cardFormInit, cardFormPayload, npcToUserCardBody };
