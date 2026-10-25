/**
 * game-msg-actions-busy.test.jsx —— 回合生成中禁用会改动存档的消息操作。
 *
 * 回归点:分支 / 重新生成 / 编辑 / 删除都会改活跃 commit 或落库消息,与在途 SSE 回合
 * 存在竞态;生成中必须 disabled(复制不受影响,仍可用)。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { NarrativeBlock, PlayerBlock } from '../components/game/GameChatMessages.jsx';

beforeEach(() => {
  window.api = {
    branches: { continueFrom: vi.fn() },
    game: { editMessage: vi.fn(), state: vi.fn().mockResolvedValue({}) },
  };
  window.toast = vi.fn();
});

function actionButtons(container) {
  return Array.from(container.querySelectorAll('.gc-msg-actions .iconbtn'));
}

describe('MsgActions — 回合生成中', () => {
  it('分支/重新生成/编辑/删除禁用,复制仍可用', () => {
    const { container } = render(
      <NarrativeBlock text="GM 正文" ts="12:00" saveId={7} msgIndex={2} busy />,
    );
    const buttons = actionButtons(container);
    // copy + fork + regen + edit + delete
    expect(buttons).toHaveLength(5);
    expect(buttons[0].disabled).toBe(false);          // 复制
    expect(buttons.slice(1).every((b) => b.disabled)).toBe(true);
    expect(buttons[1].getAttribute('data-tip')).toMatch(/生成中|generating/i);
  });

  it('空闲时分支/重新生成/编辑/删除可点', () => {
    const { container } = render(
      <NarrativeBlock text="GM 正文" ts="12:00" saveId={7} msgIndex={2} />,
    );
    const buttons = actionButtons(container);
    expect(buttons).toHaveLength(5);
    expect(buttons.every((b) => b.disabled === false)).toBe(true);
  });

  it('编辑框在开跑前已打开:生成中 textarea 与保存按钮都禁用', () => {
    const { container } = render(
      <PlayerBlock text="我推门而入" ts="12:00" saveId={7} msgIndex={2} busy />,
    );
    // 模拟「编辑框已打开后回合才开始生成」:直接派发编辑事件。
    act(() => {
      window.dispatchEvent(new CustomEvent('rpg-edit-message', {
        detail: { saveId: 7, msgIndex: 2 },
      }));
    });
    const ta = container.querySelector('textarea');
    expect(ta).toBeTruthy();
    expect(ta.disabled).toBe(true);
    const saveBtn = container.querySelector('.btn.primary');
    expect(saveBtn).toBeTruthy();
    expect(saveBtn.disabled).toBe(true);
  });
});
