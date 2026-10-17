/* MobileAdmin.jsx — 管理后台移动端(路由壳)。
   nav.page = admin-xxx 决定 section;各 section / sheet / 菜单 已纯机械拆到 ../admin/*(逐字节等价、零行为变化)。
   铁律:零 Cloudscape/CS* 组件;数据全走 window.api.admin.*;样式只用 mobile.css 已有 class + inline。 */
import React from 'react';
import { AdminMenu } from '../admin/menu.jsx';
import { SectionUsers } from '../admin/users.jsx';
import { SectionUsage } from '../admin/usage.jsx';
import { SectionAudit } from '../admin/audit.jsx';
import { SectionHealth } from '../admin/health.jsx';
import { SectionLogs } from '../admin/logs.jsx';
import { SectionRegistration } from '../admin/registration.jsx';
import { SectionSecurity } from '../admin/security.jsx';
import { SectionMaintenance } from '../admin/maintenance.jsx';
import { SectionDmcaTakedowns, SectionDmcaStrikes } from '../admin/dmca.jsx';
import { SectionCsamReports } from '../admin/csam.jsx';
import { SectionAupActions } from '../admin/aup.jsx';
import { SectionFeedback } from '../admin/feedback.jsx';
import { SectionAchievements } from '../admin/achievements.jsx';
// import { SectionDeploy } from '../admin/deploy.jsx';  // 已隐藏(2026-10),随 case 一起恢复

/* ══════════════════════════════════════════
   主入口
══════════════════════════════════════════ */
export function MobileAdmin({ nav }) {
  const page = nav.page || 'admin';

  switch (page) {
    case 'admin-users':       return <SectionUsers nav={nav} />;
    case 'admin-usage':       return <SectionUsage nav={nav} />;
    case 'admin-audit':       return <SectionAudit nav={nav} />;
    case 'admin-health':      return <SectionHealth nav={nav} />;
    case 'admin-logs':        return <SectionLogs nav={nav} />;
    case 'admin-registration': return <SectionRegistration nav={nav} />;
    case 'admin-security':    return <SectionSecurity nav={nav} />;
    case 'admin-maintenance': return <SectionMaintenance nav={nav} />;
    case 'admin-dmca-takedowns': return <SectionDmcaTakedowns nav={nav} />;
    case 'admin-dmca-strikes': return <SectionDmcaStrikes nav={nav} />;
    case 'admin-csam-reports': return <SectionCsamReports nav={nav} />;
    case 'admin-aup-actions': return <SectionAupActions nav={nav} />;
    case 'admin-feedback':    return <SectionFeedback nav={nav} />;
    case 'admin-achievements': return <SectionAchievements nav={nav} />;
    // 'admin-deploy' 已隐藏(2026-10):菜单入口已移除,深链走 default 回管理菜单。
    // 恢复 = 解注释本行 + menu.jsx 的菜单项(与桌面端入口一起)。
    // case 'admin-deploy':      return <SectionDeploy nav={nav} />;
    default:                  return <AdminMenu nav={nav} />;
  }
}

export default MobileAdmin;
