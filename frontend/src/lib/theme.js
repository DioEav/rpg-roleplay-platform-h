/* theme — 界面主题(暗/亮)切换与持久化。
 *
 * 模式完全照抄「密度切换」先例(game-console.jsx / tavern.jsx 的 RPG_setDensity):
 *   <html data-theme> 属性 + localStorage + CustomEvent + window.RPG_* 全局 API。
 *
 * 主题令牌三选一:
 *   - 'light-a' 亮色 · 暖纸(暖米白 + 赤陶橘,品牌延续)← 默认
 *   - 'light-b' 亮色 · 青竹(冷白微绿 + 竹青绿)
 *   - 'dark'    暗色 · 暖夜(原暗色风格)
 * CSS 侧对应 tokens.css 的 :root / :root[data-theme="light-a"] / [data-theme="light-b"];
 * Cloudscape 侧对应 cloudscape-theme.js 的 installWarmTheme(token) / setTheme(token)。
 *
 * 快切语义:顶栏太阳/月亮按钮 = 暗 ⇄ 上次使用的亮色子风格(rpg.theme.light 记忆,
 * 未曾选过则回落 light-a)。下拉菜单可精确指定三种之一。
 */

import { lsGet, lsSet } from './storage.js';

export const THEME_KEY = 'rpg.theme';          // 当前生效令牌: dark | light-a | light-b
export const THEME_LIGHT_KEY = 'rpg.theme.light'; // 记住上次用的亮色子风格,供快切回落
export const THEMES = ['dark', 'light-a', 'light-b'];

export function isLightTheme(token) {
  return token === 'light-a' || token === 'light-b';
}

/** 读取持久化的当前主题令牌(非法/缺失回落默认 light-a 亮色·暖纸)。 */
export function getTheme() {
  const v = lsGet(THEME_KEY, 'light-a');
  return THEMES.includes(v) ? v : 'light-a';
}

/** 读取「上次使用的亮色子风格」(快切用,非法/缺失回落 light-a)。 */
export function getLastLightTheme() {
  const v = lsGet(THEME_LIGHT_KEY, 'light-a');
  return isLightTheme(v) ? v : 'light-a';
}

/** 只把 data-theme 属性落到 <html>(不持久化、不发事件)。入口启动时首屏前调用。 */
export function applyThemeAttr(token) {
  document.documentElement.setAttribute('data-theme', isLightTheme(token) ? token : 'dark');
}

/**
 * 切换主题:落属性 + 持久化 + 派发 rpg-theme-change。
 * 调用方(React 组件/全局 API)负责同步 Cloudscape(见 cloudscape-theme.js setTheme)。
 * @param {string} token 'dark' | 'light-a' | 'light-b'
 * @returns {string} 实际生效的令牌
 */
export function setTheme(token) {
  const t = THEMES.includes(token) ? token : 'light-a';
  applyThemeAttr(t);
  lsSet(THEME_KEY, t);
  if (isLightTheme(t)) lsSet(THEME_LIGHT_KEY, t);
  window.dispatchEvent(new CustomEvent('rpg-theme-change', { detail: { theme: t } }));
  return t;
}

/** 顶栏快切:暗 → 上次亮色;亮 → 暗。返回新令牌。 */
export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || getTheme();
  return setTheme(isLightTheme(cur) ? 'dark' : getLastLightTheme());
}

// 全局 API(与 RPG_setDensity 同款,供游戏台/酒馆等非 React 场景与控制台调试调用)
if (typeof window !== 'undefined') {
  window.RPG_getTheme = getTheme;
  window.RPG_setTheme = setTheme;
  window.RPG_toggleTheme = toggleTheme;

  // 模块加载即把已存主题落到 <html>(早于 React 渲染,防闪烁;暗色也显式落属性,
  // 使 CSS 的 [data-theme="dark"] / :not([data-theme="dark"]) 判断始终成立)
  applyThemeAttr(getTheme());

  // 跨标签页跟随:平台 ↔ 游戏台是多标签工作流,别的标签切主题时本标签实时跟随
  // (storage 事件只在「非写入方」标签触发,天然不会回环)。
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    const t = getTheme();
    applyThemeAttr(t);
    window.dispatchEvent(new CustomEvent('rpg-theme-change', { detail: { theme: t } }));
  });
}
