/**
 * md-diff-hunks.test.js — 章节内联 diff 的逐块(hunk)审阅回归测试。
 *
 * 用真实 CodeMirror EditorView(jsdom)挂载 chapterDiffExtension,跑真模块:
 *   · showChapterDiff 后 doc=newText、每个改动块各有一条工具条。
 *   · 顶栏「全部批准」→ onAccept;「全部拒绝」→ onReject + 还原旧文。
 *   · 逐块:接受块1 + 拒绝块2 → onMixed(混合文本),既不调 onAccept 也不调 onReject。
 *   · 确定性:reconstruct 的混合结果逐字锁定。
 */
import { describe, it, expect, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  chapterDiffExtension, showChapterDiff, acceptChapterDiff, rejectChapterDiff,
  hasChapterDiff, lineDiff, chapterDiffCancelEffect, discardAgentChapterDiff,
  chapterDiffLocalText, chapterDiffReviewKind,
} from '../lib/md-diff.js';

function mkView(text) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc: text, extensions: [chapterDiffExtension()] }), parent });
}

describe('md-diff lineDiff', () => {
  it('单行替换 → 一删一增', () => {
    const ops = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(ops.filter((o) => o.type === 'del').map((o) => o.text)).toContain('b');
    expect(ops.filter((o) => o.type === 'add').map((o) => o.text)).toContain('B');
    expect(ops.filter((o) => o.type === 'same').map((o) => o.text)).toEqual(['a', 'c']);
  });
});

describe('md-diff 逐块审阅', () => {
  it('放弃 agent diff:文档还原 oldText、清状态,不触发 onReject', () => {
    const v = mkView('旧文第一行\n旧文第二行');
    const onReject = vi.fn();
    showChapterDiff(v, '旧文第一行\n旧文第二行', 'AI 新第一行\nAI 新第二行', {
      kind: 'agent', onAccept: vi.fn(), onReject, onMixed: vi.fn(),
    });
    expect(v.state.doc.toString()).toBe('AI 新第一行\nAI 新第二行');
    expect(discardAgentChapterDiff(v)).toBe(true);
    expect(hasChapterDiff(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('旧文第一行\n旧文第二行');
    expect(onReject).not.toHaveBeenCalled();   // 切换对话只做本地回滚
    v.destroy();
  });

  it('放弃只对 agent diff 生效:conflict diff 原样保留', () => {
    const v = mkView('old');
    showChapterDiff(v, 'old', 'server-new', {
      kind: 'conflict', onAccept: vi.fn(), onReject: vi.fn(), onMixed: vi.fn(),
    });
    expect(discardAgentChapterDiff(v)).toBe(false);
    expect(hasChapterDiff(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('server-new');
    v.destroy();
  });

  it('diff 打开时提供「本地侧原文」供草稿持久化,关闭后为空', () => {
    const v = mkView('本地原文');
    showChapterDiff(v, '本地原文', 'AI 新文', {
      kind: 'agent', onAccept: vi.fn(), onReject: vi.fn(), onMixed: vi.fn(),
    });
    // 文档已被替换成 AI 文本,但草稿必须存本地原文,否则刷新会丢本地版本/自动保存 AI 文本。
    expect(v.state.doc.toString()).toBe('AI 新文');
    expect(chapterDiffLocalText(v)).toBe('本地原文');
    expect(chapterDiffReviewKind(v)).toBe('agent');
    rejectChapterDiff(v);
    expect(chapterDiffLocalText(v)).toBeNull();
    expect(chapterDiffReviewKind(v)).toBeNull();
    v.destroy();
  });

  it('两处改动 → 两条逐块工具条;doc=newText', () => {
    const v = mkView('L1\nL2\nL3\nL4\nL5');
    showChapterDiff(v, 'L1\nL2\nL3\nL4\nL5', 'L1\nX2\nL3\nX4\nL5', { onAccept: vi.fn(), onReject: vi.fn(), onMixed: vi.fn() });
    expect(hasChapterDiff(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('L1\nX2\nL3\nX4\nL5');
    expect(v.dom.querySelectorAll('.mde-diff-hunkbar').length).toBe(2);
    v.destroy();
  });

  it('全部批准 → onAccept,保留新文', () => {
    const v = mkView('L1\nL2\nL3\nL4\nL5');
    const onAccept = vi.fn(), onReject = vi.fn(), onMixed = vi.fn();
    showChapterDiff(v, 'L1\nL2\nL3\nL4\nL5', 'L1\nX2\nL3\nX4\nL5', { onAccept, onReject, onMixed });
    acceptChapterDiff(v);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    expect(onMixed).not.toHaveBeenCalled();
    expect(hasChapterDiff(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('L1\nX2\nL3\nX4\nL5');
    v.destroy();
  });

  it('全部拒绝 → onReject,还原旧文', () => {
    const v = mkView('A\nB\nC');
    const onAccept = vi.fn(), onReject = vi.fn(), onMixed = vi.fn();
    showChapterDiff(v, 'A\nB\nC', 'A\nB2\nC', { onAccept, onReject, onMixed });
    rejectChapterDiff(v);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
    expect(onMixed).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe('A\nB\nC');
    v.destroy();
  });

  it('逐块:接受块1 + 拒绝块2 → onMixed(混合文本逐字锁定)', () => {
    const v = mkView('L1\nL2\nL3\nL4\nL5');
    const onAccept = vi.fn(), onReject = vi.fn();
    let mixedText = null;
    const onMixed = vi.fn((t) => { mixedText = t; });
    showChapterDiff(v, 'L1\nL2\nL3\nL4\nL5', 'L1\nX2\nL3\nX4\nL5', { onAccept, onReject, onMixed });
    let bars = v.dom.querySelectorAll('.mde-diff-hunkbar');
    expect(bars.length).toBe(2);
    // 接受第一个改动块(保留 X2)
    bars[0].querySelector('.mde-diff-hunk-acc').click();
    expect(onMixed).not.toHaveBeenCalled();                 // 还有一块未决,不收尾
    bars = v.dom.querySelectorAll('.mde-diff-hunkbar');
    expect(bars.length).toBe(1);                            // 已决块的工具条消失
    // 拒绝第二个改动块(还原 L4)
    bars[0].querySelector('.mde-diff-hunk-rej').click();
    expect(onMixed).toHaveBeenCalledTimes(1);
    expect(mixedText).toBe('L1\nX2\nL3\nL4\nL5');           // 接受X2 + 还原L4
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    expect(hasChapterDiff(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('L1\nX2\nL3\nL4\nL5');
    v.destroy();
  });

  it('逐块全拒 = 全部拒绝语义(都 reject → onReject)', () => {
    const v = mkView('P\nQ\nR');
    const onAccept = vi.fn(), onReject = vi.fn(), onMixed = vi.fn();
    showChapterDiff(v, 'P\nQ\nR', 'P2\nQ\nR2', { onAccept, onReject, onMixed });
    const bars = v.dom.querySelectorAll('.mde-diff-hunkbar');
    expect(bars.length).toBe(2);
    bars[0].querySelector('.mde-diff-hunk-rej').click();
    v.dom.querySelector('.mde-diff-hunkbar').querySelector('.mde-diff-hunk-rej').click();
    expect(onReject).toHaveBeenCalledTimes(1);              // 全 reject → 走 onReject 而非 onMixed
    expect(onMixed).not.toHaveBeenCalled();
    expect(v.state.doc.toString()).toBe('P\nQ\nR');
    v.destroy();
  });

  it('已有未处理 diff 时拒绝叠加第二份(避免第一份回调悬空)', () => {
    const v = mkView('A');
    const r1 = showChapterDiff(v, 'A', 'B', { kind: 'agent', onAccept: vi.fn(), onReject: vi.fn(), onMixed: vi.fn() });
    const r2 = showChapterDiff(v, 'B', 'C', { kind: 'agent', onAccept: vi.fn(), onReject: vi.fn(), onMixed: vi.fn() });
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(hasChapterDiff(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('B');
    v.destroy();
  });

  it('切标签安全清理:agent diff 只清状态并 reject,不把旧文写回新文档', () => {
    const v = mkView('A');
    const onReject = vi.fn();
    showChapterDiff(v, 'A', 'B', { kind: 'agent', onAccept: vi.fn(), onReject, onMixed: vi.fn() });
    const eff = chapterDiffCancelEffect(v, { reject: true });
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'NEW-TAB' }, effects: eff });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(hasChapterDiff(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('NEW-TAB');
    v.destroy();
  });

  it('conflict diff 清理不回调 onReject(避免静默 force-save 本地版本)', () => {
    const v = mkView('A');
    const onReject = vi.fn();
    showChapterDiff(v, 'A', 'B', { kind: 'conflict', onAccept: vi.fn(), onReject, onMixed: vi.fn() });
    const eff = chapterDiffCancelEffect(v, { reject: true });
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'NEW-TAB' }, effects: eff });
    expect(onReject).not.toHaveBeenCalled();
    expect(hasChapterDiff(v)).toBe(false);
    expect(v.state.doc.toString()).toBe('NEW-TAB');
    v.destroy();
  });
});
