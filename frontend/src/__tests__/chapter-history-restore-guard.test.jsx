// ChapterHistory 恢复前的 AI 状态守卫:有未处理 diff/续写待定区时不能先写库恢复,
// 否则随后批准 diff 会把恢复结果覆盖。守卫由父级传入,这里只验证调用时机。
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ChapterHistory } from '../components/md-editor/ChapterHistory.jsx';

const VERSION = {
  id: 3, kind: 'chapter_edit', message: 'AI 改写章节 #1', created_at: '2026-10-25T01:00:00',
  has_before: true, undone: false, source: 'ai', save_count: 1,
};

beforeEach(() => {
  window.api = {
    scripts: {
      chapterHistory: vi.fn(async () => ({ ok: true, chapter_id: 11, versions: [VERSION] })),
      chapterRestore: vi.fn(async () => ({ ok: true })),
    },
  };
});

describe('ChapterHistory 恢复守卫', () => {
  it('onBeforeRestore 返回 false 时不发恢复请求、不回调 onRestored', async () => {
    const onRestored = vi.fn();
    render(
      <ChapterHistory scriptId={1} chapterIndex={1} onClose={() => {}} onRestored={onRestored}
        onBeforeRestore={() => false} />,
    );
    await waitFor(() => expect(screen.getByText('恢复到此前')).toBeTruthy());
    fireEvent.mouseDown(screen.getByText('恢复到此前'));
    expect(window.api.scripts.chapterRestore).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('onBeforeRestore 通过时正常恢复并回调', async () => {
    const onRestored = vi.fn();
    render(
      <ChapterHistory scriptId={1} chapterIndex={1} onClose={() => {}} onRestored={onRestored}
        onBeforeRestore={() => true} />,
    );
    await waitFor(() => expect(screen.getByText('恢复到此前')).toBeTruthy());
    fireEvent.mouseDown(screen.getByText('恢复到此前'));
    await waitFor(() => expect(window.api.scripts.chapterRestore).toHaveBeenCalledTimes(1));
    expect(onRestored).toHaveBeenCalled();
  });
});
