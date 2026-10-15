/* ThemeToggle — 顶栏主题切换(快切 + 子风格下拉),平台顶栏与游戏台顶栏共用。
 *
 * 交互(与已确认的效果图一致):
 *   - 点太阳/月亮 = 暗 ⇄ 上次亮色子风格 快切(lib/theme.js toggleTheme)
 *   - 点小箭头   = 下拉菜单精确三选:暗色·暖夜 / 亮色·暖纸 / 亮色·青竹
 * 样式在 tokens.css(.thm-*);Cloudscape 表面由 cloudscape-theme.js 监听
 * rpg-theme-change 自动跟随,这里只调 lib/theme.js 的 setTheme。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getTheme, setTheme, toggleTheme, isLightTheme } from '../lib/theme.js';

const OPTIONS = [
  { id: 'dark', swatch: 'thm-sw-dark', labelKey: 'theme.dark' },
  { id: 'light-a', swatch: 'thm-sw-pa', labelKey: 'theme.light_a' },
  { id: 'light-b', swatch: 'thm-sw-bam', labelKey: 'theme.light_b' },
];

const SunIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.2v1.9M8 12.9v1.9M1.2 8h1.9M12.9 8h1.9M3.2 3.2l1.35 1.35M11.45 11.45l1.35 1.35M12.8 3.2l-1.35 1.35M4.55 11.45L3.2 12.8" />
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.2 9.6A5.8 5.8 0 0 1 6.4 2.8a5.8 5.8 0 1 0 6.8 6.8z" />
  </svg>
);

const CaretIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.6l3.2 3.2L13 5" />
  </svg>
);

export default function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setCur] = useState(() => getTheme());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // 其他入口(设置页/游戏台/控制台)切主题时同步按钮态
  useEffect(() => {
    const onCh = (e) => setCur((e && e.detail && e.detail.theme) || getTheme());
    window.addEventListener('rpg-theme-change', onCh);
    return () => window.removeEventListener('rpg-theme-change', onCh);
  }, []);

  // 点外面/Escape 收起下拉
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const light = isLightTheme(theme);
  const quickLabel = light ? t('theme.toggle_dark') : t('theme.toggle_light');

  return (
    <span className="thm-wrap" ref={wrapRef}>
      <button
        type="button"
        className="thm-quick"
        onClick={() => setCur(toggleTheme())}
        aria-label={quickLabel}
        title={quickLabel}
      >
        <span className="thm-sun"><SunIcon /></span>
        <span className="thm-moon"><MoonIcon /></span>
      </button>
      <button
        type="button"
        className="thm-caret"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('theme.menu_title')}
        title={t('theme.menu_title')}
      >
        <CaretIcon />
      </button>
      {open && (
        <div className="thm-menu" role="menu" aria-label={t('theme.menu_title')}>
          <div className="thm-menu-title">{t('theme.menu_title')}</div>
          {OPTIONS.map((o) => {
            const active = theme === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={'thm-item' + (active ? ' active' : '')}
                onClick={() => { setCur(setTheme(o.id)); setOpen(false); }}
              >
                <span className={'thm-sw ' + o.swatch}><i /><i /><i /></span>
                {t(o.labelKey)}
                <span className="thm-check"><CheckIcon /></span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
