/**
 * filetree-keydown.test.jsx — 资源管理器键盘事件不能劫持搜索框。
 *
 * 回归:keydown 挂在树根上,搜索框是它的后代。之前不做 target 判断,
 * 在搜索框按 Backspace 会触发「删除选中章节」确认,按 Enter 会打开选中节点。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { FileTree } from '../components/md-editor/FileTree.jsx';

afterEach(() => {
  cleanup();
  delete window.api;
  delete window.__confirm;
  delete window.__apiToast;
});

function mockTree() {
  window.api = {
    scripts: {
      chapters: vi.fn(async () => ({
        chapters: [{ chapter_index: 1, title: '雨夜来客', word_count: 12 }],
      })),
    },
  };
  window.__confirm = vi.fn(async () => false);
  window.__apiToast = vi.fn();
}

describe('FileTree 键盘事件', () => {
  it('搜索框里按 Backspace / Enter 不会删除或打开树节点', async () => {
    mockTree();
    const openNode = vi.fn();
    const { container } = render(
      <FileTree scriptId={1} openNode={openNode} activeKey={null} reloadKey={0} onMutate={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelector('.mde-tree-item')).toBeTruthy());
    fireEvent.click(container.querySelector('.mde-tree-item'));   // 先选中一个节点
    openNode.mockClear();

    const input = container.querySelector('.mde-tree-filter');
    fireEvent.keyDown(input, { key: 'Backspace' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(window.__confirm).not.toHaveBeenCalled();
    expect(openNode).not.toHaveBeenCalled();
  });

  it('树根获得焦点后键盘仍可操作节点', async () => {
    mockTree();
    const openNode = vi.fn();
    const { container } = render(
      <FileTree scriptId={1} openNode={openNode} activeKey={null} reloadKey={0} onMutate={vi.fn()} />,
    );

    await waitFor(() => expect(container.querySelector('.mde-tree-item')).toBeTruthy());
    fireEvent.click(container.querySelector('.mde-tree-item'));
    openNode.mockClear();

    const root = container.querySelector('.mde-tree');
    fireEvent.keyDown(root, { key: 'Enter' });
    expect(openNode).toHaveBeenCalledTimes(1);
  });
});
