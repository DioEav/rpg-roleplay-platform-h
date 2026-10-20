/* script-desc.js — 剧本「导入描述」的纯解析,收口自:
 *   components/platform/ProfilePage.jsx(首页精选 Hero 描述行)
 *   components/scripts/ScriptsLibraryView.jsx(在线剧本库表格 desc 列)
 * 背景:script_import/imports.py 曾把描述生成为
 *   「导入剧本 · N章 · 规则融合自适应 · 置信 0.88」并持久化(2026-10 起新生成只存
 *   「导入剧本 · N章」),DB 里两种存量并存。描述是持久化字符串、语言随导入时固定,
 * 展示层统一解析出章数交给调用方做 i18n(scripts.public.imported_desc);
 * 非自动生成(用户自写)的描述返回 null,调用方原样显示。
 */

/**
 * @param {string} desc 剧本 description 字段
 * @returns {{ n: number } | null} 命中自动生成模式时返回章数,否则 null
 */
export function parseImportedDesc(desc) {
  if (!desc) return null;
  const m = /^导入剧本\s*·\s*([\d,]+)\s*章/.exec(String(desc));
  return m ? { n: Number(m[1].replace(/,/g, '')) } : null;
}
