// 偏好类设置区(Pref / Extractor / BlackSwan / Clarify)。纯机械从 pages/settings.jsx 搬出,零行为变化。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import AgentModelPicker from '../AgentModelPicker.jsx';
import { useAutoSave } from '../../platform-app.jsx';
import { SetGroup, SetRow, SetSelect } from './shared.jsx';
import CSToggle from '@cloudscape-design/components/toggle';
import { changeLanguage } from '../../i18n/index.js';
import { getTheme, setTheme } from '../../lib/theme.js';

function PrefSection() {
  // task 52：从 user_preferences 拉真实初值，改动直接 patch /api/me/preference。
  const { t } = useTranslation();
  const [interfaceLang, setInterfaceLang] = useStatePL("zh-CN");
  const [serif, setSerif] = useStatePL(true);
  const [auto, setAuto] = useStatePL(true);
  // 界面主题:纯客户端偏好(localStorage rpg.theme),不走 useAutoSave/后端。
  const [uiTheme, setUiTheme] = useStatePL(() => getTheme());
  useEffectPL(() => {
    const onCh = (e) => setUiTheme((e && e.detail && e.detail.theme) || getTheme());
    window.addEventListener('rpg-theme-change', onCh);
    return () => window.removeEventListener('rpg-theme-change', onCh);
  }, []);
  const save = useAutoSave(t('settings.nav.preferences'), "pref");
  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const p = (r && r.preferences) || {};
        if (p["pref.ui_language"]) setInterfaceLang(p["pref.ui_language"]);
        else if (p.ui_language) setInterfaceLang(p.ui_language);
        if (typeof p["pref.serif"] === "boolean") setSerif(p["pref.serif"]);
        else if (typeof p.serif === "boolean") setSerif(p.serif);
        if (typeof p["pref.autosave"] === "boolean") setAuto(p["pref.autosave"]);
        else if (typeof p.autosave === "boolean") setAuto(p.autosave);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);
  return (
    <SetGroup title={t('settings.preferences.title')}>
      <SetRow label={t('settings.preferences.interface_lang')} description={t('settings.preferences.interface_lang_desc')}>
        <SetSelect value={interfaceLang}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en', label: 'English (Beta)' },
            // 繁體中文选项已移除(2026-10):i18n 资源复用简体,选项无实际意义。恢复 = 加回 { value: 'zh-TW', label: '繁體中文' }。
          ]}
          onChange={(v) => { setInterfaceLang(v); save("ui_language", v); changeLanguage(v); }} />
      </SetRow>
      <SetRow label={t('theme.setting_label')} description={t('theme.setting_desc')}>
        <SetSelect value={uiTheme}
          options={[
            { value: 'dark', label: t('theme.dark') },
            { value: 'light-a', label: t('theme.light_a') },
            { value: 'light-b', label: t('theme.light_b') },
          ]}
          onChange={(v) => setUiTheme(setTheme(v))} />
      </SetRow>
      {/* 叙述字体/自动存档两个开关已隐藏(2026-10):pref.serif / pref.autosave 是死键
          (全库无运行时消费者)。真功能在游戏内设置弹窗(localStorage rpg.narrativeFont /
          rpg.autosave)。恢复 = 解注释以下两段 SetRow。 */}
      {/* <SetRow label={t('settings.preferences.serif_font')} description={t('settings.preferences.serif_font_desc')}>
        <CSToggle checked={serif} onChange={({ detail }) => { setSerif(detail.checked); save("serif", detail.checked); }}>
          {serif ? t('settings.preferences.serif_on') : t('settings.preferences.serif_off')}
        </CSToggle>
      </SetRow> */}
      {/* <SetRow label={t('settings.preferences.autosave')} description={t('settings.preferences.autosave_desc')}>
        <CSToggle checked={auto} onChange={({ detail }) => { setAuto(detail.checked); save("autosave", detail.checked); }}>
          {auto ? t('settings.preferences.autosave_on') : t('settings.preferences.autosave_off')}
        </CSToggle>
      </SetRow> */}
    </SetGroup>
  );
}

/* ExtractorSection — task 64：暴露后端 task 62/63 的 user_preferences.extractor.*。
   后端读 user_preferences.preferences["extractor.enabled"/"extractor.api_id"/"extractor.model_real_name"]。
   useAutoSave("叙事提取器", "extractor") 让 save("enabled", v) 写到 extractor.enabled，键正好对齐。 */
function ExtractorSection() {
  const { t } = useTranslation();
  // 启用开关已隐藏(2026-10):extractor.enabled 只在 sync 后处理模式(调试用)下生效,
  // 默认 async 部署下职能已被史官三合一(recorder_unified,默认开)接管 —— 开关拨了
  // 也没用,且 UI 文案("两步式 GM/错误率低 5×")描述的是旧路径的历史行为。
  // 恢复 = 解注释以下 SetRow。
  const save = useAutoSave(t('settings.extractor.title'), "extractor");

  return (
    <SetGroup title={t('settings.extractor.title')}>
      {/* <SetRow label={t('settings.extractor.enable')} description={t('settings.extractor.enable_desc')}>
        <CSToggle checked={enabled} onChange={({ detail }) => { setEnabled(detail.checked); save("enabled", detail.checked); }}>
          {enabled ? t('settings.extractor.enable_on') : t('settings.extractor.enable_off')}
        </CSToggle>
      </SetRow> */}
      {/* 统一共享组件:与「按模块分配模型」的提取器、scripts 导入流、cards 的 card_import
          同一实现(Provider+Model + 未配 key 警告 + 写 extractor.* prefs)。
          此模型配置仍然超值:它是史官/验收官/记忆摘要精修/命令工具的回退模型。 */}
      <SetRow label={t('settings.extractor.api')} description={t('settings.extractor.model_desc')}>
        <AgentModelPicker
          prefPrefix="extractor"
          preferProvider="deepseek"
          defaultModel={null}
          variant="bare"
          configHash="settings-models"
        />
      </SetRow>
    </SetGroup>
  );
}

/* BlackSwanSection — 黑天鹅子代理开关：暴露 user_preferences["black_swan.enabled"]。
   后端 _is_black_swan_enabled(api_user) 读此偏好；未设置时退回 env-var(RPG_ENABLE_BLACK_SWAN)。
   useAutoSave("黑天鹅", "black_swan") 让 save("enabled", v) 写到 black_swan.enabled，键对齐。 */
function BlackSwanSection() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useStatePL(false);
  const save = useAutoSave(t('settings.black_swan.title'), "black_swan");
  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await window.api.account.profile();
        if (cancelled) return;
        const p = (profile && profile.preferences) || {};
        if (typeof p["black_swan.enabled"] === "boolean") setEnabled(p["black_swan.enabled"]);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);
  return (
    <SetGroup title={t('settings.black_swan.title')}>
      <SetRow label={t('settings.black_swan.enable')} description={t('settings.black_swan.enable_desc')}>
        <CSToggle checked={enabled} onChange={({ detail }) => { setEnabled(detail.checked); save("enabled", detail.checked); }}>
          {enabled ? t('settings.black_swan.enable_on') : t('settings.black_swan.enable_off')}
        </CSToggle>
      </SetRow>
    </SetGroup>
  );
}

/* ClarifySection — task 85：暴露 user_preferences.curator.confidence_threshold。
   后端 _clarify_threshold(api_user) 读 preferences["curator.confidence_threshold"]，默认 0.5，
   clamp 到 [0.0, 1.0]。useAutoSave("Curator 反问", "curator") 让 save("confidence_threshold", v)
   写到 curator.confidence_threshold，键正好对齐。 */
function ClarifySection() {
  const { t } = useTranslation();
  const DEFAULT = 0.5;
  const [threshold, setThreshold] = useStatePL(DEFAULT);
  const save = useAutoSave("Curator", "curator");
  useEffectPL(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await window.api.account.profile();
        if (cancelled) return;
        const p = (profile && profile.preferences) || {};
        const raw = p["curator.confidence_threshold"];
        if (raw !== undefined && raw !== null) {
          const v = Number(raw);
          if (Number.isFinite(v)) {
            setThreshold(Math.max(0, Math.min(1, v)));
          }
        }
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const commit = (v) => {
    let n = Number(v);
    if (!Number.isFinite(n)) n = DEFAULT;
    n = Math.max(0, Math.min(1, n));
    // 量化到 0.05 步进，避免 slider 浮点尾巴写库
    n = Math.round(n * 20) / 20;
    setThreshold(n);
    save("confidence_threshold", n);
  };

  return (
    <SetGroup title={t('settings.clarify.title')}>
      <SetRow label={t('settings.clarify.threshold')} description={t('settings.clarify.threshold_desc')}>
        <div style={{flexDirection: "row", alignItems: "center", display: "flex", gap: 8}}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => { setThreshold(Number(e.target.value)); }}
            onMouseUp={(e) => commit(e.target.value)}
            onTouchEnd={(e) => commit(e.target.value)}
            onKeyUp={(e) => commit(e.target.value)}
            style={{flex: 1, minWidth: 120}}
          />
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(e) => { setThreshold(Number(e.target.value)); }}
            onBlur={(e) => commit(e.target.value)}
            style={{width: 72}}
          />
          <span className="muted" style={{fontSize: 12, minWidth: 90}}>
            {threshold.toFixed(2)}
          </span>
        </div>
      </SetRow>
    </SetGroup>
  );
}

export {
  PrefSection,
  ExtractorSection,
  BlackSwanSection,
  ClarifySection,
};
