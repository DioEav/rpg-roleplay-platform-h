/**
 * game-confirm-strip-init.test.jsx — 「配置卡」里的「继续」不许被 init 回声点亮。
 *
 * ConfirmStrip 的 config_card（mode=missing_key）语义是「用户**在这个卡片里**配好之后才重试」：
 * ready 只该由用户真的选模型 / 加 key（rpg-credentials-updated）触发。
 * 而 AgentModelPicker 挂载时会发一条 source='init' 的「解析出的当前模型」回声 —— 它靠
 * preferProvider / defaultModel 兜底，**一个 key 都没配**时也能解析出非空对，于是旧写法
 * `onChange={() => setReady(true)}` 会把「继续」提前点亮，用户点了只是清卡片、重跑、再失败一次
 * （这条在冷加载的校真路径上今天就可达；快照路径恢复回声后更常命中）。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { ConfirmStrip } from '../components/game/GameConfirmStrip.jsx';
import { _resetPickerStoreForTests } from '../components/AgentModelPicker.jsx';

vi.mock('../router.js', () => ({ plGoto: vi.fn() }));

const CATALOG = {
  models: {
    apis: [{
      api_id: 'deepseek', display_name: 'DeepSeek', enabled: true,
      models: [{
        real_name: 'deepseek-v4-pro', display_name: 'DeepSeek V4-Pro',
        enabled: true, capabilities: ['image_gen'],
      }],
    }],
    selected: { api_id: 'deepseek', model_id: 'deepseek-v4-pro' },
  },
};

/** 目录正常返回、**凭据为空**（= 用户还没配 key，正是 missing_key 场景） */
function installApiNoCreds() {
  window.api = {
    account: {
      profile: vi.fn().mockResolvedValue({ preferences: {} }),
      preferences: vi.fn().mockResolvedValue({ ok: true }),
      getPreferences: vi.fn().mockResolvedValue({ preferences: {} }),
    },
    models: { list: vi.fn().mockResolvedValue(CATALOG.models) },
    credentials: { list: vi.fn().mockResolvedValue({ items: [] }) },
  };
}

const CONFIG_CARD = {
  id: 1,
  kind: 'config_card',
  mode: 'missing_key',
  capability: 'image_gen',
  api_id: 'deepseek',
  question: '要给「图像生成」配个模型',
  model: '',
};

beforeEach(() => {
  _resetPickerStoreForTests();
  window.localStorage.clear();
});

afterEach(() => {
  delete window.api;
  window.localStorage.clear();
});

describe('ConfirmStrip config_card — 就绪旗标', () => {
  it('picker 只发了 init 回声时,「继续」保持禁用', async () => {
    installApiNoCreds();
    render(
      <ConfirmStrip
        pendingWrites={[]}
        pendingQuestions={[CONFIG_CARD]}
        onConfigContinue={vi.fn()}
      />,
    );

    // 选择器把解析出的模型画上了屏(用户看到"已经选好")
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());

    const btn = screen.getByText('继续').closest('button');
    expect(btn).toBeTruthy();
    expect(btn.disabled, 'init 回声不得点亮「继续」—— 没配 key 时点了只会重跑再失败').toBe(true);
  });
});
