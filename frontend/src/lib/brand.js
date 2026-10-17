/**
 * brand — 品牌、线上域名与法务链接的单一出口。
 *
 * 换域名 / 改品牌时只改这一个文件（或用 VITE_ 环境变量覆盖），各端引用处不用动。
 * 注意:env 必须写成 `import.meta.env.VITE_X` 字面量 —— Vite 只对字面量做静态替换,
 * 赋值给中间变量后再取属性会导致生产构建里覆盖失效。
 * 后端镜像的默认值在 rpg/platform_app/*.py(环境变量驱动),部署侧在 deploy/ 的
 * .env 与 nginx conf —— 三处默认值需保持一致。
 */

export const BRAND_EN = 'Meadhall';
export const BRAND_ZH = '蜜酒厅';
export const BRAND_LABS = 'Meadhall Labs';

// 按界面语言取品牌名(zh 系语言 → 中文,其余 → 英文)。
// 品牌字符串不进 i18n 语言包 —— 仍以本文件为唯一出口(见文件头注释),
// 组件侧用 brandNameForLang(i18n.language) 取用。
export function brandNameForLang(lang) {
  return /^zh([-_]|$)/i.test(String(lang || '')) ? BRAND_ZH : BRAND_EN;
}

// 落地页(公测预约 + /legal 法律文档正本)
export const LANDING_BASE = import.meta.env.VITE_LANDING_BASE || 'https://play.stellatrix.icu';
// 开源文档站(站内帮助抽屉以 iframe 打开其 /embed/<slug>)
export const DOCS_ORIGIN = import.meta.env.VITE_DOCS_ORIGIN || 'https://docs.stellatrix.icu';
// 默认在线后端(自部署/移动端"在线模式"缺省指向)
export const ONLINE_BASE = import.meta.env.VITE_ONLINE_BASE || 'https://rpg-roleplay.stellatrix.icu';

export const SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL || 'support@stellatrix.icu';
export const SECURITY_EMAIL = import.meta.env.VITE_SECURITY_EMAIL || 'security@stellatrix.icu';

export const LEGAL_BASE = `${LANDING_BASE}/legal`;
export const AUP_LINK = `${LEGAL_BASE}/aup#2J`;
export const ADULT_DISCLAIMER_URL = `${LANDING_BASE}/legal/adult-content-disclaimer`;
