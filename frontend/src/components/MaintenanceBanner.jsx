/**
 * MaintenanceBanner.jsx — 全局维护模式横幅
 *
 * 自行拉取 GET /api/maintenance/status(公开端点,503 gate 豁免),维护开启时
 * 显示横幅(标签 + 管理员填写的公告文本);关闭后 60s 轮询内自动消失。
 * 不可 dismiss —— 维护公告需要用户看到。
 *
 * 渲染为普通文档流块(非 fixed 覆盖层):桌面插在吸顶导航之前、移动插在
 * .pl-root 顶部,都把内容自然推下去,不与标题栏重叠;滚动时横幅随页滚走。
 *
 * 挂载点:PlatformShellCS(platform-app.jsx)与 MobileRoot(mobile/MobileRoot.jsx)
 * 各一处 —— 登录页另有独立的公告条(见 login-app.jsx)。
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const POLL_MS = 60_000;

export default function MaintenanceBanner() {
  const { t } = useTranslation();
  const [state, setState] = useState(null); // {enabled, announcement} | null

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        // __API_BASE 由 api-client 解析(同源为空串;跨域/静态托管时指向 API 服务器)
        const base = (window.__API_BASE || "").replace(/\/+$/, "");
        const r = await fetch(`${base}/api/maintenance/status`, { credentials: 'include' });
        const j = await r.json();
        if (!cancelled) setState({ enabled: !!j.enabled, announcement: j.announcement || '' });
      } catch {
        if (!cancelled) setState(null); // 拉不到就静默,不因网络抖动误报维护
      }
    }
    check();
    const timer = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // 向 api-client 广播「本页面有维护横幅」:503 且 payload.maintenance 时才抑制
  // 通用 toast(游戏台等无横幅的独立入口仍靠 toast 获得反馈)
  useEffect(() => {
    const visible = !!(state && state.enabled);
    try { window.__MAINTENANCE_BANNER_VISIBLE = visible; } catch (_) {}
    return () => { try { window.__MAINTENANCE_BANNER_VISIBLE = false; } catch (_) {} };
  }, [state]);

  if (!state || !state.enabled) return null;

  return (
    <div
      role="alert"      style={{
        flex: 'none',
        background: 'var(--warn-soft, #fdf3d7)', color: 'var(--warn, #8a6d1f)',
        borderBottom: '1px solid rgba(212,179,102,0.4)',
        padding: '8px 16px', paddingTop: 'calc(var(--safe-top, 0px) + 8px)', fontSize: 13.5,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      }}
    >
      <strong style={{ flexShrink: 0 }}>{t('platform.maintenance_banner.label')}</strong>
      {state.announcement && <span>{state.announcement}</span>}
    </div>
  );
}
