/**
 * brand — 品牌、线上域名与法务链接的单一出口。
 *
 * 换域名 / 改品牌时只改这一个文件（或用 VITE_ 环境变量覆盖），各端引用处不用动。
 * 注意:后端镜像的默认值在 rpg/core/config.py、rpg/platform_app/*.py,
 * 部署侧在 deploy/ 的 .env 与 nginx conf —— 三处默认值需保持一致。
 */

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export const BRAND_EN = 'Meadhall';
export const BRAND_ZH = '蜜酒厅';
export const BRAND_LABS = 'Meadhall Labs';

// 落地页(公测预约 + /legal 法律文档正本)
export const LANDING_BASE = env.VITE_LANDING_BASE || 'https://play.stellatrix.icu';
// 开源文档站(站内帮助抽屉以 iframe 打开其 /embed/<slug>)
export const DOCS_ORIGIN = env.VITE_DOCS_ORIGIN || 'https://docs.stellatrix.icu';
// 默认在线后端(自部署/移动端"在线模式"缺省指向)
export const ONLINE_BASE = env.VITE_ONLINE_BASE || 'https://rpg-roleplay.stellatrix.icu';

export const SUPPORT_EMAIL = env.VITE_SUPPORT_EMAIL || 'support@stellatrix.icu';
export const SECURITY_EMAIL = env.VITE_SECURITY_EMAIL || 'security@stellatrix.icu';

export const LEGAL_BASE = `${LANDING_BASE}/legal`;
export const AUP_LINK = `${LEGAL_BASE}/aup#2J`;
export const ADULT_DISCLAIMER_URL = `${LANDING_BASE}/legal/adult-content-disclaimer`;
