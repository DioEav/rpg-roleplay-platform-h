// Cloudscape 暖色主题 —— 把项目 tokens.css 的暖色板映射到 Cloudscape 设计令牌。
// 三套调色板与 tokens.css 一一对应:
//   light-b 亮色·青竹(默认)  → Mode.Light
//   light-a 亮色·暖纸        → Mode.Light
//   dark    暗色·暖夜(原现状) → Mode.Dark
// installWarmTheme(token) 启动时按已存主题安装;运行期切换走 setTheme(token),
// 并监听 lib/theme.js 派发的 rpg-theme-change 自动跟随(调用方只需改 data-theme)。
import { applyMode, Mode, applyDensity, Density } from '@cloudscape-design/global-styles';
import { applyTheme } from '@cloudscape-design/components/theming';

// 暗色 · 暖夜(对齐 tokens.css :root,原现状,一个值不变)
const C_DARK = {
  bg: '#1a1817',
  bgDeep: '#131211',
  panel: '#211f1d',
  panel2: '#282623',
  panel3: '#2f2c28',
  line: '#36322d',
  lineSoft: '#2a2724',
  lineStrong: '#4a4540',
  text: '#ebe7df',
  textQuiet: '#c8c2b7',
  muted: '#968f85',
  accent: '#c96442',
  accentHover: '#b6593b',
  accentActive: '#a44f34',
  accentSoft: 'rgba(201, 100, 66, 0.16)',
};

// 亮色 A · 暖纸(对齐 tokens.css [data-theme="light-a"];赤陶橘加深保对比度)
const C_LIGHT_A = {
  bg: '#f7f3ec',
  bgDeep: '#efe9dd',
  panel: '#fffdf9',
  panel2: '#f2ecdf',
  panel3: '#eae2d1',
  line: '#ddd2bf',
  lineSoft: '#e9e1d1',
  lineStrong: '#c4b69e',
  text: '#35312a',
  textQuiet: '#5b554b',
  muted: '#827a6c',
  accent: '#b5532c',
  accentHover: '#a04623',
  accentActive: '#8d3d1e',
  accentSoft: 'rgba(181, 83, 44, 0.12)',
};

// 亮色 B · 青竹(对齐 tokens.css [data-theme="light-b"];竹青绿主色)
const C_LIGHT_B = {
  bg: '#f3f7f3',
  bgDeep: '#e9efe8',
  panel: '#ffffff',
  panel2: '#eef3ed',
  panel3: '#e3ece3',
  line: '#d2dcd1',
  lineSoft: '#e1e8e0',
  lineStrong: '#b0c0af',
  text: '#273028',
  textQuiet: '#4e5b50',
  muted: '#71806f',
  accent: '#2e8359',
  accentHover: '#27714c',
  accentActive: '#205e40',
  accentSoft: 'rgba(46, 131, 89, 0.12)',
};

const PALETTES = { dark: C_DARK, 'light-a': C_LIGHT_A, 'light-b': C_LIGHT_B };

// 默认主题(未存储过偏好时):亮色 · 青竹。与 lib/theme.js getTheme() 的回落值保持一致。
const DEFAULT_THEME = 'light-b';

// 颜色令牌:同时给 light/dark 槽位(Mode 由 applyMode 决定,双写更稳)
const dual = (v) => ({ light: v, dark: v });

// context 值微调:theming-runtime 的 MinimalTransformer 会把「与 root 令牌同值」的
// context 覆盖从生成规则里剔除(认为继承即可);但 global-styles 的分层暗色 context
// 规则会直接命中 .awsui-context-top-navigation 元素、压过继承值 → 顶栏文字/图标回落
// AWS 暗色默认灰(亮色下几乎不可读)。给 context 值做 1/255(或 0.001 alpha)级微调,
// 使其 ≠ root 值从而保留在规则里,差异视觉不可辨。
function offsetForContext(v) {
  const hex = typeof v === 'string' && v.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const nb = b < 255 ? b + 1 : b - 1;
    return '#' + ((r << 16) | (g << 8) | nb).toString(16).padStart(6, '0');
  }
  const rgba = typeof v === 'string' && v.match(/^rgba\((.+),\s*([\d.]+)\)$/i);
  if (rgba) {
    const a = Math.min(1, parseFloat(rgba[2]) + 0.001);
    return `rgba(${rgba[1]}, ${a})`;
  }
  return v;
}

const offsetAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, offsetForContext(v)]));

// 由调色板构建 Cloudscape 主题(tokens 结构与原暗色版完全一致,只换色源)
function buildTheme(C) {
  return {
    tokens: {
      // 字体:沿用项目现有中文字体 + serif 叙事标题
      fontFamilyBase: "'Noto Sans SC', system-ui, -apple-system, sans-serif",
      fontFamilyHeading: "'Noto Serif SC', 'Noto Sans SC', serif",

      // ── 字号阶梯整体调小(中文 + Cloudscape 默认偏大,挤压密度)──────────
      fontSizeBodyM: '13px', lineHeightBodyM: '19px',
      fontSizeBodyS: '12px', lineHeightBodyS: '16px',
      fontSizeHeadingXl: '19px', lineHeightHeadingXl: '25px',   // 页面标题 H1
      fontSizeHeadingL: '16px', lineHeightHeadingL: '21px',     // 容器标题 H2
      fontSizeHeadingM: '14px', lineHeightHeadingM: '19px',     // 卡片/区块 H3
      fontSizeHeadingS: '13px', lineHeightHeadingS: '18px',
      fontSizeHeadingXs: '12.5px', lineHeightHeadingXs: '17px',
      fontSizeDisplayL: '28px', lineHeightDisplayL: '34px',
      fontSizeFormLabel: '12.5px', lineHeightFormLabel: '17px',
      fontSizeTabs: '13px', lineHeightTabs: '18px',
      fontSizeKeyValuePairsLabel: '11.5px', lineHeightKeyValuePairsLabel: '16px',

      // ── 背景层 ──────────────────────────────────────────────
      colorBackgroundLayoutMain: dual(C.bg),
      colorBackgroundContainerContent: dual(C.panel),
      colorBackgroundContainerHeader: dual(C.panel),
      colorBackgroundHomeHeader: dual(C.bgDeep),
      colorBackgroundInputDefault: dual(C.bgDeep),
      colorBackgroundDropdownItemDefault: dual(C.panel),
      colorBackgroundDropdownItemHover: dual(C.panel2),
      colorBackgroundDropdownItemSelected: dual(C.accentSoft),
      // 下拉/弹出层表面(awsui_dropdown-content-wrapper / popover)→ 主题色,
      // 否则落到 Cloudscape 默认(暗色 #161d26 蓝灰 / 亮色纯白)。
      colorBackgroundPopover: dual(C.panel),
      colorBackgroundDropdownItemFilterMatch: dual(C.accentSoft),
      colorBackgroundItemSelected: dual(C.accentSoft),
      colorBackgroundCellShaded: dual(C.panel2),
      colorBackgroundButtonNormalDefault: dual(C.panel2),
      colorBackgroundButtonNormalHover: dual(C.panel3),
      colorBackgroundButtonNormalActive: dual(C.panel3),
      // 普通按钮文字/图标:用主题文字色,别留 AWS 蓝
      colorTextButtonNormalDefault: dual(C.text),
      colorTextButtonNormalHover: dual(C.text),
      colorTextButtonNormalActive: dual(C.text),
      colorTextButtonLinkDefault: dual(C.accent),
      colorTextButtonLinkHover: dual(C.accentHover),
      colorTextButtonLinkActive: dual(C.accentActive),
      colorBackgroundControlChecked: dual(C.accent),
      colorBackgroundControlDefault: dual(C.bgDeep),
      colorBackgroundLayoutToggleDefault: dual(C.panel2),
      colorBackgroundLayoutToggleHover: dual(C.panel3),

      // ── 文本 ────────────────────────────────────────────────
      colorTextBodyDefault: dual(C.text),
      colorTextHeadingDefault: dual(C.text),
      colorTextBodySecondary: dual(C.muted),
      colorTextLabel: dual(C.textQuiet),
      colorTextFormLabel: dual(C.textQuiet),
      colorTextFormSecondary: dual(C.muted),
      colorTextGroupLabel: dual(C.muted),
      colorTextDropdownItemDefault: dual(C.text),
      colorTextAccent: dual(C.accent),
      colorTextInteractiveDefault: dual(C.textQuiet),
      colorTextInteractiveHover: dual(C.text),
      colorTextInteractiveActive: dual(C.text),
      colorTextLinkDefault: dual(C.accent),
      colorTextLinkHover: dual(C.accentHover),

      // ── 主按钮(强调色) ────────────────────────────────────
      colorBackgroundButtonPrimaryDefault: dual(C.accent),
      colorBackgroundButtonPrimaryHover: dual(C.accentHover),
      colorBackgroundButtonPrimaryActive: dual(C.accentActive),
      colorTextButtonPrimaryDefault: dual('#ffffff'),
      colorTextButtonPrimaryHover: dual('#ffffff'),
      colorTextButtonPrimaryActive: dual('#ffffff'),
      colorBorderButtonPrimaryDefault: dual(C.accent),
      colorBorderButtonPrimaryHover: dual(C.accentHover),

      // ── 边框 ────────────────────────────────────────────────
      colorBorderDividerDefault: dual(C.line),
      colorBorderInputDefault: dual(C.lineStrong),
      colorBorderButtonNormalDefault: dual(C.lineStrong),
      colorBorderButtonNormalHover: dual(C.muted),
      colorBorderItemFocused: dual(C.accent),
      colorBorderItemSelected: dual(C.accent),          // 表格/卡片选中行描边 → 主题色(原 AWS 蓝)
      // 分段控件(SegmentedControl)选中态 → 主题色(原 AWS 蓝)
      colorBackgroundSegmentActive: dual(C.accent),
      colorBorderSegmentActive: dual(C.accent),
      colorTextSegmentActive: dual('#ffffff'),
      colorBackgroundToggleButtonNormalPressed: dual(C.accentSoft),
    },
  // 顶栏(TopNavigation)走独立 context,默认是 AWS 冷灰 —— 单独染主题色。
  // 值统一过 offsetForContext(见上,防 MinimalTransformer 剔除与 root 同值的覆盖)。
  contexts: {
    'top-navigation': {
      tokens: offsetAll({
        colorBackgroundContainerContent: C.bgDeep,
        colorBackgroundContainerHeader: C.bgDeep,
        colorBackgroundDropdownItemDefault: C.panel,
        colorBackgroundDropdownItemHover: C.panel2,
        // 下拉选中项 / 搜索框 → 主题色(原 AWS 冷蓝默认)
        colorBackgroundDropdownItemSelected: C.accentSoft,
        colorBackgroundItemSelected: C.accentSoft,
        colorBackgroundInputDefault: C.bgDeep,
        colorBackgroundButtonNormalDefault: C.panel2,
        colorBackgroundButtonNormalHover: C.panel3,
        colorBackgroundButtonNormalActive: C.panel3,
        colorBorderDividerDefault: C.line,
        colorBorderInputDefault: C.lineStrong,
        colorBorderInputFocused: C.accent,
        colorBorderItemFocused: C.accent,
        colorBorderButtonNormalDefault: C.lineStrong,
        colorTextBodyDefault: C.text,
        colorTextInteractiveDefault: C.textQuiet,
        colorTextInteractiveHover: C.text,
        colorTextAccent: C.accent,
        colorTextLinkDefault: C.accent,
        colorTextDropdownItemDefault: C.text,
        colorTextButtonNormalDefault: C.text,
        colorTextButtonNormalHover: C.text,
      }),
    },
  },
  };
}

let _reset = null;

// 按 token 安装 Cloudscape 模式 + 令牌。重复调用安全(先 reset 旧主题再上新主题)。
function applyCloudscapeTheme(token) {
  const C = PALETTES[token] || PALETTES[DEFAULT_THEME];
  applyMode(token === 'dark' ? Mode.Dark : Mode.Light);
  try {
    if (_reset) {
      try { _reset(); } catch (_) { /* 旧 reset 失败不阻塞新主题 */ }
      _reset = null;
    }
    const r = applyTheme({ theme: buildTheme(C) });
    _reset = r && r.reset;
  } catch (e) {
    // 令牌名漂移时不致命:打日志,保留 Cloudscape 默认配色
    console.error('[cloudscape-theme] applyTheme failed:', e);
  }
}

/**
 * 启动安装。token 缺省取默认主题(亮色·青竹)。
 * @param {'dark'|'light-a'|'light-b'} [token]
 */
export function installWarmTheme(token = DEFAULT_THEME) {
  applyDensity(Density.Compact); // 紧凑密度:更小行高/内边距,提升信息密度
  applyCloudscapeTheme(token);
}

/**
 * 运行期切换(幂等)。与 lib/theme.js 的 setTheme 配套:
 * 那边落 data-theme + localStorage + 事件,这里同步 Cloudscape。
 * @param {'dark'|'light-a'|'light-b'} token
 */
export function setCloudscapeTheme(token) {
  applyCloudscapeTheme(PALETTES[token] ? token : DEFAULT_THEME);
}

// 跟随 lib/theme.js 的主题事件 —— 任何入口只要调用 window.RPG_setTheme /
// dispatch 'rpg-theme-change',Cloudscape 表面即同步换装。
if (typeof window !== 'undefined') {
  window.addEventListener('rpg-theme-change', (e) => {
    setCloudscapeTheme((e && e.detail && e.detail.theme) || DEFAULT_THEME);
  });
}
