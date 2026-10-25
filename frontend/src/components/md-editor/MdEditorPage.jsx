// MdEditorPage.jsx — 三栏 IDE 页面壳 + 状态编排(从 pages/md-editor.jsx 机械搬出,逐字节不变)。
// 历史病灶(agent 写库 vs 未保存改动互覆盖 / autosave 竞态)相关 handler 原样保留:
//   openConflictMerge / saveTab / refreshTab / proposeChapterDiff / autosave effect。
import React from 'react';
import { useTranslation } from 'react-i18next';
import { lsGet, lsSet, lsGetJSON, lsRemove } from '../../lib/storage.js';
import { undo, redo, selectAll } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import { toMd, frontMatterEndOf } from '../../lib/md-serialize.js';
import { runContinue, hasPendingContinue, pendingCancelEffect, rejectPending, pendingLocalText } from '../../lib/md-continue.js';
import { copyText } from '../../lib/clipboard.js';
import { showChapterDiff, hasChapterDiff, chapterDiffCancelEffect, discardAgentChapterDiff, chapterDiffLocalText, chapterDiffReviewKind } from '../../lib/md-diff.js';
import MdEditorAgent from '../MdEditorAgent.jsx';
import EditorKbPanel, { useKbHealthBadge } from '../EditorKbPanel.jsx';
import { usePlaytest } from '../EditorPlaytest.jsx';
import { IS_MAC, api, toast, nodeKey, stripChapterPrefix } from './helpers.js';
import { ContextMenu } from './ContextMenu.jsx';
import { TbIcon } from './TbIcon.jsx';
import { FileTree } from './FileTree.jsx';
import { EditorPane } from './EditorPane.jsx';
import { QuickOpen } from './QuickOpen.jsx';
import { GlobalSearch } from './GlobalSearch.jsx';
import { ChapterHistory } from './ChapterHistory.jsx';
import { WritingRules } from './WritingRules.jsx';
import { ProblemsPanel } from './ProblemsPanel.jsx';
import { loadNodeContentMeta, saveNodeContent, conflictServer, serverBase } from './node-io.js';
import { ensureEditorStorageOwner, getWindowId, editorStorageKeys, clearEditorStorage, setEditorStorageOwner } from './editor-storage.js';
import { writeDrafts } from './draft-store.js';
const { useState, useEffect, useCallback, useRef, useMemo } = React;

// 章节身份冲突判定:新后端直接给 structure_changed;老后端没有该字段时用标签保存的
// 稳定 chapterId 与 409 快照的 id 比对兜底。命中后绝不能走内容三方合并/force-save ——
// 当前 chapter_index 已经指向另一章,合并会把旧章正文写进新章。
function chapterStructureChanged(err, tab, server) {
  if (err && err.payload && err.payload.structure_changed) return true;
  if (!tab || tab.kind !== 'chapter') return false;
  if (tab.chapterId == null || !server || server.id == null) return false;
  return String(tab.chapterId) !== String(server.id);
}

// ── 主页面 ───────────────────────────────────────────────────────────
export default function MdEditorPage() {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState(null);
  // lsGet 返回裸字符串;剧本 id 是整数 → 必须 Number 化,否则 `s.id === scriptId`(数===串)恒不等 → 刷新后工作区显示「未选择」。
  const [scriptId, setScriptId] = useState(() => { const v = lsGet('mde.scriptId', null); return (v == null || v === '') ? null : (Number(v) || v); });
  // 每个 tab 一个窗口 id(sessionStorage,刷新不变、不同窗口不同)。草稿/标签缓存
  // 都带这个后缀,避免两个窗口整键覆盖对方的未保存内容。旧版无后缀的键在恢复时
  // 一次性迁移到当前窗口。
  const windowIdRef = useRef(null);
  if (windowIdRef.current == null) {
    windowIdRef.current = getWindowId(typeof window !== 'undefined' ? window.sessionStorage : null);
  }
  const storageKeys = useCallback((sid) => editorStorageKeys(sid, windowIdRef.current), []);
  const [tabs, setTabs] = useState([]);          // [{key, kind, id, label, content, original, loading, error, dirty}]
  const [activeKey, setActiveKey] = useState(null);
  const [treeReloadKey, setTreeReloadKey] = useState(0);   // agent 写库后 bump,触发文件树重载
  const activeViewRef = useRef(null);                      // 当前 CodeMirror 视图(供侧栏「续写到正文」)
  const agentRef = useRef(null);                           // MdEditorAgent 命令句柄(续写后同步桥接)
  const activeRef = useRef(null);                          // 当前标签(在接受续写的回调里读最新 label)
  const tabsRef = useRef([]);                              // 标签列表镜像(openNode 里避免用过期闭包重复加载)
  tabsRef.current = tabs;
  const saveTabRef = useRef(null);                         // saveTab 的命令句柄(供先定义 openNode 调用)
  const refreshTabRef = useRef(null);                      // refreshTab 句柄(让 onTreeMutate 保持稳定,FileTree 才能 memo)
  const switchingRef = useRef(false);                      // 切剧本前保存期间冻结标签操作,避免边存边改
  const inflightSavesRef = useRef(new Map());              // key -> Promise:自动保存/手动保存的在途请求
  const structureMutatingRef = useRef(false);              // 文件树删除/章节重排进行中:冻结保存与切换
  const scriptIdRef = useRef(scriptId);                    // 异步回调用:结果回来时确认仍是同一个剧本
  scriptIdRef.current = scriptId;
  const setStructureMutating = useCallback((v) => { structureMutatingRef.current = !!v; }, []);
  // 每个标签的加载序号:打开标签 / 外部刷新可能并发,晚发出的请求先返回时不能让旧结果覆盖新内容。
  const loadSeqRef = useRef(new Map());
  const nextLoadSeq = useCallback((key) => {
    const n = (loadSeqRef.current.get(key) || 0) + 1;
    loadSeqRef.current.set(key, n);
    return n;
  }, []);
  // 未保存草稿落 localStorage:平台内部路由切换(SPA)不会触发 beforeunload,组件
  // 卸载时也没法 await 异步保存。把 dirty 标签(含正文/基线)写到 mde.drafts.<sid>,
  // 重新进入编辑器时恢复成 dirty 标签,避免「改完立刻切页面」静默丢内容。
  // 存正文可能较大;写失败(配额/隐私模式)静默忽略,不能影响编辑主流程。
  // draftsRestoredRef:该剧本的本地恢复流程是否已经跑过。没跑过时绝不能持久化/清理
  // ——否则启动阶段「账号校验/剧本列表/草稿恢复」还没完成,空 tabs 会把尚未恢复的
  // 草稿键直接删掉(尤其是 500ms 防抖和 beforeunload 两条路径)。
  const draftsRestoredRef = useRef(new Set());
  const draftWarnedRef = useRef(false);   // 配额/超限只警告一次,避免每次 500ms 都弹
  const persistDraftsNow = useCallback((sid, list) => {
    if (!sid || !draftsRestoredRef.current.has(sid)) return;
    try {
      const drafts = [];
      for (const t of (list || [])) {
        if (!t) continue;
        const live = activeRef.current?.key === t.key ? activeViewRef.current : null;
        let content = live ? live.state.doc.toString() : t.content;
        let review = null;
        let conflict = !!t.conflict;
        if (live) {
          // 审阅期间文档已经被整篇替换成 AI/服务端文本,当前 doc 不能当草稿:
          // 刷新后 diff 状态消失,自动保存会把未批准的 AI 文本落库。这里改存
          // 「本地侧」原文(oldText),并把草稿标记为需审阅(恢复后 conflict=true
          // 会阻止自动保存,等用户重新打开合并/确认)。
          const diffLocal = chapterDiffLocalText(live);
          if (diffLocal != null) {
            content = diffLocal;
            review = chapterDiffReviewKind(live) === 'conflict' ? 'conflict' : 'agent_diff';
            conflict = true;
          } else {
            // 续写/改写待定区同理:用 [from,to) 反推出 AI 介入前的本地文本。
            const contLocal = pendingLocalText(live);
            if (contLocal != null) {
              content = contLocal;
              review = 'continue';
              conflict = true;
            }
          }
        }
        // 审阅态即使 tab 当前不是 dirty(例如 diff 把文档换成了与 original 相同的
        // 服务端版本)也必须存:本地侧原文只在这里能保住。
        if (!t.dirty && !review) continue;
        drafts.push({
          key: t.key, kind: t.kind, id: t.id, label: t.label,
          // 活动标签优先取实时 CodeMirror 文档:state 可能还没来得及回填最后一笔。
          content,
          original: t.original,
          baseUpdatedAt: t.baseUpdatedAt ?? null,
          baseVersion: t.baseVersion ?? null,
          chapterId: t.chapterId ?? null,
          review,
          conflict,
        });
      }
      // 显式检查写入结果:配额满/隐私模式/单次载荷过大时草稿其实没落盘。
      // 静默失败会让用户以为已缓存,随后 SPA 离开/关页就丢内容 —— 这里至少给出
      // 一次强警告,提示立即保存。载荷超限时保留上一次成功草稿,不主动删除。
      const res = writeDrafts(window.localStorage, storageKeys(sid).drafts, drafts);
      if (!res.ok && !draftWarnedRef.current) {
        draftWarnedRef.current = true;
        toast(t(res.reason === 'too_large'
          ? 'md_editor.toast.draft_cache_too_large'
          : 'md_editor.toast.draft_cache_failed', {
          defaultValue: res.reason === 'too_large'
            ? '未保存内容过大,本地草稿缓存已跳过。请立即保存;离开页面可能丢失这些改动。'
            : '本地草稿缓存失败(存储空间不足或隐私模式)。请立即保存;离开页面可能丢失未保存内容。',
        }), { kind: 'danger', duration: 7000 });
      } else if (res.ok) {
        draftWarnedRef.current = false;
      }
    } catch (_) { /* 草稿持久化失败不影响编辑 */ }
  }, [t, storageKeys]);
  // 关闭/刷新页面前有 dirty 标签 → 浏览器原生离开确认 + 同步写一份草稿。
  useEffect(() => {
    const onBeforeUnload = (e) => {
      // 无论是否 dirty 都写一次:没有 dirty 时 persistDraftsNow 会删掉旧草稿。
      // 否则「刚保存完 500ms 内关闭页面」会把上一轮草稿留到下次打开,恢复出
      // 内容已落库、但基线还是旧的「假 dirty」标签。
      try { persistDraftsNow(scriptIdRef.current, tabsRef.current); } catch (_) {}
      if (tabsRef.current.some((t) => t.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [persistDraftsNow]);
  // 平时 500ms 防抖写一次草稿(避免每个键都同步写 localStorage);真正的兜底是
  // 组件卸载 cleanup 和 beforeunload 的同步写。
  useEffect(() => {
    if (!scriptId) return undefined;
    const id = setTimeout(() => persistDraftsNow(scriptId, tabsRef.current), 500);
    return () => clearTimeout(id);
  }, [tabs, activeKey, scriptId, persistDraftsNow]);
  // 组件卸载(SPA 路由离开)时同步写草稿。切剧本时 scriptIdRef 已是新值,跳过 ——
  // 旧剧本的标签已由 flushBeforeSwitch 落库,不能把新剧本标签写到旧 key。
  useEffect(() => {
    const sid = scriptId;
    return () => {
      if (sid && scriptIdRef.current === sid) persistDraftsNow(sid, tabsRef.current);
    };
  }, [scriptId, persistDraftsNow]);
  const [syncNudge, setSyncNudge] = useState(null);        // 接受续写后提示同步:{text, label, rewrite} | null
  const [selLen, setSelLen] = useState(0);                 // 正文当前选中字数(右栏「选区改写」+ 选区上下文芯片)
  const [cursor, setCursor] = useState({ line: 1, col: 1, total: 0 });   // 底部状态栏:光标行:列 + 总字数
  const [leftHidden, setLeftHidden] = useState(false);     // 左侧文件树折叠(Mod+B,VSCode 风)
  const [quickOpen, setQuickOpen] = useState(false);       // Mod+P 快速打开
  const [searchOpen, setSearchOpen] = useState(false);     // Mod+Shift+F 全书检索
  const [historyFor, setHistoryFor] = useState(null);      // 章节版本历史(chapter_index | null)
  const [rulesOpen, setRulesOpen] = useState(false);       // 写作规范(.cursorrules)编辑弹窗
  const [kbOpen, setKbOpen] = useState(false);             // 知识库中心抽屉(P1:治理能力接进 IDE)
  const kbBadge = useKbHealthBadge(scriptId);              // 顶栏徽标:{stale_count, ready} | null
  const { playtest, busy: playtestBusy } = usePlaytest(scriptId);   // P1:写完即试玩
  const [issuesOpen, setIssuesOpen] = useState(false);     // 审稿问题面板(VSCode Problems 风)
  const [issueCount, setIssueCount] = useState(0);         // 顶栏「问题」徽标计数
  const [issuesReloadKey, setIssuesReloadKey] = useState(0); // 编辑器 agent 汇报问题后 bump → 重载
  const [autoComplete, setAutoComplete] = useState(() => lsGet('mde.autocomplete', '0') === '1');  // 内联续写(Copilot ghost)开关,默认关(BYO 计费)
  // 快捷键文案 OS 自适应:mac 显示 ⌘Z,Windows/Linux 显示 Ctrl+Z(旧菜单把 ⌘ 硬编码,Windows 误导)。
  const kbd = (key, shift = false) => (IS_MAC ? `⌘${shift ? '⇧' : ''}${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`);
  // 选区/光标上报(对象):右栏要 selLen(数字),状态栏要 line/col/total。
  const onSel = useCallback((info) => {
    if (info && typeof info === 'object') {
      setSelLen(info.len || 0);
      setCursor({ line: info.line || 1, col: info.col || 1, total: info.total || 0 });
    } else { setSelLen(info || 0); }
  }, []);
  // 读当前编辑器选区 + 上下文(供右栏 agent 把选中正文作为上下文)。在发送时实时读,保证拿到最新选区。
  const getSelectionContext = useCallback(() => {
    const v = activeViewRef.current;
    if (!v) return null;
    const sel = v.state.selection.main;
    if (sel.empty) return null;
    const doc = v.state.doc;
    return {
      selection: doc.sliceString(sel.from, sel.to),
      before: doc.sliceString(Math.max(0, sel.from - 1200), sel.from),
      after: doc.sliceString(sel.to, Math.min(doc.length, sel.to + 600)),
    };
  }, []);

  // 本地缓存归属守卫:editor-storage 会在账号变化时清空 mde.*,避免上一个账号的
  // 未保存草稿/标签在当前账号下被恢复。identityReady 之前不读脚本、不恢复标签。
  const [identityReady, setIdentityReady] = useState(false);
  // 身份是否真的验证成功(auth.me 返回了用户 id)。验证失败时仍允许打开编辑器,
  // 但不恢复本地草稿/标签 —— 否则共享浏览器上可能把上一个账号的草稿读进来。
  const [identityVerified, setIdentityVerified] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let uid = null;
      try {
        const r = await api().auth.me();
        uid = r?.user?.id ?? r?.id ?? null;
      } catch (_) { uid = null; }
      if (cancelled) return;
      let changed = false;
      let unowned = false;
      try {
        const res = ensureEditorStorageOwner(window.localStorage, uid);
        changed = !!res.changed;
        unowned = !!res.unowned;
      } catch (_) { changed = false; unowned = false; }
      if (unowned) {
        // 升级前的 mde.* 没有账号归属标记:无法确定是不是当前账号的草稿。
        // 让用户确认;默认(取消/宿主没有确认框)按隐私优先清理。只有用户明确
        // 选择“保留”才认领给当前账号,避免共享浏览器把上一个账号的草稿读进来。
        let keep = false;
        try {
          if (window.__confirm) {
            keep = await window.__confirm({
              title: t('md_editor.confirm.legacy_cache_title', { defaultValue: '检测到旧版本地缓存' }),
              message: t('md_editor.confirm.legacy_cache_msg', {
                defaultValue: '本地有未标记账号的编辑器草稿/标签。只有确认它们属于当前账号才点“保留”;取消将清理这些缓存(正文不受影响)。',
              }),
              confirmText: t('md_editor.confirm.legacy_cache_keep', { defaultValue: '保留(我的)' }),
            });
          } else if (typeof window.confirm === 'function') {
            keep = window.confirm(t('md_editor.confirm.legacy_cache_plain', {
              defaultValue: '检测到旧版本地编辑器缓存。确定保留?(取消 = 清理,正文不受影响)',
            }));
          }
        } catch (_) { keep = false; }
        if (cancelled) return;
        try {
          if (keep) setEditorStorageOwner(window.localStorage, uid);
          else clearEditorStorage(window.localStorage);
        } catch (_) { /* 存储不可用:保持现状 */ }
        if (!keep) {
          try { lsRemove('mde.scriptId'); } catch (_) {}
          setScriptId(null);
          setTabs([]);
          setActiveKey(null);
          setSyncNudge(null);
          toast(t('md_editor.toast.legacy_cache_cleared', {
            defaultValue: '已清理无账号归属的旧版本地缓存;正文/历史版本不受影响。',
          }), { kind: 'warn', duration: 5200 });
        }
      }
      if (changed) {
        // 账号已切换:旧 scriptId 指向别的用户的剧本,标签/草稿也属于旧账号。
        // 这里与 identityReady 同批复位,列表 effect 随后会选第一个可编辑剧本。
        try { lsRemove('mde.scriptId'); } catch (_) {}
        setScriptId(null);
        setTabs([]);
        setActiveKey(null);
        setSyncNudge(null);
        toast(t('md_editor.toast.local_state_owner_changed', {
          defaultValue: '检测到登录账号变化,已清理上一账号的本地标签与未保存草稿。',
        }), { kind: 'warn', duration: 4600 });
      }
      setIdentityVerified(uid != null);
      setIdentityReady(true);
    })();
    return () => { cancelled = true; };
  }, [t]);

  // 拉剧本列表(仅自己拥有的可编辑)。
  useEffect(() => {
    if (!identityReady) return;   // 先确认账号归属,避免拿旧 scriptId 恢复/展示别人的草稿
    (async () => {
      try {
        const r = await api().scripts.list();
        const arr = r?.items || r?.scripts || (Array.isArray(r) ? r : []);
        const owned = arr.filter((s) => s.is_owner !== false && s.role !== 'subscriber');
        setScripts(owned);
        // localStorage 里的 mde.scriptId 可能已被删除/取消共享/不再拥有:继续用它会让
        // 文件树和标签全部 4xx,工作区标题也显示「未选择」。回退到第一个可编辑剧本。
        const valid = owned.some((s) => String(s.id) === String(scriptId));
        if (!valid) {
          const next = owned[0]?.id ?? null;
          // 必须与 setScriptId 同批清空标签:否则旧剧本的标签会继续渲染在新 scriptId 下,
          // 并被「标签缓存」effect 写进新剧本的 mde.tabs.<id>(跨剧本状态污染)。
          setTabs([]);
          setActiveKey(null);
          setSyncNudge(null);
          setScriptId(next);
          lsSet('mde.scriptId', next);
        }
      } catch (e) { setScripts([]); toast(t('md_editor.toast.scripts_load_failed'), { kind: 'danger', detail: e?.message }); }
    })();
    // eslint-disable-next-line
  }, [identityReady]);

  // 切标签/切剧本前的统一守卫:编辑器只有一个 CodeMirror 视图,AI 待定区/内联 diff 都挂在这个
  // 视图的 EditorState 上。直接换文档会把它们带到新文档(续写 token 插进新章、拒绝 diff 写回旧章),
  // 所以正常切换必须先让用户处理完。
  const guardLiveAiState = useCallback(() => {
    if (switchingRef.current) return false;   // 切剧本前的保存进行中:先等保存结束
    if (structureMutatingRef.current) {       // 删章/重排等结构操作进行中:先等它完成
      toast(t('md_editor.toast.structure_busy'), { kind: 'warn', duration: 2200 });
      return false;
    }
    const v = activeViewRef.current;
    if (!v) return true;
    if (hasChapterDiff(v) || hasPendingContinue(v)) {
      toast(t('md_editor.toast.pending_ai_resolve'), { kind: 'warn', duration: 3200 });
      return false;
    }
    return true;
  }, [t]);

  // 强制切换(切剧本/删除剧本/结构变化关闭标签)前的确定性清理:中止续写流、清空待定区。
  // rejectAgentDiff=true 时才回调 agent diff 的 onReject(会发一次 /confirm SSE):
  //   · 同一剧本内(删标签/章节重切)需要它把后端待确认的提议收尾;
  //   · 切剧本时不能发 —— 旧对话的 SSE 回来可能污染新剧本的助手会话,只清本地状态即可。
  // conflict diff 永远只清状态,绝不替用户 force-save 本地版本。
  // 不还原待定区原文 —— 调用方马上就会整篇替换或直接卸载这个标签。
  const discardActiveAiState = useCallback(({ rejectAgentDiff = false } = {}) => {
    const v = activeViewRef.current;
    if (!v) return false;
    const effects = [];
    const pe = pendingCancelEffect(v);
    if (pe) effects.push(pe);
    const de = chapterDiffCancelEffect(v, { reject: rejectAgentDiff });
    if (de) effects.push(de);
    if (!effects.length) return false;
    try { v.dispatch({ effects }); } catch (_) { return false; }
    toast(t('md_editor.toast.ai_state_discarded'), { kind: 'warn', duration: 3200 });
    return true;
  }, [t]);

  // 切换/新建/删除 AI 对话时调用:放弃一份未处理的 agent 内联 diff 时,必须把
  // 编辑器文档还原成 diff 前的 oldText —— 此时后端待确认项还没执行,若只清装饰,
  // AI 文本会留在文档里并在 2.5s 后被自动保存成普通编辑。不自动 reject:旧对话的
  // 待确认项保留,切回去时仍能从历史恢复确认卡由用户决定。
  const discardEditorAiStateForConversation = useCallback(() => {
    const v = activeViewRef.current;
    if (v && hasChapterDiff(v)) {
      // agent 提议:本地回滚 + 清状态(不自动 reject,旧对话待确认仍可恢复)。
      // conflict diff:与 AI 对话无关,保留给用户处理,切对话不能把它清掉。
      discardAgentChapterDiff(v);
      return;
    }
    discardActiveAiState();
  }, [discardActiveAiState]);

  // 切剧本前把当前剧本的未保存标签落库。编辑器自动保存有 2.5s 窗口,用户改完立刻切工作区会丢改动。
  // 逐条保存;遇到 409/网络错误、或保存期间内容又发生了变化,就中止切换并保留当前剧本。
  const flushDirtyTabs = useCallback(async () => {
    const sid = scriptId;
    if (scriptIdRef.current !== sid) return false;   // 旧剧本的过期回调
    const dirty = tabsRef.current.filter((x) => x.dirty);
    if (!dirty.length) return true;
    toast(t('md_editor.toast.saving_before_switch', { count: dirty.length }), { kind: 'info', duration: 1600 });
    const saved = new Map();   // key -> {content, updatedAt, version}
    // 标记已保存的标签:除了 React state,还要看活动标签的实时 CodeMirror 文档 ——
    // 用户最后一笔输入可能还没回填到 state,不能把它连同标签一起标成已保存。
    const applySaved = () => setTabs((cur) => cur.map((x) => {
      const s = saved.get(x.key);
      if (!s) return x;
      const view = activeRef.current?.key === x.key ? activeViewRef.current : null;
      const viewChanged = !!(view && view.state.doc.toString() !== s.content);
      return {
        ...x,
        original: s.content,
        dirty: viewChanged || x.content !== s.content,
        saving: false,
        conflict: false,
        baseUpdatedAt: s.updatedAt || x.baseUpdatedAt,
        // 角色卡的版本基数是 row_version:保存/冲突合并后必须同步推进,否则下一次保存恒 409。
        baseVersion: s.version != null ? s.version : x.baseVersion,
      };
    }));
    for (const tab of dirty) {
      // 同一标签可能正好有一次自动保存/手动保存在途:等它落地再判断,
      // 避免旧快照后到、把刚写的新内容覆盖掉(所有实体现在都有乐观锁,旧基线会直接 409)。
      const inflight = inflightSavesRef.current.get(`${sid}:${tab.key}`);
      if (inflight) { try { await inflight; } catch (_) {} }
      if (scriptIdRef.current !== sid) return false;   // 期间已切剧本:旧标签的结果不能再写回
      const latest = tabsRef.current.find((x) => x.key === tab.key);
      if (!latest || !latest.dirty) continue;
      try {
        const res = await saveNodeContent(latest.kind, sid, latest.id, latest.content, latest.original, latest.baseUpdatedAt, latest.baseVersion, latest.chapterId);
        saved.set(latest.key, {
          content: latest.content,
          updatedAt: (res && res.updatedAt) || latest.baseUpdatedAt,
          version: res && res.version != null ? res.version : latest.baseVersion,
        });
      } catch (e) {
        // 自动保存可能刚好在同一内容上赢了竞态:服务端已有同一版本 → 视为成功。
        // 所有实体都按各自 kind 反序列化服务端快照比较;章节/世界书/锚点/canon/角色卡统一走这里。
        if (e && e.status === 409 && e.payload && e.payload.conflict) {
          const server = conflictServer(e, latest.kind);
          // 身份冲突优先:index 已指向另一章。既不能按内容相等视为成功,也不能合并。
          if (chapterStructureChanged(e, latest, server)) {
            applySaved();
            toast(t('md_editor.toast.chapter_structure_changed_switch', {
              defaultValue: '章节结构已变化:当前标签对应的章节已被重排/删除。已中止切换,请关闭该标签后从文件树重新打开。',
            }), { kind: 'danger', duration: 5600 });
            return false;
          }
          if (server && toMd(latest.kind, server) === latest.content) {
            const base = serverBase(latest.kind, server);
            saved.set(latest.key, {
              content: latest.content,
              updatedAt: base.updatedAt || latest.baseUpdatedAt,
              version: base.version != null ? base.version : latest.baseVersion,
            });
            continue;
          }
          applySaved();
          toast(t('md_editor.toast.switch_blocked_conflict'), { kind: 'warn', duration: 3600 });
          return false;
        }
        applySaved();
        toast(t('md_editor.toast.save_failed'), { kind: 'danger', detail: e?.message });
        return false;
      }
    }
    // 保存期间用户可能又改了内容、切到别的标签继续写、甚至开了新标签:有任何未保存/内容变化就中止。
    if (scriptIdRef.current !== sid) return false;
    const unsavedDirty = tabsRef.current.filter((x) => x.dirty && !saved.has(x.key));
    const changedSaved = Array.from(saved.entries()).some(([key, s]) => {
      const cur = tabsRef.current.find((x) => x.key === key);
      if (!cur) return false;                       // 标签已被关闭:无需再管
      if (cur.content !== s.content) return true;
      if (key === activeRef.current?.key && activeViewRef.current) {
        return activeViewRef.current.state.doc.toString() !== s.content;
      }
      return false;
    });
    if (unsavedDirty.length || changedSaved) {
      applySaved();                                 // 已成功保存的仍然更新基线;有新输入的保持 dirty
      toast(t('md_editor.toast.switch_blocked_changed'), { kind: 'warn', duration: 3200 });
      return false;
    }
    applySaved();
    return true;
  }, [scriptId, t]);

  // 保存期间冻结标签切换/关闭/新建:避免"边保存边改"导致最后几笔又被写丢。
  const flushBeforeSwitch = useCallback(async () => {
    if (switchingRef.current) return false;
    if (!tabsRef.current.some((x) => x.dirty)) return true;
    switchingRef.current = true;
    try {
      return await flushDirtyTabs();
    } catch (e) {
      toast(t('md_editor.toast.save_failed'), { kind: 'danger', detail: e?.message });
      return false;
    } finally { switchingRef.current = false; }
  }, [flushDirtyTabs, t]);

  const pickScript = useCallback(async (id, opts = {}) => {
    if (!opts.force && switchingRef.current) return false;
    // 点当前工作区不应清空/重载已打开标签(以前会 flush + 清空,看起来像误操作)。
    if (!opts.force && String(id) === String(scriptId)) { setMenu(null); return true; }
    if (opts.force) {
      discardActiveAiState();
      try { lsRemove(storageKeys(scriptId).drafts); lsRemove(storageKeys(scriptId).legacyDrafts); } catch (_) {}
    } else {
      if (!guardLiveAiState()) return false;
      setMenu(null);
      if (!(await flushBeforeSwitch())) return false;
      // 切走前所有 dirty 标签已落库:清掉本地草稿,避免下次打开旧剧本时恢复出
      // 「已保存但 original 还是旧基线」的假 dirty 标签。
      try { lsRemove(storageKeys(scriptId).drafts); lsRemove(storageKeys(scriptId).legacyDrafts); } catch (_) {}
    }
    setScriptId(id); lsSet('mde.scriptId', id); setTabs([]); setActiveKey(null); setMenu(null);
    setSyncNudge(null);   // 旧剧本正文的「同步设定」提示不能带到新剧本
    setSelLen(0); setCursor({ line: 1, col: 1, total: 0 });   // 旧剧本的选区/光标不能带到新剧本
    return true;
  }, [guardLiveAiState, discardActiveAiState, flushBeforeSwitch, scriptId, storageKeys]);

  // EditorView 在 docKey 变化时兜底清掉了 AI 待定区/diff(正常路径会被上面的守卫拦住,
  // 这里是删除剧本、删标签等强制路径的兜底):给用户一个明确反馈。
  const onAiStateDiscarded = useCallback(() => {
    toast(t('md_editor.toast.ai_state_discarded'), { kind: 'warn', duration: 3200 });
  }, [t]);

  // 文件树删除(尤其删章会重排 chapter_index)前:除了 AI 状态,也要避开在途保存。
  // 否则 remap 后旧 key 的保存结果对不上新标签,或在途章节写回错位。
  const guardMutateStructure = useCallback(() => {
    if (!guardLiveAiState()) return false;
    if (inflightSavesRef.current.size > 0) {
      toast(t('md_editor.toast.save_in_progress'), { kind: 'warn', duration: 2400 });
      return false;
    }
    return true;
  }, [guardLiveAiState, t]);

  // 标签持久化 effect 在空列表时故意不写(避免切剧本瞬间把新剧本的缓存冲掉)。
  // 但「删章/重切章节导致所有标签被主动关闭」必须显式清缓存,否则刷新页面会把已失效的
  // 旧 chapter_index 标签重新打开。
  const clearTabsCacheIfEmpty = useCallback((nextTabs) => {
    if (!scriptId || (nextTabs && nextTabs.length)) return;
    try {
      const k = storageKeys(scriptId);
      lsSet(k.tabs, '[]');
      lsSet(k.active, '');
      // 旧版共享键也清掉;否则新窗口可能再次迁移回一整套已失效标签。
      lsRemove(k.legacyTabs);
      lsRemove(k.legacyActive);
    } catch (_) {}
  }, [scriptId, storageKeys]);

  // ── 顶栏菜单 + 可拖拽分栏 ──────────────────────────────────────────────
  const [menu, setMenu] = useState(null);   // 'ws' | 'file' | 'edit' | null
  const [tabCtx, setTabCtx] = useState(null);     // 标签页右键菜单 {x,y,key}
  const [editorCtx, setEditorCtx] = useState(null); // 编辑器正文右键菜单 {x,y}
  const panesRef = useRef(null);
  const [leftW, setLeftW] = useState(() => { const n = Number(lsGet('mde.leftW', 240)); return n >= 150 && n <= 480 ? n : 240; });
  const [rightW, setRightW] = useState(() => { const n = Number(lsGet('mde.rightW', 320)); return n >= 220 && n <= 560 ? n : 320; });
  // 右栏(AI 助手)开合:有持久化用之;否则宽屏默认开、窄屏默认关(避免小屏一进来就被浮层盖住,且提供入口)。
  const [rightOpen, setRightOpen] = useState(() => {
    const v = lsGet('mde.rightOpen', null);
    if (v === '1' || v === true || v === 1) return true;
    if (v === '0' || v === false || v === 0) return false;
    return typeof window !== 'undefined' ? window.innerWidth > 1100 : true;
  });
  const toggleRight = useCallback(() => setRightOpen((v) => { const n = !v; lsSet('mde.rightOpen', n ? '1' : '0'); return n; }), []);
  const dragRef = useRef(null);
  const onSplitDown = (side) => (e) => {
    e.preventDefault();
    const startX = e.clientX, startLeft = leftW, startRight = rightW;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const w = side === 'left'
        ? Math.max(150, Math.min(480, startLeft + dx))
        : Math.max(220, Math.min(560, startRight - dx));
      panesRef.current?.style.setProperty(side === 'left' ? '--mde-left-w' : '--mde-right-w', w + 'px');
      dragRef.current = { side, w };
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      const d = dragRef.current; dragRef.current = null;
      if (d) { if (d.side === 'left') { setLeftW(d.w); lsSet('mde.leftW', d.w); } else { setRightW(d.w); lsSet('mde.rightW', d.w); } }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  };

  // 顶栏「编辑」操作:全部作用于当前 CodeMirror 视图(activeViewRef)。
  const withView = useCallback((fn) => { const v = activeViewRef.current; if (!v) { toast(t('md_editor.toast.open_file_first'), { kind: 'warn', duration: 1400 }); return; } v.focus(); fn(v); }, [t]);
  const doUndo = useCallback(() => withView((v) => undo(v)), [withView]);
  const doRedo = useCallback(() => withView((v) => redo(v)), [withView]);
  const doSelectAll = useCallback(() => withView((v) => selectAll(v)), [withView]);
  const doFind = useCallback(() => withView((v) => openSearchPanel(v)), [withView]);
  const doCopy = useCallback(() => withView(async (v) => { const s = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to); if (!s) return; const ok = await copyText(s); if (!ok) toast(t('md_editor.toast.copy_failed_kbd', { kbd: kbd('C') }), { kind: 'warn' }); }), [withView, t]);
  const doCut = useCallback(() => withView(async (v) => { const sel = v.state.selection.main; const s = v.state.sliceDoc(sel.from, sel.to); if (!s) return; const ok = await copyText(s); if (!ok) { toast(t('md_editor.toast.cut_failed_kbd', { kbd: kbd('X') }), { kind: 'warn' }); return; } v.dispatch({ changes: { from: sel.from, to: sel.to } }); }), [withView, t]);
  const doPaste = useCallback(() => withView(async (v) => { try { const txt = await navigator.clipboard.readText(); if (!txt) return; const sel = v.state.selection.main; v.dispatch({ changes: { from: sel.from, to: sel.to, insert: txt }, selection: { anchor: sel.from + txt.length } }); } catch (_) { toast(t('md_editor.toast.paste_failed_kbd', { kbd: kbd('V') }), { kind: 'warn' }); } }), [withView, t]);
  const doGotoLine = useCallback(() => withView((v) => { const raw = window.prompt(t('md_editor.prompt.goto_line')); const n = Number(raw); if (!n || n < 1) return; const line = v.state.doc.line(Math.min(Math.floor(n), v.state.doc.lines)); v.dispatch({ selection: { anchor: line.from }, scrollIntoView: true }); }), [withView, t]);

  // 文件菜单:重命名 / 删除当前剧本(严格 owner,后端 403 兜底)。
  const renameScript = useCallback(async () => {
    setMenu(null);
    if (!scriptId) return;
    const cur = (scripts || []).find((s) => s.id === scriptId);
    const name = window.prompt(t('md_editor.prompt.rename_script'), cur?.title || '');
    if (name == null) return;
    const nm = name.trim(); if (!nm) return;
    try { await api().scripts.rename(scriptId, nm); setScripts((prev) => (prev || []).map((s) => s.id === scriptId ? { ...s, title: nm } : s)); toast(t('md_editor.toast.renamed'), { kind: 'ok', duration: 1200 }); }
    catch (e) { toast(t('md_editor.toast.rename_failed'), { kind: 'danger', detail: e?.message }); }
  }, [scriptId, scripts, t]);
  const deleteScript = useCallback(async () => {
    setMenu(null);
    if (!scriptId) return;
    if (switchingRef.current) return;   // 切剧本前的保存进行中:不要并发删当前剧本
    if (structureMutatingRef.current) return;   // 文件树结构操作进行中
    const cur = (scripts || []).find((s) => s.id === scriptId);
    const ok = await (window.__confirm
      ? window.__confirm({ title: t('md_editor.confirm.delete_script'), message: t('md_editor.confirm.delete_script_msg', { title: cur?.title || scriptId }), danger: true, confirmText: t('common.delete') })
      : Promise.resolve(window.confirm(t('md_editor.confirm.delete_script_plain'))));
    if (!ok) return;
    try {
      await api().scripts.delete(scriptId, { force: true });
      const rest = (scripts || []).filter((s) => s.id !== scriptId);
      setScripts(rest);
      if (rest[0]) await pickScript(rest[0].id, { force: true });
      else { discardActiveAiState(); setScriptId(null); lsSet('mde.scriptId', null); setTabs([]); setActiveKey(null); setSyncNudge(null); setSelLen(0); setCursor({ line: 1, col: 1, total: 0 }); }
      toast(t('md_editor.toast.script_deleted'), { kind: 'ok', duration: 1400 });
    } catch (e) { toast(t('md_editor.toast.delete_failed'), { kind: 'danger', detail: e?.message }); }
  }, [scriptId, scripts, pickScript, discardActiveAiState, t]);

  // 顶栏菜单:点击外部关闭。
  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => { if (!e.target.closest?.('.mde-menuwrap')) setMenu(null); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu]);

  // 作者优先:从零新建空白剧本 → 先保存当前剧本的未保存标签,再创建并切过去(自动带第1章)。
  const createBlankScript = async () => {
    try {
      if (!guardLiveAiState()) return;
      if (!(await flushBeforeSwitch())) return;
      const r = await api().scripts.createBlank(t('md_editor.node_defaults.script'));
      if (!r?.script_id) throw new Error(r?.error || t('md_editor.errors.create_failed'));
      setScripts((prev) => [{ id: r.script_id, title: r.title }, ...(prev || [])]);
      toast(t('md_editor.toast.blank_script_created'), { kind: 'ok', duration: 1400 });
      // 创建 API 期间用户可能又改了当前剧本、甚至开了 AI 续写:切走前再守一次、再落一次。
      if (!guardLiveAiState()) return;
      if (!(await flushBeforeSwitch())) return;
      await pickScript(r.script_id, { force: true });
    } catch (e) { toast(t('md_editor.toast.script_create_failed'), { kind: 'danger', detail: e?.message }); }
  };
  // 给当前剧本追加一章并打开。先守卫:有未处理的 AI 改动/正在保存时不要切走当前章节。
  const addChapter = async () => {
    if (!scriptId) return;
    if (switchingRef.current) return;
    if (!guardLiveAiState()) return;
    try {
      const r = await api().scripts.addChapter(scriptId, '');
      if (!r?.chapter_index) throw new Error(r?.error || t('md_editor.errors.create_failed'));
      setTreeReloadKey((x) => x + 1);
      openNode({ kind: 'chapter', id: r.chapter_index, label: `${t('md_editor.chapter_prefix', { index: r.chapter_index })} ${r.title || ''}`.trim() });
      toast(t('md_editor.toast.chapter_created'), { kind: 'ok', duration: 1200 });
    } catch (e) { toast(t('md_editor.toast.chapter_create_failed'), { kind: 'danger', detail: e?.message }); }
  };

  // 打开节点 → 新标签(或激活已开)。
  // 已存在的标签只激活、不重新拉服务端内容:否则点一下文件树就会把该标签里未保存的改动覆盖掉。
  // 只有「新建标签」或「上次加载失败」才走网络加载。
  const openNode = useCallback(async (node) => {
    if (switchingRef.current) return;   // 保存并切换期间冻结标签结构
    if (scriptIdRef.current !== scriptId) return;   // 旧剧本的过期回调
    const sid = scriptId;
    const key = nodeKey(node.kind, node.id);
    if (key !== activeRef.current?.key && !guardLiveAiState()) return;
    // 切走当前标签前先落盘:自动保存只盯 active tab,不 flush 的话前一个标签的未保存
    // 内容会一直留在内存,浏览器关闭/崩溃即丢。fire-and-forget,不阻塞打开新节点;
    // 若保存 409,该标签会被标 conflict,用户切回去仍可合并。
    const prev = activeRef.current;
    if (prev && prev.key !== key && prev.dirty) saveTabRef.current?.(prev.key, { auto: true });
    const existing = tabsRef.current.find((x) => x.key === key);
    if (existing && !existing.error) { setActiveKey(key); return; }
    const seq = nextLoadSeq(key);
    setActiveKey(key);
    setTabs((cur) => {
      if (cur.some((t) => t.key === key)) {
        return cur.map((t) => t.key === key ? { ...t, loading: true, error: null } : t);
      }
      return [...cur, {
        key, kind: node.kind, id: node.id, label: node.label, content: '', original: '',
        // 缓存恢复会带 chapterId;正常从文件树打开为空,加载后由 meta.stableId 回填。
        chapterId: node.kind === 'chapter' ? (node.chapterId ?? null) : null,
        loading: true, error: null, dirty: false,
      }];
    });
    try {
      const meta = await loadNodeContentMeta(node.kind, sid, node.id);
      if (loadSeqRef.current.get(key) !== seq || scriptIdRef.current !== sid) return;   // 期间被外部刷新/重开/切剧本
      // 缓存恢复的章节标签:index 现在指向的行 id 与缓存不一致 = 外部重排/删除过,
      // 绝不能把另一章当作「上次打开的章节」展示/编辑。跳过并提示从文件树重开。
      if (node.kind === 'chapter' && node.chapterId != null && meta.stableId != null
          && String(node.chapterId) !== String(meta.stableId)) {
        setTabs((cur) => cur.filter((t) => t.key !== key));
        setActiveKey((prev) => {
          if (prev !== key) return prev;
          const rest = tabsRef.current.filter((t) => t.key !== key);
          return rest[0]?.key || null;
        });
        toast(t('md_editor.toast.chapter_structure_skipped', {
          defaultValue: '章节结构已变化:缓存的章节标签已失效,已跳过;请从文件树重新打开对应章节',
        }), { kind: 'warn', duration: 5200 });
        return;
      }
      setTabs((cur) => cur.map((t) => t.key === key ? {
        ...t, content: meta.content, original: meta.content,
        baseUpdatedAt: meta.updatedAt, baseVersion: meta.version ?? null,
        chapterId: meta.stableId ?? node.chapterId ?? t.chapterId ?? null,
        loading: false,
      } : t));
    } catch (e) {
      if (loadSeqRef.current.get(key) !== seq || scriptIdRef.current !== sid) return;
      setTabs((cur) => cur.map((t) => t.key === key ? { ...t, loading: false, error: e?.message || String(e) } : t));
    }
  }, [scriptId, guardLiveAiState, nextLoadSeq]);

  const onEdit = useCallback((key, val) => {
    setTabs((cur) => cur.map((t) => t.key === key ? { ...t, content: val, dirty: val !== t.original } : t));
  }, []);

  // 顶栏「问题」徽标:载入剧本/agent 汇报后拉一次计数(面板未开也显示数量)。
  useEffect(() => {
    if (!scriptId) { setIssueCount(0); return; }
    let cancelled = false;
    (async () => {
      try { const r = await api().scripts.issues(scriptId); if (!cancelled) setIssueCount(r && r.ok ? (r.issues || []).length : 0); }
      catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [scriptId, issuesReloadKey]);

  // 刷新 / 切换工作区:恢复该剧本上次打开的标签页 + 未保存草稿 + 激活标签。
  // 必须等账号归属确认(identityReady)与剧本列表(scripts)都就绪,并且当前 scriptId
  // 确实在“可编辑剧本”里,才恢复本地缓存 —— 否则可能在权限校验前把上一个账号/
  // 已失效剧本的草稿渲染出来。
  const scriptsReady = scripts !== null;
  useEffect(() => {
    if (!identityReady || !identityVerified || !scriptsReady || !scriptId) return;
    if (!(scripts || []).some((s) => String(s.id) === String(scriptId))) return;
    // 归属确认通过:从这一刻起允许持久化/清理该剧本的草稿(即使下面发现没有缓存)。
    draftsRestoredRef.current.add(scriptId);
    const k = storageKeys(scriptId);
    // 先读当前窗口自己的缓存;没有则一次性迁移旧版共享键(并把旧键删掉,
    // 防止同一浏览器的另一个新窗口/标签页再次恢复同一批旧标签)。
    let saved = lsGetJSON(k.tabs, null);
    let savedActive = lsGet(k.active, null);
    if (saved == null) {
      saved = lsGetJSON(k.legacyTabs, null);
      if (saved != null) {
        savedActive = lsGet(k.legacyActive, null);
        lsRemove(k.legacyTabs);
        lsRemove(k.legacyActive);
      }
    }
    let drafts = [];
    try {
      let raw = lsGetJSON(k.drafts, null);
      if (raw == null) {
        raw = lsGetJSON(k.legacyDrafts, null);
        if (raw != null) lsRemove(k.legacyDrafts);
      }
      if (Array.isArray(raw)) {
        drafts = raw.filter((d) => d && d.key && d.kind && d.id != null);
      }
    } catch (_) { drafts = []; }
    if ((!Array.isArray(saved) || !saved.length) && !drafts.length) return;
    let cancelled = false;
    const draftKeys = new Set(drafts.map((d) => d.key));
    const activeDraft = drafts.find((d) => d.key === savedActive) || drafts[0] || null;
    (async () => {
      // 草稿必须【先同步恢复】成 dirty 标签,再后台补齐上次打开的干净标签。
      // 若等所有 openNode 完成才写 tabs,期间的 500ms 草稿持久化/离开页面会看到
      // 空 tabs → 把尚未恢复的草稿键删掉(新剧本切换后的首帧尤其容易踩到)。
      if (drafts.length) {
        setTabs((cur) => {
          const exist = new Set(cur.map((x) => x.key));
          const add = drafts.filter((d) => !exist.has(d.key)).map((d) => ({
            key: d.key, kind: d.kind, id: d.id, label: d.label,
            content: d.content || '',
            original: d.original != null ? d.original : (d.content || ''),
            baseUpdatedAt: d.baseUpdatedAt ?? null,
            baseVersion: d.baseVersion ?? null,
            chapterId: d.chapterId ?? null,
            // review 草稿 = 上次在 AI diff/续写/冲突合并打开时离开的,存的是本地侧
            // 原文。恢复后标 conflict,既提示用户,也让自动保存让路;等用户手动保存/
            // 重新走合并或确认后再清除。
            loading: false, error: null, dirty: true,
            conflict: !!d.conflict || !!d.review,
          }));
          return [...add, ...cur];
        });
        // 先激活草稿本身(内容立即可见);若离开时激活的是某个干净缓存标签,
        // 等后台 openNode 补齐后由流程末尾再切回 savedActive。
        setActiveKey(activeDraft.key);
        toast(t('md_editor.toast.drafts_restored', {
          count: drafts.length,
          defaultValue: '已恢复 {{count}} 个未保存草稿(来自上次离开编辑器时的本地缓存)',
        }), { kind: 'warn', duration: 4600 });
        const reviewed = drafts.filter((d) => d.review).length;
        if (reviewed) {
          toast(t('md_editor.toast.review_drafts_restored', {
            count: reviewed,
            defaultValue: '其中 {{count}} 个是上次 AI 审阅中的本地版本;未批准的 AI 改动需要重新确认,已暂停自动保存。',
          }), { kind: 'warn', duration: 6000 });
        }
      }
      for (const t of (saved || [])) {
        if (cancelled) return;
        const key = nodeKey(t.kind, t.id);
        if (draftKeys.has(key)) continue;   // 有未保存草稿的标签不要用缓存描述重新加载覆盖
        // chapterId 是缓存时的稳定行 id;openNode 加载后会与服务端当前 id 比对,
        // index 已被外部重排指向另一章时直接跳过这个缓存标签。
        await openNode({
          kind: t.kind, id: t.id, label: t.label,
          chapterId: t.kind === 'chapter' ? (t.chapterId ?? null) : undefined,
        });
      }
      if (cancelled) return;
      // openNode 会逐个把激活标签切到刚加载的缓存标签;恢复流程结束时再落回
      // 用户离开时的激活标签(草稿优先,否则缓存记录的 activeKey)。
      if (drafts.length) {
        setActiveKey(savedActive || activeDraft.key);
      } else if (savedActive) {
        setActiveKey(savedActive);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptId, identityReady, identityVerified, scriptsReady]);

  // 持久化已打开标签:只在非空时写,避免切换工作区瞬间的空态把缓存清掉。
  useEffect(() => {
    if (!scriptId || !tabs.length) return;
    try {
      const k = storageKeys(scriptId);
      lsSet(k.tabs, JSON.stringify(tabs.map((t) => ({
        kind: t.kind, id: t.id, label: t.label,
        chapterId: t.kind === 'chapter' ? (t.chapterId ?? undefined) : undefined,
      }))));
      lsSet(k.active, activeKey || '');
    } catch (_) {}
  }, [tabs, activeKey, scriptId, storageKeys]);

  const closeTab = useCallback(async (key) => {
    if (switchingRef.current) return;   // 保存并切换期间冻结标签结构
    const sid = scriptId;
    // 关闭当前标签会切换(或卸载)实时视图:有未处理的 AI 待定区/diff 时先让用户处理。
    if (key === activeKey && !guardLiveAiState()) return;
    // 修复:局部 `const t` 曾遮蔽 useTranslation 的 t() → t('…') 把 tab 对象当函数调 = TypeError;
    // 且 message: tab.label 引用了未定义的 `tab`(实际变量被命名为遮蔽的 t)→ ReferenceError。
    // 关闭「有未保存改动」的标签必崩。改名局部为 tab,恢复 t() 为翻译函数。
    const tab = tabs.find((x) => x.key === key);
    if (tab?.dirty) {
      const ok = await (window.__confirm ? window.__confirm({ title: t('md_editor.confirm.discard_changes'), message: tab.label, danger: true, confirmText: t('md_editor.confirm.discard') }) : Promise.resolve(confirm(t('md_editor.confirm.discard_changes'))));
      if (!ok) return;
    }
    if (scriptIdRef.current !== sid) return;   // 确认框期间已切剧本:不要动新剧本的同名标签
    setTabs((cur) => {
      const idx = cur.findIndex((x) => x.key === key);
      const next = cur.filter((x) => x.key !== key);
      if (activeKey === key) setActiveKey(next[Math.max(0, idx - 1)]?.key || null);
      return next;
    });
    // 显式清缓存:空列表时持久化 effect 会跳过(避免切剧本清掉新剧本缓存),
    // 所以「手动关掉最后一个标签」必须在这里清,否则刷新页面又把它打开。
    clearTabsCacheIfEmpty(tabsRef.current.filter((x) => x.key !== key));
  }, [activeKey, guardLiveAiState, t, scriptId, clearTabsCacheIfEmpty]);

  // 批量关闭标签(关闭其他/右侧/已保存/全部):若集合里有未保存的,先确认一次。
  const closeTabs = useCallback(async (keys) => {
    if (switchingRef.current) return;   // 保存并切换期间冻结标签结构
    const sid = scriptId;
    const set = keys instanceof Set ? keys : new Set(keys);
    const targets = tabs.filter((t) => set.has(t.key));
    if (!targets.length) return;
    // 批量关闭包含当前标签时同样会切走实时视图:有未处理 AI 改动先拦下。
    if (set.has(activeKey) && !guardLiveAiState()) return;
    const dirtyCnt = targets.filter((t) => t.dirty).length;
    if (dirtyCnt) {
      const ok = await (window.__confirm
        ? window.__confirm({ title: t('md_editor.confirm.discard_tabs', { count: dirtyCnt }), message: t('md_editor.confirm.discard_tabs_msg'), danger: true, confirmText: t('md_editor.confirm.discard_and_close') })
        : Promise.resolve(confirm(t('md_editor.confirm.discard_tabs_plain', { count: dirtyCnt }))));
      if (!ok) return;
    }
    if (scriptIdRef.current !== sid) return;   // 确认框期间已切剧本
    setTabs((cur) => {
      const next = cur.filter((t) => !set.has(t.key));
      if (set.has(activeKey)) setActiveKey(next[next.length - 1]?.key || null);
      return next;
    });
    clearTabsCacheIfEmpty(tabsRef.current.filter((t) => !set.has(t.key)));   // 空列表时 effect 不写,需显式清
  }, [activeKey, guardLiveAiState, t, scriptId, clearTabsCacheIfEmpty]);

  // 冲突三方合并(P0):把「服务端新版 vs 本地未保存」丢进现成逐块 diff 审阅。
  // 全部批准=采用对方;全部拒绝=保留自己(以服务端版本为基线强制落库);逐块=合并保存。
  // 现在覆盖全部实体(章节/角色卡/世界书/锚点/canon),不再只限章节 —— 所有实体都有了
  // 乐观锁,冲突处理走同一条 UI。仅当该标签是激活标签(有 EditorView)时可用,否则返回
  // false 让调用方走降级提示。
  // serverMeta: { updatedAt, version } = 服务端快照的版本基线(章节/世界书/锚点/canon 用
  // updatedAt,角色卡用 version=row_version)。
  const openConflictMerge = useCallback((key, localContent, serverMd, serverMeta, kind) => {
    const view = activeViewRef.current;
    const a = activeRef.current;
    if (!view || !a || a.key !== key || a.kind !== kind) return false;
    // 有未接受的续写待定区时先撤掉,用还原后的原文作为本地版本,避免把半截 AI 文本带进冲突合并。
    if (hasPendingContinue(view)) {
      rejectPending(view);
      localContent = view.state.doc.toString();
    }
    const applyTab = (content, meta) => setTabs((cur) => cur.map((x) => x.key === key
      ? {
        ...x, content, original: content, dirty: false, saving: false, conflict: false,
        baseUpdatedAt: (meta && meta.updatedAt) || null,
        baseVersion: meta && meta.version != null ? meta.version : null,
        chapterId: (meta && meta.chapterId) || x.chapterId || null,
      } : x));
    const sid = scriptId;
    const forceSave = async (finalText, okMsg) => {
      try {
        // 以服务端版本为基线强制落库:差异 = 本地最终文本 vs serverMd,基线 = serverMeta。
        // 若合并期间服务端又被改了一次,这次保存会再次 409,不会静默覆盖。
        const res = await saveNodeContent(
          kind, sid, a.id, finalText, serverMd,
          (serverMeta && serverMeta.updatedAt) || null,
          serverMeta && serverMeta.version != null ? serverMeta.version : null,
          // 章节身份锁:旧标签没有 chapterId 时用 409 快照里的稳定 id 补齐;合并期间
          // index 再被重排同样会被服务端拒绝。
          a.kind === 'chapter' ? ((serverMeta && serverMeta.chapterId) ?? a.chapterId ?? null) : null,
        );
        if (scriptIdRef.current !== sid) return;   // 期间已切剧本:不要改新剧本的同名标签
        applyTab(finalText, res || serverMeta);
        toast(okMsg, { kind: 'ok', duration: 1600 });
      } catch (e2) {
        if (scriptIdRef.current !== sid) return;
        toast(t('md_editor.toast.save_failed'), { kind: 'danger', detail: e2?.message });
      }
    };
    const ok = showChapterDiff(view, localContent, serverMd, {
      kind: 'conflict',
      onAccept: () => { applyTab(serverMd, serverMeta); toast(t('md_editor.conflict.took_theirs'), { kind: 'ok', duration: 1600 }); },
      onReject: () => { forceSave(localContent, t('md_editor.conflict.kept_yours')); },
      onMixed: (finalText) => { forceSave(finalText, t('md_editor.conflict.mixed_saved')); },
    });
    if (ok) toast(t('md_editor.conflict.merge_prompt'), { kind: 'warn', duration: 3200 });
    return ok;
  }, [scriptId, t]);

  const saveTab = useCallback(async (key, opts) => {
    if (switchingRef.current) return false;   // 切剧本前的批量保存正在进行,避免并发写同一标签
    if (structureMutatingRef.current) {
      if (!(opts && opts.auto)) toast(t('md_editor.toast.structure_busy'), { kind: 'warn', duration: 2200 });
      return false;
    }
    if (scriptIdRef.current !== scriptId) return false;   // 旧剧本的过期回调
    const sid = scriptId;
    const tab = tabs.find((x) => x.key === key);
    if (!tab || !tab.dirty) return true;
    // 待定区/内联 diff 还没被用户确认时,文档里是「未确认的 AI 文本/提议版本」,不能直接落库。
    // 自动保存静默跳过(避免每 2.5s 弹一次),手动保存给明确提示。
    const liveView = activeRef.current?.key === key ? activeViewRef.current : null;
    if (liveView && (hasPendingContinue(liveView) || hasChapterDiff(liveView))) {
      if (!(opts && opts.auto)) toast(t('md_editor.toast.resolve_ai_before_save'), { kind: 'warn', duration: 2800 });
      return false;
    }
    setTabs((cur) => cur.map((x) => x.key === key ? { ...x, saving: true } : x));
    const savePromise = saveNodeContent(tab.kind, sid, tab.id, tab.content, tab.original, tab.baseUpdatedAt, tab.baseVersion, tab.chapterId);
    const inflightKey = `${sid}:${key}`;
    inflightSavesRef.current.set(inflightKey, savePromise);
    try {
      const res = await savePromise;
      if (scriptIdRef.current !== sid) return false;   // 期间已切剧本:旧标签的结果不要再写回
      setTabs((cur) => cur.map((x) => {
        if (x.key !== key) return x;
        // 保存期间用户可能又输入了:当前 content 不等于本次落库快照时不能标干净,
        // 否则这段新输入会被静默丢掉(自动保存同样会踩)。
        const stillSame = x.content === tab.content;
        return {
          ...x, original: tab.content, dirty: !stillSame, saving: false, conflict: false,
          baseUpdatedAt: (res && res.updatedAt) || x.baseUpdatedAt,
          // 角色卡 row_version 随每次成功写入推进;不更新会让下一次保存恒 409。
          baseVersion: res && res.version != null ? res.version : x.baseVersion,
        };
      }));
      // 返回值供「先保存再试玩」这类调用方判断是否真的干净:保存期间用户又输入了,
      // state/实时视图会与本次落库快照不同,此时不能继续用旧内容去建档。
      const latest = tabsRef.current.find((x) => x.key === key);
      const live = activeRef.current?.key === key ? activeViewRef.current : null;
      const clean = (!latest || latest.content === tab.content)
        && (!live || live.state.doc.toString() === tab.content);
      toast(t('md_editor.toast.saved'), { kind: 'ok', duration: 1200 });
      return clean;
    } catch (e) {
      if (scriptIdRef.current !== sid) return false;   // 期间已切剧本:不要在新剧本上开冲突 diff/弹错
      setTabs((cur) => cur.map((x) => x.key === key ? { ...x, saving: false } : x));
      if (e && e.status === 409 && e.payload && e.payload.conflict) {
        // 所有实体共用 409 形状:conflict=true + 对应 server_* 快照。按 kind 取快照,
        // 反序列化成本地同一套 markdown 后比较,再进三方合并。
        const server = conflictServer(e, tab.kind);
        // 身份冲突优先于内容冲突:index 已指向另一章,内容相等/三方合并都不成立。
        // 保留本地内容并标 conflict,提示用户关标签后从文件树重开(不要 force-save)。
        if (chapterStructureChanged(e, tab, server)) {
          setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
          toast(t('md_editor.conflict.structure_changed', {
            defaultValue: '章节结构已变化:当前标签对应的章节已被重排/删除,不能合并或强制保存。请复制需要保留的内容,关闭标签后从文件树重新打开。',
          }), { kind: 'danger', duration: 5600 });
          return false;
        }
        const serverMd = server ? toMd(tab.kind, server) : '';
        const serverMeta = serverBase(tab.kind, server);
        const view = activeRef.current?.key === key ? activeViewRef.current : null;
        const localContent = view ? view.state.doc.toString() : ((tabsRef.current.find((x) => x.key === key) || tab).content);
        // 并发重复保存(自动保存与手动保存撞在一起)也会 409,但服务端内容其实与本地一致
        // —— 这不是真冲突。按成功路径推进基线,避免弹出一个左右完全相同的合并面板。
        if (server && serverMd === localContent) {
          setTabs((cur) => cur.map((x) => x.key === key ? {
            ...x, original: localContent, dirty: x.content !== localContent,
            saving: false, conflict: false,
            baseUpdatedAt: serverMeta.updatedAt || x.baseUpdatedAt,
            baseVersion: serverMeta.version != null ? serverMeta.version : x.baseVersion,
            // 旧标签可能没有 chapterId:用 409 快照的稳定 id 补齐,后续保存可做身份校验。
            chapterId: serverMeta.chapterId ?? x.chapterId ?? null,
          } : x));
          toast(t('md_editor.toast.saved'), { kind: 'ok', duration: 1200 });
          return true;
        }
        if (opts && opts.auto) {
          setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
          toast(t('md_editor.conflict.auto_deferred'), { kind: 'warn', duration: 3600 });
          return false;
        }
        if (switchingRef.current) {
          // 切剧本前的批量保存进行中:不要把内联 diff 叠到即将切换的视图上,标冲突后由切换流程中止。
          setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
          toast(t('md_editor.toast.switch_blocked_conflict'), { kind: 'warn', duration: 3600 });
          return false;
        }
        if (server && openConflictMerge(key, localContent, serverMd, serverMeta, tab.kind)) return false;
        setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
        toast(t('md_editor.conflict.other_tab'), { kind: 'warn', duration: 3600 });
        return false;
      }
      toast(t('md_editor.toast.save_failed'), { kind: 'danger', detail: e?.message });
      return false;
    } finally {
      if (inflightSavesRef.current.get(inflightKey) === savePromise) inflightSavesRef.current.delete(inflightKey);
    }
  }, [tabs, scriptId, t, openConflictMerge]);
  // openNode 定义在 saveTab 之前,用 ref 取最新实现:切标签前先落盘,不依赖闭包顺序。
  saveTabRef.current = saveTab;

  // agent 写库后:重载受影响的标签(若打开且无未保存改动)+ 刷新文件树。
  // opts.silent:成功刷新时不弹「AI 已修改」——恢复(ChapterHistory onRestored)等非 AI 场景用,
  // 调用方已弹过自己的提示(如「已恢复到该版本之前」),再用 AI 文案会误导。
  const refreshTab = useCallback(async (kind, id, opts = {}) => {
    setTreeReloadKey((x) => x + 1);
    if (scriptIdRef.current !== scriptId) return;   // 旧剧本的过期回调
    if (structureMutatingRef.current) return;   // 章节结构操作进行中:标签即将重排/关闭,先不刷新
    if (switchingRef.current) return;   // 正在保存并切换剧本:旧标签马上清空,不再刷新(避免打开冲突 diff)
    const sid = scriptId;
    const key = nodeKey(kind, id);
    // AI 删除实体成功:关闭对应已打开标签(活动标签先清 AI 状态),树已在上面 bump 重载。
    if (opts.deleted) {
      if (activeRef.current?.key === key) discardActiveAiState({ rejectAgentDiff: true });
      setTabs((cur) => {
        const idx = cur.findIndex((t) => t.key === key);
        if (idx < 0) return cur;
        const next = cur.filter((t) => t.key !== key);
        if (activeKey === key) setActiveKey(next[Math.max(0, idx - 1)]?.key || null);
        return next;
      });
      clearTabsCacheIfEmpty(tabsRef.current.filter((t) => t.key !== key));
      return;
    }
    const tab = tabs.find((x) => x.key === key);
    if (!tab) return;
    const seq = nextLoadSeq(key);
    try {
      const meta = await loadNodeContentMeta(kind, sid, id);
      if (loadSeqRef.current.get(key) !== seq || scriptIdRef.current !== sid) return;   // 期间有更新的加载/已切剧本
      // 等待网络期间用户可能已经开始输入:用【最新的 tab】和实时视图判断,而不是闭包里捕获的旧 tab.dirty。
      const latest = tabsRef.current.find((x) => x.key === key) || tab;
      const view = activeRef.current?.key === key ? activeViewRef.current : null;
      const editedInView = !!(view && view.state.doc.toString() !== (latest.original || ''));
      // 身份先于内容:服务端这个 index 现在返回的 chapter id 与标签打开时不同,
      // 说明外部已重排/删除。绝不能把另一章的内容同步进当前标签(或反向合并)。
      if (kind === 'chapter' && latest.chapterId != null && meta.stableId != null
          && String(latest.chapterId) !== String(meta.stableId)) {
        setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
        toast(t('md_editor.conflict.structure_changed', {
          defaultValue: '章节结构已变化:当前标签对应的章节已被重排/删除,不能合并或强制保存。请复制需要保留的内容,关闭标签后从文件树重新打开。',
        }), { kind: 'danger', duration: 5600 });
        return;
      }
      // 用户正在审阅 AI 提议(diff)或有未接受的续写待定区时,不能在它下面整篇换文档:
      // 待定区/diff 的 ops 都按打开时的文档计算,替换后位置全部错位。先让用户处理完,
      // 这里只标记冲突(树已重载,用户仍可手动保存/合并)。
      if (view && (hasChapterDiff(view) || hasPendingContinue(view))) {
        setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
        toast(t('md_editor.toast.ai_edited_has_unsaved'), { kind: 'warn', duration: 3200 });
        return;
      }
      if (!latest.dirty && !editedInView) {
        // 活动标签:必须把服务端新文同步进实时 CodeMirror 视图。只改 React state 不够 ——
        // 同一 docKey 不会回灌,编辑器仍显示旧文;而 baseUpdatedAt 已被推进,用户随后敲一个字
        // 保存就会把 AI/撤销/恢复后的新文覆盖掉(且不会触发 409)。选区尽量保留,越界夹到末尾。
        if (view) {
          const curDoc = view.state.doc.toString();
          if (curDoc !== meta.content) {
            const sel = view.state.selection.main;
            const len = meta.content.length;
            view.dispatch({
              changes: { from: 0, to: curDoc.length, insert: meta.content },
              selection: { anchor: Math.min(sel.from, len), head: Math.min(sel.to, len) },
              // 程序性整篇替换不进 undo 历史:否则 Ctrl+Z 会把旧文倒回、自动保存再用
              // 已推进的基线覆盖服务端新文。用户想撤销 AI 改动应走明确的冲突/历史流程。
              annotations: Transaction.addToHistory.of(false),
            });
          }
        }
        setTabs((cur) => cur.map((x) => x.key === key ? {
          ...x, content: meta.content, original: meta.content, baseUpdatedAt: meta.updatedAt,
          baseVersion: meta.version ?? null, chapterId: meta.stableId ?? x.chapterId ?? null,
          loading: false, error: null, dirty: false, conflict: false,
        } : x));
        if (!opts.silent) toast(t('md_editor.toast.ai_refreshed'), { kind: 'ok', duration: 1400 });
        return;
      }
      // P0:有未保存改动时不再只 toast(旧行为=用户随后 ⌘S 用旧底稿覆盖 AI 改动,静默丢数据)。
      // 激活标签→直接进三方合并;其他情况标记冲突,乐观锁在保存时兜底(现在覆盖全部实体:
      // 章节/角色卡/世界书/锚点/canon 都带版本基线,服务端 409 会再给出对应 server_* 快照)。
      const localForMerge = view ? view.state.doc.toString() : latest.content;
      // 本地 dirty 但内容其实已经等于服务端(典型:agent approve 后,后端写入的就是这份文本;
      // refresh 只是回读)。这不是冲突,直接对齐 content/original/基线并清 dirty,
      // 避免弹出一个左右完全相同的合并面板。
      if (meta.content === localForMerge) {
        setTabs((cur) => cur.map((x) => x.key === key ? {
          ...x, content: meta.content, original: meta.content, baseUpdatedAt: meta.updatedAt,
          baseVersion: meta.version ?? null, chapterId: meta.stableId ?? x.chapterId ?? null,
          loading: false, error: null, dirty: false, conflict: false,
        } : x));
        return;
      }
      if (openConflictMerge(key, localForMerge, meta.content, { updatedAt: meta.updatedAt, version: meta.version, chapterId: meta.stableId ?? null }, kind)) return;
      setTabs((cur) => cur.map((x) => x.key === key ? { ...x, conflict: true } : x));
      toast(t('md_editor.toast.ai_edited_has_unsaved'), { kind: 'warn', duration: 3200 });
    } catch (e) {
      if (loadSeqRef.current.get(key) !== seq || scriptIdRef.current !== sid) return;
      // 原来在 loading 的标签上刷新失败:必须收掉 loading,否则它再也等不到 openNode 的结果。
      setTabs((cur) => cur.map((x) => (x.key === key && x.loading) ? { ...x, loading: false, error: e?.message || String(e) } : x));
    }
  }, [tabs, scriptId, t, openConflictMerge, nextLoadSeq, activeKey, discardActiveAiState, clearTabsCacheIfEmpty]);
  // refreshTab 的依赖含 tabs(每次键入都变);onTreeMutate 通过 ref 取最新实现,保持自身
  // 引用稳定 → 包了 React.memo 的 FileTree 不会在每次按键时重渲染。
  refreshTabRef.current = refreshTab;

  // 资源管理器增删改后:同步已打开的标签(删→关、改名→更新标题),并触发树重载。
  const onTreeMutate = useCallback((action, kind, id, label) => {
    if (scriptIdRef.current !== scriptId) return;   // 旧剧本的过期回调
    const key = nodeKey(kind, id);
    if (action === 'delete') {
      if (activeKey === key) discardActiveAiState({ rejectAgentDiff: true });   // 同剧本内删活动标签:先收尾 AI 状态再切走
      setTabs((cur) => {
        const idx = cur.findIndex((t) => t.key === key);
        const next = cur.filter((t) => t.key !== key);
        if (activeKey === key) setActiveKey(next[Math.max(0, idx - 1)]?.key || null);
        return next;
      });
      clearTabsCacheIfEmpty(tabsRef.current.filter((t) => t.key !== key));
    } else if (action === 'rename' && label) {
      // 只改 label 不够:重命名 bump 了服务端 updated_at / row_version,标签里的旧正文
      // (front-matter 的 title/name/story_time_label)和旧基线都过期了。刷新一次:
      // 干净标签同步新内容+新基线;dirty 标签走冲突合并,不丢用户输入。
      setTabs((cur) => cur.map((t) => t.key === key ? { ...t, label } : t));
      refreshTabRef.current?.(kind, id, { silent: true });
    } else if (action === 'reorder') {
      // 世界书拖拽改了多条 priority:把打开着的同类标签都刷新一遍(干净标签同步内容+基线,
      // dirty 标签进合并),否则旧 priority/旧基线会让下一次保存弹假冲突。
      for (const t of tabsRef.current) {
        if (t.kind === kind) refreshTabRef.current?.(kind, t.id, { silent: true });
      }
    }
  }, [activeKey, discardActiveAiState, scriptId, clearTabsCacheIfEmpty]);

  // 章节删除后端会整本重排 chapter_index:已打开的其他章节标签必须同步改号,否则之后保存会写错章。
  // 被删章节的标签关闭;序号大于删除项的标签按「删掉了几个更小的序号」左移,label 重新生成。
  // serverChapters: delete 接口返回的重排后 [{chapter_index, updated_at}]。_renumber_contiguous
  // 会 bump 全表 updated_at,若不把这些新基线写回标签,打开中的章节下一次保存会误报 409。
  const onChaptersDeleted = useCallback((deletedIds, serverChapters) => {
    if (scriptIdRef.current !== scriptId) return;   // 旧剧本的过期回调
    const del = new Set((deletedIds || []).map(Number).filter((n) => Number.isFinite(n)));
    if (!del.size) { setTreeReloadKey((x) => x + 1); return; }
    const shiftFor = (id) => { let n = 0; for (const d of del) if (d < id) n += 1; return n; };
    const remapId = (id) => id - shiftFor(id);
    // 重排后的真实版本基线 + 稳定 id。只更新 baseUpdatedAt/chapterId,不触碰
    // content/original:用户未保存的编辑仍然保留;下一次保存用新基线 + 本地内容正常落库。
    const tsByIndex = new Map();
    const idByIndex = new Map();
    for (const ch of (serverChapters || [])) {
      const ci = Number(ch?.chapter_index);
      if (!Number.isFinite(ci)) continue;
      tsByIndex.set(ci, ch.updated_at || null);
      if (ch?.id != null) idByIndex.set(ci, ch.id);
    }
    const oldTabs = tabsRef.current;
    const remapped = [];
    let changed = false;
    for (const tab of oldTabs) {
      if (tab.kind !== 'chapter') { remapped.push(tab); continue; }
      const id = Number(tab.id);
      // 正在加载的章节标签直接关掉:它的 in-flight 请求仍按旧 key 回填,remap 后新 key 永远等不到
      // 结果(会卡在 loading)。关掉比留下一个空标签安全,用户可重新打开。
      if (del.has(id) || tab.loading) { changed = true; continue; }
      const nid = remapId(id);
      const freshBase = tsByIndex.get(nid);
      const freshId = idByIndex.get(nid);
      if (nid === id) {
        // index 没变,但必须把稳定 id 对齐(重排后 index 的归属由服务端返回的 id 决定)。
        remapped.push({ ...tab, baseUpdatedAt: freshBase || tab.baseUpdatedAt, chapterId: freshId ?? tab.chapterId });
        continue;
      }
      changed = true;
      const bare = stripChapterPrefix(tab.label || '');
      remapped.push({
        ...tab,
        id: nid,
        key: nodeKey('chapter', nid),
        label: `${t('md_editor.chapter_prefix', { index: nid })} ${bare}`.trim(),
        baseUpdatedAt: freshBase || tab.baseUpdatedAt,
        chapterId: freshId ?? tab.chapterId,
      });
    }
    const oldActive = activeRef.current;
    const oldIdx = oldActive ? oldTabs.findIndex((x) => x.key === oldActive.key) : -1;
    setTabs(remapped);
    clearTabsCacheIfEmpty(remapped);
    setActiveKey(() => {
      if (!oldActive) return remapped[0]?.key || null;
      const m = /^chapter:(\d+)$/.exec(oldActive.key);
      if (!m) return oldActive.key;                    // 非章节标签:原 key 不变
      const id = Number(m[1]);
      if (del.has(id)) {
        const fallback = remapped[Math.min(Math.max(oldIdx, 0), remapped.length - 1)] || remapped[0];
        return fallback ? fallback.key : null;
      }
      const nk = nodeKey('chapter', remapId(id));
      return remapped.some((x) => x.key === nk) ? nk : (remapped[0]?.key || null);
    });
    setTreeReloadKey((x) => x + 1);
    if (changed) toast(t('md_editor.toast.chapters_remapped'), { kind: 'warn', duration: 2600 });
  }, [t, clearTabsCacheIfEmpty, scriptId]);

  // AI 重切/替换整本已导入章节:旧 chapter_index 到新序号的映射不可知,保守关闭全部章节标签,
  // 保留角色卡/世界书/时间线/设定等非章节标签;用户可重新打开需要的章节。
  const handleChaptersRestructured = useCallback(() => {
    if (scriptIdRef.current !== scriptId) return;   // 旧剧本的过期回调
    discardActiveAiState({ rejectAgentDiff: true });   // 同剧本内:把待确认的 agent 提议收尾
    const next = tabsRef.current.filter((x) => x.kind !== 'chapter');
    setTabs(next);
    clearTabsCacheIfEmpty(next);
    setActiveKey((prev) => (prev && prev.startsWith('chapter:') ? (next[0]?.key || null) : prev));
    setTreeReloadKey((x) => x + 1);
    toast(t('md_editor.toast.chapters_restructured'), { kind: 'warn', duration: 3200 });
  }, [discardActiveAiState, clearTabsCacheIfEmpty, t, scriptId]);

  // 接受一段续写/改写后的桥接:够长就提示「要不要让助手把新设定同步进知识库」。
  // (续写引擎只产纯文本不落库,知识同步只能由右栏 agent 触发 —— 这条桥接把两路打通。)
  const onProseAccepted = useCallback((text, info) => {
    const tx = (text || '').trim();
    if (tx.length < 12) return;   // 太短(单词级)不打扰
    setSyncNudge({ text: tx, label: activeRef.current?.label || t('md_editor.sync.prose_label'), rewrite: !!(info && info.rewrite) });
  }, [t]);

  // 侧栏「续写到正文」:对当前打开的章节正文,在光标处(或选中段)用 AI 续写/改写。
  const onContinue = useCallback((instruction) => {
    const view = activeViewRef.current;
    if (!view) { toast(t('md_editor.toast.open_file_first_continue'), { kind: 'warn' }); return; }
    const _a = activeRef.current;
    const _ci = (_a && _a.kind === 'chapter') ? _a.id : null;   // 章号→后端装配相关设定+防剧透
    runContinue(view, { scriptId, instruction, onAccept: onProseAccepted, chapterIndex: _ci });
  }, [scriptId, onProseAccepted, t]);

  // agent 提议改某章 → 在中间编辑器内联 diff(绿增/红删)+ 顶栏「全部批准/拒绝」。
  // 仅当该章正是当前激活的 tab 时拦截到编辑器;否则返回 false → 侧栏走原确认。cbs.onAccept/onReject
  // 在用户点批准/拒绝时回调(触发对 agent 的 /confirm approve|reject)。任何异常都回 false 退回侧栏。
  // opts.truncated:后端 preview 有 16000 字截断护栏;截断的 after 绝不能拿来整篇替换编辑器,
  // 否则长章接受后本地只剩前 16k。截断时返回 false,让侧栏确认块(写库用完整 args)接管。
  const proposeChapterDiff = useCallback((chapterIndex, newText, cbs, opts = {}) => {
    try {
      if (opts.truncated) return false;
      const view = activeViewRef.current;
      const a = activeRef.current;
      if (!view || !a || a.kind !== 'chapter' || String(a.id) !== String(chapterIndex)) return false;
      // 预览里的 chapter_id 是「确认时该 index 指向的稳定行 id」。与当前标签打开时
      // 记住的 id 不一致 = 该章已被外部重排/替换;内联 diff 不能叠到另一章上。
      if (opts.chapterId != null && a.chapterId != null && String(opts.chapterId) !== String(a.chapterId)) {
        toast(t('md_editor.conflict.ai_target_moved', {
          defaultValue: 'AI 要修改的章节已被重排(当前章号已指向另一章),已取消内联审阅;请让助手重新读取章节后再改。',
        }), { kind: 'danger', duration: 5600 });
        return false;
      }
      if (newText == null) return false;
      // 先把未接受的续写待定区撤掉(还原原文),再取 diff 基线;否则基线里会混着半截 AI 文本。
      if (hasPendingContinue(view)) rejectPending(view);
      const oldText = view.state.doc.toString();
      // 后端 preview.after 只有章节正文(DB 的 content 列),而编辑器文档是 toMd 生成的
      // 「YAML front-matter + 正文」。两者直接 diff 会把 front matter 整段当成删除,
      // 用户点「全部批准」后本地文档的 front matter 就没了,后续保存还会被冻结闸拒绝。
      // 这里把原文档的 front matter 原样拼回 after,保证 diff 两侧是同一种格式。
      let fullNew = String(newText);
      // preview.after 的约定是「章节正文」(DB 的 content 列),不是完整 markdown。
      // 无论正文首行是不是 '---'(作者可能用分隔线/场景分隔开场),都必须补回原 front matter;
      // 不能拿首行 '---' 判断它已经带了 front matter,否则正文以分隔线开头的章节会在
      // 「全部批准」时把 YAML 整段丢掉。
      const fmEnd = frontMatterEndOf(oldText);
      if (fmEnd >= 0) {
        // frontMatterEndOf 停在闭合围栏后的换行;toMd 在围栏与正文之间还有一个空行。
        const prefix = oldText.slice(0, fmEnd + (oldText[fmEnd] === '\n' ? 1 : 0));
        fullNew = prefix + fullNew;
      }
      // 逐块取舍(混合):后端 approve 会写【整段 newText】→ 不能用 approve。改为 reject 掉 agent 提议,
      // 再把编辑器里玩家逐块选定的实际文本经 owner 校验端点直接落库(云端隔离)。
      const onMixed = async (finalText) => {
        try { cbs.onReject?.(); } catch (_) {}
        const sid = scriptId;
        try {
          // 逐块取舍的最终稿同样要带打开标签时的乐观锁基线:审阅期间作者可能
          // 手动保存/另一标签写入,不带 base 会用旧底稿静默覆盖服务端新内容。
          // oldText 是打开 diff 前的本地文档,基线仍是服务端最后已知版本,两者配套。
          const res = await saveNodeContent(
            'chapter', sid, chapterIndex, finalText, oldText,
            a.baseUpdatedAt ?? null, null, a.chapterId ?? null,
          );
          if (scriptIdRef.current !== sid) return;   // 期间已切剧本:不要改新剧本的同名标签
          const key = nodeKey('chapter', chapterIndex);
          // 这条路径写入时不带 version(内容是逐块取舍后的最终稿),但落库后必须把新
          // updated_at 记回标签;否则下一次保存会拿旧基线撞 409,弹出一个假冲突。
          setTabs((cur) => cur.map((x) => x.key === key ? {
            ...x, content: finalText, original: finalText, dirty: false,
            baseUpdatedAt: (res && res.updatedAt) || x.baseUpdatedAt,
            baseVersion: res && res.version != null ? res.version : x.baseVersion,
          } : x));
          setTreeReloadKey((x) => x + 1);
          toast(t('md_editor.diff.mixed_saved', { defaultValue: '已按你的逐段取舍保存' }), { kind: 'ok', duration: 1600 });
        } catch (e) {
          if (scriptIdRef.current !== sid) return;
          toast(t('md_editor.toast.save_failed'), { kind: 'danger', detail: e?.message });
          // 409 = 审阅期间服务端已变化。diff 已被 applyDecisions 清掉、文档是最终稿;
          // 重新拉一次服务端并走现成的冲突合并,而不是只弹 toast 让用户手动 ⌘S。
          if (e && e.status === 409) {
            try { await refreshTabRef.current?.('chapter', chapterIndex, { silent: true }); } catch (_) {}
          }
        }
      };
      return showChapterDiff(view, oldText, fullNew, { ...cbs, kind: 'agent', onMixed });
    } catch (_) { return false; }
  }, [scriptId, t]);

  // 内联续写(Copilot ghost):据光标前文向后端要一句短续写。owner-scoped + 用户自有模型/key(后端隔离)。
  // 只发 before(后端限 1500 字):ghost 是低延迟本地补全,不按章装配世界书/设定上下文;
  // 旧代码传的 chapter_index 后端从未使用,已移除,避免让人误以为它会影响补全。
  const ghostFetch = useCallback(async (before) => {
    try {
      const r = await api().scripts.autocomplete(scriptId, { before });
      return (r && r.ok && r.text) ? String(r.text) : '';
    } catch (_) { return ''; }
  }, [scriptId]);
  const toggleAutoComplete = useCallback(() => {
    setAutoComplete((on) => { const next = !on; lsSet('mde.autocomplete', next ? '1' : '0'); return next; });
  }, []);
  // AI 复审本章(对标 Copilot /review):让右栏 agent 通读本章 + 汇总问题到「问题」面板(沿用 Batch 6 管线)。
  const reviewActiveChapter = useCallback(() => {
    const a = activeRef.current;
    if (!a || a.kind !== 'chapter') return;
    setRightOpen(true); lsSet('mde.rightOpen', '1');
    const ok = agentRef.current?.reviewChapter?.(a.id, a.label);
    if (ok === false) { toast(t('md_editor.review.busy', { defaultValue: 'AI 正忙,请稍候再试' }), { kind: 'warn' }); return; }
    toast(t('md_editor.review.started', { defaultValue: '正在复审本章,问题会汇总到「问题」面板' }), { kind: 'ok', duration: 2400 });
  }, [t]);

  // 「同步设定」:把刚接受的正文丢给右栏 agent,按 rule 4 读现状 + 同步知识资产。
  const doSync = useCallback(() => {
    const n = syncNudge;
    if (!n) return;
    // 先调 syncFromProse:agent busy 时它返回 false,此时保留提示条而不是先清掉,
    // 用户可以等 AI 空闲后再点一次(旧实现先 setSyncNudge(null),忙时提示直接消失、也没发送)。
    const ok = agentRef.current?.syncFromProse(n.text, n.label, n.rewrite);
    if (ok === false) {
      toast(t('md_editor.sync.busy', { defaultValue: 'AI 正忙,请稍候再同步设定' }), { kind: 'warn', duration: 2600 });
      return;
    }
    setSyncNudge(null);
  }, [syncNudge, t]);

  // 全局快捷键(OS 自适应:Mac=⌘ / 其它=Ctrl):保存 / 折叠左树 / 快速打开 / 替换。
  // 注意:只在「焦点不在普通输入框」且「没有浮层打开」时生效。旧实现挂在 window 上却不看
  // e.target,在 AI 输入框/文件树搜索/快速打开/写作规范里按 Ctrl+W 会关掉编辑器标签,
  // Ctrl+S 会保存编辑器而不是写作规范。CodeMirror 自己的 .cm-content 是 contenteditable,
  // 必须放行(否则编辑器内 Ctrl+S/W/P 全失效);CM 搜索面板里的 input 走普通输入框分支。
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const tgt = e.target;
      const inEditorContent = !!(tgt && tgt.closest && tgt.closest('.cm-content'));
      const typing = !!(tgt && (
        tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable
        || (tgt.closest && tgt.closest('input, textarea, [contenteditable="true"]'))
      ));
      if (typing && !inEditorContent) return;
      if (quickOpen || searchOpen || rulesOpen || issuesOpen || historyFor != null || kbOpen) return;
      const k = (e.key || '').toLowerCase();
      if (k === 's') { e.preventDefault(); if (activeKey) saveTab(activeKey); }
      // 关闭当前编辑器标签(与右键菜单里的 kbd 提示一致)。注意这会覆盖浏览器的 Ctrl/Cmd+W;
      // 这是 IDE 的预期行为(VSCode 同款),否则菜单里的提示就是空头支票。
      else if (k === 'w' && !e.shiftKey && !e.altKey) { e.preventDefault(); if (activeKey) closeTab(activeKey); }
      else if (k === 'b' && !e.shiftKey && !e.altKey) { e.preventDefault(); setLeftHidden((v) => !v); }
      else if (k === 'p' && !e.shiftKey && !e.altKey) { e.preventDefault(); setQuickOpen(true); }
      else if (k === 'f' && e.shiftKey && !e.altKey) { e.preventDefault(); setSearchOpen(true); }
      // 替换:Mac=⌘⌥F(系统占用 ⌘H);Win/Linux=Ctrl+H。两者都打开 CM 搜索面板(含替换)。
      else if ((IS_MAC && e.altKey && k === 'f') || (!IS_MAC && k === 'h')) {
        e.preventDefault();
        const v = activeViewRef.current; if (v) { v.focus(); try { openSearchPanel(v); } catch (_) {} }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeKey, saveTab, closeTab, quickOpen, searchOpen, rulesOpen, issuesOpen, historyFor, kbOpen]);


  const active = tabs.find((t) => t.key === activeKey) || null;
  // 右栏 agent 只依赖名称/类型/id;不要把 content 传进去,否则每敲一个字都会重渲染整条
  // 消息列表(可能很长)。标量依赖保证对象只在真正切标签/改名时变化。
  const activeMeta = useMemo(() => (
    active ? { key: active.key, kind: active.kind, id: active.id, label: active.label, chapterId: active.chapterId ?? null } : null
  ), [active?.key, active?.kind, active?.id, active?.label, active?.chapterId]);
  // refreshTab 每次键入都会换引用;包一层稳定回调,agent 的 memo 才不会被它击穿。
  const onAgentWriteComplete = useCallback((...args) => refreshTabRef.current?.(...args), []);
  const onAgentIssuesReported = useCallback(() => setIssuesReloadKey((x) => x + 1), []);
  // 确认批准失败(版本指纹过期/写库失败/网络错误)时:内联 diff 已经先把 AI 文本
  // 写进编辑器,必须把目标标签拉回服务端真实内容。标签是 dirty 的话 refreshTab 会
  // 自动进三方合并,让用户明确选择;不再让编辑器与库长期不一致。
  const onAgentConfirmFailed = useCallback((ctx) => {
    // 用 ref 取最新 refreshTab:本回调作为 MdEditorAgent 的 prop,必须保持稳定引用,
    // 否则 refreshTab 每次键入都换引用 → 击穿 agent 的 React.memo,长聊天列表每次按键全量重渲染。
    const refresh = (...a) => refreshTabRef.current?.(...a);
    const tool = ctx && ctx.tool;
    const args = (ctx && ctx.args) || {};
    const ci = args.chapter_index;
    if (tool === 'update_script_chapter' && ci != null) {
      refresh('chapter', ci, { silent: true });
      return;
    }
    if (tool === 'upsert_worldbook_entry' && args.entry_id != null) {
      refresh('worldbook', args.entry_id, { silent: true });
      return;
    }
    if (tool === 'upsert_worldbook_entries' && Array.isArray(args.entries)) {
      const ids = args.entries.map((e) => e && e.entry_id).filter((id) => id != null);
      if (ids.length) { ids.forEach((id) => refresh('worldbook', id, { silent: true })); return; }
    }
    if (tool === 'update_npc_card' && args.card_id != null) {
      refresh('card', args.card_id, { silent: true });
      return;
    }
    if (tool === 'update_anchor' && args.anchor_id != null) {
      refresh('anchor', args.anchor_id, { silent: true });
      return;
    }
    if (tool === 'upsert_canon_entity' && args.logical_key != null) {
      refresh('canon', args.logical_key, { silent: true });
      return;
    }
    // 删除/重构/其它:没有单一内容标签要回灌,至少重拉文件树/结构。
    setTreeReloadKey((x) => x + 1);
  }, []);
  // 重构类 AI 工具(resplit / 整本导入)执行前由 agent 的确认卡调用:有未保存章节时
  // 禁用「批准」,避免 handleChaptersRestructured 关闭标签时丢掉本地内容。
  const getDirtyChapterCount = useCallback(() => (
    tabsRef.current.filter((t) => t.kind === 'chapter' && t.dirty).length
  ), []);
  // 按节点 kind 统计未保存标签:rebuild_script_module 按目标模块(卡片/世界书/…)检查。
  const getDirtyCountByKind = useCallback((kind) => (
    tabsRef.current.filter((t) => t.kind === kind && t.dirty).length
  ), []);
  // 状态栏「字数」只算正文,不把 YAML front-matter 也算进去(旧实现直接用 doc.length)。
  const bodyChars = (() => {
    const c = active?.content || '';
    const end = frontMatterEndOf(c);
    return end >= 0 ? Math.max(0, c.length - end) : c.length;
  })();
  activeRef.current = active;

  // 自动保存:正文 dirty 后 2.5s 空闲存盘;内联 diff 审阅中【绝不】自动保存(否则把未批准的 diff
  // 文本落库)。云端多用户安全:saveTab 走 owner 校验的 updateChapter 端点。
  useEffect(() => {
    if (!active || !active.dirty) return undefined;
    if (active.conflict) return undefined;   // 冲突已标记:等用户 ⌘S 进合并,不再重试(否则每 2.5s 409+toast 轰炸)
    const key = active.key;
    const id = setTimeout(() => {
      if (switchingRef.current || structureMutatingRef.current) return;   // 切剧本/结构操作优先,自动保存让路
      const v = activeViewRef.current;
      // diff 审阅中 / AI 续写待定区未接受:都跳过自动保存(否则会把未批准文本落库)。
      if (v && (hasChapterDiff(v) || hasPendingContinue(v))) return;
      saveTab(key, { auto: true });
    }, 2500);
    return () => clearTimeout(id);
  }, [active && active.key, active && active.content, active && active.dirty, active && active.conflict, saveTab]);

  return (
    <div className="mde-root">
      {/* 顶栏:工作区 + 编辑图标 + 文件/编辑菜单 */}
      <div className="mde-topbar">
        {/* 工作区切换(剧本) */}
        <div className="mde-menuwrap">
          <button className="mde-ws" onClick={() => setMenu(menu === 'ws' ? null : 'ws')} title={t('md_editor.ws.switch_title')}>
            <span className="mde-ws-kicker">{t('md_editor.ws.label')}</span>
            <span className="mde-ws-name">{(scripts || []).find((s) => s.id === scriptId)?.title || (scripts === null ? t('common.loading') : t('md_editor.ws.none_selected'))}</span>
            <span className="mde-ws-caret">▾</span>
          </button>
          {menu === 'ws' && (
            <div className="mde-menu mde-ws-menu">
              {scripts === null && <div className="mde-menu-hint">{t('md_editor.ws.loading')}</div>}
              {scripts && scripts.length === 0 && <div className="mde-menu-hint">{t('md_editor.ws.no_scripts')}</div>}
              {(scripts || []).map((s) => (
                <button key={s.id} className={'mde-menu-item' + (s.id === scriptId ? ' on' : '')} onClick={() => pickScript(s.id)}>{s.title || t('md_editor.ws.script_fallback', { id: s.id })}</button>
              ))}
              <div className="mde-menu-sep" />
              <button className="mde-menu-item" onClick={() => { setMenu(null); createBlankScript(); }}>＋ {t('md_editor.menu.new_blank_script')}</button>
            </div>
          )}
        </div>

        {/* 编辑操作图标组 */}
        <div className="mde-tb-icons">
          <button className="mde-tb-ic" data-tip={t('md_editor.toolbar.undo')} title={t('md_editor.toolbar.undo')} onClick={doUndo}><TbIcon name="undo" /></button>
          <button className="mde-tb-ic" data-tip={t('md_editor.toolbar.redo')} title={t('md_editor.toolbar.redo')} onClick={doRedo}><TbIcon name="redo" /></button>
          <span className="mde-tb-divider" />
          <button className="mde-tb-ic" data-tip={t('md_editor.toolbar.copy')} title={t('md_editor.toolbar.copy')} onClick={doCopy}><TbIcon name="copy" /></button>
          <button className="mde-tb-ic" data-tip={t('md_editor.toolbar.cut')} title={t('md_editor.toolbar.cut')} onClick={doCut}><TbIcon name="cut" /></button>
          <button className="mde-tb-ic" data-tip={t('md_editor.toolbar.paste')} title={t('md_editor.toolbar.paste')} onClick={doPaste}><TbIcon name="paste" /></button>
        </div>

        {/* 文件菜单 */}
        <div className="mde-menuwrap">
          <button className={'mde-menubtn' + (menu === 'file' ? ' on' : '')} onClick={() => setMenu(menu === 'file' ? null : 'file')}>{t('md_editor.menu.file')}</button>
          {menu === 'file' && (
            <div className="mde-menu">
              <button className="mde-menu-item" disabled={!scriptId} onClick={() => { setMenu(null); addChapter(); }}>{t('md_editor.menu.new_chapter')}</button>
              <button className="mde-menu-item" onClick={() => { setMenu(null); createBlankScript(); }}>{t('md_editor.menu.new_blank_script')}</button>
              <button className="mde-menu-item" disabled={!scriptId} onClick={renameScript}>{t('md_editor.menu.rename_script')}</button>
              <div className="mde-menu-sep" />
              <button className="mde-menu-item danger" disabled={!scriptId} onClick={deleteScript}>{t('md_editor.menu.delete_script')}</button>
            </div>
          )}
        </div>

        {/* 编辑菜单 */}
        <div className="mde-menuwrap">
          <button className={'mde-menubtn' + (menu === 'edit' ? ' on' : '')} onClick={() => setMenu(menu === 'edit' ? null : 'edit')}>{t('md_editor.menu.edit')}</button>
          {menu === 'edit' && (
            <div className="mde-menu">
              <button className="mde-menu-item" onClick={() => { setMenu(null); doUndo(); }}>{t('md_editor.menu.undo')}<span className="mde-menu-kbd">{kbd('Z')}</span></button>
              <button className="mde-menu-item" onClick={() => { setMenu(null); doRedo(); }}>{t('md_editor.menu.redo')}<span className="mde-menu-kbd">{kbd('Z', true)}</span></button>
              <div className="mde-menu-sep" />
              <button className="mde-menu-item" onClick={() => { setMenu(null); doCopy(); }}>{t('md_editor.menu.copy')}<span className="mde-menu-kbd">{kbd('C')}</span></button>
              <button className="mde-menu-item" onClick={() => { setMenu(null); doCut(); }}>{t('md_editor.menu.cut')}<span className="mde-menu-kbd">{kbd('X')}</span></button>
              <button className="mde-menu-item" onClick={() => { setMenu(null); doPaste(); }}>{t('md_editor.menu.paste')}<span className="mde-menu-kbd">{kbd('V')}</span></button>
              <div className="mde-menu-sep" />
              <button className="mde-menu-item" onClick={() => { setMenu(null); doFind(); }}>{t('md_editor.menu.find')}<span className="mde-menu-kbd">{kbd('F')}</span></button>
              <button className="mde-menu-item" onClick={() => { setMenu(null); doSelectAll(); }}>{t('md_editor.menu.select_all')}<span className="mde-menu-kbd">{kbd('A')}</span></button>
              <button className="mde-menu-item" onClick={() => { setMenu(null); doGotoLine(); }}>{t('md_editor.menu.goto_line')}</button>
              <div className="mde-menu-sep" />
              <button className="mde-menu-item" disabled={!active || !active.dirty} onClick={() => { setMenu(null); if (active) saveTab(active.key); }}>{t('common.save')}<span className="mde-menu-kbd">{kbd('S')}</span></button>
            </div>
          )}
        </div>

        <div className="mde-tb-spacer" />
        {scriptId && active && active.kind === 'chapter' && <button className={'mde-tb-txt' + (autoComplete ? ' on' : '')} data-tip={t('md_editor.ghost.tip', { defaultValue: '内联续写:打字停顿后给灰色续写建议,Tab 采纳(用你自己的模型)' })} title={t('md_editor.ghost.btn', { defaultValue: 'AI 续写' })} onClick={toggleAutoComplete}>{t('md_editor.ghost.btn', { defaultValue: 'AI 续写' })}{autoComplete ? ' ·开' : ''}</button>}
        {scriptId && <button className={'mde-tb-txt' + (issueCount > 0 ? ' has-badge' : '')} data-tip={t('md_editor.problems.tip', { defaultValue: 'AI 审稿发现的问题(可跳转章节)' })} title={t('md_editor.problems.btn', { defaultValue: '问题' })} onClick={() => setIssuesOpen(true)}>{t('md_editor.problems.btn', { defaultValue: '问题' })}{issueCount > 0 ? <span className="mde-tb-badge">{issueCount}</span> : null}</button>}
        {scriptId && <button className="mde-tb-txt" data-tip={t('md_editor.rules.tip', { defaultValue: '写作规范:每次生成都会遵守' })} title={t('md_editor.rules.btn', { defaultValue: '写作规范' })} onClick={() => setRulesOpen(true)}>{t('md_editor.rules.btn', { defaultValue: '写作规范' })}</button>}
        {scriptId && <button className={'mde-tb-txt' + (kbBadge && !kbBadge.ready ? ' has-badge' : '')} data-tip={t('md_editor.kb.tip', { defaultValue: '本剧本知识库健康度与重建(摘要精炼/世界书充实/复核卡/嵌入)' })} title={t('md_editor.kb.title', { defaultValue: '知识库中心' })} onClick={() => setKbOpen(true)}>{t('md_editor.kb.title', { defaultValue: '知识库中心' })}{kbBadge && !kbBadge.ready ? <span className="mde-tb-badge">{kbBadge.stale_count}</span> : null}</button>}
        {active && active.dirty && <button className="mde-save" onClick={() => saveTab(active.key)} disabled={active.saving}>{active.saving ? t('md_editor.save_btn.saving') : t('md_editor.save_btn.save')}</button>}
        <button className={'mde-tb-ic' + (rightOpen ? ' on' : '')} data-tip={rightOpen ? t('md_editor.panel.hide_ai') : t('md_editor.panel.show_ai')} title={rightOpen ? t('md_editor.panel.hide_ai') : t('md_editor.panel.show_ai')} onClick={toggleRight}><TbIcon name="panelRight" /></button>
      </div>

      {/* 窄屏右栏浮层的背景遮罩:点击/触摸关闭(CSS 只在 <1100px 显示;宽屏右栏是网格列不显示)。 */}
      {rightOpen && <div className="mde-scrim" onClick={toggleRight} aria-hidden="true" />}
      <div className={'mde-panes' + (rightOpen ? '' : ' right-collapsed') + (leftHidden ? ' left-collapsed' : '')} ref={panesRef} style={{ '--mde-left-w': leftW + 'px', '--mde-right-w': rightW + 'px' }}>
        {/* 左:文件树 */}
        <aside className="mde-left">
          {scriptId ? <FileTree scriptId={scriptId} openNode={openNode} activeKey={activeKey} reloadKey={treeReloadKey} onMutate={onTreeMutate} onChaptersDeleted={onChaptersDeleted} onBeforeDelete={guardMutateStructure} onMutatingChange={setStructureMutating} /> : <div className="mde-tree-hint">{t('md_editor.ws.select_first')}</div>}
        </aside>

        <div className="mde-splitter mde-splitter-left" onPointerDown={onSplitDown('left')} title={t('md_editor.splitter.left')} />

        {/* 中:标签 + 编辑器 */}
        <main className="mde-center">
          <div className="mde-tabs">
            {tabs.map((tb) => (
              <div key={tb.key} className={'mde-tab' + (tb.key === activeKey ? ' active' : '')} onClick={() => { if (switchingRef.current) return; if (tb.key !== activeKey && !guardLiveAiState()) return; if (tb.key !== activeKey) { const prev = activeRef.current; if (prev?.dirty) saveTabRef.current?.(prev.key, { auto: true }); } setActiveKey(tb.key); }}
                title={tb.label}
                onContextMenu={(e) => { e.preventDefault(); setTabCtx({ x: e.clientX, y: e.clientY, key: tb.key }); }}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tb.key); } /* 中键关闭(VSCode) */ }}>
                <span className={'mde-tab-label' + (tb.conflict ? ' mde-tab-conflict' : '')} title={tb.conflict ? t('md_editor.conflict.tab_tip') : undefined}>{tb.conflict ? '! ' : (tb.dirty ? '● ' : '')}{tb.label}</span>
                <span className="mde-tab-close" title={t('common.close')} onClick={(e) => { e.stopPropagation(); closeTab(tb.key); }}>×</span>
              </div>
            ))}
          </div>
          <div className="mde-editorwrap" onContextMenu={(e) => { if (!active) return; e.preventDefault(); setEditorCtx({ x: e.clientX, y: e.clientY }); }}>
            <EditorPane tab={active} onChange={onEdit} scriptId={scriptId} onViewReady={(v) => { activeViewRef.current = v; }} onContinueAccept={onProseAccepted} chapterIndex={active && active.kind === 'chapter' ? active.id : null} onSelectionChange={onSel} ghostEnabled={autoComplete} ghostFetch={ghostFetch} onAiStateDiscarded={onAiStateDiscarded} />
          </div>
          {/* 底部状态栏(VSCode 风):字数 + 光标行:列 + 选中 + 保存态 */}
          <div className="mde-statusbar">
            {active ? (
              <>
                <span className="mde-sb-item">{t('md_editor.statusbar.words', { n: bodyChars.toLocaleString(), defaultValue: '{{n}} 字' })}</span>
                <span className="mde-sb-item">{t('md_editor.statusbar.lncol', { line: cursor.line, col: cursor.col, defaultValue: '行 {{line}}, 列 {{col}}' })}</span>
                {selLen > 0 && <span className="mde-sb-item">{t('md_editor.statusbar.selected', { n: selLen, defaultValue: '选中 {{n}}' })}</span>}
                <span className="mde-sb-spacer" />
                {active.kind === 'chapter' && (
                  <button type="button" className="mde-sb-btn" onClick={reviewActiveChapter}>{t('md_editor.review.btn', { defaultValue: 'AI 复审本章' })}</button>
                )}
                {active.kind === 'chapter' && (
                  <button type="button" className="mde-sb-btn" onClick={() => { if (!guardLiveAiState()) return; setHistoryFor(active.id); }}>{t('md_editor.history.btn', { defaultValue: '版本历史' })}</button>
                )}
                {active.kind === 'chapter' && (
                  <button type="button" className="mde-sb-btn" disabled={playtestBusy || active.saving} onClick={async () => {
                    // 先保存再建档:否则试玩用的是磁盘上的旧正文(用户刚写的这段不在里面)。
                    // saveTab 返回 false = 保存失败/有冲突/保存期间又有新输入,这时不能继续。
                    let ok = true;
                    if (active.dirty) ok = await saveTab(active.key);
                    if (!ok) {
                      toast(t('md_editor.playtest.save_first', { defaultValue: '请先保存当前章节并处理冲突,再开始试玩' }), { kind: 'warn', duration: 2800 });
                      return;
                    }
                    playtest(active.id, active.label);
                  }}>{playtestBusy ? t('md_editor.playtest.busy', { defaultValue: '试玩中…' }) : t('md_editor.playtest.btn', { defaultValue: '从本章试玩' })}</button>
                )}
                <span className={'mde-sb-item' + (active.dirty ? ' dirty' : '')}>{active.dirty ? t('md_editor.statusbar.unsaved', { defaultValue: '未保存' }) : t('md_editor.statusbar.saved', { defaultValue: '已保存' })}</span>
              </>
            ) : <span className="mde-sb-item muted">{t('md_editor.statusbar.no_file', { defaultValue: '未打开文件' })}</span>}
          </div>
          {tabCtx && (() => {
            const idx = tabs.findIndex((t) => t.key === tabCtx.key);
            const others = tabs.filter((t) => t.key !== tabCtx.key).map((t) => t.key);
            const toRight = tabs.slice(idx + 1).map((t) => t.key);
            const saved = tabs.filter((t) => !t.dirty).map((t) => t.key);
            const items = [
              { label: t('common.close'), kbd: kbd('W'), onClick: () => closeTab(tabCtx.key) },
              { label: t('md_editor.tab_ctx.close_others'), disabled: others.length === 0, onClick: () => { if (switchingRef.current) return; if (tabCtx.key !== activeKey && !guardLiveAiState()) return; setActiveKey(tabCtx.key); closeTabs(others); } },
              { label: t('md_editor.tab_ctx.close_to_right'), disabled: toRight.length === 0, onClick: () => closeTabs(toRight) },
              { sep: true },
              { label: t('md_editor.tab_ctx.close_saved'), disabled: saved.length === 0, onClick: () => closeTabs(saved) },
              { label: t('md_editor.tab_ctx.close_all'), disabled: tabs.length === 0, onClick: () => closeTabs(tabs.map((tb) => tb.key)) },
            ];
            return <ContextMenu x={tabCtx.x} y={tabCtx.y} items={items} onClose={() => setTabCtx(null)} />;
          })()}
          {editorCtx && (
            <ContextMenu x={editorCtx.x} y={editorCtx.y} onClose={() => setEditorCtx(null)} items={[
              { label: t('md_editor.menu.cut'), kbd: kbd('X'), onClick: doCut },
              { label: t('md_editor.menu.copy'), kbd: kbd('C'), onClick: doCopy },
              { label: t('md_editor.menu.paste'), kbd: kbd('V'), onClick: doPaste },
              { sep: true },
              { label: t('md_editor.menu.select_all'), kbd: kbd('A'), onClick: doSelectAll },
              { sep: true },
              { label: t('md_editor.menu.undo'), kbd: kbd('Z'), onClick: doUndo },
              { label: t('md_editor.menu.redo'), kbd: kbd('Z', true), onClick: doRedo },
            ]} />
          )}
          {syncNudge && (
            <div className="mde-syncbar">
              <span className="mde-syncbar-text">
                {syncNudge.rewrite ? t('md_editor.sync.nudge_rewrite') : t('md_editor.sync.nudge_continue')}
              </span>
              <button className="mde-syncbar-go" onClick={doSync}>{t('md_editor.sync.sync_btn')}</button>
              <button className="mde-syncbar-no" onClick={() => setSyncNudge(null)}>{t('md_editor.sync.ignore_btn')}</button>
            </div>
          )}
        </main>

        <div className="mde-splitter mde-splitter-right" onPointerDown={onSplitDown('right')} title={t('md_editor.splitter.right')} />

        {/* 右:agent 直写面板(console_assistant SSE)+ 续写到正文 */}
        <aside className="mde-right">
          {scriptId
            ? <MdEditorAgent ref={agentRef} scriptId={scriptId} activeTab={activeMeta} onWriteComplete={onAgentWriteComplete} onRestructure={handleChaptersRestructured} onContinue={onContinue} onProposeChapterEdit={proposeChapterDiff} selLen={selLen} getSelectionContext={getSelectionContext} onIssuesReported={onAgentIssuesReported} getDirtyChapterCount={getDirtyChapterCount} getDirtyCountByKind={getDirtyCountByKind} onDiscardEditorAiState={discardEditorAiStateForConversation} onConfirmFailed={onAgentConfirmFailed} guardEditorAiState={guardLiveAiState} />
            : <div className="mde-tree-hint">{t('md_editor.ws.select_first')}</div>}
        </aside>
      </div>
      {quickOpen && scriptId && <QuickOpen scriptId={scriptId} openNode={openNode} onClose={() => setQuickOpen(false)} />}
      {searchOpen && scriptId && <GlobalSearch scriptId={scriptId} openNode={openNode} onClose={() => setSearchOpen(false)} />}
      {historyFor != null && scriptId && <ChapterHistory scriptId={scriptId} chapterIndex={historyFor} onBeforeRestore={guardLiveAiState} onClose={() => setHistoryFor(null)} onRestored={() => { try { refreshTab('chapter', historyFor, { silent: true }); } catch (_) {} setHistoryFor(null); }} />}
      {rulesOpen && scriptId && <WritingRules scriptId={scriptId} onClose={() => setRulesOpen(false)} />}
      {kbOpen && scriptId && <EditorKbPanel scriptId={scriptId} open={kbOpen} onClose={() => setKbOpen(false)} />}
      {issuesOpen && scriptId && <ProblemsPanel scriptId={scriptId} reloadKey={issuesReloadKey} onCountChange={setIssueCount}
        onJump={(ch) => { if (ch != null) openNode({ kind: 'chapter', id: ch, label: t('md_editor.chapter_prefix', { index: ch }) }); setIssuesOpen(false); }}
        onClose={() => setIssuesOpen(false)} />}
    </div>
  );
}
