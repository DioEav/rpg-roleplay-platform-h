/**
 * tavern-msg-fork.test.jsx — 酒馆消息分支按钮的「fork = 新对话」语义。
 *
 * 背景:游戏台的分支按钮(branches.continueFrom)对酒馆档是同档指针倒回——原对话尾巴
 * 变成酒馆 UI 不可达的孤儿分支。酒馆的正确分叉 = 克隆出新对话(原对话保留)。
 *
 * 覆盖:
 *   · forkKind="tavern" 时点分支按钮 → 派发 rpg-tavern-fork 事件,不弹确认框、不调 continueFrom
 *   · 索引折算:玩家输入原值、角色回复 +1(与后端 resolve_commit_id_by_message 回合口径对齐)
 *   · hideFork → 分支按钮不渲染(游戏台误载酒馆档的堵漏)
 *   · 未传 forkKind(游戏台)→ 仍弹 ForkConfirmModal、确认后走 continueFrom(零回归)
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { PlayerBlock, NarrativeBlock } from '../components/game/GameChatMessages.jsx';

function mockApi() {
  window.api = {
    branches: { continueFrom: vi.fn().mockResolvedValue({ ok: true, active_commit_id: 99 }) },
    tavern: { fork: vi.fn().mockResolvedValue({ ok: true, new_save_id: 55, save: { id: 55, title: 'x' } }) },
  };
  window.toast = vi.fn();
  return window.api;
}

function forkButton(container) {
  const btns = Array.from(container.querySelectorAll('.gc-msg-actions .iconbtn'));
  return btns.find((b) => {
    const tip = b.getAttribute('data-tip') || '';
    // 酒馆可用态:"在此消息处开启新对话";游戏可用态:"从这里新建分支";
    // 禁用态(两者共用):"缺存档上下文，无法分支"。
    return /开启新对话|新建分支|new chat|new branch|无法分支/i.test(tip);
  });
}

describe('酒馆消息 fork(forkKind="tavern")', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('玩家消息:点击派发 rpg-tavern-fork,message_index 原值,不调 continueFrom', async () => {
    const api = mockApi();
    const events = [];
    const onFork = (e) => events.push(e.detail);
    window.addEventListener('rpg-tavern-fork', onFork);
    const { container } = render(
      <PlayerBlock text="我推门而入" ts="12:00" saveId={7} msgIndex={3} forkKind="tavern" />,
    );
    const btn = forkButton(container);
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ save_id: 7, message_index: 3 });
    expect(api.branches.continueFrom).not.toHaveBeenCalled();
    // 非破坏性操作:不弹 ForkConfirmModal(确认框为 game fork 专属)
    expect(container.textContent).not.toContain('新分叉');
    window.removeEventListener('rpg-tavern-fork', onFork);
  });

  it('角色回复:message_index +1(新对话包含该回复)', async () => {
    const api = mockApi();
    const events = [];
    const onFork = (e) => events.push(e.detail);
    window.addEventListener('rpg-tavern-fork', onFork);
    const { container } = render(
      <NarrativeBlock text="她抬起头。" ts="12:01" saveId={7} msgIndex={4} forkKind="tavern" />,
    );
    fireEvent.click(forkButton(container));
    await waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ save_id: 7, message_index: 5 });
    expect(api.branches.continueFrom).not.toHaveBeenCalled();
    window.removeEventListener('rpg-tavern-fork', onFork);
  });

  it('缺 saveId/msgIndex 时按钮禁用', () => {
    mockApi();
    const { container } = render(
      <PlayerBlock text="我推门而入" ts="12:00" forkKind="tavern" />,
    );
    const btn = forkButton(container);
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it('hideFork → 分支按钮不渲染(其余动作按钮保留)', () => {
    mockApi();
    const { container } = render(
      <PlayerBlock text="我推门而入" ts="12:00" saveId={7} msgIndex={3} hideFork />,
    );
    expect(forkButton(container)).toBeFalsy();
    // 复制按钮仍在(fork 之外的动作不受影响)
    const btns = Array.from(container.querySelectorAll('.gc-msg-actions .iconbtn'));
    expect(btns.length).toBeGreaterThan(0);
  });
});

describe('游戏台 fork 零回归(未传 forkKind)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('点击弹确认框,确认后走 branches.continueFrom', async () => {
    const api = mockApi();
    const events = [];
    const onFork = (e) => events.push(e.detail);
    window.addEventListener('rpg-tavern-fork', onFork);
    const { container } = render(
      <NarrativeBlock text="GM 正文" ts="12:00" saveId={7} msgIndex={2} commitId={31} />,
    );
    const btn = forkButton(container);
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    // 确认框出现(确认按钮文案 = game.app.fork_modal.new_branch "新建分支")
    const confirmBtn = await waitFor(() => {
      const el = Array.from(document.querySelectorAll('button')).find((b) => /新建分支|create new branch/i.test(b.textContent || ''));
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(api.branches.continueFrom).toHaveBeenCalledTimes(1));
    expect(api.branches.continueFrom).toHaveBeenCalledWith(expect.objectContaining({ node_id: 31 }));
    // 游戏 fork 不派发酒馆事件
    expect(events.length).toBe(0);
    window.removeEventListener('rpg-tavern-fork', onFork);
  });
});
