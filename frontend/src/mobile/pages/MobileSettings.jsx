/* MobileSettings.jsx — 移动端设置页(单文件,内部 section 状态切换)
   覆盖路由: settings / settings-models / settings-modelparams / settings-modules
            / settings-memory / settings-permissions / settings-account
   (settings-danger 高危区块已隐藏(2026-09);组件 ../settings/danger-section.jsx 保留可恢复)
   铁律:零 Cloudscape / 零电脑端 UI 复用;数据层全接 window.api.* 真实接口。
   ──────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { PrefSection } from '../settings/pref-section.jsx';
import { ModelParamsSection } from '../settings/modelparams-section.jsx';
import { ModuleModelsSection } from '../settings/module-models-section.jsx';
import { MemorySection } from '../settings/memory-section.jsx';
import { PermissionsSection } from '../settings/perm-section.jsx';
import { AccountSection } from '../settings/account-section.jsx';
import { DangerSection } from '../settings/danger-section.jsx';
import { ModelsSection } from '../settings/models-section.jsx';

/* ────────────────────────────────────────────────────────────────── */
/* 主组件                                                               */
/* ────────────────────────────────────────────────────────────────── */
const SECTIONS = [
  { id:'preferences',   icon:'settings',  tone:'' },
  { id:'models',        icon:'cpu',       tone:'accent' },
  { id:'modelparams',   icon:'gauge',     tone:'' },
  { id:'modules',       icon:'layers',    tone:'info' },
  { id:'memory',        icon:'memory',    tone:'' },
  { id:'permissions',   icon:'shield',    tone:'ok' },
  { id:'account',       icon:'user',      tone:'' },
  // 'danger' 入口已隐藏(2026-09),DangerSection 组件保留可恢复
];

// 把路由 id 映射到 section id
const ROUTE_MAP = {
  'settings':               null,   // hub
  'settings-models':        'models',
  'settings-modelparams':   'modelparams',
  'settings-modules':       'modules',
  'settings-memory':        'memory',
  'settings-permissions':   'permissions',
  'settings-account':       'account',
  // 'settings-danger' 路由已隐藏:落到未匹配 → 回 hub
};

export function MobileSettings({ nav }) {
  const { t } = useTranslation();
  // 外部路由可以通过 nav.params.section 指定起始分节
  const [section, setSection] = useState(() => {
    // 支持初始路由直达
    if (nav && nav.params && nav.params.section) return nav.params.section;
    // 支持由 nav.go('settings-xxx') 跳转时传的 routeId
    if (nav && nav.currentRouteId && ROUTE_MAP[nav.currentRouteId]) return ROUTE_MAP[nav.currentRouteId];
    return null; // null = hub 列表
  });

  // 监听 cap-navigate-subsection 事件(电脑端同款)
  useEffect(() => {
    const handler = (ev) => {
      const target = ev?.detail?.target;
      if (!target || typeof target !== 'string') return;
      const parts = target.split('.');
      if (parts[0] !== 'settings' || parts.length < 2) return;
      const ALIASES = { api:'models' };
      const sub = ALIASES[parts[1]] || parts[1];
      if (SECTIONS.some(s => s.id===sub)) setSection(sub);
    };
    window.addEventListener('cap-navigate-subsection', handler);
    return () => window.removeEventListener('cap-navigate-subsection', handler);
  }, []);

  const meta = SECTIONS.find(s => s.id===section) || null;

  /* ── Hub: 分节列表 ── */
  if (!section) {
    return (
      <>
        <div className="pl-head">
          <div className="pl-head-title center">
            <strong>{t('mobile.settings.title')}</strong>
          </div>
        </div>
        <div className="pl-body tabbed">
          <div className="pl-pad" style={{ display:'grid', gap:7 }}>
            {SECTIONS.map(s => (
              <button key={s.id} className="pl-row" onClick={() => setSection(s.id)}>
                <span className={`pl-row-ic ${s.tone||''}`}><Icon name={s.icon} size={18} /></span>
                <span className="pl-row-tx"><strong>{t(`mobile.settings.section.${s.id}.label`)}</strong><span>{t(`mobile.settings.section.${s.id}.sub`)}</span></span>
                <span className="pl-row-chev"><Icon name="chevron_right" size={17} /></span>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  }

  /* ── 分节视图 ── */
  // ProviderDetail 自带 pl-head，需要特殊处理
  // 其他分节统一用下面的 shell
  return (
    <>
      {/* 如果是 models section 并且 ProviderDetail 正在展示，
          ProviderDetail 内部会 render 自己的 pl-head，所以让 ModelsSection 控制全屏 */}
      {section === 'models' ? (
        <ModelsSection nav={nav} onBack={() => setSection(null)} />
      ) : (
        <>
          <div className="pl-head">
            <button className="pl-back" onClick={() => setSection(null)}>
              <Icon name="chevron_left" size={20} />
            </button>
            <div className="pl-head-title">
              <strong>{meta ? t(`mobile.settings.section.${meta.id}.label`) : t('mobile.settings.title')}</strong>
              <span className="sub">{meta ? t(`mobile.settings.section.${meta.id}.sub`) : ''}</span>
            </div>
          </div>
          <div className="pl-body tabbed">
            <div className="pl-pad">
              {section === 'preferences'  && <PrefSection nav={nav} />}
              {section === 'modelparams'  && <ModelParamsSection />}
              {section === 'modules'      && <ModuleModelsSection nav={nav} />}
              {section === 'memory'       && <MemorySection />}
              {section === 'permissions'  && <PermissionsSection nav={nav} />}
              {section === 'account'      && <AccountSection nav={nav} />}
              {/* 'danger' 区块已隐藏:DangerSection 组件保留(import 已摘除) */}
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default MobileSettings;
