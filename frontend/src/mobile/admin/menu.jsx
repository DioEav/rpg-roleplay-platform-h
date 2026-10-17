/* MobileAdmin section 菜单(getSections/AdminMenu)。纯机械从 pages/MobileAdmin.jsx 拆出,逐字节等价。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';

/* ── section nav 菜单(admin-xxx 列表) ─────────────────── */
function getSections(t) {
  return [
    { key: 'admin-users', icon: 'user', label: t('mobile.admin.section.users') },
    { key: 'admin-usage', icon: 'usage', label: t('mobile.admin.section.usage') },
    { key: 'admin-audit', icon: 'history', label: t('mobile.admin.section.audit') },
    { key: 'admin-health', icon: 'cpu', label: t('mobile.admin.section.health') },
    { key: 'admin-logs', icon: 'list', label: t('mobile.admin.section.logs') },
    { key: 'admin-registration', icon: 'key', label: t('mobile.admin.section.registration') },
    // 'admin-security' 已隐藏(2026-10):后端不消费 admin.security_config(见桌面端 platform-app.jsx admin 组注释)。
    // { key: 'admin-security', icon: 'shield', label: t('mobile.admin.section.security') },
    { key: 'admin-maintenance', icon: 'settings', label: t('mobile.admin.section.maintenance') },
    { key: 'admin-dmca-takedowns', icon: 'flag', label: t('mobile.admin.section.dmca_takedowns') },
    { key: 'admin-dmca-strikes', icon: 'warn', label: t('mobile.admin.section.dmca_strikes') },
    { key: 'admin-csam-reports', icon: 'lock', label: t('mobile.admin.section.csam_reports') },
    { key: 'admin-aup-actions', icon: 'slash', label: t('mobile.admin.section.aup_actions') },
    { key: 'admin-feedback', icon: 'feedback', label: t('mobile.admin.section.feedback') },
    { key: 'admin-achievements', icon: 'trophy', label: t('mobile.admin.section.achievements') },
    // 'admin-deploy' 已隐藏(2026-10):后端不消费 admin.deployment_config(见桌面端 platform-app.jsx admin 组注释)。
    // 恢复 = 解注释本行 + MobileAdmin.jsx 的 case(与桌面端入口一起)。
    // { key: 'admin-deploy', icon: 'cloud', label: t('mobile.admin.section.deploy') },
  ];
}

function AdminMenu({ nav }) {
  const { t } = useTranslation();
  const sections = getSections(t);
  return (
    <>
      <div className="pl-head">
        <button className="pl-headbtn" onClick={() => nav.pop?.() || nav.switchTab?.('me')}><Icon name="chevron_left" size={20} /></button>
        <div className="pl-head-title"><strong style={{ fontSize: 15 }}>{t('mobile.admin.title')}</strong></div>
      </div>
      <div className="pl-body tabbed">
        <div className="pl-pad">
          <div className="pl-sec">
            <div className="pl-sec-head"><h2>{t('mobile.admin.modules_heading')}</h2></div>
            {sections.map((s) => (
              <button key={s.key} className="pl-row" onClick={() => nav.go(s.key)}>
                <span className="pl-row-ic"><Icon name={s.icon} size={17} /></span>
                <span className="pl-row-tx"><strong style={{ fontSize: 13.5 }}>{s.label}</strong></span>
                <span className="pl-row-chev"><Icon name="chevron_right" size={17} /></span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export { AdminMenu };
