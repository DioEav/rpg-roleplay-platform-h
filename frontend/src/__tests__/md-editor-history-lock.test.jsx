/**
 * md-editor-history-lock.test.jsx — 两个 P0 编辑安全回归。
 *
 * 1. 切标签(docKey 变)必须重置 CodeMirror 撤销历史:否则切到第 2 章后按一次撤销,
 *    会把第 1 章正文倒回第 2 章标签,随后自动保存会用第 2 章基线把错内容写进库。
 * 2. diff 打开期间用户编辑必须被冻结:ops/装饰按打开时文档计算,接受/拒绝会用旧 ops
 *    整篇重建并覆盖用户输入。diff 自己的重建带 setChapterDiff 效果,仍应放行。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import CodeMirrorEditor from '../components/CodeMirrorEditor.jsx';
import {
  chapterDiffExtension, showChapterDiff, acceptChapterDiff, hasChapterDiff,
} from '../lib/md-diff.js';
import { runContinue } from '../lib/md-continue.js';

afterEach(() => { cleanup(); });

describe('切标签重置撤销历史', () => {
  it('docKey 变化后 undo 不会把上一标签内容倒回来', () => {
    let view = null;
    const onChange = vi.fn();
    const props = {
      value: 'A content',
      docKey: 'chapter:1',
      onChange,
      scriptId: 1,
      onViewReady: (v) => { if (v) view = v; },
      onContinueAccept: () => {},
      chapterIndex: 1,
      onSelectionChange: () => {},
      ghostEnabled: false,
      ghostFetch: null,
      onAiStateDiscarded: () => {},
    };
    const { rerender } = render(<CodeMirrorEditor {...props} />);
    expect(view).toBeTruthy();
    expect(view.state.doc.toString()).toBe('A content');

    act(() => {
      rerender(<CodeMirrorEditor {...props} value="B content" docKey="chapter:2" chapterIndex={2} />);
    });
    expect(view.state.doc.toString()).toBe('B content');

    act(() => { undo(view); });
    // 旧实现 reuses EditorView + 整篇 dispatch:这里会得到 'A content'(跨章污染)。
    expect(view.state.doc.toString()).toBe('B content');
  });
});

describe('diff 打开期间冻结用户编辑', () => {
  it('普通 docChange 被拦下;diff 自己的接受仍可整篇重建', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: 'L1\nL2', extensions: [chapterDiffExtension()] }),
      parent,
    });
    showChapterDiff(view, 'L1\nL2', 'L1\nL2 changed', { onAccept: vi.fn(), onReject: vi.fn(), onMixed: vi.fn() });
    expect(hasChapterDiff(view)).toBe(true);
    const afterShow = view.state.doc.toString();

    // 模拟用户编辑(事务不带 setChapterDiff 效果):必须被过滤器丢弃。
    view.dispatch({ changes: { from: 0, insert: 'USER ' } });
    expect(view.state.doc.toString()).toBe(afterShow);

    // diff 自己的「全部批准」带 setChapterDiff 效果:放行并完成重建。
    acceptChapterDiff(view);
    expect(hasChapterDiff(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('L1\nL2 changed');
    view.destroy();
  });
});

describe('AI 续写的 front-matter 边界', () => {
  it('光标停在 YAML 里时 runContinue 直接拒绝,不发请求', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const doc = '---\ntitle: 雪夜\n---\n\n正文第一段。';
    const view = new EditorView({ state: EditorState.create({ doc }), parent });
    // 光标放在 title 值里(front-matter 内)。
    view.dispatch({ selection: { anchor: doc.indexOf('雪夜') } });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runContinue(view, { scriptId: 1, instruction: '' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    view.destroy();
  });
});
