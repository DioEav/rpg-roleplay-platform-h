/* Game Console 顶栏(TopBar)—— 纯机械从 game-app.jsx 搬出,DOM/视觉/行为零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useState as useStateA, useEffect as useEffectA } from 'react';
import { Icon } from '../../game-icons.jsx';
import ThemeToggle from '../ThemeToggle.jsx';

// ----------------------------- TOP BAR -----------------------------------
function TopBar({ state, saveUpdatedAt, onOpenSearch, onOpenHistory, onOpenSettings, railCollapsed, onExpandRail, panelCollapsed, onExpandPanel, versionSelectEl, onOpenNav }) {
  const { t } = useTranslation();
  // task 49：原 "已存档 · 12 分钟前" 写死。改成读真实 save 的 updated_at（来自 /api/saves）。
  const savedAgo = (saveUpdatedAt && window.__fmt && window.__fmt.ago)
    ? window.__fmt.ago(saveUpdatedAt)
    : (saveUpdatedAt || "—");
  const scriptName = state?._raw?.save_title || state?.app?.script_name || "";
  // M7 修复：state.app.current_chapter 后端从不写，恒 undefined；权威值来自
  // GET /api/saves/:id/timeline 的 current_chapter（game-panels.jsx PanelTimeline 同款读法）。
  // 存档切换时（saveId 变化）才重新拉取，避免每次 render 重复请求。
  const saveId = state?._raw?.save_id ?? null;
  const [currentChapter, setCurrentChapter] = useStateA(null);
  // 白玖实锤:面板「回到此节点」成功后广播 game-state-refresh,但顶栏章号只挂 saveId
  // 依赖 → rewind 后顶栏停在旧章(数据层已回退,纯显示滞后)。监听同一事件重拉。
  const [chapterTick, setChapterTick] = useStateA(0);
  useEffectA(() => {
    const bump = () => setChapterTick((k) => k + 1);
    window.addEventListener("game-state-refresh", bump);
    return () => window.removeEventListener("game-state-refresh", bump);
  }, []);
  useEffectA(() => {
    if (!saveId) { setCurrentChapter(null); return; }
    let cancelled = false;
    const base = (typeof window !== "undefined" && window.__API_BASE) || "";
    fetch(`${base}/api/saves/${saveId}/timeline`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (!cancelled && json) setCurrentChapter(json.current_chapter ?? null); })
      .catch(() => { if (!cancelled) setCurrentChapter(null); });
    return () => { cancelled = true; };
  }, [saveId, chapterTick]);
  const chapter = currentChapter ? t('game.app.topbar.chapter', { n: currentChapter }) : "";
  const phase = state?.world?.timeline?.current_phase || "";
  return (
    <header className="gc-topbar">
      <div className="gc-topbar-left">
        {/* #手机端: 汉堡按钮打开 rail 抽屉(存档/记忆/分支/运行状态),仅移动端显示 */}
        <button className="iconbtn gc-nav-toggle" onClick={onOpenNav} data-tip={t('game.app.topbar.menu_tip')} data-tip-pos="below" aria-label={t('game.app.topbar.open_menu')}>
          <Icon name="menu" size={16} />
        </button>
        {railCollapsed && (
          <button className="iconbtn gc-topbar-expand" onClick={onExpandRail} data-tip={t('game.app.topbar.expand_rail')} data-tip-pos="below">
            <Icon name="chevron_right" size={14} />
          </button>
        )}
        <span className="pill"><span className="dot ok" /> {saveUpdatedAt ? t('game.app.topbar.saved_ago', { ago: savedAgo }) : t('game.app.topbar.unsaved')}</span>
        {versionSelectEl}
      </div>
      <div className="gc-topbar-center">
        {scriptName && <span style={{maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{scriptName}</span>}
        {chapter && <><span>·</span><span>{chapter}</span></>}
        {phase && <><span>·</span><span style={{color:'var(--text)'}}>{phase}</span></>}
      </div>
      <div className="gc-topbar-right">
        <button className="iconbtn" data-tip={t('game.app.topbar.history_tip')} data-tip-pos="below" onClick={onOpenHistory}><Icon name="history" size={14} /></button>
        <button className="iconbtn" data-tip={t('game.app.topbar.search_tip')} data-tip-pos="below" onClick={onOpenSearch}><Icon name="search" size={14} /></button>
        {/* 导出可读 .txt(当小说分享用)— 链接走 cookie 鉴权,Content-Disposition: attachment 直接下载 */}
        {state?._raw?.save_id ? (
          <a className="iconbtn" download
             href={`${window.__API_BASE || ''}/api/saves/${state._raw.save_id}/export/txt`}
             data-tip={t('game.app.topbar.export_txt_tip')} data-tip-pos="below"
             aria-label={t('game.app.topbar.export_txt_tip')}>
            <Icon name="book" size={14} />
          </a>
        ) : null}
        <button className="iconbtn" data-tip={t('game.app.topbar.settings_tip')} data-tip-pos="below" onClick={onOpenSettings}><Icon name="settings" size={14} /></button>
        {/* 主题切换(快切 + 暗夜/暖纸/青竹三选下拉)— 与平台顶栏同款组件 */}
        <ThemeToggle />
        {/* 反馈入口 — 玩家遇 bug 时不用切回 Platform tab,直接报。
            runtime-telemetry 已装钩子,提交时自动附带最近 20 errors + 10 失败
            API + 最近对话快照,无需手动复制日志(FeedbackDrawer.jsx:154
            window.__getRuntimeSnapshot({includeRecentDialog: true})) */}
        <button className="iconbtn" data-tip={t('game.app.topbar.feedback_tip')} data-tip-pos="below"
                aria-label={t('game.app.topbar.feedback_tip')}
                onClick={() => {
                  if (window.__openFeedback) window.__openFeedback();
                  else window.dispatchEvent(new CustomEvent('feedback:open'));
                }}>
          <Icon name="message_square" size={14} />
        </button>
        {/* task: 游戏内不再放使用须知按钮(只保留反馈),减少顶栏干扰。
            想看须知到 Platform 点「📖 使用须知」即可 */}
        {panelCollapsed && (
          <button className="iconbtn gc-topbar-expand-right" data-tip={t('game.app.topbar.expand_panel')} data-tip-pos="below" onClick={onExpandPanel}>
            <Icon name="chevron_left" size={14} />
          </button>
        )}
        {/* task 127: 删 Tweaks 调试按钮 — 用户不要这个内部入口 */}
      </div>
    </header>);

}

export { TopBar };
