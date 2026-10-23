/**
 * modelparams-thinking-selected.test.jsx
 *
 * 设置页「深度思考」档位必须跟随 /api/models 顶层的 selected(= 当前真正生效的
 * 模型:存档 session_model > GM 偏好),而不是 catalog 内嵌的 models.selected
 * (全局默认 / 用户第一个有凭证的模型)。
 *
 * 回归背景:两者不同时,编辑 A 模型的可用档位,设置页却按 B 模型渲染按钮,
 * 表现为「模型编辑里的可用档位不生效」。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelParamsSection } from '../components/settings/modelparams-section.jsx';

function reasoning(levels, defaultLevel, dialect = 'mimo_thinking') {
  return {
    supported: true,
    dialect,
    can_disable: levels.includes('off'),
    levels,
    default_level: defaultLevel,
    confidence: 'verified',
    source: 'builtin',
  };
}

describe('ModelParamsSection — 深度思考跟随生效模型', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
  });

  it('顶层 selected 与 catalog selected 不同时,按顶层选中模型的档位渲染', async () => {
    window.api = {
      account: {
        profile: vi.fn().mockResolvedValue({ preferences: {} }),
        preferences: vi.fn().mockResolvedValue({ ok: true }),
      },
      models: {
        list: vi.fn().mockResolvedValue({
          // 当前真正生效的模型(游戏内选中 / 存档级 session_model)
          selected: { api_id: 'myrelay', real_name: 'mimo-v2.6-flash' },
          models: {
            // catalog 内嵌 selected:另一个模型(如用户第一个有凭证的模型)
            selected: { api_id: 'myrelay', real_name: 'other-model' },
            apis: [{
              id: 'myrelay',
              models: [
                {
                  id: 'mimo-v2.6-flash',
                  real_name: 'mimo-v2.6-flash',
                  // 用户在「编辑模型」里改过的可用档位
                  reasoning: reasoning(
                    ['auto', 'low', 'medium', 'high'], 'medium', 'openai_effort'),
                },
                {
                  id: 'other-model',
                  real_name: 'other-model',
                  // 自动识别的 3 档(Auto / 已关闭 / 高)
                  reasoning: reasoning(['auto', 'off', 'high'], 'high'),
                },
              ],
            }],
          },
        }),
      },
    };
    window.__apiToast = vi.fn();

    render(<ModelParamsSection />);

    // 生效模型的档位:有 low/medium,没有「已关闭」。
    await waitFor(() => expect(screen.getByText('low')).toBeTruthy());
    expect(screen.getByText('medium')).toBeTruthy();
    expect(screen.queryByText('已关闭')).toBeNull();
    // 默认档位 medium 高亮(来自生效模型的 spec.default_level)。
    expect(screen.getByText('medium').closest('button').className.includes('primary')).toBe(true);
  });

  it('高级发送方式改方言时,保留已编辑的档位/默认档位/每档参数', async () => {
    const fullSpec = {
      enabled: true,
      supported: true,
      dialect: 'custom_json',
      can_disable: true,
      levels: ['auto', 'off', 'low', 'medium', 'high'],
      default_level: 'high',
      params_by_level: { high: { reasoning_effort: 'high' } },
      reasoning_counts_in_output: true,
      output_reserve_tokens: 2048,
    };
    window.api = {
      account: {
        profile: vi.fn().mockResolvedValue({
          preferences: {
            model_effort: { 'myrelay:mimo-v2.6-flash': 'high' },
            reasoning_model_overrides: { 'myrelay:mimo-v2.6-flash': fullSpec },
          },
        }),
        preferences: vi.fn().mockResolvedValue({ ok: true }),
      },
      models: {
        list: vi.fn().mockResolvedValue({
          selected: { api_id: 'myrelay', real_name: 'mimo-v2.6-flash' },
          models: {
            selected: { api_id: 'myrelay', real_name: 'mimo-v2.6-flash' },
            apis: [{
              id: 'myrelay',
              models: [{
                id: 'mimo-v2.6-flash',
                real_name: 'mimo-v2.6-flash',
                reasoning: {
                  supported: true,
                  dialect: 'custom_json',
                  can_disable: true,
                  levels: ['auto', 'off', 'low', 'medium', 'high'],
                  default_level: 'high',
                  confidence: 'assumed',
                  source: 'user',
                },
              }],
            }],
          },
        }),
      },
    };
    window.__apiToast = vi.fn();

    render(<ModelParamsSection />);

    // 自定义 JSON 也必须在下拉里有对应项(否则当前值显示为空,像"自动匹配")。
    const trigger = (await screen.findByText('自定义 JSON · 每档 extra_body')).closest('button');
    fireEvent.mouseDown(trigger);
    fireEvent.mouseUp(await screen.findByRole('option', { name: 'OpenAI · reasoning_effort' }));

    await waitFor(() => expect(window.api.account.preferences).toHaveBeenCalled());
    const payload = window.api.account.preferences.mock.calls
      .map((c) => c[0] && c[0].preferences && c[0].preferences.reasoning_model_overrides)
      .find(Boolean);
    const saved = payload['myrelay:mimo-v2.6-flash'];
    expect(saved.dialect).toBe('openai_effort');
    expect(saved.default_level).toBe('high');
    expect(saved.levels).toEqual(['auto', 'off', 'low', 'medium', 'high']);
    expect(saved.params_by_level.high).toEqual({ reasoning_effort: 'high' });
  });

  it('原生 anthropic provider 只显示自己的发送方式', async () => {
    const override = {
      enabled: true,
      supported: true,
      dialect: 'anthropic_budget',
      can_disable: true,
      levels: ['auto', 'off', 'high'],
      default_level: 'high',
    };
    window.api = {
      account: {
        profile: vi.fn().mockResolvedValue({
          preferences: {
            reasoning_model_overrides: { 'anthropic:claude-sonnet-4-5': override },
          },
        }),
        preferences: vi.fn().mockResolvedValue({ ok: true }),
      },
      models: {
        list: vi.fn().mockResolvedValue({
          selected: { api_id: 'anthropic', real_name: 'claude-sonnet-4-5' },
          models: {
            selected: { api_id: 'anthropic', real_name: 'claude-sonnet-4-5' },
            apis: [{
              id: 'anthropic',
              kind: 'anthropic',
              models: [{
                id: 'claude-sonnet-4-5',
                real_name: 'claude-sonnet-4-5',
                reasoning: {
                  supported: true,
                  dialect: 'anthropic_budget',
                  can_disable: true,
                  levels: ['auto', 'off', 'high'],
                  default_level: 'high',
                  confidence: 'assumed',
                  source: 'user',
                },
              }],
            }],
          },
        }),
      },
    };
    window.__apiToast = vi.fn();

    render(<ModelParamsSection />);

    const trigger = (await screen.findByText('Anthropic · budget_tokens')).closest('button');
    fireEvent.mouseDown(trigger);
    expect(await screen.findByRole('option', { name: 'Anthropic · budget_tokens' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'OpenAI · reasoning_effort' })).toBeNull();
  });
});
