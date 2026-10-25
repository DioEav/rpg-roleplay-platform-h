// CodeMirrorEditor.jsx — CodeMirror 6 的极简 React 包装(markdown 模式 + 暖色主题)。
// 只在 MD 编辑器页用,经 md-editor 页 chunk 懒加载(CM6 ~2-3MB 不进主 bundle)。
// 受控约定:docKey 变(切标签)→ 整篇替换为 value;同一 docKey 内用户输入由 CM 内部管理、
// 经 onChange 上抛,绝不把 value 回灌(否则光标乱跳)。
import React from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, highlightActiveLineGutter, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, codeFolding, foldGutter, foldKeymap } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, selectNextOccurrence } from '@codemirror/search';
import { aiContinueExtension, cmdKKeymap, pendingCancelEffect, hasPendingContinue } from '../lib/md-continue.js';
import { chapterDiffExtension, chapterDiffCancelEffect, hasChapterDiff, chapterDiffKind } from '../lib/md-diff.js';
import { ghostCompleteExtension } from '../lib/md-ghost.js';

const { useRef, useEffect } = React;

// 暖色主题:映射 tokens.css 的 CSS 变量,融入平台主题。CM6 theme 接受 var() 字符串。
const warmTheme = EditorView.theme({
  '&': { color: 'var(--text, #ebe7df)', backgroundColor: 'var(--bg, #1a1817)', height: '100%', fontSize: '13.5px' },
  '.cm-content': { fontFamily: 'var(--font-mono, monospace)', padding: '12px 0', caretColor: 'var(--accent, #b5654a)', lineHeight: '1.7' },
  '.cm-scroller': { fontFamily: 'var(--font-mono, monospace)', overflow: 'auto' },
  '.cm-gutters': { backgroundColor: 'var(--bg-deep, #131211)', color: 'var(--muted-2, #6b655e)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--panel-2, #282623)' },
  // 折叠槽(v1.82.1):默认样式在暖色主题里是刺眼的高对比小三角,收到与行号同一档灰度,
  // hover 才提亮 —— 与平台「状态用文字/边框/高亮,不用装饰图标」的取向一致。
  '.cm-foldGutter': { width: '14px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--muted-2, #6b655e)', cursor: 'pointer', padding: '0 2px' },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--accent, #b5654a)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-2, #282623)', border: '1px solid var(--line, #3a3733)', color: 'var(--muted, #9c958c)', borderRadius: '3px', padding: '0 6px', margin: '0 2px' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent, #b5654a)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--info-soft, rgba(122,166,194,.22))' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(181,101,74,0.18)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(181,101,74,0.30)', outline: '1px solid var(--accent,#b5654a)' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(122,166,194,.18)', outline: 'none' },
}, { dark: true });

// front-matter 冻结(交互层):保护 `---` 围栏 + 顶层字段的「键名」token,用户只能改值不能改键/破栏。
// 不限制任何「值」编辑(标量值/数组项/多行块标量/嵌套对象都放行) —— 故对 YAML 数组(keys/aliases)、
// sample_dialogue、canon.attrs 等多行值零误伤。新增/删除顶层字段(加项目)由保存时的键集校验兜底拦。
function frontMatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text !== '---') return -1;
  for (let i = 2; i <= doc.lines; i++) if (doc.line(i).text === '---') return doc.line(i).to;
  return -1;   // 未闭合 → 视作无 front-matter
}
function frontMatterGuard() {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    // 撤销/重做放行:历史里只可能存在「当初已通过本过滤器的改动」(被拒的事务从未记入历史),
    // 故其逆操作必然也落在值区/正文区,重新校验是多余的——直接放行,避免边界条件误伤合法回退。
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return tr;
    const doc = tr.startState.doc;
    const fmEnd = frontMatterEnd(doc);
    if (fmEnd < 0) return tr;                       // 无 front-matter(如纯正文章节无围栏)→ 不限制
    let full = false;
    tr.changes.iterChanges((fA, tA) => { if (fA === 0 && tA === doc.length) full = true; });
    if (full) return tr;                            // 整篇替换(切标签/程序性 setValue)→ 放行
    let ok = true;
    tr.changes.iterChanges((fromA, toA) => {
      if (!ok || fromA > fmEnd) return;            // 改动起点在正文区 → 放行
      const a = doc.lineAt(fromA), b = doc.lineAt(Math.min(toA, doc.length));
      for (let n = a.number; n <= b.number; n++) {
        const ln = doc.line(n);
        if (ln.text === '---') {                    // 围栏行:任何触及(含行首/行尾边界插入)都禁
          if (fromA <= ln.to && toA >= ln.from) { ok = false; return; }
          continue;
        }
        // 顶层字段行(顶格、非注释/数组项、含冒号)→ 保护 [行首, 冒号] 的键名 token(含行首边界插入)
        if (/^[^\s#-][^:]*:/.test(ln.text)) {
          const keyEnd = ln.from + ln.text.indexOf(':');   // 冒号绝对位置
          if (fromA <= keyEnd && toA >= ln.from) { ok = false; return; }
        }
      }
    });
    return ok ? tr : [];
  });
}

// export:给 vitest 用真 EditorView 断言扩展**真的生效**(编辑器改动纪律:光看 import 不算数,
// 历史上 diff 的块装饰就是「代码在、运行时抛错」)。生产路径仍只有下面的默认导出用它。
export function baseExtensions(onChange, readOnly, getScriptId, getOnAccept, getChapterIndex, getOnSel, getGhostEnabled, getGhostFetch) {
  return [
    frontMatterGuard(),
    aiContinueExtension(),
    chapterDiffExtension(),
    ghostCompleteExtension({
      isEnabled: () => { try { return !!(getGhostEnabled && getGhostEnabled()); } catch (_) { return false; } },
      fetchCompletion: (before) => { try { const f = getGhostFetch && getGhostFetch(); return f ? f(before) : ''; } catch (_) { return ''; } },
      // 采纳 ghost 后触发与「续写到正文」相同的知识同步提示(短文不足 12 字时父级会自行忽略)。
      onAccept: (text) => { try { getOnAccept?.()?.(text, { rewrite: false }); } catch (_) {} },
      // ghost 只在正文可用:front-matter 内会写脏 YAML 值;diff 审阅中/待定区未处理时
      // 继续生成会把文本插进一份即将被重建的文档。三种情况都直接不触发。
      isBlocked: (view) => {
        try {
          if (hasChapterDiff(view) || hasPendingContinue(view)) return true;
          const fmEnd = frontMatterEnd(view.state.doc);
          return fmEnd >= 0 && view.state.selection.main.head <= fmEnd;
        } catch (_) { return false; }
      },
    }),
    cmdKKeymap(getScriptId, getOnAccept, getChapterIndex),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    // IDE 基本功(v1.82.1)。依赖早就在(@codemirror/language / /search),只是从没开过 ——
    // 长章节(本平台单章常上万字)不能折叠、改个反复出现的称呼不能多光标,是编辑器体验缺口。
    // 折叠按 markdown 标题层级(lang-markdown 提供 foldService),对「## 第N章 / ### 小节」直接可用。
    codeFolding(),
    foldGutter({ openText: '▾', closedText: '▸' }),
    // 多光标:allowMultipleSelections 是**必需的开关**,不开则 Alt+点击 / Cmd+D 全部无效
    // (drawSelection 只负责画,不负责允许)。rectangularSelection = Alt+拖拽列选。
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown(),
    EditorView.lineWrapping,
    // Mod-d = 选中下一处相同文本(VSCode/Copilot 里改称呼的肌肉记忆)。放在 defaultKeymap
    // **之前**:defaultKeymap 里 Mod-d 是 deleteCharForward 的别名,放后面会被它吃掉。
    keymap.of([{ key: 'Mod-d', run: selectNextOccurrence, preventDefault: true }]),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
    warmTheme,
    EditorState.readOnly.of(!!readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange?.(u.state.doc.toString());
      // 选区变化 → 上报 {选中字数, 光标行:列, 总字数}(右栏选区改写 + 底部状态栏)。
      if (u.selectionSet || u.docChanged) {
        const s = u.state.selection.main;
        const doc = u.state.doc;
        const ln = doc.lineAt(s.head);
        getOnSel?.()?.({ len: s.empty ? 0 : (s.to - s.from), line: ln.number, col: s.head - ln.from + 1, total: doc.length });
      }
    }),
  ];
}

export default function CodeMirrorEditor({ value, docKey, onChange, readOnly = false, scriptId, onViewReady, onContinueAccept, chapterIndex, onSelectionChange, ghostEnabled = false, ghostFetch = null, onAiStateDiscarded = null }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const scriptIdRef = useRef(scriptId);
  scriptIdRef.current = scriptId;
  const onViewReadyRef = useRef(onViewReady);
  onViewReadyRef.current = onViewReady;
  const onContinueAcceptRef = useRef(onContinueAccept);
  onContinueAcceptRef.current = onContinueAccept;
  const chapterIndexRef = useRef(chapterIndex);
  chapterIndexRef.current = chapterIndex;
  const onSelChangeRef = useRef(onSelectionChange);
  onSelChangeRef.current = onSelectionChange;
  const ghostEnabledRef = useRef(ghostEnabled);
  ghostEnabledRef.current = ghostEnabled;
  const ghostFetchRef = useRef(ghostFetch);
  ghostFetchRef.current = ghostFetch;
  const onAiStateDiscardedRef = useRef(onAiStateDiscarded);
  onAiStateDiscardedRef.current = onAiStateDiscarded;
  const lastKeyRef = useRef(docKey);

  // 建一次。
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: value || '',
        extensions: baseExtensions((v) => onChangeRef.current?.(v), readOnly, () => scriptIdRef.current, () => onContinueAcceptRef.current, () => chapterIndexRef.current, () => onSelChangeRef.current, () => ghostEnabledRef.current, () => ghostFetchRef.current),
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    lastKeyRef.current = docKey;
    if (import.meta.env?.DEV) { try { window.__mdeView = view; } catch (_) {} }   // 仅 DEV:e2e 测试句柄(生产构建剔除)
    onViewReadyRef.current?.(view);   // 暴露给侧栏 agent 的「续写到正文」用
    return () => {
      // 组件卸载(切路由/切剧本)时中止在飞续写:否则 runContinue 的异步流会继续往
      // 已 destroy 的 view 上 dispatch,抛错或插到不该插的地方。这里只 abort,不还原原文。
      try { pendingCancelEffect(view); } catch (_) {}
      onViewReadyRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切标签(docKey 变)→ 用新文档重建 EditorState。
  // 为什么不是 dispatch 整篇替换:同一个 EditorView 的 history() 会把整篇替换记进撤销栈,
  // 用户切到第 2 章后按一次 Ctrl+Z / 工具栏撤销,就会把第 1 章正文倒回第 2 章标签;
  // onChange 标 dirty 后 2.5s 自动保存会用第 2 章的基线把第 1 章内容写进库。
  // setState 同时重置 history 和 pending/diff/ghost 这些 per-document 状态。
  // 旧状态的 AI 收尾回调仍要执行(中止流 / reject agent 提议),否则后端待确认会悬空。
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (lastKeyRef.current === docKey) return;   // 同标签,跳过(避免回灌)
    lastKeyRef.current = docKey;
    let hadAiState = false;
    try {
      if (hasPendingContinue(view)) {
        hadAiState = true;
        pendingCancelEffect(view);          // abort 在飞请求;返回的 effect 随旧 state 丢弃
      }
      if (chapterDiffKind(view)) {
        hadAiState = true;
        // agent diff 需要显式 reject 后端待确认;conflict diff 不替用户 force-save。
        chapterDiffCancelEffect(view, { reject: true });
      }
    } catch (_) {}
    const extensions = baseExtensions(
      (v) => onChangeRef.current?.(v),
      readOnly,
      () => scriptIdRef.current,
      () => onContinueAcceptRef.current,
      () => chapterIndexRef.current,
      () => onSelChangeRef.current,
      () => ghostEnabledRef.current,
      () => ghostFetchRef.current,
    );
    view.setState(EditorState.create({ doc: value || '', extensions }));
    if (hadAiState) { try { onAiStateDiscardedRef.current?.(); } catch (_) {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  return <div ref={hostRef} className="mde-cm" />;
}
