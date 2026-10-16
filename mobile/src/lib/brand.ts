/**
 * brand — 品牌、线上域名与法务链接的单一出口。
 * 换域名时只改这个文件（或用 EXPO_PUBLIC_ 环境变量覆盖）。
 * 注意:env 必须写成 `process.env.EXPO_PUBLIC_X` 字面量 —— Expo 只对字面量做
 * 构建期内联,赋值给中间变量后再取属性会导致生产包里覆盖失效。
 * 与 frontend/src/lib/brand.js、后端 rpg 的默认值保持一致。
 */

export const BRAND_EN = "Meadhall";
export const BRAND_ZH = "蜜酒厅";
export const BRAND_LABS = "Meadhall Labs";

// 落地页(公测预约 + /legal 法律文档正本)
export const LANDING_BASE =
  process.env.EXPO_PUBLIC_LANDING_BASE || "https://play.stellatrix.icu";
// 默认在线后端(官方云实例,App 启动缺省直连)
export const ONLINE_BASE =
  process.env.EXPO_PUBLIC_ONLINE_BASE || "https://rpg-roleplay.stellatrix.icu";
export const SUPPORT_EMAIL =
  process.env.EXPO_PUBLIC_SUPPORT_EMAIL || "support@stellatrix.icu";

export const LEGAL_BASE = `${LANDING_BASE}/legal`;
export const ADULT_DISCLAIMER_ZH_URL = `${LEGAL_BASE}/adult-content-disclaimer.zh-CN.html`;
