/**
 * game-confirm-strip-running.test.jsx —— 回合生成中禁用待审/待答操作。
 *
 * 背景:待答选项会调用 startRun(中止当前 SSE);待审写入可能被本轮快照覆盖。
 * 生成中只禁用「允许/拒绝/回答/配置卡继续」,保留展开、稍后处理、去设置等非破坏操作。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfirmStrip } from '../components/game/GameConfirmStrip.jsx';

const ACTIONS = {
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onAnswer: vi.fn(),
  onDismiss: vi.fn(),
  onConfigDefault: vi.fn(),
  onConfigContinue: vi.fn(),
  onConfigSettings: vi.fn(),
};

const PENDING = {
  pendingWrites: [{ id: 1, field: 'world.time', from: '黄昏', to: '深夜', risk: 'low', reason: '测试' }],
  pendingQuestions: [
    { id: 2, question: '接下来怎么办？', options: ['继续赶路', '原地休息'] },
    {
      id: 3, kind: 'config_card', mode: 'ask_default', capability: 'llm',
      api_id: 'deepseek', model: 'deepseek-v4', question: '给主 GM 配个模型',
    },
  ],
};

const btn = (text) => screen.getByText(text).closest('button');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConfirmStrip — 回合生成中', () => {
  it('允许/拒绝/选项/配置卡生成按钮禁用,并显示等待提示', () => {
    render(<ConfirmStrip {...ACTIONS} {...PENDING} running />);

    expect(btn('允许').disabled).toBe(true);
    expect(btn('拒绝').disabled).toBe(true);
    expect(btn('继续赶路').disabled).toBe(true);
    expect(btn('原地休息').disabled).toBe(true);
    expect(btn('用 deepseek-v4 生成').disabled).toBe(true);
    expect(screen.getByText(/本轮生成中/)).toBeTruthy();
  });

  it('非生成中时上述按钮全部可用', () => {
    render(<ConfirmStrip {...ACTIONS} {...PENDING} />);

    expect(btn('允许').disabled).toBe(false);
    expect(btn('拒绝').disabled).toBe(false);
    expect(btn('继续赶路').disabled).toBe(false);
    expect(btn('原地休息').disabled).toBe(false);
    expect(btn('用 deepseek-v4 生成').disabled).toBe(false);
    expect(screen.queryByText(/本轮生成中/)).toBeNull();
  });
});
