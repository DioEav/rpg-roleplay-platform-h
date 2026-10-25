// md-continue.js — Cursor 风「AI 续写/改写正文」引擎(CodeMirror 6)。
// 设计:LLM 只产正文文本(流式),前端确定性决定插哪(选中→改写替换 / 光标→续写插入),
// 插入内容高亮为「待定区」,Tab 接受 / Esc 放弃 —— 即 VSCode/Cursor 的 Cmd+K 应用到小说正文。
// 复用后端 POST /api/console_assistant/continue(SSE: token/done/error)。
import { StateField, StateEffect, Prec, Transaction } from '@codemirror/state';
import { EditorView, Decoration, keymap, showPanel } from '@codemirror/view';
import { setPanelVisible } from './md-panel.js';
import { consumeSSE } from './sse-consume.js';
import { frontMatterEndOf } from './md-serialize.js';
import { hasChapterDiff } from './md-diff.js';

// 裸 fetch 不经过 api-client 的 BASE:跨域部署(静态托管 + 独立 API 域名)时必须补上。
const apiBase = () => (typeof window !== 'undefined' && window.__API_BASE) || '';

// ── 待定区状态(高亮 + 范围 + 改写时的原文,用于放弃还原)──────────────────
const setPending = StateEffect.define();   // {from,to,original,busy} | null

export const pendingField = StateField.define({
  create: () => null,
  update(val, tr) {
    let v = val;
    if (v && tr.docChanged) {
      // 流式插入会改文档,映射范围;from 用 -1(不随插入右移)、to 用 1(随插入扩张)。
      v = { ...v, from: tr.changes.mapPos(v.from, -1), to: tr.changes.mapPos(v.to, 1) };
    }
    for (const e of tr.effects) if (e.is(setPending)) v = e.value;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (v) =>
    (v && v.to > v.from)
      ? Decoration.set([Decoration.mark({ class: 'mde-ai-pending' }).range(v.from, v.to)])
      : Decoration.none),
});

function pendingState(view) { return view.state.field(pendingField, false) || null; }

// 供切标签/卸载前判断:当前视图是否还有 AI 待定区(生成中或已生成待接受)。
export function hasPendingContinue(view) {
  return !!pendingState(view);
}

// 草稿持久化用:待定区里的文本是「未接受的 AI 生成」,当前 doc 不能直接当草稿存
// (刷新后待定区状态消失,自动保存会把未接受文本落库)。用待定区 [from,to) 反向
// 还原成 AI 介入前的本地文档:
//   · continue:original='' → 去掉插入段;
//   · rewrite: original=被替换的选中文本 → 用原文换回生成段。
export function pendingLocalTextFromParts(docText, from, to, original) {
  const s = String(docText ?? '');
  const a = Math.max(0, Math.min(Number(from) || 0, s.length));
  const b = Math.max(a, Math.min(Number(to) || 0, s.length));
  return s.slice(0, a) + String(original ?? '') + s.slice(b);
}

export function pendingLocalText(view) {
  const p = pendingState(view);
  if (!p) return null;
  return pendingLocalTextFromParts(view.state.doc.toString(), p.from, p.to, p.original);
}

// 安全清理:中止在飞请求并清空待定区,但【不还原原文】。
// 调用方即将整篇替换文档(切标签/切剧本),此时还原只会制造一次无意义的中间文档。
// 若需要保留旧标签内容,调用方应先用 rejectPending(会还原原文)。
export function pendingCancelEffect(view) {
  const p = pendingState(view);  if (!p) return null;
  try { p.ctrl?.abort(); } catch (_) {}
  return setPending.of(null);
}

export function acceptPending(view) {
  const p = pendingState(view);
  if (!p) return false;
  // 接受前先抓住这段被接受的正文,清空待定区后回调(用于「续写后同步设定到知识库」桥接)。
  const text = view.state.doc.sliceString(p.from, p.to);
  view.dispatch({ effects: setPending.of(null) });
  try { p.ctrl?.abort(); } catch (_) {}   // 用户 Tab 提前采纳时,立即停掉剩余流
  view.focus();
  if (text && text.trim() && typeof p.onAccept === 'function') {
    try { p.onAccept(text, { rewrite: !!p.rewrite }); } catch (_) {}
  }
  return true;
}

export function rejectPending(view) {
  const p = pendingState(view);
  if (!p) return false;
  try { p.ctrl?.abort(); } catch (_) {}   // Esc 取消时立即断流,不等下一个 token
  // 删掉插入的待定文本;改写模式还原原文。
  // 不进 undo 历史:待定区的增删由 Tab/Esc 两个显式动作管理。若让 Ctrl+Z 能撤销
  // 这里的还原/插入,历史里的位置与 pendingField 的范围会脱节,后续 token 会插错位。
  view.dispatch({
    changes: { from: p.from, to: p.to, insert: p.original || '' },
    effects: setPending.of(null),
    annotations: Transaction.addToHistory.of(false),
  });
  view.focus();
  return true;
}

// ── 顶部提示条(待定时显示 Tab 接受 / Esc 放弃)──────────────────────────
function pendingPanel(view) {
  const dom = document.createElement('div');
  dom.className = 'mde-ai-panel';
  dom.style.display = 'none';
  const sync = (v) => {
    const p = v.state.field(pendingField, false);
    setPanelVisible(dom, !!p);
    if (p) dom.textContent = p.busy ? 'AI 生成中…  Esc 取消' : 'AI 续写完成 —  Tab 接受   Esc 放弃';
  };
  sync(view);
  return { dom, update: (u) => sync(u.view) };
}

// ── 待定期间的快捷键(高优先级:Tab 接受 / Esc 放弃)────────────────────
const pendingKeymap = Prec.highest(keymap.of([
  { key: 'Tab', run: (view) => acceptPending(view) },
  { key: 'Mod-Enter', run: (view) => acceptPending(view) },
  { key: 'Escape', run: (view) => rejectPending(view) },
]));

export function aiContinueExtension() {
  return [pendingField, showPanel.of(pendingPanel), pendingKeymap];
}

const BEFORE_CAP = 4000, AFTER_CAP = 1500;

// ── 主入口:对一个 EditorView 跑一次续写/改写 ────────────────────────────
// opts: { scriptId, instruction, onState?(s) }  s ∈ 'busy'|'done'|'error'|'cancel'
export async function runContinue(view, opts = {}) {
  if (!view) return;
  // diff 审阅中禁止再起续写:编辑器已被 diff 锁成不可编辑,流式 token 会被事务过滤器
  // 静默丢掉,只在界面上留下一个永远「生成中」的待定区。Cmd+K 也走这里,所以必须在此拦。
  if (hasChapterDiff(view)) {
    try {
      window.__apiToast?.('请先处理编辑器里的 AI 改动审阅', {
        kind: 'warn',
        detail: '点顶栏「全部批准 / 拒绝」或逐块处理完 diff 后,再发起续写。',
      });
    } catch (_) {}
    opts.onState?.('error', 'diff-open');
    return;
  }
  if (pendingState(view)) rejectPending(view);   // 已有待定 → 先清掉再来

  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const rewrite = !sel.empty;
  const selectionText = rewrite ? doc.sliceString(sel.from, sel.to) : '';
  const anchor = rewrite ? sel.from : sel.head;
  // AI 只能写正文:front matter 是结构化元数据(YAML),把模型输出塞进去会把 title/keys
  // 等值写脏。frontMatterEndOf 返回闭合围栏后的下标;光标/选区落在它之前一律拒绝。
  const fmEnd = frontMatterEndOf(doc.toString());
  if (fmEnd >= 0 && (anchor <= fmEnd || (rewrite && sel.from <= fmEnd))) {
    try {
      window.__apiToast?.('AI 续写/改写只作用于正文', {
        kind: 'warn',
        detail: '光标或选区在 YAML front-matter 里。请把光标移到正文区(闭合 --- 之后)再试。',
      });
    } catch (_) {}
    opts.onState?.('error', 'front-matter');
    return;
  }
  const before = doc.sliceString(Math.max(0, anchor - BEFORE_CAP), anchor);
  const afterStart = rewrite ? sel.to : sel.head;
  const after = doc.sliceString(afterStart, Math.min(doc.length, afterStart + AFTER_CAP));

  // 改写:先删选中,插入点 = 选中起点(原文存进待定区,放弃时还原)。
  let insertAt = anchor;
  if (rewrite) {
    // 改写删除也不进 undo 历史:否则用户 Ctrl+Z 会把原文倒回来,而待定区/流仍按
    // 删除后的位置插入,导致插入点错位。取消改写统一走 Esc(rejectPending 会还原)。
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: '' },
      annotations: Transaction.addToHistory.of(false),
    });
    insertAt = sel.from;
  }
  // 建空待定区(busy)。onAccept/rewrite/ctrl 随待定区一路携带,接受时回调用于「同步到知识库」桥接,
  // ctrl 用于切标签/取消时确定性中止在飞请求(否则流会继续打到已经换过文档的视图上)。
  const ctrl = new AbortController();
  view.dispatch({ effects: setPending.of({ from: insertAt, to: insertAt, original: selectionText, busy: true, onAccept: opts.onAccept, rewrite, ctrl }) });
  view.focus();

  let got = false;
  opts.onState?.('busy');

  const insertToken = (text) => {
    if (!text) return;
    const p = pendingState(view);
    if (!p) { ctrl.abort(); return; }   // 用户中途取消
    // 插入点取「待定区末尾」p.to —— pendingField 已随并发编辑重映射;不用裸闭包整数 pos,
    // 否则流式期间用户在待定区前手输使文档左移、旧 pos 失效 → token 插错位、高亮与实文发散(harness 审计 P2)。
    const at = p.to;
    view.dispatch({
      changes: { from: at, insert: text },
      effects: setPending.of({ from: p.from, to: at + text.length, original: p.original, busy: true, onAccept: p.onAccept, rewrite: p.rewrite, ctrl: p.ctrl }),
      scrollIntoView: true,
      // 流式 token 不进 undo 历史:待定区的接受/放弃由 Tab/Esc 管理。
      annotations: Transaction.addToHistory.of(false),
    });
    got = true;
  };

  try {
    const res = await fetch(`${apiBase()}/api/console_assistant/continue`, {
      method: 'POST', credentials: 'include', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        before, after, selection: selectionText,
        instruction: opts.instruction || '',
        mode: rewrite ? 'rewrite' : 'continue',
        script_id: opts.scriptId,
        chapter_index: (opts.chapterIndex != null ? opts.chapterIndex : null),  // 后端据此装配相关设定+防剧透
      }),
    });
    let errMsg = '';
    await consumeSSE(res, (ev, data) => {
      if (ev === 'token') insertToken(data.text || '');
      else if (ev === 'error') errMsg = data.message || '生成失败';
    }, { signal: ctrl.signal });

    const p = pendingState(view);
    if (!p) { opts.onState?.('cancel'); return; }
    if (!got) {
      // SSE 正常结束却一个 token 都没产出(模型返空/拒答/上下文不适合补全),或带 error —— 别留个
      // 空的「续写完成」让用户以为写了却「啥也没看到」(群反馈 耀月余辉)。撤回空待定区 + 明确提示。
      rejectPending(view);
      opts.onState?.('error', errMsg || 'empty');
      try {
        window.__apiToast?.(
          errMsg ? 'AI 续写失败' : 'AI 没有返回续写内容',
          { kind: errMsg ? 'danger' : 'warn',
            detail: errMsg || '该模型对当前上下文没有给出补全。试试:把光标放进正文段落里、先选中一段再「改写」、或在右栏切换一个模型重试。' },
        );
      } catch (_) {}
      return;
    }
    if (errMsg) {
      // 已收到部分 token 后服务端报错:保留已生成的部分,但必须把 busy 落下,让用户
      // Tab 接受 / Esc 放弃。旧实现忽略 errMsg 直接标 done,错误被吞掉;网络异常路径
      // 则让 pending 永远停在"生成中",保存/切标签一直被 hasPendingContinue 拦住。
      view.dispatch({ effects: setPending.of({ ...p, busy: false }) });
      opts.onState?.('error', errMsg);
      try {
        window.__apiToast?.('AI 续写中断(已保留部分内容)', {
          kind: 'danger',
          detail: `${errMsg}。可 Tab 接受已生成部分,或 Esc 放弃。`,
        });
      } catch (_) {}
      return;
    }
    // 完成:留高亮 + 提示条,等用户 Tab 接受 / Esc 放弃。
    view.dispatch({ effects: setPending.of({ from: p.from, to: p.to, original: p.original, busy: false, onAccept: p.onAccept, rewrite: p.rewrite, ctrl: p.ctrl }) });
    opts.onState?.('done');
  } catch (e) {
    // 切标签 / Esc / 主动 abort 不是错误:静默收尾,不弹「AI 续写出错」红条。
    if (ctrl.signal.aborted) { opts.onState?.('cancel'); return; }
    const p = pendingState(view);
    if (p) {
      if (got) {
        // 已生成部分文本:保留内容、结束 busy,交给用户决定接受还是放弃。
        view.dispatch({ effects: setPending.of({ ...p, busy: false }) });
      } else {
        rejectPending(view);
      }
    }
    opts.onState?.('error', e?.message);
    try { window.__apiToast?.('AI 续写出错', { kind: 'danger', detail: e?.message }); } catch (_) {}
  }
}

// ── Cmd+K 行内指令:复用全局 __prompt 取指令 → runContinue ────────────────
// getOnAccept:可选,返回「接受续写后同步知识库」回调,与侧栏「续写到正文」共用同一桥接。
export function cmdKKeymap(getScriptId, getOnAccept, getChapterIndex) {
  return keymap.of([{
    key: 'Mod-k',
    run: (view) => {
      (async () => {
        const sel = view.state.selection.main;
        const title = sel.empty ? 'AI 续写(光标处)' : 'AI 改写选中段';
        let instr = '';
        try {
          instr = await (window.__prompt
            ? window.__prompt({ title, label: '指令(可空;续写直接回车=顺势写)', default: '' })
            : Promise.resolve(prompt(title)));
        } catch (_) { instr = null; }
        if (instr === null) return;   // 取消
        runContinue(view, { scriptId: getScriptId?.(), instruction: instr, onAccept: getOnAccept?.(), chapterIndex: getChapterIndex?.() });
      })();
      return true;
    },
  }]);
}
