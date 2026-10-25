// md-ghost.js — Copilot 风「内联续写(ghost text)」(CodeMirror 6)。
// 作者打字停顿后,向后端要一句短续写,以暗色幽灵文本显示在光标后;按 Tab 采纳、Esc/继续打字/移动光标即消失。
// 用户隔离在后端(owner-scoped + 用户自有模型/key);前端只负责触发节流 + 渲染 + 采纳。
import { StateField, StateEffect, Prec } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap } from '@codemirror/view';

// 状态:{ text, pos } | null —— pos 是请求时的光标位置(幽灵文本锚点)。
const setGhostE = StateEffect.define();
const clearGhostE = StateEffect.define();

export const ghostField = StateField.define({
  create: () => null,
  update(val, tr) {
    let v = val;
    if (tr.docChanged) v = null;                                  // 任何文档改动作废(含采纳插入本身)
    for (const e of tr.effects) { if (e.is(setGhostE)) v = e.value; else if (e.is(clearGhostE)) v = null; }
    if (v && tr.selection && tr.newSelection.main.head !== v.pos) v = null;   // 光标移开作废
    return v;
  },
});

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'mde-ghost';
    span.textContent = this.text;            // textContent 保留换行需配 CSS white-space: pre-wrap
    return span;
  }
  ignoreEvent() { return true; }
}

const ghostDeco = EditorView.decorations.compute([ghostField], (state) => {
  const v = state.field(ghostField, false);
  if (!v || !v.text) return Decoration.none;
  const pos = Math.min(v.pos, state.doc.length);
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(v.text), side: 1 }).range(pos)]);
});

export function hasGhost(view) { const v = view.state.field(ghostField, false); return !!(v && v.text); }

// 采纳:把幽灵文本插入光标处,光标移到末尾。返回 true 以消费 Tab(无幽灵时返回 false 让 Tab 走缩进)。
// onAccept 可选:鲜活文本同样是 AI 续写,采纳后交给父级走「同步设定到知识库」桥接
// (与侧栏「续写到正文」/ ⌘K 的 onAccept 一致;旧实现只有后者会提示同步)。
export function acceptGhost(view, onAccept) {
  const v = view.state.field(ghostField, false);
  if (!v || !v.text) return false;
  const text = v.text;
  const pos = Math.min(v.pos, view.state.doc.length);
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    effects: clearGhostE.of(null),
    userEvent: 'input.complete',
  });
  if (typeof onAccept === 'function') {
    try { onAccept(text); } catch (_) {}
  }
  return true;
}

export function clearGhost(view) {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: clearGhostE.of(null) });
  return true;
}

// 触发器:作者「打字」停顿 delay 后,取光标前文 fetchCompletion → 若期间无新输入/光标未移 → setGhost。
function ghostTrigger({ isEnabled, fetchCompletion, delay = 650 }) {
  let timer = null, seq = 0;
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged && !u.selectionSet) return;
    if (timer) { clearTimeout(timer); timer = null; }    // 任何变动取消挂起请求
    seq++;
    const mySeq = seq;
    if (typeof isEnabled === 'function' && !isEnabled()) return;
    if (typeof fetchCompletion !== 'function') return;
    const sel = u.state.selection.main;
    if (!sel.empty) return;                              // 有选区不触发
    // 仅「打字输入」触发(input.type / 其 compose 变体);粘贴/删除/采纳(input.complete)不触发
    const typed = u.transactions.some((t) => t.isUserEvent('input.type'));
    if (!typed) return;
    const view = u.view;
    const pos = sel.head;
    const before = u.state.doc.sliceString(Math.max(0, pos - 1500), pos);
    if (before.trim().length < 4) return;
    timer = setTimeout(async () => {
      timer = null;
      let text = '';
      try { text = await fetchCompletion(before); } catch (_) { return; }
      if (mySeq !== seq) return;                         // 期间又动过 → 作废
      if (!text) return;
      const cur = view.state.selection.main;
      if (!cur.empty || cur.head !== pos) return;        // 光标已移 → 作废
      if (view.state.field(ghostField, false)) return;   // 已有幽灵
      view.dispatch({ effects: setGhostE.of({ text: String(text), pos }) });
    }, delay);
  });
}

// keymap 用 Prec.highest 抢在缩进(indentWithTab)之前:有幽灵→Tab 采纳,无幽灵→返回 false 放行缩进。
export function ghostCompleteExtension(opts = {}) {
  return [
    ghostField,
    ghostDeco,
    Prec.highest(keymap.of([
      { key: 'Tab', run: (view) => acceptGhost(view, opts.onAccept) },
      { key: 'Escape', run: clearGhost },
    ])),
    ghostTrigger(opts),
  ];
}
