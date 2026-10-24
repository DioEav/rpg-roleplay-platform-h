/**
 * modelparams-protocol-support.test.jsx — 参数页按当前协议显示“会发送 / 不会发送”。
 *
 * 锁死:
 *   · Responses 下 Top-k / 重复 / 频率 / 存在惩罚 / Seed / Stop 置灰；
 *   · 预览 JSON 把不支持的字段放进“不会发送”组，不再伪装成请求参数；
 *   · Chat Completions 下这些控件保持可用，预览只显示“会发送”组。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { ModelParamsSection } from '../components/settings/modelparams-section.jsx';

const MODEL = {
  id: 'grok-4.6',
  real_name: 'grok-4.6',
  display_name: 'Grok 4.6',
  enabled: true,
  capabilities: ['text', 'reasoning'],
  reasoning: {
    supported: true,
    dialect: 'openai_effort',
    levels: ['auto', 'low', 'high'],
    default_level: 'auto',
    effort_values: { low: 'low', high: 'high' },
  },
};

function installMocks({
  credFormat = 'responses',
  catalogFormat = 'chat_completions',
  catalogKind = 'openai_compat',
  prefs = {},
} = {}) {
  window.api = {
    models: {
      list: vi.fn().mockResolvedValue({
        models: {
          apis: [{
            id: 'opencode-go', display_name: 'OpenCode Go', kind: catalogKind,
            api_format: catalogFormat, enabled: true, models: [MODEL],
          }],
          selected: { api_id: 'opencode-go', model_id: 'grok-4.6' },
        },
        selected: { api_id: 'opencode-go', real_name: 'grok-4.6', model_id: 'grok-4.6' },
      }),
    },
    credentials: {
      list: vi.fn().mockResolvedValue({
        items: [{
          api_id: 'opencode-go', has_credential: true, configured: true,
          enabled: true, auth_mode: 'api_key', api_format: credFormat,
          base_url_override: 'https://opencode.ai/zen/go/v1',
        }],
      }),
    },
    account: {
      profile: vi.fn().mockResolvedValue({ preferences: prefs }),
    },
  };
  window.__apiToast = vi.fn();
}

function previewGroupByTitle(re) {
  const title = screen.getByText(re);
  return title.parentElement;
}

describe('模型参数 — 协议能力感知', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
  });
  afterEach(() => {
    window.api = undefined;
  });

  it('Responses: 不支持的采样项置灰，并进入“不会发送”分组', async () => {
    installMocks({ credFormat: 'responses' });
    render(<ModelParamsSection />);

    await waitFor(() => expect(screen.getByText(/Responses \(\/responses\) 协议/)).toBeTruthy());

    // 4 个不支持的滑块（top_k / repetition / frequency / presence）被禁用；
    // temperature / top_p 仍可用。
    const ranges = [...document.querySelectorAll('input[type="range"]')];
    expect(ranges).toHaveLength(6);
    expect(ranges.filter((el) => el.disabled)).toHaveLength(4);

    expect(document.querySelector('input[placeholder="-1"]').disabled).toBe(true);
    expect(document.querySelector('input[placeholder="player:|system:"]').disabled).toBe(true);

    const sent = previewGroupByTitle(/① 当前协议会发送/);
    const sentJson = sent.querySelector('pre').textContent;
    expect(sentJson).toContain('temperature');
    expect(sentJson).toContain('top_p');
    expect(sentJson).toContain('max_output_tokens');
    expect(sentJson).not.toContain('top_k');

    const notSent = previewGroupByTitle(/② 当前协议不会发送/);
    const notSentJson = notSent.querySelector('pre').textContent;
    expect(notSentJson).toContain('top_k');
    expect(notSentJson).toContain('repetition_penalty');
    expect(notSentJson).toContain('frequency_penalty');
    expect(notSentJson).toContain('presence_penalty');
    expect(notSentJson).not.toContain('temperature');
  });

  it('Chat Completions: 控件保持可用，只显示“会发送”分组', async () => {
    installMocks({ credFormat: 'chat_completions' });
    render(<ModelParamsSection />);

    await waitFor(() => expect(screen.getByText(/Chat Completions \(\/chat\/completions\)/)).toBeTruthy());

    const ranges = [...document.querySelectorAll('input[type="range"]')];
    expect(ranges.filter((el) => el.disabled)).toHaveLength(0);
    expect(document.querySelector('input[placeholder="-1"]').disabled).toBe(false);
    expect(document.querySelector('input[placeholder="player:|system:"]').disabled).toBe(false);

    const sent = previewGroupByTitle(/① 当前协议会发送/);
    expect(sent.querySelector('pre').textContent).toContain('frequency_penalty');
    expect(sent.querySelector('pre').textContent).toContain('max_tokens');
    expect(screen.queryByText(/② 当前协议不会发送/)).toBeNull();
  });

  it.each([
    ['Anthropic Messages', 'anthropic', 'top_k', ['frequency_penalty', 'presence_penalty', 'seed']],
    ['Vertex AI', 'vertex_ai', 'seed', ['frequency_penalty', 'presence_penalty', 'repetition_penalty']],
  ])('%s: 只把该协议支持的项放进“会发送”', async (label, kind, sentKey, notSentKeys) => {
    installMocks({
      credFormat: '', catalogFormat: 'chat_completions', catalogKind: kind,
      prefs: { seed: 42 },
    });
    render(<ModelParamsSection />);

    await waitFor(() => expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0));
    const sent = previewGroupByTitle(/① 当前协议会发送/);
    expect(sent.querySelector('pre').textContent).toContain(sentKey);

    const notSent = previewGroupByTitle(/② 当前协议不会发送/);
    const json = notSent.querySelector('pre').textContent;
    for (const key of notSentKeys) expect(json).toContain(key);
  });
});
