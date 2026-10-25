// Game Console 页面入口 — Vite ESM 版
import '../web-vitals-rum.js';
import React from 'react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import * as ReactDOM from 'react-dom/client';

// 基础设施 side-effect 模块
import '../mock-data.js';
import '../api-client.js';
// 运行环境采集 — 反馈抽屉提交时附带最近 20 个错误 + 10 个失败 API 给管理员排查
import '../runtime-telemetry.js';
import '../data-loader.js';
import '../state-event-bridge.js';
import '../worldbook-status-toast.js';
import '../ui-atlas.js';
import '../a11y-tooltip-labels.js';   // data-tip → aria-label 镜像(屏幕阅读器)
import '../console-assistant-navigation.jsx';
import '../i18n/index.js';   // 初始化 i18next + 接 interfaceLang
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { lsGet, lsSet, lsRemove } from '../lib/storage.js';
import { normalizePermissionForUi } from '../lib/permission-mode.js';
import { isMobileV2Enabled } from '../lib/mobile-gate.js';

// 客户端动作命令:本地执行、不发给 GM(区别于 /set /loc /time 等后端 directive,后者仍作为文本发送)。
const CLIENT_CMDS = new Set(['retry', 'save', 'status', 'debug']);

// 反馈抽屉使用 Cloudscape 组件；游戏页也加载同一套暖色主题(按已存主题,首屏前无闪烁)。
import '@cloudscape-design/global-styles/index.css';
import { installWarmTheme } from '../cloudscape-theme.js';
import { getTheme } from '../lib/theme.js';
installWarmTheme(getTheme());

// 组件模块 — named import
import { useResizable, useBreakpoint } from '../responsive.jsx';
// 移动原生游戏台(P2)— <600px 且开启 m2 标志时替代电脑端 gc-shell。
import '../mobile.css';
import '../media.css';
import { MobileGame } from '../mobile/game/MobileGame.jsx';
import { safeUUID } from '../lib/crypto-safe.js';
import { safeStructuredClone } from '../lib/clone-safe.js';
import { LeftRail, TopBar, ChatArea, HistoryDrawer, SearchDrawer, GameToastStack, GameSettingsModal } from '../game-app.jsx';
import { Composer, ConfirmStrip } from '../game-composer.jsx';
import { RightPanel, PANEL_TABS } from '../game-panels.jsx';
// AGE-02: splash gate
import AdultSplash from '../components/AdultSplash.jsx';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';
import { FeedbackDrawerRoot } from '../components/FeedbackDrawer.jsx';
import GlobalTaskFloater from '../components/GlobalTaskFloater.jsx';
import ModelConfigInterceptModal, { capConfig } from '../components/ModelConfigInterceptModal.jsx';
import DesktopDialogHost from '../components/DesktopDialogHost.jsx';
import { AcceptanceAbPanel } from '../components/AcceptanceAbPanel.jsx';
import { MobileDialogHost } from '../mobile/dialog.jsx';
// 模块化拆分:自包含展示组件搬到 components/game/(DOM/视觉/行为零变化)。
import { ScriptVersionSelect } from '../components/game/ScriptVersionSelect.jsx';
import { plGoto } from '../router.js';
const SPLASH_VERSION = 'v1.0-2026-05-31';

// density preset + narrative font init（等价原 HTML 非 babel inline script）
(function () {
  const VALID_DENSITY = { compact: 1, default: 1, spacious: 1 };
  function _applyDensity(d) {
    if (!VALID_DENSITY[d]) d = 'default';
    document.documentElement.setAttribute('data-density', d);
    lsSet('rpg.density', d);
    window.dispatchEvent(new CustomEvent('rpg-density-change', { detail: d }));
  }
  const storedDensity = lsGet('rpg.density') || 'default';
  _applyDensity(storedDensity);
  window.RPG_setDensity = _applyDensity;

  const FONT_MAP = { serif: 'var(--font-serif)', sans: 'var(--font-sans)', mono: 'var(--font-mono)' };
  const storedFont = lsGet('rpg.narrativeFont') || 'serif';
  if (FONT_MAP[storedFont]) {
    document.documentElement.style.setProperty('--narrative-font', FONT_MAP[storedFont]);
  }
})();

// ---- App ----

const TWEAK_DEFAULTS = {
  composerMode: 'compact',
  defaultRightTab: 'status',
  rightPanelWidth: 320,
  narrativeFont: 'serif',
  monoFont: 'jetbrains',
  uiSize: 13,
  narrativeSize: 15,
  density: 'normal',
  showRail: true,
};

const MOBILE_GAME_ENABLED = isMobileV2Enabled();

const PUBLIC_STAGES = {
  context: { id: 'context', get label() { return i18n.t('game.console.stage.context'); }, order: 1 },
  rules:   { id: 'rules',   get label() { return i18n.t('game.console.stage.context'); }, order: 2 },
  // task 64: 精简文案。thinking 期与生成期统一显示"生成中"。
  gm:      { id: 'gm',      get label() { return i18n.t('game.console.stage.generating'); }, order: 3 },
  save:    { id: 'save',    get label() { return i18n.t('game.console.stage.rendering'); }, order: 4 },
  system:  { id: 'system',  get label() { return i18n.t('game.console.stage.context'); }, order: 0 },
};
function mapAgentPhase(phase) {
  if (!phase) return null;
  if (
    phase === 'prompt' || phase === 'intent' || phase === 'llm_curator' ||
    phase === 'manifest' || phase === 'assembly' || phase === 'context_retrieve' ||
    phase === 'context_agent' || phase === 'world_check' || phase === 'prompt_assemble' ||
    phase === 'aborted' || (typeof phase === 'string' && phase.startsWith('provider:'))
  ) return PUBLIC_STAGES.context;
  if (phase === 'rules_engine' || phase === 'acceptance_check') return PUBLIC_STAGES.rules;
  if (phase === 'main_gm') return PUBLIC_STAGES.gm;
  return PUBLIC_STAGES.system;
}
function advancePublicStage(prevId, nextStage) {
  if (!nextStage) return prevId;
  const prev = (prevId && PUBLIC_STAGES[prevId]) || null;
  if (!prev) return nextStage.id;
  return nextStage.order >= prev.order ? nextStage.id : prev.id;
}

// 酒馆档判定:/api/state 对普通游戏档也会返回 tavern: {} —— 空对象在 JS 里是 truthy,
// 旧代码 !!data.tavern 会把每个普通档都标成酒馆档(首次加载隐藏分支按钮)。
// 这里优先看显式 save_kind;老后端没有该字段时,用 tavern 里是否真有角色/persona 等键判断。
function isTavernPayload(data) {
  if (!data) return false;
  // 先看 tavern 块是否有内容:旧后端/未跑 migration 65 的库没有 save_kind,
  // 但酒馆档一定带 character/persona 等键;反过来,普通档的 tavern 是空对象。
  const tav = data.tavern;
  if (tav && typeof tav === 'object' && !Array.isArray(tav) && Object.keys(tav).length > 0) return true;
  if (data.save_kind != null && String(data.save_kind).trim() !== '') {
    return String(data.save_kind).toLowerCase() === 'tavern';
  }
  return false;
}

// SSE status/done 的轻量 payload 可能不带 save_kind/tavern(旧后端)。有相关字段就以新值
// 为准,否则沿用当前 _raw.isTavern;绝不能因为字段缺失把酒馆档“洗白”成游戏档。
function tavernFlagFrom(data, prevRaw) {
  if (data && (data.save_kind != null || data.tavern !== undefined)) return isTavernPayload(data);
  return !!(prevRaw && prevRaw.isTavern);
}

// 存档元信息合并:回合结束/状态事件只改 updated_at/title 时也要更新 activeSave ——
// 旧代码只在 save_id 变化时才 setActiveSave,导致顶栏「已存档 · X 分钟前」永远停在开页时间。
function saveMetaFrom(data, prev, t) {
  if (!data || data.save_id == null) return prev;
  const same = !!(prev && prev.id != null && String(prev.id) === String(data.save_id));
  const title = data.save_title || (same ? prev.title : '')
    || t('game.console.save.untitled', { id: data.save_id });
  const updated = data.save_updated_at || (same ? prev.updated_at : '') || '';
  // 保留存档类型:reloadSaves 过滤 tavern 档时,若当前档就是 tavern(误载),
  // 需要靠 activeSave.save_kind 判断“不要用别的档覆盖显示”,不能只看 ref(异步渲染有延迟)。
  // 旧库没有 save_kind 字段时,用非空 tavern 块兜底识别酒馆档。
  const saveKind = isTavernPayload(data)
    ? 'tavern'
    : ((data.save_kind || (same ? prev.save_kind : 'game')) || 'game');
  if (same && prev.title === title && prev.updated_at === updated && prev.save_kind === saveKind) return prev;
  return { id: data.save_id, title, updated_at: updated, save_kind: saveKind };
}

// A/B 候选定位:优先用后端下发的权威 message_index(按首稿全文算,不受异步竞态影响);
// 没有时回退「最后一条 assistant」(旧档/未命中)。桌面与移动端共用同一判定。
function acceptanceTarget(alt, history) {
  const list = Array.isArray(history) ? history : [];
  let idx = -1;
  if (alt && alt.message_index != null && alt.message_index >= 0 && alt.message_index < list.length) {
    idx = alt.message_index;
  } else {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].role === 'assistant') { idx = i; break; }
    }
  }
  const original = idx >= 0 ? String(list[idx].content || '') : '';
  return { idx, original };
}

const STREAM_CHUNKS = [
  '你转过身去看沈知微，雾灯把她的侧脸照得发青。她没再追问残页，反而把腰上的铜针袋解下来，递到你手里。',
  '\n\n『先收着。』她说，『北港有人来了——是从南陵跟过来的。』',
  '\n\n海雾忽然又厚一层。你借着雾色看向北港，看见三个穿青衣的人正在台阶下停步。其中走在最前的一个，腰间挂着南陵巡检的腰牌——是韩司直。',
  '\n\n他抬头朝你的方向看了一眼，又像是没看见，绕过石阶往灯塔的方向去了。',
  '\n\n沈知微低声道：『他在等天黑。等天黑你就走不掉了。』',
];

function App() {
  const { t } = useTranslation();  // 旧 useTweaks/setTweak 用法迁出(tweaks-panel.jsx 已删,只是设计原型工具);
  // 这里仅消费默认值,改成普通常量即可。
  const tweaks = TWEAK_DEFAULTS;

  // P2 移动游戏台:窄屏 + 灰度开关 → 渲染移动原生 UI(复用同一 run-loop,见下方早返)
  const { width: _vpWidth } = useBreakpoint();
  const mobileGame = MOBILE_GAME_ENABLED && _vpWidth > 0 && _vpWidth < 600;

  // A2: 多 tab 冲突检测 — BroadcastChannel
  // 同一 origin 内不同 tab 打开同一 save_id 时，后进者收到 banner 警告。
  const [tabConflictBanner, setTabConflictBanner] = useState(null); // null | { conflictTabId }
  // refs 让 activeSave effect 能向 channel 广播而不需要重新订阅
  const _tabChRef = useRef(null);    // BroadcastChannel instance
  const _tabIdRef = useRef(null);    // 本 tab 的唯一 ID
  const _tabSaveRef = useRef(null);  // 当前广播中的 save_id（字符串）

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return; // 不支持的环境静默跳过
    const tabId = safeUUID();
    _tabIdRef.current = tabId;
    const ch = new BroadcastChannel('rpg-game-tabs');
    _tabChRef.current = ch;

    const broadcast = (type, saveId) => {
      const sid = saveId ?? _tabSaveRef.current;
      if (!sid) return;
      ch.postMessage({ type, save_id: String(sid), tab_id: tabId, ts: Date.now() });
    };

    // 心跳：让晚打开的 tab 发现已有其他实例
    const heartbeatId = setInterval(() => broadcast('heartbeat'), 30000);

    ch.onmessage = (ev) => {
      const { type, save_id, tab_id } = ev.data || {};
      if (!save_id || !tab_id || tab_id === tabId) return; // 忽略自己
      const curSid = _tabSaveRef.current;
      if (!curSid || String(save_id) !== String(curSid)) return; // 不同存档不冲突

      if (type === 'mounted' || type === 'heartbeat') {
        // 另一个 tab 打开了同一存档
        setTabConflictBanner({ conflictTabId: tab_id });
        // 同时回告知对方我们也在
        if (type === 'mounted') broadcast('heartbeat');
      } else if (type === 'unmounted') {
        // 冲突的那个 tab 已关闭，隐藏 banner
        setTabConflictBanner((prev) => {
          if (prev && prev.conflictTabId === tab_id) return null;
          return prev;
        });
      }
    };

    return () => {
      clearInterval(heartbeatId);
      broadcast('unmounted');
      ch.close();
      _tabChRef.current = null;
    };
  }, []); // 仅 mount/unmount 一次

  // 当 activeSave 变化时由下方 useEffect 更新广播 save_id（activeSave 在下方声明）

  const IS_ANON = !(window.RPG_AUTH && window.RPG_AUTH.authed);
  const EMPTY_STATE = {
    player: { name: '', role: '', background: '', current_location: '' },
    world: { time: '', weather: '', known_events: [], timeline: {} },
    relationships: {},
    // NPC 议程(后端 status_payload 下发):人物面板读取;必须在 PICK_STATE_KEYS 里,
    // 否则 /api/state 的值永远进不了 game,议程区块从未显示过。
    npc_agendas: {},
    memory: {},
    worldline: {},
    ruleset: {},
    player_character: {},
    scene: {},
    encounter: {},
    dice_log: [],
    permissions: { mode: 'full_access', pending_writes: [], pending_questions: [] },
    suggestions: [],
    turn: 0,
    history: [],
  };
  // 老 WebView 没有 structuredClone(Chrome 98+),而这行在组件初始化时就跑 —— 裸调即整页白屏。
  const INITIAL_STATE = IS_ANON && window.MOCK_STATE ? safeStructuredClone(window.MOCK_STATE) : safeStructuredClone(EMPTY_STATE);
  const [game, setGame] = useState(INITIAL_STATE);
  const [history, setHistory] = useState(INITIAL_STATE.history || []);
  // 当前 history 的同步镜像:startRunReal 在追加玩家气泡前记录「本轮开始前有几条 assistant」,
  // on_done 的空回复兜底据此判断服务端最后一条 assistant 是不是本轮新产生的(防止拿上一轮冒充)。
  const historyRef = useRef(history);
  historyRef.current = history;
  // acceptance A/B 改写候选(后端 `acceptance_alt` 事件):{alt_id, turn, rewrite, unmet}。null=无待选候选。
  const [rewriteAlt, setRewriteAlt] = useState(null);
  const [abBusy, setAbBusy] = useState(false);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [model, setModel] = useState(null);
  const [permission, setPermission] = useState(
    normalizePermissionForUi(INITIAL_STATE.permissions && INITIAL_STATE.permissions.mode)
  );
  // 只有玩家主动改权限时才回写后端。此前用 useEffect([permission]) 在挂载时无条件 POST,
  // 而登录态 INITIAL_STATE 的默认值是 full_access → 页面一打开就可能把存档原本的
  // read_only/default 覆盖成完全访问(与 reloadState 的 GET 竞态,慢网/冷缓存下会永久丢原值)。
  // 服务端下发的状态仍走原始 setPermission,不再回声写回。
  const changePermission = useCallback((mode) => {
    const next = normalizePermissionForUi(mode);
    setPermission(next);
    if (!window.api || !window.api.game || !window.api.game.permissions) return;
    window.api.game.permissions({ mode: next }).catch((e) => {
      // 不能静默吞:UI 已乐观切成新模式,失败时必须告知并拉回服务端真值。
      window.__apiToast?.(t('game.permission.save_failed'), { kind: 'danger', detail: e?.message });
      try { window.dispatchEvent(new CustomEvent('rpg-state-reload')); } catch (_) {}
    });
  }, [t]);
  const getRightTabForLocation = (fallback) => {
    const hash = String(location.hash || '').replace(/^#/, '');
    const tabs = PANEL_TABS || [];
    return tabs.some((tab) => tab.id === hash) ? hash : fallback;
  };
  const [activeTab, setActiveTab] = useState(() => getRightTabForLocation(tweaks.defaultRightTab || 'status'));
  // 侧栏折叠状态持久化(localStorage,刷新后保留)。来自 PR #14。
  const [railCollapsed, setRailCollapsed] = useState(() => lsGet('gc.rail.collapsed') === 'true');
  const [panelCollapsed, setPanelCollapsed] = useState(() => lsGet('gc.panel.collapsed') === 'true');
  useEffect(() => { lsSet('gc.rail.collapsed', railCollapsed ? 'true' : 'false'); }, [railCollapsed]);
  useEffect(() => { lsSet('gc.panel.collapsed', panelCollapsed ? 'true' : 'false'); }, [panelCollapsed]);
  const [mobileNav, setMobileNav] = useState(false);  // 手机端: 左 rail 改汉堡抽屉的开关
  const [showSlash, setShowSlash] = useState(false);
  const [showPlus, setShowPlus] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showPerm, setShowPerm] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showSearchDrawer, setShowSearchDrawer] = useState(false);
  const [showInGameSettings, setShowInGameSettings] = useState(false);
  // AGE-02: null = loading, true = need splash, false = no splash needed
  const [splashNeeded, setSplashNeeded] = useState(null);
  useEffect(() => {
    fetch('/api/me/splash/status', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { setSplashNeeded(j ? !j.acked : false); })
      .catch(() => { setSplashNeeded(false); });
  }, []);

  const _railResize = useResizable({
    storageKey: 'gc.rail.w', defaultSize: 240, min: 180, max: 360, side: 'left',
    cssVar: '--gc-rail-w',
  });
  const gcRailW = _railResize.size;
  const gcRailDragProps = _railResize.dragHandleProps;
  const _panelResize = useResizable({
    storageKey: 'gc.panel.w', defaultSize: 320, min: 180, max: 520, side: 'right',
  });
  const gcPanelW = _panelResize.size;
  const gcPanelDragProps = _panelResize.dragHandleProps;

  useEffect(() => {
    // 宽度不足 180 时自动折叠；但不再自动展开——折叠/展开完全由用户控制
    if (gcPanelW < 180 && !panelCollapsed) setPanelCollapsed(true);
  }, [gcPanelW]);

  const [pickedCommand, setPickedCommand] = useState(null);
  const [lastPlayerText, setLastPlayerText] = useState('');
  const [sseLog, setSseLog] = useState([]);
  const [sseLogOpen, setSseLogOpen] = useState(false);
  // #11: token 用量显示 — lastUsage 存本轮 usage 事件,showUsage 由设置开关控制(默认关)
  const [lastUsage, setLastUsage] = useState(null);
  const [clicheNotice, setClicheNotice] = useState(null);  // 反馈#22: 套路比喻提示
  const [showUsage, setShowUsage] = useState(() => lsGet('rpg.showTokenUsage') === 'on');
  useEffect(() => {
    const onUsageChange = (e) => setShowUsage(!!(e && e.detail));
    window.addEventListener('rpg-show-usage-change', onUsageChange);
    return () => window.removeEventListener('rpg-show-usage-change', onUsageChange);
  }, []);

  const [runState, setRunState] = useState({
    running: false, publicStage: null, label: '', detail: '',
    totalElapsed: 0, completedAt: 0, completedElapsed: 0, rawSteps: [],
  });
  const runRef = useRef({ timers: [], stopped: false, sse: null, doneTimer: null, runId: 0 });

  const [pendingWrites, setPendingWrites] = useState(
    (INITIAL_STATE.permissions && INITIAL_STATE.permissions.pending_writes) || []
  );
  const [pendingQuestions, setPendingQuestions] = useState(
    (INITIAL_STATE.permissions && INITIAL_STATE.permissions.pending_questions) || []
  );
  const [realSaves, setRealSaves] = useState([]);
  const [activeSave, setActiveSave] = useState(null);
  // reloadState 是稳定 useCallback([]),用 ref 读取当前 active save id,判断本次 state
  // 拉取是否跨档(跨档时才用服务端 models.selected 回填本地 model)。
  const activeSaveIdRef = useRef(null);
  activeSaveIdRef.current = activeSave && activeSave.id != null ? String(activeSave.id) : null;
  // task #61: activeSave 变化时更新 BroadcastChannel 广播的 save_id
  useEffect(() => {
    const sid = activeSave?.id != null ? String(activeSave.id) : null;
    if (!sid || sid === _tabSaveRef.current) return;
    _tabSaveRef.current = sid;
    const ch = _tabChRef.current;
    const tabId = _tabIdRef.current;
    if (ch && tabId) {
      ch.postMessage({ type: 'mounted', save_id: sid, tab_id: tabId, ts: Date.now() });
    }
  }, [activeSave?.id]);
  const [retryFailed, setRetryFailed] = useState(false);
  // G6: state loaded successfully but player not yet set up (new save pending opening)
  const [stateLoadedNoPlayer, setStateLoadedNoPlayer] = useState(false);
  // 当前档是否酒馆档。reloadSaves 是稳定 useCallback([]),不能直接读 game;用 ref 暴露
  // 最新值,供「存档列表过滤 tavern 档时保留当前档」判断。
  const isTavernRef = useRef(false);
  isTavernRef.current = !!(game && game._raw && game._raw.isTavern);
  // 酒馆档不能由游戏台承载(分支/回退/回合管线都是游戏语义)。检测到 active save 是
  // tavern 时跳到独立的 Tavern.html;ref 保证一次 mount 只跳一次,避免初始重试循环重复导航。
  const tavernRedirectRef = useRef(false);
  // 多标签冲突横幅的同步镜像:Retry/Regenerate 在 await 回滚期间横幅可能刚出现,
  // 闭包里的 state 会过期;用 ref 在真正发送前再拦一次。
  const tabConflictRef = useRef(null);
  tabConflictRef.current = tabConflictBanner;
  // /api/state 与 /api/saves 都可能被多个事件并发触发(切档、game-state-refresh、on_done)。
  // 旧响应后到会把新档的 game/activeSave/realSaves 覆盖回去;各自用递增序号只接受最新请求。
  const stateSeqRef = useRef(0);
  const savesSeqRef = useRef(0);
  // /api/state 返回的权威 save_id。reloadState 在 await 之后同步写入;切档流程是
  // `await reloadState(); await reloadSaves()`,此时 setActiveSave 还没重新渲染,
  // activeSaveIdRef 可能仍是旧档,reloadSaves 的详情兜底会拿错 id。
  const stateSaveIdRef = useRef(null);
  // 开场请求的三道闸:
  //  · openingInFlightRef —— 同一存档已有开场流在飞时不再重复开流(两次 /api/state 响应
  //    落在同一帧时 rAF 都会过 seq 检查)。
  //  · openingFailedRef —— 开场最终失败后置位,让错误条的「重试」走「重新生成开场」
  //    而不是重发玩家输入(此时历史里没有可重发的输入)。
  //  · forceOpeningRef —— 「重试开场」置位一次,reloadState 消费后无视 seenKey 再开一次。
  const openingInFlightRef = useRef(null);
  const openingFailedRef = useRef(false);
  const forceOpeningRef = useRef(false);

  const PICK_STATE_KEYS = [
    'player','world','relationships','npc_agendas','memory','worldline','permissions','suggestions','turn',
    'ruleset','player_character','scene','encounter','dice_log','content_pack',
    'active_entities','app','models',
    // ModelPopover / EffortSection 需要读本存档的模型与思考档位覆盖;
    // 不在这里透传 → 切了档位后控件回显会退回用户级默认。
    'session_model','session_reasoning',
  ];
  const RESETTABLE_KEYS = new Set(['suggestions']);

  const reloadState = useCallback(async () => {
    const seq = ++stateSeqRef.current;
    // 「重试开场」只强制一次;不消费掉的话后续每次普通刷新都会避开 seenKey 反复开场。
    const forceOpening = forceOpeningRef.current;
    forceOpeningRef.current = false;
    try {
      // 请求发出时先记一次在途状态:请求可能跨过回合开始/结束,只在「发送和返回时都没有
      // SSE 在途」才允许用服务端 history 覆盖本地(避免用 pre-commit 的旧 history 覆盖已落库结果)。
      const _runInFlightAtStart = !!(runRef.current && runRef.current.sse);
      const data = await window.api.game.state();
      // 期间有更新的 reloadState(切档/刷新)已经发起 → 本次旧响应直接丢弃,
      // 否则会把新档的 game/activeSave/history 覆盖回旧档。
      if (seq !== stateSeqRef.current) return false;
      if (data && data.save_id != null) stateSaveIdRef.current = String(data.save_id);
      // 当前 active save 若是酒馆档,游戏台无法正确承载:交给 Tavern.html(同一个 active
      // runtime,不会丢对话)。旧代码只隐藏 fork,却仍用游戏回合管线跑酒馆档。
      if (isTavernPayload(data)) {
        if (!tavernRedirectRef.current) {
          tavernRedirectRef.current = true;
          try { location.replace(new URL('Tavern.html', location.href).href); }
          catch (_) { try { location.href = 'Tavern.html'; } catch (_) {} }
        }
        return false;
      }
      if (data && data.player) {
        setStateLoadedNoPlayer(false);
        setGame((g) => {
          const next = { ...g };
          for (const k of PICK_STATE_KEYS) {
            if (data[k] !== undefined) next[k] = data[k];
            else if (RESETTABLE_KEYS.has(k)) {
              next[k] = Array.isArray(g[k]) ? [] : (typeof g[k] === 'object' ? {} : null);
            }
          }
          next._raw = {
            save_id: data.save_id ?? null,
            save_title: data.save_title ?? null,
            turn: data.turn ?? null,
            // 普通游戏档也会返回 tavern: {};用 isTavernPayload(save_kind/非空 tavern)判断,
            // 不能再用 !!data.tavern(空对象 truthy → 所有档都被当成酒馆档)。
            isTavern: tavernFlagFrom(data, g._raw),
          };
          return next;
        });
        // 模型也是存档级状态:切档后 Composer 的 model state 若还留着上一档的选择,
        // 底部标签会显示旧模型(虽然后端实际用新档 session_model)。用 /api/state 的
        // models.selected(后端已按 session_model>用户偏好>全局默认解析)回填。
        // 只在「跨档」或本地 model 为空时写:同一档的普通 state 刷新不要把用户刚选中的
        // 模型用一次可能尚未落库的旧快照覆盖回去。
        if (data.models && data.models.selected) {
          const sel = data.models.selected;
          const switchingSave = activeSaveIdRef.current !== (data.save_id != null ? String(data.save_id) : null);
          const nextModel = {
            id: sel.model_id || sel.real_name || '',
            api_id: sel.api_id || '',
            label: sel.real_name || sel.model_id || '',
          };
          setModel((cur) => (cur == null || switchingSave ? nextModel : cur));
        }
        // 回合进行中(SSE 在途)服务端 history 还没有本轮流式 assistant。此时若因面板编辑
        // 触发 game-state-refresh → reloadState 把 history 整体覆盖,正在输出的气泡会被截断,
        // 后续 token 只能从半截重开。其余状态(关系/世界/记忆等)照常更新,回合结束后
        // on_done 会用服务端最终 history 回填。发送/返回任一时刻在途都跳过。
        const _runInFlightNow = !!(runRef.current && runRef.current.sse);
        if (Array.isArray(data.history) && !_runInFlightAtStart && !_runInFlightNow) setHistory(data.history);
        if (data.permissions) {
          setPermission(normalizePermissionForUi(data.permissions.mode));
          setPendingWrites(data.permissions.pending_writes || []);
          setPendingQuestions(data.permissions.pending_questions || []);
        }
        try {
          const isFresh = (
            (!Array.isArray(data.history) || data.history.length === 0) &&
            (data.turn === 0 || data.turn == null) && data.save_id != null
          );
          const seenKey = 'gc.opened_save.' + data.save_id;
          const alreadyOpened = sessionStorage.getItem(seenKey);
          // forceOpening 来自错误条的「重试」:开场最终失败时已 removeItem(seenKey),
          // 这里再无视一次标记重开,避免失败后只能靠换标签页。
          // openingFailedRef:同一页面会话内已失败过就不要再被普通刷新自动拉起(否则每次
          // 面板操作都重试一次,持续烧 token);刷新页面(ref 归零)或点「重试」才再开。
          if (isFresh && (forceOpening || (!alreadyOpened && !openingFailedRef.current))) {
            // G7: 从 800ms 硬延迟改为 requestAnimationFrame,UI 已 mount 直接发请求
            requestAnimationFrame(() => {
              try {
                // rAF 可能晚于下一次 reloadState(切档/刷新)才执行。序号已过期就放弃:
                // 否则会拿旧档的 save_id 往新档 history 里塞开场占位,甚至并发两条开场流。
                if (seq !== stateSeqRef.current) return;
                // 同一存档已有开场流在飞(同一帧两次 reloadState 都会走到这里)→ 不重复开流。
                if (openingInFlightRef.current === String(data.save_id)) return;
                openingInFlightRef.current = String(data.save_id);
                // opened 标记改到 on_done(成功)再写:请求最终失败时本 tab 仍能重试/刷新重开,
                // 旧实现发请求前就写 → 开场失败后刷新也永远不会再触发。
                const sse = window.api && window.api.raw && window.api.raw.sseStream;
                if (!sse) { openingInFlightRef.current = null; return; }
                let openingText = '';
                let openingRetried = false;
                setHistory((h) => {
                  const arr = Array.isArray(h) ? [...h] : [];
                  // 思考指示器统一:不再给开场占位消息打 _thinking(否则 NarrativeBlock 渲染
                  // gc-msg-thinking 旋转 spinner,与同时出现的 ThinkingPill 圆环构成第二对重复思考UI)。
                  // 占位仍显示「拉开帷幕…」文本,随 on_token 流式替换为真实开场;思考动画只由 ThinkingPill 承担。
                  arr.push({ role: 'assistant', content: t('game.console.opening.curtain'), _opening: true });
                  return arr;
                });
                const triggerOpening = () => {
                  // 自动重试的 setTimeout 可能在切档之后才执行:当前权威 save_id 已变就放弃,
                  // 否则会对着新档重放旧档的开场请求(甚至和新档自己的开场流并发)。
                  // 同时清掉 running,避免「停止」按钮一直停在生成中。
                  const openingSaveId = data.save_id != null ? String(data.save_id) : null;
                  if (openingSaveId && stateSaveIdRef.current && stateSaveIdRef.current !== openingSaveId) {
                    openingInFlightRef.current = null;
                    runRef.current.sse = null;
                    setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '' }));
                    return;
                  }
                  // G8: 开场期间设置 running=true,使 stop 按钮可见可用
                  setRunState((r) => ({ ...r, running: true, publicStage: 'context', label: t('game.console.opening.raising_curtain'), detail: '' }));
                  // sseStream 的 onClose 在 reader EOF 时永远会触发,即使刚收到 done。
                  // 用本地 flag 区分「正常完成后 close」vs「无 done 直接 close」 —
                  // 否则正常完成的 opening 末尾会被错误加上『[连接断开,内容可能不完整]』。
                  let gotDone = false;
                  // 同一次 opening 尝试内,on_error / onClose 只允许收尾一次;若已安排自动重试,
                  // 另一个回调不得提前 finalize(否则会把重试路径吞掉)。
                  let openingFinalized = false;
                  let openingRetryScheduled = false;
                  const finishOpeningFailure = (allowRetry) => {
                    if (openingFinalized || openingRetryScheduled) return;
                    // G9: 断线重试 — 未收到任何 token 时自动重试一次
                    if (allowRetry && !openingText && !openingRetried) {
                      openingRetried = true;
                      openingRetryScheduled = true;
                      // 挂进 timers:切档/停止/卸载时统一清掉,避免 1s 后对已离开的页面重开流。
                      const retryTimer = setTimeout(() => {
                        runRef.current.timers = (runRef.current.timers || []).filter((id) => id !== retryTimer);
                        try { triggerOpening(); } catch (e) {
                          console.warn('[opening] retry error', e);
                          openingInFlightRef.current = null;
                          openingFailedRef.current = true;
                          try { sessionStorage.removeItem(seenKey); } catch (_) {}
                          setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '' }));
                          setHasError(t('game.console.opening.failed'));
                        }
                      }, 1000);
                      runRef.current.timers.push(retryTimer);
                      return;
                    }
                    openingFinalized = true;
                    openingInFlightRef.current = null;
                    // 最终失败:清掉 seenKey 并标记 openingFailed —— 刷新页面或错误条的
                    // 「重试」都能重新生成开场;旧实现请求前就写入 seenKey,失败后永久卡死。
                    try { sessionStorage.removeItem(seenKey); } catch (_) {}
                    openingFailedRef.current = true;
                    runRef.current.sse = null;
                    setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '' }));
                    // 错误条(标题「生成失败」+ 重试按钮)接管恢复入口;onRetry 会识别
                    // openingFailedRef 走「重新生成开场」而不是重发玩家输入。
                    setHasError(t('game.console.opening.failed'));
                    const note = t('game.console.run.disconnected_incomplete');
                    // 就地更新既有占位气泡:旧 on_error 在已有部分文本时会再 push 一条
                    // 「同文本 + 断线提示」→ 开场正文出现两份。onClose 原本的“只在没有文本时
                    // 什么都不做”也改为给占位补一条失败说明,避免停在“正在拉开帷幕…”。
                    setHistory((h) => {
                      const arr = Array.isArray(h) ? h.slice() : [];
                      const last = arr[arr.length - 1];
                      const base = openingText
                        || (last && last._opening ? last.content : '')
                        || t('game.console.opening.curtain');
                      const merged = `${base}\n\n*${note}*`;
                      if (last && last._opening) {
                        arr[arr.length - 1] = { ...last, content: merged, streaming: false, _opening: true };
                      } else {
                        arr.push({ role: 'assistant', content: merged, _opening: true });
                      }
                      return arr;
                    });
                    window.__apiToast?.(t('game.console.run.generation_failed'), { kind: 'warn', detail: note, duration: 5000 });
                  };
                  // G8: 保存 handle 到 runRef.current.sse,使 stop 按钮可中断 opening
                  const handle = sse('/api/v1/opening', {}, {
                    on_stage: (d) => {
                      const label = (d && d.label) || '';
                      const phase = (d && d.phase) || '';
                      if (!label && phase !== 'done') return;
                      setHistory((h) => {
                        const arr = Array.isArray(h) ? [...h] : [];
                        if (arr.length && arr[arr.length - 1]._opening && !openingText) {
                          // 只更新占位文本为阶段标签,不再设 _thinking(避免 spinner 与 ThinkingPill 圆环重复)。
                          arr[arr.length - 1] = { ...arr[arr.length - 1], content: label || arr[arr.length - 1].content };
                        }
                        return arr;
                      });
                    },
                    on_token: (d) => {
                      const tok = (d && d.text) || '';
                      if (tok) {
                        openingText += tok;
                        setHistory((h) => {
                          const arr = Array.isArray(h) ? [...h] : [];
                          if (arr.length && arr[arr.length - 1].role === 'assistant' && arr[arr.length - 1]._opening) {
                            arr[arr.length - 1] = { ...arr[arr.length - 1], content: openingText, _thinking: null };
                          } else {
                            arr.push({ role: 'assistant', content: openingText, _opening: true });
                          }
                          return arr;
                        });
                      }
                    },
                    on_done: () => {
                      gotDone = true;
                      // 开场真正成功才写 opened 标记;失败路径会 removeItem,保证可重试。
                      try { sessionStorage.setItem(seenKey, '1'); } catch (_) {}
                      openingInFlightRef.current = null;
                      openingFailedRef.current = false;
                      setHasError(false);
                      runRef.current.sse = null;
                      // 标记 opening message 流式完成,避免 onClose 误判为断线
                      setHistory((h) => {
                        const arr = Array.isArray(h) ? [...h] : [];
                        const last = arr[arr.length - 1];
                        if (last && last._opening) {
                          arr[arr.length - 1] = { ...last, streaming: false };
                        }
                        return arr;
                      });
                      setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '' }));
                      setTimeout(async () => {
                        // 新一轮已开始(玩家在开场完成后 300ms 内就发了消息)或组件已卸载时,
                        // 绝不能用这个快照覆盖 history —— 会把刚插入的玩家气泡/流式回复截掉。
                        if (runRef.current.sse || runRef.current.stopped) return;
                        try {
                          const d2 = await window.api.game.state();
                          if (d2 && d2.player) {
                            if (Array.isArray(d2.history)) {
                              setHistory(d2.history);
                            }
                            if (d2.permissions) {
                              setPermission(normalizePermissionForUi(d2.permissions.mode));
                              setPendingWrites(d2.permissions.pending_writes || []);
                              setPendingQuestions(d2.permissions.pending_questions || []);
                            }
                            setGame((g) => {
                              const next = { ...g };
                              for (const k of PICK_STATE_KEYS) {
                                if (k === 'suggestions') { if (d2[k] !== undefined) next[k] = d2[k]; }
                                else if (d2[k] !== undefined) next[k] = d2[k];
                              }
                              return next;
                            });
                          }
                        } catch (_) {}
                      }, 300);
                    },
                    on_error: () => {
                      runRef.current.sse = null;
                      finishOpeningFailure(true);
                    },
                    onClose: () => {
                      runRef.current.sse = null;
                      // 正常完成路径:on_done 已经触发并 setRunState/setHistory streaming=false,
                      // 这里直接 noop,绝不能再加『连接断开』。
                      if (gotDone) return;
                      finishOpeningFailure(true);
                    },
                  });
                  // G8: 挂到 runRef,与 chat SSE 保持一致
                  if (handle && typeof handle === 'object') runRef.current.sse = handle;
                };
                triggerOpening();
              } catch (e) {
                // 同步构造/开流失败:必须解开 in-flight 闸并给出可见错误,否则后续
                // 刷新都会以为「已有开场在飞」而永远不再重试。
                console.warn('[opening] trigger error', e);
                openingInFlightRef.current = null;
                openingFailedRef.current = true;
                try { sessionStorage.removeItem(seenKey); } catch (_) {}
                setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '' }));
                setHasError(t('game.console.opening.failed'));
              }
            });
          }
        } catch (_) {}
      } else if (data && data.save_id != null) {
        // G6: 存档存在但 player 尚未 setup(新建存档等待开场),标记而非静默降级
        setStateLoadedNoPlayer(true);
      }
      if (data && data.save_id != null) {
        // 合并而不是整体替换:同档时也要更新 save_updated_at(否则顶栏「已存档」时间停住)。
        setActiveSave((prev) => saveMetaFrom(data, prev, t));
      }
      // 返回是否真正拿到了可玩状态(供 mount 重试判断是否还要再拉一次)。
      return !!(data && data.player);
    } catch (e) {
      console.warn('[reloadState] error', e);
      return false;
    }
  }, []);

  const reloadSaves = useCallback(async () => {
    const seq = ++savesSeqRef.current;
    const isLatest = () => seq === savesSeqRef.current;
    try {
      // 用 offset 分页拉全量(每页 200,上限 20 页)。旧代码只取 /api/saves 默认的
      // 50 条;当前档较旧时 norm 里找不到它,后面的 setActiveSave 会用列表第一项
      // 冒充当前档,顶栏/左栏显示错档。offset 模式与排序一致,cursor 模式按 id
      // 分页而排序按 last_played_at,混用会漏条。
      const PAGE = 200;
      const all = new Map();
      let offset = 0;
      let total = null;
      for (let i = 0; i < 20; i++) {
        const r = await window.api.saves.list({ limit: PAGE, offset, sort: 'played' });
        if (!isLatest()) return;
        const pageItems = Array.isArray(r) ? r : (r?.items || r?.saves || []);
        for (const s of pageItems) {
          if (s && s.id != null) all.set(String(s.id), s);
        }
        if (typeof r?.total === 'number') total = r.total;
        offset += pageItems.length;
        if (!pageItems.length) break;
        if (total != null && offset >= total) break;
        // 老后端不认 offset/total:返回不足一页就停,避免同一页循环 20 次。
        if (total == null && pageItems.length < PAGE) break;
      }
      // 兜底:active save 仍不在列表(页数上限/并发删除/老后端分页)时单独取详情补进来。
      // activeSave 来自 /api/state,是当前档的权威来源,不能被列表第一项替代。
      // 优先用 reloadState 刚落定的 stateSaveIdRef:切档时 activeSaveIdRef 要等下一次
      // 渲染才更新,直接读它可能拿到切换前的旧档。
      const curId = stateSaveIdRef.current || activeSaveIdRef.current;
      if (curId && !all.has(curId)) {
        try {
          const d = await window.api.saves.detail(curId);
          if (!isLatest()) return;
          const save = d?.save || d;
          if (save && save.id != null) all.set(String(save.id), save);
        } catch (_) { /* 档已删除/无权:保持下面的 activeSave 原值 */ }
      }
      if (!isLatest()) return;
      // 游戏台只列游戏档:酒馆档在酒馆页玩,混进下拉会让控制台误载。
      const norm = [...all.values()]
        .map(window.__normalizeSave || ((x) => x))
        .filter((s) => s && s.save_kind !== 'tavern');
      setRealSaves(norm);
      setActiveSave((prev) => {
        if (prev && norm.some((s) => String(s.id) === String(prev.id))) return prev;
        // 当前是酒馆档(不在游戏台列表里):保留 activeSave,由 reloadState 的重定向处理。
        if (prev && prev.id != null && (prev.save_kind === 'tavern' || isTavernRef.current)) return prev;
        // 当前档不在全量列表(并发删除/详情也取不到):保留 activeSave 原值,
        // 不要用 norm[0] 冒充当前档;reloadState 若已切到别的档会另行更新。
        if (prev && prev.id != null) return prev;
        const cur = norm.find((s) => s.current) || norm[0];
        return cur ? { id: cur.id, title: cur.title, updated_at: cur.updated_at || '', save_kind: cur.save_kind || 'game' } : null;
      });
    } catch (_) {
      if (isLatest()) setRealSaves([]);
    }
  }, []);

  // 手动存档的统一入口:`/api/save` 返回最新 state payload(含 save_updated_at)。
  // 之前各个按钮只 await + toast,不更新 activeSave → 顶栏「已存档」时间仍是旧值,
  // 玩家以为没存上。这里合并服务端时间;拿不到就退化为 reloadSaves。
  const manualSave = useCallback(async () => {
    try {
      const r = await window.api.game.saveGame();
      // /api/save 返回 {ok, state: <payload>};mock/旧版本可能直接回 payload。
      const payload = (r && r.state) ? r.state : r;
      if (payload && payload.save_id != null) setActiveSave((prev) => saveMetaFrom(payload, prev, t));
      // 左栏存档列表的 updated_at 是 normalizeSave 时格式化的字符串,也要重拉才会更新。
      await reloadSaves();
      window.__apiToast?.(t('common.save') + ' ✓', { kind: 'ok' });
      return true;
    } catch (e) {
      window.__apiToast?.(t('game.console.save.save_failed'), { kind: 'danger', detail: e?.message });
      return false;
    }
  }, [t, reloadSaves]);

  // A/B 候选裁决(桌面/移动共用):
  //   rewrite → 乐观替换本地气泡,后端失败必须回滚并保留面板;
  //   original → 只记录选择,不改本地文本。
  // 生成中禁止:同步路径的候选可能先于 done 到达,点选会被随后 done.history 覆盖。
  const chooseAcceptance = useCallback(async (idx, choice) => {
    if (runState.running) {
      window.__apiToast?.(t('game.app.msg.busy_tip'), { kind: 'warn', duration: 2400 });
      return;
    }
    if (abBusy || !rewriteAlt) return;
    const alt = rewriteAlt;
    // 选择前重新定位目标,不信任渲染时的 idx:等待选择期间 history 可能已被分支切换/
    // 回退/编辑替换。对不上就撤下候选,绝不能让后端采用一个指向别的 assistant 的 index
    // (后端内容匹配失败时会回退到它,直接改写该位置)。
    const target = acceptanceTarget(alt, history);
    const targetMsg = target.idx >= 0 ? history[target.idx] : null;
    const curSaveId = activeSave && activeSave.id != null ? String(activeSave.id) : null;
    const altSaveId = alt.save_id != null ? String(alt.save_id) : null;
    if (
      (curSaveId && altSaveId && curSaveId !== altSaveId)
      || target.idx < 0 || !targetMsg || targetMsg.role !== 'assistant'
    ) {
      setRewriteAlt(null);
      window.__apiToast?.(t('game.console.acceptance_ab.stale'), { kind: 'warn', duration: 3000 });
      return;
    }
    idx = target.idx;
    const prevMsg = (choice === 'rewrite' && idx >= 0 && history[idx]) ? { ...history[idx] } : null;
    setAbBusy(true);
    try {
      if (prevMsg) {
        setHistory((h) => h.map((m, i) => (i === idx ? { ...m, content: alt.rewrite } : m)));
      }
      await window.api.game.acceptanceChoice({ alt_id: alt.alt_id, choice, message_index: idx });
      // 成功才收起候选;失败保留面板让玩家重试/关闭。
      setRewriteAlt(null);
    } catch (e) {
      // 失败必须把乐观替换回滚,否则 UI 显示改写稿、DB 仍是原稿,刷新后才“变回去”。
      if (prevMsg) {
        setHistory((h) => h.map((m, i) => (i === idx ? prevMsg : m)));
      }
      window.__apiToast?.(t('game.console.acceptance_ab.save_failed', '选择保存失败'), { kind: 'warn', detail: e?.message });
    } finally {
      setAbBusy(false);
    }
  }, [rewriteAlt, abBusy, history, runState.running, activeSave, t]);

  useEffect(() => {
    let cancelled = false;
    // 后端 per-user 运行时状态在页面首次加载/导航后可能尚未热(_ensure_loaded 冷启动),
    // 首次 /api/state 可能返回空(无 player/save_id),导致首屏停在 INITIAL_STATE
    // ("尚未创建存档")。带界限重试直到拿到可玩状态;对 100 并发用户首进游戏的
    // 冷缓存同样有韧性。拿到即停,不过度轮询。
    (async () => {
      let ok = false;
      for (let i = 0; i < 6 && !cancelled; i++) {
        ok = await reloadState();
        await reloadSaves();
        if (ok || cancelled) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!ok && !cancelled) setRetryFailed(true);
    })();
    return () => { cancelled = true; };
  }, [reloadState, reloadSaves]);

  useEffect(() => {
    const onReload = () => {
      // 分支切换 / 回退删消息 / 消息编辑 / fork 都会换掉 history:A/B 候选的「首稿」
      // 目标可能已不在新历史里。先撤下候选,否则选择「改写稿」时前端按当前 history
      // 重算的 message_index 会指到另一条 assistant(后端内容匹配失败时会采用它)。
      setRewriteAlt(null);
      reloadState();
      reloadSaves();
    };
    window.addEventListener('rpg-state-reload', onReload);
    window.addEventListener('game-state-refresh', onReload);
    return () => {
      window.removeEventListener('rpg-state-reload', onReload);
      window.removeEventListener('game-state-refresh', onReload);
    };
  }, [reloadState, reloadSaves]);

  useEffect(() => { setActiveTab(getRightTabForLocation(tweaks.defaultRightTab || 'status')); }, [tweaks.defaultRightTab]);
  useEffect(() => {
    const onHashChange = () => setActiveTab(getRightTabForLocation(tweaks.defaultRightTab || 'status'));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [tweaks.defaultRightTab]);
  // acceptance 改写候选现在【后台生成】(不阻塞回合),生成后经 state_event_bus emit → 长连
  // /state_events → state-event-bridge 派发 `rpg-acceptance_alt-updated`。这里收下,给本存档、
  // 非运行中、且当前没有待选候选时,挂出双栏 A/B(避免打断正在进行的回合 / 覆盖已有候选)。
  useEffect(() => {
    const handler = (ev) => {
      const { op, payload } = (ev && ev.detail) || {};
      if (op !== 'ready' || !payload || !payload.alt_id) return;
      if (!String(payload.rewrite || '').trim()) return;
      const curSave = (activeSave && activeSave.id) || (game && game._raw && game._raw.save_id) || null;
      if (curSave != null && payload.save_id != null && Number(payload.save_id) !== Number(curSave)) return;
      if (runRef.current && runRef.current.sse) return;  // 回合进行中(SSE 未收尾)不弹
      setRewriteAlt((prev) => prev || {
        alt_id: payload.alt_id, turn: payload.turn,
        // 记下候选所属存档:选择前再校验一次,避免极端时序下把 A 档的改写稿用到 B 档。
        save_id: (payload.save_id != null ? payload.save_id : curSave),
        rewrite: String(payload.rewrite || ''),
        unmet: Array.isArray(payload.unmet) ? payload.unmet : [],
        // 后端按首稿全文算的权威展示序 index(可能 null=旧档/未命中);优先用它定位改写目标,
        // 避免异步候选下前端「最后一条 assistant」指到相邻回合(改到前一个回合)。
        message_index: (payload.message_index != null && payload.message_index >= 0) ? Number(payload.message_index) : null,
      });
    };
    window.addEventListener('rpg-acceptance_alt-updated', handler);
    return () => window.removeEventListener('rpg-acceptance_alt-updated', handler);
  }, [activeSave, game]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setShowSlash(false); setShowPlus(false); setShowModel(false); setShowPerm(false); }
      if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); setShowSlash(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 卸载清理:回合进行中卸载(SPA 导航 / 重挂 / HMR / ErrorBoundary)时,abort 在途
  // SSE 流 + 清所有计时器,避免孤儿流继续烧 token + 200ms ticker 对已卸载组件 setState。
  // 只操作 runRef(不 setState),unmount 安全。
  useEffect(() => () => {
    const rc = runRef.current;
    rc.stopped = true;
    rc.timers.forEach((t) => { try { clearTimeout(t); } catch (_) {} try { clearInterval(t); } catch (_) {} });
    rc.timers = [];
    if (rc.doneTimer) { clearTimeout(rc.doneTimer); rc.doneTimer = null; }
    if (rc.inactivityTimer) { clearTimeout(rc.inactivityTimer); rc.inactivityTimer = null; }
    if (rc.sse) { try { rc.sse.stop('unmount'); } catch (_) {} rc.sse = null; }
  }, []);
  useEffect(() => {
    if (pickedCommand) return;
    if (text.startsWith('/') && !showSlash) setShowSlash(true);
    if (!text.startsWith('/') && showSlash && text !== '') setShowSlash(false);
  }, [text, pickedCommand]);

  const stopRun = useCallback(() => {
    runRef.current.stopped = true;
    runRef.current.timers.forEach(clearTimeout);
    runRef.current.timers.forEach((t) => { try { clearInterval(t); } catch (_) {} });
    runRef.current.timers = [];
    if (runRef.current.doneTimer) { clearTimeout(runRef.current.doneTimer); runRef.current.doneTimer = null; }
    if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
    runRef.current.runId = (runRef.current.runId || 0) + 1;
    if (runRef.current.sse) { try { runRef.current.sse.stop('manual_stop'); } catch (_) {} runRef.current.sse = null; }
    // 停止会 abort 开场流(sseStream 的 abort 不回调 onClose,不会自动收尾)。玩家按下停止
    // = 明确不想再等开场:给该档写上 opened 标记,避免下一次普通刷新又把开场自动拉起;
    // 之后想重开可以刷新页面/新开标签页(新会话没有这个标记)。
    if (openingInFlightRef.current) {
      try { sessionStorage.setItem('gc.opened_save.' + openingInFlightRef.current, '1'); } catch (_) {}
    }
    openingInFlightRef.current = null;
    // 已到达的 A/B 候选属于被停止的回合(首稿可能还没落库),继续挂着选择会按
    // message_index 改到新历史的另一条 assistant 上 —— 直接撤下。
    setRewriteAlt(null);
    try { window.api.game.stop(); } catch (_) {}
    setRunState((r) => ({ ...r, running: false, label: t('game.console.run.stopped'), detail: '', publicStage: null, completedAt: 0, completedElapsed: r.totalElapsed }));
  }, [t]);

  const startRunReal = useCallback(async (playerText) => {
    // task #61: 存档冲突时拒绝发送（用户点"继续"后 banner 清空才恢复）
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    // 防重入/防残留:开新一轮前,先 abort 任何在途流与残留计时器。
    // (规避 onAnswerQuestion / 重新生成 / 连点发送 触发的双流并发——后一个 sse handle
    //  覆盖前一个,前者永远 stop 不掉 → 既串戏又泄漏。)
    {
      const rc = runRef.current;
      if (rc.sse) { rc.runId = (rc.runId || 0) + 1; try { rc.sse.stop('superseded'); } catch (_) {} rc.sse = null; try { window.api.game.stop(); } catch (_) {} }
      rc.timers.forEach((t) => { try { clearTimeout(t); } catch (_) {} try { clearInterval(t); } catch (_) {} });
      rc.timers = [];
      if (rc.inactivityTimer) { clearTimeout(rc.inactivityTimer); rc.inactivityTimer = null; }
      // 玩家已经进入正式回合:之前失败的开场标记不应再劫持后续的 Retry;被 supersede
      // 的开场流也不会再收尾,一并解开 in-flight 闸。
      openingInFlightRef.current = null;
      openingFailedRef.current = false;
    }
    const runId = (runRef.current.runId || 0) + 1;
    runRef.current.runId = runId;
    const isCurrentRun = () => runRef.current.runId === runId;
    const ts = (window.__fmt && window.__fmt.nowHHMM) ? window.__fmt.nowHHMM() : new Date().toLocaleTimeString().slice(0, 5);
    const sentAttachments = attachments;
    // 本轮“当前应重发的输入”。正常就是玩家刚发送的文本;/set rewind 后变成后端回放的
    // 原始输入(replay_user),失败恢复/重试都要用它,不能再用 /set 命令本身。
    runRef.current.activeInput = playerText;
    // 记录本轮开始前已有多少条 assistant:on_done 的“空回复兜底”回查服务端时,
    // 只有 assistant 数目真的增加,才能确认这条回复是本轮新生成的(而不是上一轮旧回复)。
    runRef.current.assistantCountBefore = (historyRef.current || [])
      .filter((m) => m && m.role === 'assistant').length;
    setHistory((h) => [...h, { role: 'user', content: playerText, ts, attachments: sentAttachments }]);
    setRewriteAlt(null);  // 玩家继续 = 隐式保留当前版本(chosen 留 null,区分「主动选原版」vs「忽略」,亦是数据)
    setLastPlayerText(playerText);
    setSseLog([{ t: Date.now(), kind: 'send', payload: { message: playerText, model: model && model.id } }]);
    setText(''); setAttachments([]);
    setShowSlash(false); setShowPlus(false);
    setPendingQuestions((arr) => (arr || []).filter((q) => {
      const src = String(q && q.source || '');
      const systemPrefix = ['gm', 'rules_engine', 'curator', 'extractor', 'set_parser'];
      return !systemPrefix.some((s) => src === s || src.startsWith(s + ':'));
    }));
    const startedAt = Date.now();
    setRunState({ running: true, publicStage: 'context', label: PUBLIC_STAGES.context.label, detail: '', totalElapsed: 0, completedAt: 0, completedElapsed: 0, rawSteps: [] });
    setClicheNotice(null);  // 反馈#22: 新一轮清掉上轮的套路比喻提示
    if (runRef.current.doneTimer) { clearTimeout(runRef.current.doneTimer); runRef.current.doneTimer = null; }
    runRef.current.stopped = false;
    let lastSseEvent = { t: Date.now(), kind: 'send', payload: { message_len: String(playerText || '').length } };
    const logEvent = (kind, payload) => {
      const entry = { t: Date.now(), kind, payload };
      lastSseEvent = entry;
      setSseLog((l) => (l.length >= 500 ? l : [...l, entry]));
    };
    const tickerId = setInterval(() => {
      if (runRef.current.stopped) { clearInterval(tickerId); return; }
      setRunState((r) => ({ ...r, totalElapsed: Date.now() - startedAt }));
    }, 200);
    runRef.current.timers.push(tickerId);
    // #7 深度思考: 30s→120s。思考模型(reasoning)首 token 前可能静默 30-90s,30s 太短会把
    // 正常深度思考误判超时。reasoning/status/token 等任何活动都会重置此计时(见各 handler)。
    const STREAM_IDLE_TIMEOUT_MS = 120000;
    // 新一轮开跑即清「失败轮未落库」标记(onRetry 在调 startRun 之前消费它;本轮再失败会重新置位)
    runRef.current.lastRunFailedUnpersisted = false;
    let openedAssistant = false;
    let gotReceipt = false;  // #13: 本轮是否收到 system_receipt(斜杠命令回执)
    let gotDone = false;
    let streamFailed = false;
    // /set rewind 会先回滚上一轮再重演:本轮的 assistant 总数可能不增反平,
    // 落库核对不能用严格的 +1 判定。
    let sawRewind = false;
    let reasoningBuf = '';   // #7: 本轮累计的 reasoning(思考过程)文本
    const describeLastSseEvent = () => {
      const ev = lastSseEvent || {};
      const age = ev.t ? Math.max(0, Math.round((Date.now() - ev.t) / 1000)) : null;
      const suffix = age == null ? '' : t('game.console.sse.ago', { seconds: age });
      if (ev.kind === 'token') return t('game.console.sse.last_token') + suffix;
      if (ev.kind === 'reasoning') return t('game.console.sse.last_reasoning') + suffix;
      if (ev.kind === 'agent') return t('game.console.sse.last_agent', { phase: (ev.payload && ev.payload.phase) || 'agent' }) + suffix;
      if (ev.kind === 'status') return t('game.console.sse.last_status') + suffix;
      if (ev.kind === 'usage') return t('game.console.sse.last_usage') + suffix;
      if (ev.kind === 'send') return t('game.console.sse.sent_no_response') + suffix;
      return t('game.console.sse.last_event', { kind: ev.kind || t('common.unknown') }) + suffix;
    };
    const restoreFailedDraft = (opts = {}) => {
      // gotDone 之后到达的 error/close 不能再当成失败轮处理:否则会把已经落库的
      // 完整 assistant 气泡当成“半截回复”删掉。
      // 例外:on_done 的空回复兜底本身是在 gotDone 之后执行的,传 force 允许清理
      // 本轮玩家气泡/恢复草稿(那时 openedAssistant=false,不会误删有效回复)。
      if (!isCurrentRun()) return;
      if (gotDone && !opts.force) return;
      // 失败轮未落库标记:「重试」据此跳过 rollback。不标的话,气泡被下面移除后,
      // onRetry 从历史找到的最后一条玩家输入是【上一个好回合】,rollback 会把它滚进
      // trash = 每次失败重试多吃一个好回合(群反馈:安全过滤失败自动回退到前一回合)。
      runRef.current.lastRunFailedUnpersisted = true;
      // 已收到部分 token 时,最后一条是本轮未完成的 assistant 气泡。它不能留在历史里:
      // 旧代码在这里直接 return,重试时新回复会接在半截后面,出现「玩家消息 → 半截 GM →
      // 同一条玩家消息 → 新 GM」。注意即使开了 gc.keepFailedTurn 也要先移除这半截,
      // 保留的只是玩家气泡(那是可重发的输入),不是未完成的回复。
      if (openedAssistant) {
        setHistory((h) => {
          const arr = Array.isArray(h) ? h.slice() : [];
          const last = arr[arr.length - 1];
          if (last && last.role === 'assistant') arr.pop();
          return arr;
        });
      }
      // 「保留未响应轮」(设置开关 gc.keepFailedTurn,默认关):失败/未响应/中断时不回退本轮玩家
      // 气泡,保留在对话里,由错误条的「重试」按钮重发。开=保留玩家气泡(半截回复已在上面清掉),
      // 输入框不再重复填;重试时 onRetry 会复用/替换这条气泡,不会产生两条相同输入。
      if (lsGet('gc.keepFailedTurn') === 'on') return;
      const draftText = runRef.current.activeInput || playerText;
      setText((cur) => (String(cur || '').trim() ? cur : draftText));
      setAttachments((cur) => (Array.isArray(cur) && cur.length ? cur : sentAttachments));
      setHistory((h) => {
        // 上面的 setHistory 先按顺序执行,此时最后一条应是本轮玩家气泡(半截 assistant
        // 已移除);只删内容完全匹配的那条,避免误删上一轮。
        const last = h[h.length - 1];
        if (last && last.role === 'user' && last.content === draftText) return h.slice(0, -1);
        return h;
      });
    };
    // 流在没有 done 的情况下收尾(EOF/读流错误/客户端 abort/空闲超时)时,先回查服务端
    // 确认本轮是否其实已经落库:服务端是「先提交回合、再发 done」,done 可能在传输中丢失,
    // 而客户端 abort 也不代表服务端没跑完。旧逻辑直接当失败 → restoreFailedDraft 置
    // lastRunFailedUnpersisted → onRetry 跳过 rollback 再发一次 → 存档里多出重复回合。
    // 判定口径与 on_done 的空回复兜底一致:assistant 条数确实增加且最后一条有正文。
    let brokenStreamHandled = false;
    const handleBrokenStream = async ({ errorMsg, label, detail, toastTitle, toastKind = 'warn', toastDetail }) => {
      if (brokenStreamHandled || !isCurrentRun() || gotDone) return;
      brokenStreamHandled = true;
      streamFailed = true;
      runRef.current.sse = null;
      clearInterval(tickerId);
      if (runRef.current.doneTimer) { clearTimeout(runRef.current.doneTimer); runRef.current.doneTimer = null; }
      if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
      // 斜杠命令回执已收到:本轮语义已完成(只是 done 没到),不该报“生成失败”。
      if (gotReceipt) {
        setRewriteAlt(null);
        setPickedCommand(null);
        setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '', completedAt: 0 }));
        try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
        return;
      }
      let recovered = false;
      try {
        const d2 = await window.api.game.state();
        if (!isCurrentRun()) return;
        if (d2 && Array.isArray(d2.history)) {
          const beforeCount = Number(runRef.current.assistantCountBefore) || 0;
          const afterCount = d2.history.filter((m) => m && m.role === 'assistant').length;
          const lastSrv = d2.history.length ? d2.history[d2.history.length - 1] : null;
          // 正常回合严格 +1(rewind 可能持平);再校验服务端最后一条玩家输入确实是本轮输入,
          // 避免「首屏 history 还没加载完就发送」时把旧回合误判成本轮已落库。
          const countOk = sawRewind ? afterCount >= beforeCount : afterCount === beforeCount + 1;
          const wantInput = String(runRef.current.activeInput || '').trim();
          const srvLastUser = [...d2.history].reverse().find((m) => m && m.role === 'user');
          const inputOk = !wantInput || String((srvLastUser && srvLastUser.content) || '').trim().startsWith(wantInput);
          if (countOk && inputOk && lastSrv && lastSrv.role === 'assistant' && String(lastSrv.content || '').trim()) {
            // 本轮已落库:采用服务端最终 history,清掉失败标记;不动 A/B 候选 —— 它对应的
            // 首稿现在确实存在,仍然可以选。
            logEvent('recovered_turn', { before: beforeCount, after: afterCount });
            setHistory(d2.history);
            if (d2.player) setGame((g) => {
              const next = { ...g };
              for (const k of PICK_STATE_KEYS) if (d2[k] !== undefined) next[k] = d2[k];
              next._raw = {
                save_id: d2.save_id ?? next._raw?.save_id,
                save_title: d2.save_title ?? next._raw?.save_title,
                turn: d2.turn ?? next._raw?.turn,
                isTavern: tavernFlagFrom(d2, next._raw),
              };
              return next;
            });
            if (d2.permissions) {
              setPermission(normalizePermissionForUi(d2.permissions.mode));
              setPendingWrites(d2.permissions.pending_writes || []);
              setPendingQuestions(d2.permissions.pending_questions || []);
            }
            if (d2.save_id != null) setActiveSave((prev) => saveMetaFrom(d2, prev, t));
            runRef.current.lastRunFailedUnpersisted = false;
            setPickedCommand(null);
            setHasError(false);
            setRunState((r) => ({
              ...r, running: false, publicStage: null,
              label: t('game.console.run.turn_complete'), detail: '',
              completedAt: Date.now(), completedElapsed: r.totalElapsed,
            }));
            if (runRef.current.doneTimer) clearTimeout(runRef.current.doneTimer);
            runRef.current.doneTimer = setTimeout(() => {
              runRef.current.doneTimer = null;
              setRunState((r) => (r.running ? r : { ...r, publicStage: null, completedAt: 0, label: '' }));
            }, 1800);
            window.__apiToast?.(t('game.console.run.recovered_title'), {
              kind: 'ok', detail: t('game.console.run.recovered_detail'), duration: 3500,
            });
            try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
            recovered = true;
          }
        }
      } catch (_) { /* 回查失败 → 按未落库处理,与旧行为一致 */ }
      if (recovered) return;
      if (!isCurrentRun() || gotDone) return;
      // 确认没落库:撤下该回合的 A/B 候选(目标不存在),恢复草稿并报错。
      setRewriteAlt(null);
      restoreFailedDraft();
      setRunState((r) => ({ ...r, running: false, label, detail, publicStage: null, completedAt: 0 }));
      setHasError(errorMsg);
      window.__apiToast?.(toastTitle, { kind: toastKind, detail: toastDetail });
    };
    const resetInactivityTimer = () => {
      if (runRef.current.inactivityTimer) clearTimeout(runRef.current.inactivityTimer);
      runRef.current.inactivityTimer = setTimeout(() => {
        if (!isCurrentRun()) return;
        logEvent('idle_timeout', { ms: STREAM_IDLE_TIMEOUT_MS });
        try { runRef.current.sse && runRef.current.sse.stop && runRef.current.sse.stop('idle_timeout'); } catch (_) {}
        void handleBrokenStream({
          errorMsg: t('game.console.run.idle_timeout_error'),
          label: t('game.console.run.timed_out'),
          detail: t('game.console.run.idle_timeout_detail'),
          toastTitle: t('game.console.run.idle_timeout_title'),
          toastKind: 'warn',
          toastDetail: t('game.console.run.idle_timeout_detail'),
        });
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    resetInactivityTimer();
    const _chatSaveId = activeSave?.id ?? null;
    runRef.current.sse = window.api.game.chat(
      { message: playerText, text: playerText, attachments: sentAttachments, model, command: pickedCommand?.id || null, save_id: _chatSaveId },
      {
        // task #61: HTTP 层错误（如 409 save_id_mismatch）
        onError: (err) => {
          if (!isCurrentRun()) return;
          clearInterval(tickerId);
          if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
          const code = err && err.payload && err.payload.code;
          const detail = err && err.payload && err.payload.message;
          logEvent('http_error', { status: err && err.status, code, message: (err && err.message) || detail || t('game.console.run.request_failed') });
          if (code === 'save_id_mismatch') {
            streamFailed = true;
            setRunState((r) => ({ ...r, running: false, label: t('game.console.conflict.toast_title'), detail: detail || t('game.console.conflict.save_switched'), publicStage: null, completedAt: 0 }));
            setHasError(detail || t('game.console.conflict.save_switched_refresh'));
            window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: detail || t('game.console.conflict.refresh_hint'), duration: 5000 });
            // 请求根本没跑起来(存档已被切走),本轮不可能落库,直接恢复草稿。
            restoreFailedDraft();
            return;
          }
          const msg = (err && err.message) || t('game.console.run.request_failed');
          if (err && err.code === 'stream_read') {
            // 已是流式阶段后读失败:服务端可能已经提交回合,先核对再决定是否判失败。
            void handleBrokenStream({
              errorMsg: msg,
              label: t('game.console.run.interrupted'),
              detail: (err && err.message) || '',
              toastTitle: t('game.console.run.generation_interrupted'),
              toastKind: 'warn',
              toastDetail: (err && err.message) || t('game.console.run.please_retry'),
            });
            return;
          }
          streamFailed = true;
          setRunState((r) => ({ ...r, running: false, label: t('game.console.run.request_failed'), detail: msg, publicStage: null, completedAt: 0 }));
          setHasError(msg);
          window.__apiToast?.(t('game.console.run.request_failed'), { kind: 'danger', detail: msg });
          // 撤回本轮用户消息
          restoreFailedDraft();
        },
        onAbort: (data) => {
          // gotDone 后的迟到 abort/error 不能把已完成的回合改成失败。
          if (!isCurrentRun() || gotDone) return;
          const reason = (data && data.reason) || '';
          logEvent('abort', { reason, stopped: runRef.current.stopped });
          clearInterval(tickerId);
          if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
          if (runRef.current.stopped || reason === 'manual_stop' || reason === 'superseded' || reason === 'unmount' || reason === 'idle_timeout') {
            streamFailed = true;
            runRef.current.sse = null;
            return;
          }
          // 浏览器/网络侧 abort:服务端可能已经跑完并提交(只是响应读不到了),
          // 不能直接当失败恢复草稿 —— 否则 Retry 会跳过 rollback 再发一遍。
          runRef.current.sse = null;
          void handleBrokenStream({
            errorMsg: t('game.console.run.browser_abort_error'),
            label: t('game.console.run.cancelled'),
            detail: t('game.console.run.browser_abort_detail'),
            toastTitle: t('game.console.run.generation_cancelled'),
            toastKind: 'warn',
            toastDetail: t('game.console.run.browser_abort_detail'),
          });
        },
        on_status: (data) => {
          if (!isCurrentRun()) return;
          logEvent('status', data);
          if (data && data.player) setGame((g) => {
            const n = { ...g };
            for (const k of PICK_STATE_KEYS) if (data[k] !== undefined) n[k] = data[k];
            n._raw = {
              save_id: data.save_id ?? n._raw?.save_id,
              save_title: data.save_title ?? n._raw?.save_title,
              turn: data.turn ?? n._raw?.turn,
              // SSE payload 也可能缺 isTavern;有相关字段时按最新值算,缺失时保留旧值,
              // 避免酒馆档跑完一回合就“变成”游戏档(分支按钮重新出现)。
              isTavern: tavernFlagFrom(data, n._raw),
            };
            return n;
          });
          if (data && data.permissions) {
            setPermission(normalizePermissionForUi(data.permissions.mode));
            setPendingWrites(data.permissions.pending_writes || []);
            setPendingQuestions(data.permissions.pending_questions || []);
          }
          if (data && data.save_id != null) {
            // 同档也要刷新 updated_at/title(回合结束后顶栏「已存档」时间).
            setActiveSave((prev) => saveMetaFrom(data, prev, t));
          }
        },
        on_reasoning: (data) => {
          if (!isCurrentRun()) return;
          // #7 深度思考: 思考过程流式 — 重置 idle 计时(防止长思考被误判超时)并在
          // thinking pill 显示思考预览。reasoning 不进主叙事 transcript(单独事件)。
          resetInactivityTimer();
          const piece = (data && (data.text || data.delta)) || '';
          if (!piece) return;
          reasoningBuf += piece;
          logEvent('reasoning', { len: piece.length, total: reasoningBuf.length });
          setRunState((r) => (r.running ? { ...r, label: t('game.console.run.thinking'), detail: reasoningBuf.slice(-90).replace(/\s+/g, ' ').trim() } : r));
        },
        on_token: (data) => {
          if (!isCurrentRun()) return;
          resetInactivityTimer();
          logEvent('token', { len: ((data && (data.text || data.delta)) || '').length });
          const piece = (data && (data.text || data.delta)) || '';
          if (!piece) return;
          // task 141: 第一个 token = thinking 结束,切到"正在生成 GM 回复"
          const wasFirstToken = !openedAssistant;
          setHistory((h) => {
            if (!openedAssistant) { openedAssistant = true; return [...h, { role: 'assistant', content: piece, ts, streaming: true }]; }
            const last = h[h.length - 1];
            if (!last || last.role !== 'assistant') return [...h, { role: 'assistant', content: piece, ts, streaming: true }];
            return [...h.slice(0, -1), { ...last, content: (last.content || '') + piece }];
          });
          if (wasFirstToken) {
            setRunState((r) => {
              if (r.publicStage !== 'gm') return r;
              const rawSteps = (Array.isArray(r.rawSteps) ? r.rawSteps : []).map((s) =>
                s && s.phase === 'main_gm' ? { ...s, message: t('game.console.run.gm_generating') } : s
              );
              // task 64: 首 token 后 label 保持"生成中"(与 stage label 一致)
              return { ...r, label: t('game.console.stage.generating'), rawSteps };
            });
          }
        },
        on_agent: (data) => {
          if (!isCurrentRun()) return;
          resetInactivityTimer();
          logEvent('agent', data);
          if (!data || !data.phase) return;
          const mapped = mapAgentPhase(data.phase);
          setRunState((r) => {
            const rawSteps = Array.isArray(r.rawSteps) ? r.rawSteps.slice() : [];
            const idx = rawSteps.findIndex((s) => s.phase === data.phase);
            // task 141: main_gm 刚触发(第一个 token 还没来)时,显示"思考中"
            // 而不是后端发的"读取上下文并生成正文" — thinking 模型这段静默期可能 5-20s
            let msg = data.message || (idx >= 0 ? rawSteps[idx].message : data.phase);
            if (data.phase === 'main_gm' && !openedAssistant && data.status !== 'done') {
              msg = t('game.console.stage.generating');  // task 64: 精简文案
            }
            const merged = { phase: data.phase, message: msg, status: data.status || 'running', elapsed_ms: data.elapsed_ms ?? (idx >= 0 ? rawSteps[idx].elapsed_ms : 0), detail: data.detail || (idx >= 0 ? rawSteps[idx].detail : undefined) };
            if (idx >= 0) rawSteps[idx] = { ...rawSteps[idx], ...merged }; else rawSteps.push(merged);
            const nextStageId = advancePublicStage(r.publicStage, mapped);
            const nextLabel = (nextStageId && PUBLIC_STAGES[nextStageId]) ? PUBLIC_STAGES[nextStageId].label : r.label;
            if (data.status === 'stopped') return { ...r, rawSteps, publicStage: null, label: t('game.console.run.stopped'), detail: '' };
            return { ...r, rawSteps, publicStage: nextStageId, label: nextLabel, detail: '' };
          });
        },
        on_acceptance_alt: (data) => {
          if (!isCurrentRun()) return;
          // 后端 acceptance 硬闸:首稿有验收点未覆盖且节流放行 → 额外生成一份改写候选(首稿不被替换)。
          // 存起来,本轮 done 后在 gc-foot 处并排给玩家 A/B 选择。
          logEvent('acceptance_alt', { alt_id: data && data.alt_id, unmet: (data && data.unmet && data.unmet.length) || 0 });
          if (data && data.alt_id && String(data.rewrite || '').trim()) {
            setRewriteAlt({
              alt_id: data.alt_id, turn: data.turn,
              // SSE 内联候选不带 save_id,用本轮发送时绑定的存档兜底,供选择前校验。
              save_id: _chatSaveId,
              rewrite: String(data.rewrite || ''),
              unmet: Array.isArray(data.unmet) ? data.unmet : [],
            });
          }
        },
        on_rewind: (data) => {
          if (!isCurrentRun()) return;
          // 反馈#42: 重写型 /set —— 后端已回滚上一轮并将以"上一轮的原始输入"在纠正后的状态下
          // 重演本轮。前端同步抹掉乐观插入的 /set 气泡 + 被回滚的那一轮(assistant+user),换上
          // 重演用的原始输入气泡,随后到来的 GM token 会开一条新的 assistant 气泡。
          resetInactivityTimer();
          logEvent('rewind', data);
          sawRewind = true;
          const replayUser = (data && data.replay_user) || '';
          if (replayUser) {
            // 后端用“上一轮的原始输入”重演;后续失败/重试要恢复和重发的都是这句，
            // 而不是触发 rewind 的 /set 命令。同步更新 activeInput + lastPlayerText。
            runRef.current.activeInput = replayUser;
            setLastPlayerText(replayUser);
          }
          setHistory((h) => {
            const arr = h.slice();
            if (arr.length && arr[arr.length - 1].role === 'user') arr.pop();        // 乐观的 /set 气泡
            if (arr.length && arr[arr.length - 1].role === 'assistant') arr.pop();   // 被回滚轮的 GM 回复
            if (arr.length && arr[arr.length - 1].role === 'user') arr.pop();        // 被回滚轮的玩家输入
            if (replayUser) arr.push({ role: 'user', content: replayUser, ts });
            return arr;
          });
          openedAssistant = false;
          window.__apiToast?.(t('game.console.run.rewound_toast'), { kind: 'info', duration: 2500 });
        },
        on_updates: (data) => {
          if (!isCurrentRun()) return;
          logEvent('updates', data);
          const stage = data && data.stage;
          // #13 沉浸感: /set 等 directive 确认(pre_llm)是确定性回执,以 toast 呈现,
          // 不进主聊天 transcript(原本被直接丢弃,现给 /set"修改世界观"一个确认通道)。
          if (stage === 'pre_llm') {
            const items = (data && Array.isArray(data.items)) ? data.items : [];
            if (items.length) {
              // 失败项(后端惯例:「X 失败:」「X 被拒绝:」「X 未生效:」)不该被标成「已更新」
              const fail = items.filter((s) => /失败|被拒绝|未生效/.test(String(s))).length;
              const label = fail
                ? t('game.console.run.settings_updated_partial', { ok: items.length - fail, fail })
                : t('game.console.run.settings_updated', { count: items.length });
              window.__apiToast?.(label, { kind: fail ? 'warn' : 'ok', detail: items.join('\n'), duration: fail ? 6000 : 4000 });
            }
            return;
          }
          if (stage === 'rules_engine') return;
          setRunState((r) => {
            const nextStageId = advancePublicStage(r.publicStage, PUBLIC_STAGES.save);
            return { ...r, publicStage: nextStageId, label: PUBLIC_STAGES[nextStageId].label, detail: '' };
          });
        },
        on_system_receipt: (data) => {
          if (!isCurrentRun()) return;
          // #13 沉浸感: 斜杠命令(/time /loc /rel /var 等)的确定性回执 → toast,不进
          // 主叙事 transcript。gotReceipt 防止 on_done 把本轮误判为"空回复"恢复草稿。
          resetInactivityTimer();
          gotReceipt = true;
          const text = (data && data.text) || '';
          logEvent('system_receipt', { changed: !!(data && data.changed), len: text.length });
          if (!text) return;
          const firstLine = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim().split('\n')[0] || t('game.console.run.updated');
          window.__apiToast?.(firstLine, {
            kind: (data && data.changed) ? 'ok' : 'info',
            detail: text.trim().length > firstLine.length ? text.trim() : undefined,
            duration: (data && data.changed) ? 3500 : 7000,
          });
        },
        on_cliche_notice: (data) => {
          if (!isCurrentRun()) return;
          // 反馈#22: 后端检测到套路比喻 → 复用 ConfirmStrip(GM 询问窗口)提示,按钮复用 onRetry
          logEvent('cliche_notice', data);
          if (data && Array.isArray(data.phrases) && data.phrases.length) setClicheNotice(data);
        },
        on_weekday_notice: (data) => {
          if (!isCurrentRun()) return;
          // 客户 abci: 确定性星期验错查出 LLM 算错的星期 → toast 明示,玩家可重新生成。
          logEvent('weekday_notice', data);
          const errs = (data && Array.isArray(data.errors)) ? data.errors : [];
          if (!errs.length) return;
          const detail = errs.map((e) => `${e.rel}应为${e.expected}(写成了${e.claimed})`).join('；');
          window.__apiToast?.(`本轮星期算错了(今天${(data && data.base) || ''})`, {
            kind: 'warn', detail: `${detail}。可点「重新生成」。`, duration: 8000,
          });
        },
        on_usage: (data) => {
          if (!isCurrentRun()) return;
          // #11: 后端在 done 前发独立 usage 事件(input/output/cached/reasoning tokens
          // + context 占用 + cost_usd),存起来给输入框下方 footer 显示。
          // 内容被拦时的可读解释走后端 agent 事件(_stop_reason_notice),不在这里重复提示。
          logEvent('usage', data);
          if (data) setLastUsage(data);
        },
        on_done: (data) => {
          if (!isCurrentRun()) return;
          gotDone = true;
          if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
          if (data && data.usage) setLastUsage(data.usage);  // #11: 兜底(若无独立 usage 事件)
          logEvent('done', { status: !!data && data.status ? 'ok' : 'noop', interrupted: data && data.interrupted, usage: data && data.usage });
          clearInterval(tickerId);
          if (!openedAssistant && !gotReceipt) {
            if (runRef.current.doneTimer) { clearTimeout(runRef.current.doneTimer); runRef.current.doneTimer = null; }
            const _interrupted = !!(data && data.interrupted);
            // 「要刷新才出响应」(线上反馈):本轮没收到任何增量 token(provider 非增量流式 / SSE 丢事件),
            // 但 GM 回复其实已生成并落库 → 旧逻辑直接判「空回复」,逼用户手动刷新才看到已存的回复。
            // 先回查一次最新存档(与开场流 on_done 同款 setTimeout(async) 兜底),若 history 真长出本轮
            // assistant 回复就直接渲染;确为空/被中断才提示。回查失败/无新轮 → 维持原空回复提示。
            setTimeout(async () => {
              if (!isCurrentRun()) return;
              if (!_interrupted) {
                try {
                  const d2 = await window.api.game.state();
                  // await 期间玩家可能已经发了下一轮(runId 变化);此时不能用旧请求的
                  // 结果覆盖新一轮的乐观消息/运行状态。
                  if (!isCurrentRun()) return;
                  const hist = (d2 && Array.isArray(d2.history)) ? d2.history : null;
                  const lastSrv = (hist && hist.length) ? hist[hist.length - 1] : null;
                  // 旧逻辑只看最后一条是不是 assistant —— 本轮失败未落库时,上一轮的 assistant
                  // 会被误当成“本轮已生成的回复”,直接覆盖 history 并吞掉错误提示。
                  // 只有 assistant 条数比本轮开始时真的多,才认为本轮回复已落库。
                  const beforeCount = Number(runRef.current.assistantCountBefore) || 0;
                  const afterCount = hist ? hist.filter((m) => m && m.role === 'assistant').length : 0;
                  if (afterCount > beforeCount && lastSrv && lastSrv.role === 'assistant' && String(lastSrv.content || '').trim()) {
                    setHistory(hist);
                    setRunState((r) => ({ ...r, running: false, publicStage: null, label: '', detail: '', completedAt: Date.now() }));
                    runRef.current.sse = null;
                    try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
                    return;  // 已从存档兜底出本轮回复 → 不再误报空回复
                  }
                } catch (_) { /* 回查失败 → 落到下面的空回复提示 */ }
              }
              // 空回复/被中断:本轮首稿没有落库,A/B 候选的目标不存在,先撤下。
              setRewriteAlt(null);
              restoreFailedDraft({ force: true });
              const msg = _interrupted ? t('game.console.run.interrupted_msg') : t('game.console.run.empty_reply_msg');
              setRunState((r) => ({
                ...r,
                running: false,
                label: _interrupted ? t('game.console.run.interrupted') : t('game.console.run.empty_reply'),
                detail: msg,
                publicStage: null,
                completedAt: 0,
              }));
              setHasError(msg);
              window.__apiToast?.(_interrupted ? t('game.console.run.generation_interrupted') : t('game.console.run.empty_reply'), {
                kind: 'warn',
                detail: msg,
                duration: 5000,
              });
              runRef.current.sse = null;
            }, 0);
            return;
          }
          const stripOps = (txt) => {
            if (!txt) return txt;
            // Robust: find JSON arrays containing "op": and remove them.
            // Strategy: locate `[` followed by `"op"` within 80 chars, then find matching `]`.
            let out = txt;
            // 1. fenced code blocks wrapping ops
            out = out.replace(/```(?:json)?\s*\[[\s\S]*?"op"\s*:[\s\S]*?\]\s*```/gi, '');
            out = out.replace(/```(?:json)?\s*\{[\s\S]*?"op"\s*:[\s\S]*?\}\s*```/gi, '');
            // 2. Bare JSON ops array: find `[` + within 80 chars `"op":` + greedy to last `]`
            // Use a function-based replace to find the matching bracket
            let idx;
            while ((idx = out.search(/\[\s*\{[^[\]]{0,80}"op"\s*:/)) !== -1) {
              // Find matching ] by counting brackets
              let depth = 0, end = -1;
              for (let i = idx; i < out.length; i++) {
                if (out[i] === '[') depth++;
                else if (out[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
              }
              if (end === -1) break; // malformed, stop
              // Remove including leading newlines
              let start = idx;
              while (start > 0 && out[start - 1] === '\n') start--;
              out = out.slice(0, start) + out.slice(end + 1);
            }
            return out.trimEnd();
          };
          // 若 on_done payload 包含服务端最终 history,直接用服务端版本(已是净内容),
          // 不必在前端再 stripOps 并写 streaming_done — 否则 React 18 批处理中两次
          // setHistory 并发,最后一次(payload.history)覆盖前一次但前一次的 streaming_done 丢失。
          // 只在 payload 无 history 时才回退到前端 strip+标记。
          const _payloadForStrip = (data && data.status) || null;
          if (!(_payloadForStrip && Array.isArray(_payloadForStrip.history))) {
            setHistory((h) => {
              const last = h[h.length - 1];
              if (!last || last.role !== 'assistant') return h;
              const cleaned = stripOps(last.content || '');
              return [...h.slice(0, -1), { ...last, content: cleaned, streaming: false, streaming_done: true }];
            });
          }
          setRunState((r) => {
            // 修: rawSteps 里所有 status='running' 的步骤 mark 'done' — 否则最后那步
            // ("主 GM 正在读取上下文并生成正文")永远是 pulse 状态,看起来像卡死。
            const rawSteps = (Array.isArray(r.rawSteps) ? r.rawSteps : []).map((s) =>
              s && s.status === 'running' ? { ...s, status: 'done' } : s
            );
            return { ...r, running: false, label: t('game.console.run.turn_complete'), detail: '',
                     completedAt: Date.now(), completedElapsed: r.totalElapsed,
                     rawSteps };
          });
          if (runRef.current.doneTimer) clearTimeout(runRef.current.doneTimer);
          runRef.current.doneTimer = setTimeout(() => {
            runRef.current.doneTimer = null;
            // 1.8s 后清 publicStage/completedAt/label 让顶部 thinking pill 消失。
            // **保留 rawSteps**:LeftRail RunStateSection 默认折叠,但用户点击
            // "空闲·等待玩家"行可展开看上一轮详情。下一轮 setRunState 才会
            // 重新填 rawSteps。
            setRunState((r) => (r.running ? r : { ...r, publicStage: null, completedAt: 0, label: '' }));
          }, 1800);
          const payload = (data && data.status) || null;
          if (payload && payload.player) setGame((g) => {
            const n = { ...g };
            for (const k of PICK_STATE_KEYS) if (payload[k] !== undefined) n[k] = payload[k];
            n._raw = {
              save_id: payload.save_id ?? n._raw?.save_id,
              save_title: payload.save_title ?? n._raw?.save_title,
              turn: payload.turn ?? n._raw?.turn,
              isTavern: tavernFlagFrom(payload, n._raw),
            };
            return n;
          });
          if (payload && Array.isArray(payload.history)) setHistory(payload.history);
          if (payload && payload.permissions) {
            setPermission(normalizePermissionForUi(payload.permissions.mode));
            setPendingWrites(payload.permissions.pending_writes || []);
            setPendingQuestions(payload.permissions.pending_questions || []);
          }
          if (payload && payload.save_id != null) {
            setActiveSave((prev) => saveMetaFrom(payload, prev, t));
          }
          runRef.current.sse = null;
          setPickedCommand(null);
          // 回合结束后刷新一次外围数据:顶栏「已存档」时间/章号、时间线面板、NPC 议程、
          // 世界书 overlay、左栏存档时间等由独立请求/事件驱动的区域不会随 SSE state 自动更新。
          // reloadState 有 in-flight SSE 守卫:玩家若已开始下一轮,不会用旧 history 覆盖。
          try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
        },
        on_error: (data) => {
          // gotDone 后的迟到 error 不能把已完成的回合标成失败(SSE 关闭阶段的网络抖动)。
          if (!isCurrentRun() || gotDone) return;
          streamFailed = true;
          logEvent('error', data);
          clearInterval(tickerId);
          if (runRef.current.doneTimer) { clearTimeout(runRef.current.doneTimer); runRef.current.doneTimer = null; }
          if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
          const realMsg = (data && (data.message || data.detail || data.error)) || '';
          // 服务端明确报错:本轮不会有首稿落库,A/B 候选的目标不存在,先撤下。
          setRewriteAlt(null);
          setRunState((r) => ({ ...r, running: false, label: t('game.console.run.generation_failed'), detail: realMsg, publicStage: null, completedAt: 0 }));
          setHasError(realMsg || true);
          window.__apiToast?.(t('game.console.run.generation_failed'), { kind: 'danger', detail: realMsg || t('game.console.run.please_retry') });
          restoreFailedDraft();
        },
        onClose: () => {
          if (!isCurrentRun()) return;
          const lastDetail = describeLastSseEvent();
          logEvent('close', { got_done: gotDone, stream_failed: streamFailed, stopped: runRef.current.stopped, last_event: lastSseEvent && lastSseEvent.kind });
          clearInterval(tickerId);
          if (runRef.current.inactivityTimer) { clearTimeout(runRef.current.inactivityTimer); runRef.current.inactivityTimer = null; }
          if (gotDone || streamFailed || runRef.current.stopped) {
            runRef.current.sse = null;
            return;
          }
          // EOF 但没有 done:服务端可能已在关闭前提交本轮。先核对 /api/state,
          // 已落库就采用服务端 history;否则才恢复草稿并报「连接中断」。
          runRef.current.sse = null;
          void handleBrokenStream({
            errorMsg: t('game.console.run.stream_closed_error', { detail: lastDetail }),
            label: t('game.console.run.interrupted'),
            detail: lastDetail,
            toastTitle: t('game.console.run.generation_interrupted'),
            toastKind: 'warn',
            toastDetail: lastDetail,
          });
        },
      }
    );
  }, [attachments, model, pickedCommand, activeSave, tabConflictBanner]);

  const startRun = useCallback((playerText) => {
    if (window.api && window.api.base !== undefined) return startRunReal(playerText);
    const ts = ['申时三刻', '酉时初', '酉时一刻', '酉时二刻'][history.length % 4];
    setHistory((h) => [...h, { role: 'user', content: playerText, ts, attachments }]);
    setText(''); setAttachments([]); setShowSlash(false); setShowPlus(false);
    runRef.current.stopped = false; runRef.current.timers = [];
    if (runRef.current.doneTimer) { clearTimeout(runRef.current.doneTimer); runRef.current.doneTimer = null; }
    const startedAt = Date.now();
    const MOCK_PHASES = [
      { phase: 'prompt',       message: '加载上下文子代理运行提示（模式：local_fallback）。', duration: 220 },
      { phase: 'intent',       message: '未发现显式时间跳跃；沿用当前锁定时间线。', duration: 180 },
      { phase: 'manifest',     message: '已解析 ContentPack：novel · woaileni', duration: 260 },
      { phase: 'provider:novel_retrieval', message: 'novel_retrieval 贡献 4 层、6 条事实', duration: 620 },
      { phase: 'assembly',     message: '已生成主 GM 上下文清单。', duration: 200 },
      { phase: 'rules_engine', message: 'RulesEngine 已完成本轮规则裁定。', duration: 340 },
      { phase: 'main_gm',      message: '主 GM 正在读取上下文并生成正文。', duration: 2200 },
    ];
    setRunState({ running: true, publicStage: 'context', label: PUBLIC_STAGES.context.label, detail: '', totalElapsed: 0, completedAt: 0, completedElapsed: 0, rawSteps: [] });
    setClicheNotice(null);  // 反馈#22: 新一轮清掉上轮的套路比喻提示
    const tickerId = setInterval(() => {
      if (runRef.current.stopped) { clearInterval(tickerId); return; }
      setRunState((r) => ({ ...r, totalElapsed: Date.now() - startedAt }));
    }, 200);
    runRef.current.timers.push(tickerId);
    const runStep = (i) => {
      if (runRef.current.stopped) return;
      if (i >= MOCK_PHASES.length) {
        clearInterval(tickerId);
        setRunState((r) => ({ ...r, running: false, label: t('game.console.run.turn_complete'), detail: '', completedAt: Date.now(), completedElapsed: Date.now() - startedAt }));
        if (runRef.current.doneTimer) clearTimeout(runRef.current.doneTimer);
        runRef.current.doneTimer = setTimeout(() => { runRef.current.doneTimer = null; setRunState((r) => (r.running ? r : { ...r, publicStage: null, completedAt: 0, label: '' })); }, 1800);
        setPendingWrites((arr) => arr.some((w) => w.id === 'pw-3') ? arr : [...arr, { id: 'pw-3', field: 'memory.facts', from: null, to: '韩司直已抵达北港', risk: 'low', reason: 'GM 提议加入事实库（低风险）' }]);
        return;
      }
      const step = MOCK_PHASES[i];
      const mapped = mapAgentPhase(step.phase);
      setRunState((r) => {
        const rawSteps = [...r.rawSteps, { phase: step.phase, message: step.message, status: 'running', elapsed_ms: 0 }];
        const nextStageId = advancePublicStage(r.publicStage, mapped);
        return { ...r, rawSteps, publicStage: nextStageId, label: PUBLIC_STAGES[nextStageId].label, detail: '' };
      });
      if (step.phase === 'main_gm') {
        setHistory((h) => [...h, { role: 'assistant', content: '', ts, streaming: true }]);
        let chunkIdx = 0;
        const chunkInterval = setInterval(() => {
          if (runRef.current.stopped) { clearInterval(chunkInterval); return; }
          if (chunkIdx >= STREAM_CHUNKS.length) { clearInterval(chunkInterval); return; }
          const piece = STREAM_CHUNKS[chunkIdx++];
          setHistory((h) => { const last = h[h.length - 1]; if (!last || last.role !== 'assistant') return h; return [...h.slice(0, -1), { ...last, content: (last.content || '') + piece }]; });
        }, step.duration / (STREAM_CHUNKS.length + 1));
        runRef.current.timers.push(chunkInterval);
      }
      const timerB = setTimeout(() => {
        if (runRef.current.stopped) return;
        setRunState((r) => { const rawSteps = r.rawSteps.slice(); const idx = rawSteps.findIndex((s) => s.phase === step.phase); if (idx >= 0) rawSteps[idx] = { ...rawSteps[idx], status: 'done', elapsed_ms: step.duration }; return { ...r, rawSteps }; });
        if (step.phase === 'main_gm') { setHistory((h) => { const last = h[h.length - 1]; if (!last || last.role !== 'assistant') return h; return [...h.slice(0, -1), { ...last, streaming: false, streaming_done: true }]; }); }
        runStep(i + 1);
      }, step.duration);
      runRef.current.timers.push(timerB);
    };
    runStep(0);
  }, [history.length, attachments]);

  const onSend = () => {
    // 选了斜杠命令但没填文字时,也允许直接发送(发命令 trigger)。来自 PR #14。
    if (!text.trim() && !attachments.length && !pickedCommand) return;
    if (runState.running) return;
    // 客户端动作命令(/retry /save /status /debug)= 本地执行,不发给 GM。
    // 此前 onSend 一律 startRun → "/retry" 被当玩家文本发给 GM,retry 从不执行(用户反馈)。
    // /set /loc /time /rel /var /pin /note /memory /permission 是后端 directive,仍走 startRun 发送。
    const typed = text.trim().toLowerCase();
    const typedId = (typed.startsWith('/') && CLIENT_CMDS.has(typed.slice(1))) ? typed.slice(1) : '';
    const cmdId = (pickedCommand && CLIENT_CMDS.has(pickedCommand.id)) ? pickedCommand.id : typedId;
    if (cmdId) {
      setText(''); setPickedCommand(null); setShowSlash(false);
      if (cmdId === 'retry') onRetry();
      // /status 不只是展开面板:右栏可能正停在记忆/世界线,必须同时切到 status tab。
      else if (cmdId === 'status') { setPanelCollapsed(false); setActiveTab('status'); }
      else if (cmdId === 'debug') setSseLogOpen(true);
      else if (cmdId === 'save') {
        manualSave();
      }
      return;
    }
    setHasError(false);
    // pickedCommand 可能来自不同宿主(桌面菜单对象有 trigger;移动端对象曾是 trig)。
    // 这里只在本对象真的带字符串 trigger 时才取命令文本,否则退到附件/空文本兜底,
    // 避免 undefined.trim() 崩掉发送。
    const cmdText = (pickedCommand && typeof pickedCommand.trigger === 'string')
      ? pickedCommand.trigger.trim()
      : t('game.console.send.attachment_only');
    startRun(text.trim() || cmdText);
  };
  const onSendRaw = useCallback((raw) => {
    if (runState.running) return;
    const t2 = (raw || '').trim();
    if (!t2) return;
    setHasError(false);
    startRun(t2);
  }, [runState.running, startRun]);
  const onStop = () => stopRun();
  const onRetry = useCallback(async () => {
    if (runState.running) {
      window.__apiToast?.(t('game.console.retry.still_running'), { kind: 'warn', duration: 2400 });
      return;
    }
    // 多标签冲突横幅出现时不要先回滚:rollback 已经删了本轮,startRunReal 再被横幅拦下
    // → 本轮彻底丢失。这里提前拦;回滚 await 期间横幅可能才出现,发送前还会用 ref 再拦一次。
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    // 开场最终失败:此时历史里没有可重发的玩家输入,「重试」应重新生成开场。
    // 失败收尾时已 removeItem(seenKey),这里置 forceOpening 让 reloadState 无视标记再开一次。
    if (openingFailedRef.current) {
      openingFailedRef.current = false;
      setHasError(false);
      setRewriteAlt(null);
      const sid = stateSaveIdRef.current || activeSaveIdRef.current;
      if (sid) { try { sessionStorage.removeItem('gc.opened_save.' + sid); } catch (_) {} }
      forceOpeningRef.current = true;
      await reloadState();
      // 等 reloadState 里排的 opening rAF 执行完再判断:开流会置 in-flight;成功会写 seenKey。
      // 不能直接用 reloadState 的返回值 —— 新建档在开场前可能还没有 player,返回 false 属正常。
      await new Promise((resolve) => setTimeout(resolve, 120));
      // 等待期间玩家可能已切档:状态已换成新档,别把错误条写到新档上。
      if (sid && stateSaveIdRef.current && stateSaveIdRef.current !== sid) return;
      const started = !!openingInFlightRef.current
        || openingFailedRef.current
        || !!(sid && (() => { try { return sessionStorage.getItem('gc.opened_save.' + sid); } catch (_) { return null; } })());
      if (!started && !tavernRedirectRef.current) {
        // 请求失败/没有可重开的开场:保留错误条,让玩家可以再点一次。
        openingFailedRef.current = true;
        setHasError(t('game.console.opening.failed'));
      }
      return;
    }
    // 「重试」语义 = 删除本轮输出(回滚到本轮玩家输入之前)+ 再次发送本轮输入。
    // 文本来源分两种情况:
    //   · 失败轮未落库(restoreFailedDraft 已处理气泡):要重发的是刚失败的那句
    //     lastPlayerText;keepFailedTurn=off 时历史最后一条 user 已经是【上一个好回合】,
    //     不能拿它当重试文本(否则会重发上一轮并误删好回合)。pIdx 置 -1 表示不回滚。
    //   · 正常/手动停止:历史最后一条玩家消息才是本轮输入;编辑消息 / /set rewind 后
    //     lastPlayerText 可能过期,所以优先历史。
    const h = Array.isArray(history) ? history : [];
    let pIdx = -1;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i] && h[i].role === 'user' && (h[i].content || '').trim()) {
        pIdx = i;
        break;
      }
    }
    const lastUserText = pIdx >= 0 ? String(h[pIdx]?.content || '').trim() : '';
    const _failedUnpersisted = runRef.current.lastRunFailedUnpersisted === true;
    let t2 = '';
    if (_failedUnpersisted) {
      t2 = (lastPlayerText || '').trim() || lastUserText;
      if (lastUserText && t2 !== lastUserText) pIdx = -1;
    } else {
      t2 = lastUserText || (lastPlayerText || '').trim();
    }
    if (!t2) { window.__apiToast?.(t('game.console.retry.no_input'), { kind: 'warn', duration: 2000 }); return; }
    setHasError(false);
    // 之前只截断【前端】历史、不动后端 → 重发会叠在旧本轮之上(玩家报「没有删除」)。
    // 改:先调 rollback 把本轮(玩家输入及之后)从后端删除并回退活跃指针(旧回合进 trash ref 可恢复),
    // reloadState 后历史截到本轮之前,再 startRun 重走 → 真正实现「删除本轮 + 重发」。
    const saveId = activeSave?.id ?? null;
    let rolled = false;
    // 【off-by-one 防线】失败轮未落库时(安全过滤/生成失败,restoreFailedDraft 已把本轮气泡
    // 移除),历史里最后一条玩家输入是【上一个好回合】——rollback 会成功地把好回合滚进 trash,
    // 每次失败重试多吃一轮(群反馈:自动回退到前一回合,要去分支里找最新回合)。
    const _pContent = pIdx >= 0 ? String(h[pIdx]?.content || '').trim() : '';
    if (!_failedUnpersisted && _pContent === t2 && saveId != null && pIdx >= 0) {
      try {
        const r = await window.api.branches.rollbackToMessage(saveId, pIdx);
        if (r && r.ok === false) throw new Error(r.error || r.detail || 'rollback denied');
        await reloadState();
        rolled = true;
      } catch {
        // 本轮可能尚未提交(纯生成失败,后端无本轮 commit)→ 退化为前端截断,不打断重试。
        rolled = false;
      }
    }
    if (!rolled) {
      setHistory((hh) => {
        const out = [...hh];
        // 失败/手动停止时最后一条 assistant 可能仍是流式半截(streaming=true):它不是
        // 有效回复,重试前必须移除,否则会和新回复叠成两条。空 assistant 也一并清掉。
        while (out.length && out[out.length - 1].role === 'assistant'
          && (out[out.length - 1].streaming || !(out[out.length - 1].content || '').trim())) out.pop();
        if (out.length && out[out.length - 1].role === 'user' && (out[out.length - 1].content || '').trim() === t2) out.pop();
        return out;
      });
    }
    // 回滚/截断完成后、真正发送前再检查一次:横幅可能在 await 期间才出现。此时把本轮
    // 输入回填到输入框,至少不让玩家白丢一句话。
    if (tabConflictRef.current) {
      setText(t2);
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    window.__apiToast?.(t('game.console.retry.retrying'), { kind: 'info', duration: 1600 });
    startRun(t2);
  }, [lastPlayerText, history, runState.running, startRun, activeSave, reloadState, t]);
  // 反馈:每条消息的「重新生成这一轮」(MsgActions 派发 rpg-regenerate 事件,携 message_index)。
  // 语义 = 删除本轮 + 用同一条玩家输入重走 → 换个结果替换旧的(非分叉保留)。故用 rollback(删除,
  // 旧回合进 trash ref 可恢复)而非 continueFrom(那是「建立分支」,保留旧线、玩家反馈「没有删除」)。
  // reloadState 把历史截到本轮前 → 用同一条玩家输入 startRun 重走完整 GM 流程。
  const onRegenerate = useCallback(async (messageIndex) => {
    if (runState.running) { window.__apiToast?.(t('game.console.retry.still_generating'), { kind: 'warn', duration: 2000 }); return; }
    // 同 onRetry:横幅出现时不能先 rollback(删了回合却被拦下,本轮永久丢失)。
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    const h = Array.isArray(history) ? history : [];
    let pIdx = Number(messageIndex);
    if (!Number.isFinite(pIdx)) pIdx = h.length - 1;
    pIdx = Math.min(pIdx, h.length - 1);
    // 从本条往前找这一轮的玩家输入(role==='user')
    while (pIdx >= 0 && h[pIdx]?.role !== 'user') pIdx--;
    if (pIdx < 0) { window.__apiToast?.(t('game.console.regen.no_player_input'), { kind: 'warn', duration: 2400 }); return; }
    const playerText = String(h[pIdx]?.content || '').trim();
    if (!playerText) { window.__apiToast?.(t('game.console.regen.empty_input'), { kind: 'warn', duration: 2400 }); return; }
    const saveId = activeSave?.id ?? null;
    if (saveId == null) { window.__apiToast?.(t('game.console.regen.no_save_context'), { kind: 'warn', duration: 2400 }); return; }
    try {
      setHasError(false);
      const r = await window.api.branches.rollbackToMessage(saveId, pIdx);  // 删除本轮(玩家输入及之后),回退活跃指针
      if (r && r.ok === false) throw new Error(r.error || r.detail || t('game.console.regen.branch_rejected'));
      await reloadState();                 // 历史截到本轮之前(本轮玩家输入及之后被移除)
      // await 期间横幅可能才出现。回滚已发生,至少把本轮输入放回输入框,避免玩家白丢。
      if (tabConflictRef.current) {
        setText(playerText);
        window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
        return;
      }
      window.__apiToast?.(t('game.console.regen.regenerating'), { kind: 'ok', duration: 1800 });
      startRun(playerText);                // 用同样的玩家输入重走 GM(完整后端流程)
    } catch (e) {
      window.__apiToast?.(t('game.console.regen.failed'), { kind: 'danger', detail: e?.message, duration: 3000 });
    }
  }, [history, runState.running, activeSave, reloadState, startRun, t]);
  useEffect(() => {
    const onRegen = (e) => onRegenerate(e?.detail?.message_index);
    window.addEventListener('rpg-regenerate', onRegen);
    return () => window.removeEventListener('rpg-regenerate', onRegen);
  }, [onRegenerate]);
  const onShowSse = useCallback(() => setSseLogOpen(true), []);

  const onSlashPick = (cmd) => {
    if (cmd && typeof cmd.trigger === 'string' && cmd.trigger.endsWith(' ')) {
      setText(cmd.trigger); setPickedCommand(null); setShowSlash(false); return;
    }
    setPickedCommand(cmd); setText(''); setShowSlash(false);
  };
  // 真实文件上传(对齐酒馆):file/image/card 走文件选择器读成 data_url 真实附件 →
  // 后端 _save_attachments 取前 6000 字节文本注入 GM,GM 即可读到附件内容(反馈:游戏附件
  // 此前是假占位,GM 读不到)。chapter/world/mcp/skill/plan 尚未接线:它们只会添加没有
  // data_url 的占位对象,后端 _save_attachments 会直接抛「附件内容为空」导致整条消息发送失败,
  // 因此这里拒绝并把“未接入”告诉用户,而不是制造一个必失败的附件。
  const fileInputRef = useRef(null);
  const pendingAttachRef = useRef({ kind: 'file' });
  const ATTACH_KINDS = new Set(['file', 'image', 'card']);
  const onAttachPick = (item) => {
    setShowPlus(false);
    if (!item || !ATTACH_KINDS.has(item.id)) {
      window.__apiToast?.(t('game.console.attach.not_supported', { defaultValue: '该附件类型暂未接入' }), { kind: 'info', duration: 2400 });
      return;
    }
    pendingAttachRef.current = { kind: item.id };
    const inp = fileInputRef.current;
    if (inp) {
      inp.value = '';
      inp.accept = item.id === 'card' ? '.png,.json,.webp' : (item.id === 'image' ? 'image/*' : '');
      inp.click();
    }
  };
  const onFilePicked = (e) => {
    const f = e.target && e.target.files && e.target.files[0];
    if (!f) return;
    const kind = (pendingAttachRef.current && pendingAttachRef.current.kind) || 'file';
    if (f.size > 12 * 1024 * 1024) { window.__apiToast?.(t('game.console.attach.file_too_large'), { kind: 'warn', duration: 2400 }); return; }
    // 后端 MAX_ATTACHMENTS_PER_REQUEST=8;前端先拦,避免用户选了一堆文件后整条消息被 400。
    if ((attachments || []).length >= 8) {
      window.__apiToast?.(t('game.console.attach.max_count', { defaultValue: '单次最多 8 个附件' }), { kind: 'warn', duration: 2400 });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAttachments((a) => [...a, { name: f.name, type: f.type || 'application/octet-stream', data_url: String(reader.result || ''), kind }]);
    reader.onerror = () => window.__apiToast?.(t('game.console.attach.read_failed', { defaultValue: '附件读取失败' }), { kind: 'danger', duration: 2400 });
    reader.readAsDataURL(f);
  };

  const _matchPending = (target) => (item, idx) => {
    if (target.id != null && item.id != null) return item.id !== target.id;
    return idx !== target.index;
  };
  // 待审/待答在生成中统一拦住:回答会 startRun 中止当前 SSE;批准写入可能被本轮快照覆盖。
  const notifyRunBusy = () => window.__apiToast?.(t('game.app.msg.busy_tip'), { kind: 'warn', duration: 2400 });
  const onApprove = async (target) => {
    if (runState.running) { notifyRunBusy(); return; }
    setPendingWrites((arr) => arr.filter(_matchPending(target)));
    try { await window.api.game.pendingWrite({ id: target.id, index: target.index, action: 'approve' }); } catch (e) { window.__apiToast?.(t('game.console.write.approve_failed'), { kind: 'danger', detail: e?.message }); }
    try { const d = await window.api.game.state(); if (d && d.permissions) { setPendingWrites(d.permissions.pending_writes || []); setPendingQuestions(d.permissions.pending_questions || []); } } catch (_) {}
  };
  const onReject = async (target) => {
    if (runState.running) { notifyRunBusy(); return; }
    setPendingWrites((arr) => arr.filter(_matchPending(target)));
    try { await window.api.game.pendingWrite({ id: target.id, index: target.index, action: 'reject' }); } catch (e) { window.__apiToast?.(t('game.console.write.reject_failed'), { kind: 'danger', detail: e?.message }); }
    try { const d = await window.api.game.state(); if (d && d.permissions) { setPendingWrites(d.permissions.pending_writes || []); setPendingQuestions(d.permissions.pending_questions || []); } } catch (_) {}
  };
  const onAnswerQuestion = async (target, choice) => {
    if (runState.running) { notifyRunBusy(); return; }
    // 先清问题再 startRun:若横幅此刻在,旧逻辑会把问题清掉但回合不发 → 选择丢失。
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    setPendingQuestions((arr) => arr.filter(_matchPending(target)));
    try { await window.api.game.clearQuestions({ id: target.id, index: target.index, choice }); } catch (e) { window.__apiToast?.(t('game.console.write.answer_failed'), { kind: 'danger', detail: e?.message }); }
    try { const d = await window.api.game.state(); if (d && d.permissions) { setPendingWrites(d.permissions.pending_writes || []); setPendingQuestions(d.permissions.pending_questions || []); } } catch (_) {}
    const nextAction = String(choice || '').trim();
    if (nextAction) startRun(nextAction);
  };
  const onDismissConfirm = (target) => {
    // × = 纯前端「稍后处理」:不写后端,下次状态刷新会重新出现(与酒馆一致)。
    setPendingWrites((arr) => arr.filter(_matchPending(target)));
    setPendingQuestions((arr) => arr.filter(_matchPending(target)));
  };

  // ── config_card(agent:config_card)处理 ──────────────────────────
  // 共用一个清除助手:乐观移除 + 后端 clearQuestions(choice=null) + 刷新 pending。
  const _clearConfigQuestion = async (target) => {
    setPendingQuestions((arr) => arr.filter(_matchPending(target)));
    try { await window.api.game.clearQuestions({ id: target.id, index: target.index, choice: null }); } catch (_) {}
    try { const d = await window.api.game.state(); if (d && d.permissions) { setPendingWrites(d.permissions.pending_writes || []); setPendingQuestions(d.permissions.pending_questions || []); } } catch (_) {}
  };
  // mode "ask_default":持久化该能力偏好 → 清掉卡片 → startRun("用 X 生成") 让 LLM 带着偏好重调工具。
  const onConfigDefault = async (handleId, item, model) => {
    if (runState.running) { notifyRunBusy(); return; }
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    const cap = capConfig(item.capability);
    const aid = item.api_id || '';
    if (aid && model) {
      try {
        await window.api.account.preferences({
          [`${cap.prefPrefix}.api_id`]: aid,
          [`${cap.prefPrefix}.model_real_name`]: model,
        });
      } catch (e) { window.__apiToast?.(t('game.console.config.save_pref_failed'), { kind: 'danger', detail: e?.message }); }
    }
    await _clearConfigQuestion(handleId);
    startRun(t('game.console.retry.generate_with', { model: model || cap.label }));
  };
  // mode "missing_key":用户在卡片里配好后点「继续」→ 清掉卡片 → startRun("继续") 重试。
  const onConfigContinue = async (handleId, item, label) => {
    if (runState.running) { notifyRunBusy(); return; }
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    await _clearConfigQuestion(handleId);
    startRun(label || t('game.console.retry.continue'));
  };
  const onConfigSettings = () => { plGoto('settings-models'); };
  // mode "model_not_configured"(hard):打开阻塞弹窗。
  const [hardConfigItem, setHardConfigItem] = useState(null);
  const onHardConfig = (item) => setHardConfigItem(item);
  const _hardHandleId = (item) => ({ id: (item && item.id != null) ? item.id : null, index: null });
  const onHardResolve = async (chosenModel) => {
    if (runState.running) { notifyRunBusy(); return; }
    if (tabConflictRef.current) {
      window.__apiToast?.(t('game.console.conflict.toast_title'), { kind: 'warn', detail: t('game.console.conflict.toast_detail'), duration: 4000 });
      return;
    }
    const item = hardConfigItem; if (!item) return;
    setHardConfigItem(null);
    await _clearConfigQuestion(_hardHandleId(item));
    startRun(t('game.console.retry.generate_with', { model: chosenModel || item.model || '' }));
  };
  const onHardCancel = async () => {
    const item = hardConfigItem; if (!item) { setHardConfigItem(null); return; }
    setHardConfigItem(null);
    await _clearConfigQuestion(_hardHandleId(item));
    window.__apiToast?.(t('game.console.config.cancelled'), { kind: 'info', duration: 2000 });
  };

  // 切存档时必须清掉的「会话级」UI 状态。旧版只 stop/activate/reloadState,导致:
  //   · 上一档的 lastPlayerText 被 Retry 发进新档;
  //   · A/B 改写候选、套路提示、错误条、token 用量、SSE 日志、多标签冲突横幅跨档残留;
  //   · 输入框草稿/附件跟着玩家切到另一档,误发。
  // 这些都不属于存档数据,清掉不会丢进度。activeSave.id 变化时兜底调用一次,桌面/移动共用。
  const resetSessionUiState = useCallback(() => {
    setRewriteAlt(null);
    setAbBusy(false);
    setClicheNotice(null);
    setHasError(false);
    setLastUsage(null);
    setLastPlayerText('');
    setSseLog([]);
    setSseLogOpen(false);
    setTabConflictBanner(null);
    setText('');
    setAttachments([]);
    setPickedCommand(null);
    // 模型选择是存档级状态;切档先清空,随后 reloadState 会用新档的 models.selected 回填,
    // 避免底部模型标签停在上一个存档。
    setModel(null);
    setShowSlash(false);
    setShowPlus(false);
    setShowModel(false);
    setShowPerm(false);
    setHardConfigItem(null);
    setShowHistoryDrawer(false);
    setShowSearchDrawer(false);
    setShowInGameSettings(false);
    // 新档的加载状态由接下来的 reloadState 决定;先把上一档的失败/等待开场标记清掉,
    // 避免 reloadState 失败时还显示上一档的“加载失败,重试”或“等待开场”。
    setRetryFailed(false);
    setStateLoadedNoPlayer(false);
    // 清掉上一档遗留的“本轮输入/失败轮”运行态;它们不是存档数据,留着会让新档的
    // Retry 用旧文本。runRef 是同步对象,不影响渲染。
    runRef.current.activeInput = '';
    runRef.current.lastRunFailedUnpersisted = false;
    runRef.current.assistantCountBefore = 0;
    // 开场状态是存档级的:切档后旧档的失败标记/强制标记必须失效,否则新档会被误判成
    // 「开场失败」或误用旧档的重试。注意不要清 openingInFlightRef:切档流程是
    // reloadState 先排 rAF、activeSave 变化后才触发本 reset,清掉会把刚起步的新档开场
    // 从「在飞」状态抹掉,后续刷新就可能重复开流(它按 save_id 区分,旧档残留无害)。
    openingFailedRef.current = false;
    forceOpeningRef.current = false;
    setRunState({ running: false, publicStage: null, label: '', detail: '', totalElapsed: 0, completedAt: 0, completedElapsed: 0, rawSteps: [] });
  }, []);
  const activeSaveId = (activeSave && activeSave.id != null) ? String(activeSave.id) : null;
  const prevActiveSaveIdRef = useRef(undefined);
  useEffect(() => {
    const prev = prevActiveSaveIdRef.current;
    if (prev === undefined) { prevActiveSaveIdRef.current = activeSaveId; return; }
    // 首屏从「无存档」到拿到 activeSave 不算切档:此时不能清 tabConflictBanner,
    // 否则第二标签页刚建立的“同档冲突”提示会被首轮 /api/state 回来的 reset 抹掉。
    if (prev == null && activeSaveId != null) { prevActiveSaveIdRef.current = activeSaveId; return; }
    if (prev !== activeSaveId) {
      prevActiveSaveIdRef.current = activeSaveId;
      resetSessionUiState();
    }
  }, [activeSaveId, resetSessionUiState]);

  const rootStyle = useMemo(() => {
    const densityMap = { compact: 0.92, normal: 1, comfy: 1.1 };
    return { '--density': densityMap[tweaks.density] || 1, '--ui-size': tweaks.uiSize + 'px', '--narrative-size': tweaks.narrativeSize + 'px' };
  }, [tweaks.density, tweaks.uiSize, tweaks.narrativeSize]);

  const [mountStage, setMountStage] = useState(0);
  useEffect(() => {
    if (mountStage >= 2) return;
    // 双 RAF 把重面板(RightPanel 等)推迟到首帧之后,避免首屏卡顿。
    // 但后台标签页(document.hidden)里浏览器会暂停 requestAnimationFrame → mountStage
    // 永远停在 0 → 整个游戏区卡在「正在初始化…」(用户在后台预加载 Game Console、
    // 或切走再切回前的瞬间就会看到)。加 setTimeout 兜底:RAF 不触发时也能推进;
    // 前台时 RAF(~16ms)先到并触发 re-render→cleanup 清掉这个 timeout,几乎无副作用。
    const raf = requestAnimationFrame(() => { requestAnimationFrame(() => setMountStage((s) => Math.min(2, s + 1))); });
    const fallback = setTimeout(() => setMountStage((s) => Math.min(2, s + 1)), 200);
    return () => { cancelAnimationFrame(raf); clearTimeout(fallback); };
  }, [mountStage]);

  // ── P2 移动原生游戏台:窄屏早返。UI 全按设计稿重写(MobileGame),逻辑/数据复用本 App
  //    的全部 state + handler;设计稿砍掉的功能(历史/搜索/游戏内设置/反馈/SSE 调试)用
  //    既有 overlay 找回(它们是模态浮层,非主 UI 本体)。
  if (mobileGame && mountStage >= 1) {
    // A/B 候选的定位在桌面/移动共用同一 helper;移动端只负责渲染面板。
    const acceptance = rewriteAlt ? acceptanceTarget(rewriteAlt, history) : null;
    // 目标已被分支切换/回退换掉时不再渲染面板(否则点选会把改写稿落到别的消息上)。
    const acceptanceUsable = !!(acceptance && acceptance.idx >= 0
      && history[acceptance.idx] && history[acceptance.idx].role === 'assistant');
    return (
      <>
        <MobileGame
          game={game} history={
            (stateLoadedNoPlayer && history.length === 0)
              ? [{ role: 'assistant', content: t('game.console.opening.waiting'), _opening: true, _thinking: 'starting' }] : history
          }
          runState={runState} text={text} setText={setText}
          onSend={onSend} onSendRaw={onSendRaw} onStop={onStop}
          attachments={attachments} setAttachments={setAttachments}
          model={model} setModel={setModel}
          permission={permission} setPermission={changePermission}
          pendingWrites={pendingWrites} pendingQuestions={pendingQuestions}
          onApprove={onApprove} onReject={onReject} onAnswerQuestion={onAnswerQuestion} onDismissConfirm={onDismissConfirm}
          /* config_card 处理(模型/能力未配置):移动端也必须能“配置后继续/用默认模型生成”,
             旧版只把卡片当普通问句渲染,hard 拦截连弹窗都没有 → 卡死。 */
          onConfigDefault={onConfigDefault} onConfigContinue={onConfigContinue}
          onConfigSettings={onConfigSettings} onHardConfig={onHardConfig}
          /* acceptance A/B(移动端也要能选;旧版只在桌面 foot 渲染,移动端候选直接消失) */
          rewriteAlt={acceptanceUsable ? rewriteAlt : null} acceptanceIdx={acceptance ? acceptance.idx : -1}
          acceptanceOriginal={acceptance ? acceptance.original : ''}
          abBusy={abBusy} onChooseAcceptance={chooseAcceptance}
          onDismissAcceptance={() => setRewriteAlt(null)}
          onSlashPick={onSlashPick} onAttachPick={onAttachPick} pickedCommand={pickedCommand} onClearCommand={() => setPickedCommand(null)}
          onRetry={onRetry} onRegenerate={onRegenerate} onShowSse={onShowSse}
          clicheNotice={clicheNotice} onRetryCliche={() => { setClicheNotice(null); onRetry(); }} onDismissCliche={() => setClicheNotice(null)}
          hasError={hasError}
          activeSave={activeSave} realSaves={realSaves.length ? realSaves : ((window.RPG_AUTH && window.RPG_AUTH.authed) ? [] : (window.MOCK_PLATFORM?.saves || []))}
          onSwitchSave={async (sid) => { if (activeSave && String(activeSave.id) === String(sid)) return; try { if (runRef.current.sse || runState.running) stopRun(); await window.api.saves.activate(sid); resetSessionUiState(); openingInFlightRef.current = null; await reloadState(); await reloadSaves(); } catch (e) { window.__apiToast?.(t('game.console.save.switch_failed'), { kind: 'danger', detail: e?.message }); } }}
          onNew={async () => { if (!await window.__confirm({ message: t('game.console.save.new_confirm') })) return; location.href = '/saves'; }}
        onSave={manualSave}
          reloadState={reloadState}
          activeTab={activeTab} setActiveTab={setActiveTab}
          lastUsage={lastUsage}
          tabConflictBanner={tabConflictBanner} setTabConflictBanner={setTabConflictBanner}
          onExit={() => { try { location.href = new URL('Platform.html', location.href).href; } catch (_) { location.href = 'Platform.html'; } }}
          onOpenHistory={() => setShowHistoryDrawer(true)}
          onOpenSearch={() => setShowSearchDrawer(true)}
          onOpenSettings={() => setShowInGameSettings(true)}
          onOpenFeedback={() => { try { window.__openFeedback?.(); } catch (_) {} }}
        />
        {/* 找回的模态浮层(非主 UI 本体) */}
        <GameSettingsModal open={showInGameSettings} onClose={() => setShowInGameSettings(false)} saveTitle={activeSave?.title || game?._raw?.save_title || ''} saveId={activeSave?.id ?? null} />
        <HistoryDrawer open={showHistoryDrawer} history={history} onClose={() => setShowHistoryDrawer(false)} />
        <SearchDrawer open={showSearchDrawer} history={history} state={game} onClose={() => setShowSearchDrawer(false)} />
        {/* hard config_card(model_not_configured):移动端也必须有阻塞弹窗,否则只能“忽略”。 */}
        <ModelConfigInterceptModal open={!!hardConfigItem} item={hardConfigItem} onResolve={onHardResolve} onCancel={onHardCancel} disabled={runState.running} />
        {splashNeeded && <AdultSplash splashVersion={SPLASH_VERSION} onAcked={() => setSplashNeeded(false)} />}
        {/* 移动早返同样需要 toast 渲染落点:MobileGame 全部 window.__apiToast 指向 game 通道,
            但桌面 return 的 <GameToastStack/> 早返永不到达 → 切档/保存/分支/回滚反馈静默。
            早返条件已是 mountStage>=1,直接挂(不复制桌面 mountStage>=2 守卫)。总线已 install,
            这里只补渲染器,working 总线零变化。 */}
        <GameToastStack />
        {/* 移动游戏台同样需要命令式确认/输入弹窗 Host(底抽屉),否则 onNew 新建确认 +
            game-panels 记忆/时间线 prompt/confirm 调 window.__confirm 时该全局未安装 → 报错。
            桌面 return 用 DesktopDialogHost(模态);移动早返用 MobileDialogHost(底抽屉)。 */}
        <MobileDialogHost />
        {/* 移动早返的真实文件上传 input(与桌面同 ref/handler;onAttachPick 触发)→ GM 读文本附件 */}
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onFilePicked} />
        {sseLogOpen && (
          <div className="gc-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'flex-end' }} onClick={() => setSseLogOpen(false)}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxHeight: '80vh', background: 'var(--panel,#211f1d)', color: 'var(--text)', borderRadius: '14px 14px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--line-soft)' }}>
                <strong>{t('game.console.sse_log.title', { count: sseLog.length })}</strong>
                <button className="btn ghost" onClick={() => setSseLogOpen(false)}>{t('common.close')}</button>
              </div>
              <div style={{ overflow: 'auto', padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.5 }}>
                {sseLog.length === 0 ? <div style={{ padding: '20px 0', color: 'var(--muted)' }}>{t('game.console.sse_log.empty')}</div> : sseLog.map((ev, i) => (
                  <div key={i} style={{ padding: '3px 0', borderBottom: '1px dashed var(--line-soft)' }}>
                    <span style={{ color: 'var(--accent)' }}>{ev.kind}</span> <span style={{ wordBreak: 'break-all' }}>{JSON.stringify(ev.payload)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="gc-shell" style={{ ...rootStyle, '--gc-rail-w': gcRailW + 'px' }}>
      {/* 命令式确认/输入弹窗 Host:为本独立入口提供 window.__confirm / window.__prompt
          (游戏台不经 platform-app,否则 onNew 新建确认、game-panels 记忆/时间线操作全回退原生弹窗)。 */}
      <DesktopDialogHost />
      {/* A2: 多 tab 冲突 banner */}
      {tabConflictBanner && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000,
          background: 'rgba(200,130,0,0.93)', color: '#fff',
          padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12,
          fontSize: 13, boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>
          <span style={{ flex: 1 }}>
            {t('game.console.conflict.banner_text')}
          </span>
          <button
            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.5)', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 12 }}
            onClick={() => setTabConflictBanner(null)}
          >{t('game.console.conflict.continue_btn')}</button>
          <button
            style={{ padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.5)', background: 'rgba(0,0,0,0.2)', color: '#fff', cursor: 'pointer', fontSize: 12 }}
            onClick={() => window.close()}
          >{t('game.console.conflict.close_window_btn')}</button>
        </div>
      )}
      {splashNeeded && (
        <AdultSplash splashVersion={SPLASH_VERSION} onAcked={() => setSplashNeeded(false)} />
      )}
      {mountStage >= 2 && <GameToastStack />}
      {mountStage >= 1 ? <LeftRail
        resizeHandle={<div className="gc-rail-resize-handle" title={t('game.console.resize_rail_tip')} {...gcRailDragProps} />}
        collapsed={railCollapsed}
        onToggle={() => { setRailCollapsed((c) => !c); setMobileNav(false); }}
        state={game} runState={runState}
        onNew={async () => { if (!await window.__confirm({ message: t('game.console.save.new_confirm') })) return; window.open('/saves', '_blank'); }}
        onSave={manualSave}
        onSwitchSave={async (sid) => { setMobileNav(false); if (activeSave && String(activeSave.id) === String(sid)) return; try { if (runRef.current.sse || runState.running) stopRun(); await window.api.saves.activate(sid); resetSessionUiState(); openingInFlightRef.current = null; await reloadState(); await reloadSaves(); } catch (e) { window.__apiToast?.(t('game.console.save.switch_failed'), { kind: 'danger', detail: e?.message }); } }}
        currentSaveId={activeSave?.id ?? null}
        activeSave={activeSave}
        saves={realSaves.length ? realSaves : ((window.RPG_AUTH && window.RPG_AUTH.authed) ? [] : (window.MOCK_PLATFORM?.saves || []))}
        mobileOpen={mobileNav}
      /> : <aside className="gc-rail" aria-hidden="true" />}

      <main className="gc-main">
        {mountStage >= 1 && <TopBar
          state={game}
          saveUpdatedAt={activeSave?.updated_at || ''}
          onOpenSearch={() => setShowSearchDrawer(true)}
          onOpenHistory={() => setShowHistoryDrawer(true)}
          onOpenSettings={() => setShowInGameSettings(true)}
          railCollapsed={railCollapsed}
          onExpandRail={() => setRailCollapsed(false)}
          panelCollapsed={panelCollapsed}
          onExpandPanel={() => setPanelCollapsed(false)}
          onOpenNav={() => setMobileNav(true)}
          versionSelectEl={
            (game?.app?.script_id || game?.content_pack?.script_id)
              ? <ScriptVersionSelect
                  scriptId={game.app?.script_id || game.content_pack?.script_id}
                  headCommitId={game.app?.head_commit_id || null}
                />
              : null
          }
        />}
        {mountStage >= 2 && <>
          <GameSettingsModal open={showInGameSettings} onClose={() => setShowInGameSettings(false)} saveTitle={activeSave?.title || game?._raw?.save_title || ''} saveId={activeSave?.id ?? null} />
          <HistoryDrawer open={showHistoryDrawer} history={history} onClose={() => setShowHistoryDrawer(false)} />
          <SearchDrawer open={showSearchDrawer} history={history} state={game} onClose={() => setShowSearchDrawer(false)} />
        </>}
        {/* config_card hard 拦截弹窗(mode model_not_configured):ConfirmStrip onHardConfig 触发 */}
        <ModelConfigInterceptModal open={!!hardConfigItem} item={hardConfigItem} onResolve={onHardResolve} onCancel={onHardCancel} disabled={runState.running} />
        {/* GM 模型选择走 Composer 内置 ModelPopover(下拉,基于统一规范组件 AgentModelPicker)。
            旧的全屏 ModelPicker modal(dead code)已删除。 */}
        {/* narrativeFont 不再下传(2026-10-15):ChatArea 不再内联 --narrative-font,
            GM 字体统一由 <html> 上的变量驱动(游戏内设置弹窗可实时切换)。 */}
        {mountStage >= 1 ? <ChatArea
          history={
            // G6: 存档已加载但 player 还未 setup,显示"等待开场..."占位而非空白
            (stateLoadedNoPlayer && history.length === 0)
              ? [{ role: 'assistant', content: t('game.console.opening.waiting'), _opening: true, _thinking: 'starting' }]
              : history
          } runState={runState}
          narrativeSize={tweaks.narrativeSize}
          hasError={hasError}
          saveId={(activeSave && activeSave.id) || (game && game._raw && game._raw.save_id) || null}
          onRetry={onRetry} onShowSse={onShowSse}
          memory={(game && game.memory) || null}
          hideFork={!!(game && game._raw && game._raw.isTavern)}
        /> : (
          retryFailed ? (
            <div className="gc-chat" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <div style={{ textAlign: 'center', color: 'var(--muted)', lineHeight: 2 }}>
                <div style={{ marginBottom: 8 }}>{t('game.console.load.failed_msg')}</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn ghost" onClick={() => { setRetryFailed(false); reloadState().then(ok => { if (!ok) setRetryFailed(true); }); reloadSaves(); }}>{t('game.console.load.retry_btn')}</button>
                  <button className="btn ghost" onClick={() => { location.href = '/saves'; }}>{t('game.console.load.back_to_saves_btn')}</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="gc-chat" aria-busy="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--muted)' }}>
              <span style={{ marginRight: 6 }}>⏳</span>{t('game.console.load.initializing')}
            </div>
          )
        )}
        <div className="gc-foot-wrap">
          {rewriteAlt && (() => {
            // 候选定位/裁决逻辑与移动端共用(acceptanceTarget / chooseAcceptance)。
            const { idx, original } = acceptanceTarget(rewriteAlt, history);
            // 目标已不存在(分支切换/回退/编辑后 history 被换)→ 不渲染。
            if (idx < 0 || !history[idx] || history[idx].role !== 'assistant') return null;
            return (
              <AcceptanceAbPanel
                alt={rewriteAlt} original={original} busy={abBusy || runState.running}
                onChoose={(choice) => chooseAcceptance(idx, choice)} onDismiss={() => setRewriteAlt(null)}
              />
            );
          })()}
          <ConfirmStrip pendingWrites={pendingWrites} pendingQuestions={pendingQuestions} onApprove={onApprove} onReject={onReject} onAnswer={onAnswerQuestion} onDismiss={onDismissConfirm}
            clicheNotice={clicheNotice} running={runState.running}
            onRetryCliche={() => { setClicheNotice(null); onRetry(); }}
            onDismissCliche={() => setClicheNotice(null)}
            onConfigDefault={onConfigDefault} onConfigContinue={onConfigContinue} onHardConfig={onHardConfig} onConfigSettings={onConfigSettings} />
          <Composer
            text={text} setText={setText} onSend={onSend} onStop={onStop} running={runState.running}
            onSendRaw={onSendRaw} permission={permission} setPermission={changePermission}
            model={model} setModel={setModel} composerMode={tweaks.composerMode}
            suggestions={game.suggestions} gameState={game}
            attachments={attachments} removeAttachment={(i) => setAttachments((a) => a.filter((_, j) => j !== i))}
            onAttachPick={onAttachPick} onSlashPick={onSlashPick}
            pickedCommand={pickedCommand} onClearCommand={() => setPickedCommand(null)}
            showSlash={showSlash} showPlus={showPlus} showModel={showModel} showPerm={showPerm}
            toggleSlash={() => { setShowSlash((s) => !s); setShowPlus(false); setShowModel(false); setShowPerm(false); }}
            togglePlus={() => { setShowPlus((s) => !s); setShowSlash(false); setShowModel(false); setShowPerm(false); }}
            toggleModel={() => { setShowModel((s) => !s); setShowSlash(false); setShowPlus(false); setShowPerm(false); }}
            togglePerm={() => { setShowPerm((s) => !s); setShowSlash(false); setShowPlus(false); setShowModel(false); }}
            saveId={(activeSave && activeSave.id) || (game && game._raw && game._raw.save_id) || null}
            imageGenKind="game"
            /* 「附加 / 工具」按钮已隐藏(2026-10):图片附件在文本管线下不被识别(仅记占位),
               按钮留着只会产生无效附件。恢复 = 删掉本行 hideAttach(Composer 组件开关保留)。 */
            hideAttach={true}
          />
          {/* 真实文件上传(file/image/card 共用;onAttachPick 触发)→ GM 可读文本附件内容 */}
          <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={onFilePicked} />
          {showUsage && lastUsage && (
            <div className="gc-usage-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', alignItems: 'center', padding: '3px 12px 4px', fontSize: 11, lineHeight: 1.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, ui-monospace, Menlo, monospace)' }}>
              <span title={t('game.console.usage.input_tip')}>↑ {Number(lastUsage.input_tokens || 0).toLocaleString()}{lastUsage.cached_input_tokens ? ` · ${t('game.console.usage.cached')} ${Number(lastUsage.cached_input_tokens).toLocaleString()}` : ''}</span>
              <span title={t('game.console.usage.output_tip')}>↓ {Number(lastUsage.output_tokens || 0).toLocaleString()}{lastUsage.reasoning_tokens ? ` · ${t('game.console.usage.thinking')} ${Number(lastUsage.reasoning_tokens).toLocaleString()}` : ''}</span>
              {lastUsage.context_max ? <span title={t('game.console.usage.context_tip')}>{t('game.console.usage.context')} {Number(lastUsage.context_used || 0).toLocaleString()}/{Number(lastUsage.context_max).toLocaleString()} · {Math.round(lastUsage.context_pct || 0)}%</span> : null}
              {lastUsage.cost_usd ? <span title={t('game.console.usage.cost_tip')}>${Number(lastUsage.cost_usd).toFixed(4)}</span> : null}
              {lastUsage.model ? <span style={{ opacity: 0.6 }}>{lastUsage.model}</span> : null}
            </div>
          )}
        </div>
      </main>

      {sseLogOpen && (
        <div className="gc-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setSseLogOpen(false)}>
          {/* 注意:面板颜色必须用 tokens.css 真实令牌(--panel 等)。此前写错为不存在的
              --surface,var() 永远落到暗色兜底值 → 弹框在任何主题下都是深色。 */}
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(860px, 92vw)', maxHeight: '82vh', background: 'var(--panel)', color: 'var(--text)', borderRadius: 8, border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
              <strong>{t('game.console.sse_log.title_detailed', { count: sseLog.length })}</strong>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(sseLog, null, 2)); window.__apiToast?.(t('game.console.sse_log.copied'), { kind: 'ok', duration: 1500 }); } catch { window.__apiToast?.(t('game.console.sse_log.copy_failed'), { kind: 'danger' }); } }}>{t('game.console.sse_log.copy_json_btn')}</button>
                <button className="btn ghost" onClick={() => setSseLogOpen(false)}>{t('common.close')}</button>
              </div>
            </div>
            <div style={{ overflow: 'auto', padding: '8px 16px', fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', fontSize: 12, lineHeight: 1.5 }}>
              {sseLog.length === 0 && <div style={{ padding: '24px 0', color: 'var(--muted)' }}>{t('game.console.sse_log.empty_detailed')}</div>}
              {sseLog.map((ev, i) => (
                <div key={i} style={{ padding: '4px 0', borderBottom: '1px dashed var(--line-soft)' }}>
                  <span style={{ color: 'var(--muted-2)' }}>[{new Date(ev.t).toISOString().slice(11, 23)}]</span>{' '}
                  <span style={{ color: 'var(--accent)' }}>{ev.kind}</span>{' '}
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(ev.payload)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 移动端抽屉 backdrop：面板展开时显示，点击关闭面板 */}
      {mobileNav && (
        <div className="gc-nav-backdrop" onClick={() => setMobileNav(false)} aria-hidden="true" />
      )}
      {mountStage >= 2 && !panelCollapsed && (
        <div className="gc-panel-backdrop" onClick={() => setPanelCollapsed(true)} aria-hidden="true" />
      )}
      {mountStage >= 2 && <RightPanel state={game} activeTab={activeTab} setActiveTab={setActiveTab} sidebarWidth={gcPanelW} density={tweaks.density} running={runState.running} collapsed={panelCollapsed} onToggle={() => setPanelCollapsed((c) => !c)} resizeHandle={<div className="gp-panel-resize-handle" title={t('game.console.resize_panel_tip')} {...gcPanelDragProps} />} />}
      <button className="gc-float-panel-btn" onClick={() => { setPanelCollapsed(false); _panelResize.setSize(320); }} title={t('game.console.open_panel_tip')}>⌖</button>
    </div>
  );
}

const __mount = () => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <ErrorBoundary>
      <App />
      {/* 反馈抽屉根节点 — 监听 window.__openFeedback 全局事件,
          游戏控制台的顶栏按钮 + Game console-assistant-navigation 都能触发 */}
      <FeedbackDrawerRoot />
      {/* 全局后台任务浮窗(导入 / 重建 / 生图,有活跃任务才显示) */}
      <GlobalTaskFloater />
    </ErrorBoundary>
  );
  // 通知 HTML splash 淡出 + 移除节点(交给 CSS transition + setTimeout)
  try {
    document.body.classList.add('rpg-mounted');
    setTimeout(() => {
      const sp = document.getElementById('rpg-game-splash');
      if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
    }, 300);
  } catch (_) {}
};
const __gateThenMount = (info) => {
  const offline = new URLSearchParams(location.search).has('offline');
  if (info && info.online && !info.authed && !offline) {
    const next = encodeURIComponent(location.pathname + location.search + location.hash);
    location.replace('Login.html?next=' + next);
    return;
  }
  __mount();
};
if (window.RPG_DATA_READY) {
  window.RPG_DATA_READY.then(__gateThenMount);
} else {
  __mount();
}
