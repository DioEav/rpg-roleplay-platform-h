/* Game Console — main app shell: top bar, left rail, chat area with run-state, right panel. */
// 模块化拆分(纯机械搬家,DOM/视觉/行为零变化):组件定义已搬到 components/game/,
// 本文件只保留 toast 总线顶层副作用 + 全部具名 export 转发。
// 【历史大坑,勿动】下方 toast 总线 install 顶层副作用必须留在本文件:曾把桌面 Platform 的
// __apiToast 劫持到 game 总线造成静默丢通知,现接线一字未动。

import { createToastChannel } from './toast.jsx';

// ── 组件转发(逐字节搬迁到 components/game/,零行为变化)──────────────────────
export { LeftRail, ThinkingPill } from './components/game/GameLeftRail.jsx';
export { NarrativeBlock, PlayerBlock, renderNarrativeWithInlineTools, useSaveImages, SaveImagesStrip } from './components/game/GameChatMessages.jsx';
export { ChatArea } from './components/game/GameChatArea.jsx';
export { GameSettingsModal } from './components/game/GameSettingsModal.jsx';
export { HistoryDrawer, SearchDrawer } from './components/game/GameDrawers.jsx';
export { TopBar } from './components/game/GameTopBar.jsx';

// ----------------------- TOAST 容器 (task 14) ----------------------------
// 现象：Game Console 调 window.__apiToast / window.toast 但只落到 console.log，
// 因为 ToastStack 只挂在 Platform Shell，Game Console 页没人渲染它。
// 修法：toast pub/sub + window.toast/__apiToast + pl-toast-stack 渲染已收口到 ./toast.jsx 的
// createToastChannel(与 platform-app 共用工厂)。game 通道逐字保留原 IIFE 语义:
//   · window.toast 仅在未被 Platform 装过时才装(guardWindowToast);
//   · __apiToast 无条件指向本通道 fire(setApiToast,覆盖 api-client 的 console 兜底);
//   · GameToastStack = 本通道的 ToastStack(兼容现有 import { GameToastStack })。
// install() 在模块加载即执行(等价原 IIFE 时机);幂等(__GAME_TOAST 由通道 installed 标记承接)。
const __gameToast = createToastChannel({ name: 'game', setWindowToast: true, guardWindowToast: true, setApiToast: true });
const GameToastStack = __gameToast.ToastStack;
__gameToast.install();

export { GameToastStack };
