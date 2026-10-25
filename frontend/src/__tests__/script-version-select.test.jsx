/**
 * script-version-select.test.jsx — 顶栏版本历史只读查看器。
 *
 * 回归点:
 *   · 后端 commit id 是数字(bigint→JSON number),旧代码直接 c.id.slice / headCommitId.slice
 *     会抛 "slice is not a function";这里锁「数字 id 也能渲染」。
 *   · 后端 checkout 仍是 501 stub,列表行必须是只读 div,不能再渲染成可点 button。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScriptVersionSelect } from '../components/game/ScriptVersionSelect.jsx';

beforeEach(() => {
  window.api = {
    scripts: {
      commits: vi.fn().mockResolvedValue({
        ok: true,
        commits: [
          { id: 202, message: '最新的改动', kind: 'editor' },
          { id: 101, message: '旧版本', kind: 'editor' },
        ],
      }),
    },
  };
});

describe('ScriptVersionSelect — 只读版本历史', () => {
  it('数字 commit id 正常渲染;列表行只读,不再有切换按钮', async () => {
    const { container } = render(<ScriptVersionSelect scriptId={7} headCommitId={202} />);

    // 顶部只有一个展开/收起按钮;点开后列表是 div 行(不是可点的切换按钮)。
    fireEvent.click(await screen.findByRole('button', { name: /HEAD/i }));

    await waitFor(() => expect(screen.getByText('最新的改动')).toBeInTheDocument());
    expect(screen.getByText('202')).toBeInTheDocument();
    expect(screen.getByText('101')).toBeInTheDocument();
    expect(container.querySelectorAll('.gc-version-row')).toHaveLength(2);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});
