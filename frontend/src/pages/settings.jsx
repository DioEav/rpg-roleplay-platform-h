/* Settings page — split out of platform-app.jsx (task 52).
   只搬家，UI / props 流 / fetch 路径完全不变。
   依赖 platform-app.jsx 注入的全局: Icon / SettingsToggle / ConfirmModal / useAutoSave / usePlatformData / fmtN。 */

import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import GmStyleEditor from '../components/GmStyleEditor.jsx';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import { PrefSection, ExtractorSection, BlackSwanSection, ClarifySection } from '../components/settings/pref-sections.jsx';
import { ModelsSection, ApiModelsList, AddModelModal, EditApiModal, ValidateModal, VisibilityModal, ProviderCard, ProviderConfigSection, ModelNameCell, HealthDot, MODELS_DATA, PROVIDERS_CONFIG, normalizeApiId } from '../components/settings/models-section.jsx';
import { ModelParamsSection, ParamSlider } from '../components/settings/modelparams-section.jsx';
import { ModuleModelsSection } from '../components/settings/module-models-section.jsx';
import { MemorySection } from '../components/settings/memory-section.jsx';
import { PermSection, AuditLogView } from '../components/settings/perm-section.jsx';
import { DeploySection } from '../components/settings/deploy-section.jsx';
import { AccountSection } from '../components/settings/account-section.jsx';
import { DangerSection } from '../components/settings/danger-section.jsx';

// Wave 11-C: typed map 对齐 ModelCapabilities struct 字段
// import type { ModelInfo } from "@/types/rust/catalog/ModelInfo"
// import type { ProviderId } from "@/types/rust/catalog/ProviderId"
// import type { ModelCapabilities } from "@/types/rust/catalog/ModelCapabilities"
// import type { CatalogSource } from "@/types/rust/catalog/CatalogSource"
/** @type {Record<keyof import("../types/rust/catalog/ModelCapabilities").ModelCapabilities, string>} */
// Wave 11.5-A: CAP_LABEL / capFlags 抽到 components/catalog-helpers.js,
// 这里只读 window 上的副本(由 entries/platform.jsx 提前 import 注册)。
const CAP_LABEL = window.CAP_LABEL;
const capFlags = window.capFlags;

/* ---------------------------- SETTINGS ------------------------- */
function SettingsPage({ section: sectionProp } = {}) {
  // 新 IA:section 由模块左栏(路由)驱动。传入 sectionProp 时隐藏内部导航。
  const { t } = useTranslation();
  const [sectionState, setSection] = useStatePL("preferences");
  const external = !!sectionProp;
  const section = sectionProp || sectionState;
  const SECTIONS = [
    { id: "preferences", label: t('settings.nav.preferences'), icon: "settings" },
    { id: "models",      label: t('settings.nav.models'),      icon: "sparkle" },
    { id: "modelparams", label: t('settings.nav.modelparams'), icon: "spark" },
    { id: "modules",     label: t('settings.nav.modules'),     icon: "spark" },
    { id: "memory",      label: t('settings.nav.memory'),      icon: "memory" },
    { id: "permissions", label: t('settings.nav.permissions'), icon: "lock" },
    { id: "deploy",      label: t('settings.nav.deploy'),      icon: "world" },
    { id: "account",     label: t('settings.nav.account'),     icon: "user" },
    // 「高危」区块已隐藏(2026-09,应运营要求):DangerSection 组件与 i18n 原样保留,
    // 恢复 = 把 danger 加回 SECTIONS 并渲染 <DangerSection />。清空存档仍可走后端 CLI。
  ];
  // task 57：助手 navigate_to_setting 触发 cap-navigate-subsection 事件
  // (settings.permissions → section="permissions"，settings.api → section="models")
  useEffectPL(() => {
    const handler = (ev) => {
      const target = ev && ev.detail && ev.detail.target;
      if (!target || typeof target !== "string") return;
      const parts = target.split(".");
      if (parts[0] !== "settings" || parts.length < 2) return;
      const sub = parts[1];
      const ALIASES = { "api": "models" };
      const normalized = ALIASES[sub] || sub;
      if (SECTIONS.some(s => s.id === normalized)) setSection(normalized);
    };
    window.addEventListener("cap-navigate-subsection", handler);
    return () => window.removeEventListener("cap-navigate-subsection", handler);
  }, []);
  const sectionLabel = (SECTIONS.find((s) => s.id === section) || {}).label || t('settings.title');
  return (
    <CSSpaceBetween size="l">
      {!external && (
        <CSHeader variant="h1">{t('settings.title')}</CSHeader>
      )}
      {!external && (
        <CSSpaceBetween direction="horizontal" size="xs">
          {SECTIONS.map((s) => (
            <CSButton key={s.id} variant={section === s.id ? 'primary' : 'normal'} onClick={() => setSection(s.id)}>
              {s.label}
            </CSButton>
          ))}
        </CSSpaceBetween>
      )}
      {external && <CSHeader variant="h1">{sectionLabel}</CSHeader>}
      {section === "preferences" && [<PrefSection key="pref" />, <CSContainer key="gmstyle"><GmStyleEditor scope="user" /></CSContainer>, <BlackSwanSection key="bs" />, <ExtractorSection key="ext" />, <ClarifySection key="clar" />]}
      {section === "models" && <ModelsSection />}
      {section === "modelparams" && <ModelParamsSection />}
      {section === "modules" && <ModuleModelsSection />}
      {section === "memory" && <MemorySection />}
      {section === "permissions" && <PermSection />}
      {section === "deploy" && <DeploySection />}
      {section === "account" && <AccountSection />}
      {/* 「高危」区块已隐藏:见上方 SECTIONS 处注释 */}
    </CSSpaceBetween>
  );
}

// ── ESM export(W12 重构修复 Vite 迁移后的跨文件作用域断裂)──
// platform-app.jsx 用到 MODELS_DATA / PROVIDERS_CONFIG;原 babel-script 时代它们
// 是全局 const 自然可见,Vite ESM 下变成 module-local 必须显式 export 出来。
export {
  SettingsPage,
  MODELS_DATA,
  PROVIDERS_CONFIG,
  normalizeApiId,
  CAP_LABEL,
  ApiModelsList,
  AddModelModal,
  EditApiModal,
  ValidateModal,
  VisibilityModal,
  ProviderCard,
  ProviderConfigSection,
  ParamSlider,
  ModelNameCell,
  HealthDot,
  ModelsSection,
  ModuleModelsSection,
  ModelParamsSection,
  BlackSwanSection,
  ExtractorSection,
  PrefSection,
  PermSection,
  ClarifySection,
  MemorySection,
  DangerSection,
  DeploySection,
  AccountSection,
  AuditLogView,
};

// 过渡期保留 window 注入,等所有 consumer 改完 import 后删除。
