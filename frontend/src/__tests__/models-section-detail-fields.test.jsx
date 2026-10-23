/**
 * models-section-detail-fields.test.jsx — API 设置详情表的三列 + 工具栏回归。
 *
 * 锁死两条:
 *   1. /api/models 返回的 input_cost_per_million / context_window / source
 *      必须透传到详情表(此前 mapModel 白名单把它们丢掉,三列恒为「—」)。
 *   2. 搜索框旁的排序下拉已隐藏(固定智能排序),工具栏里不应再有 select。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelsSection, autoSyncState } from '../components/settings/models-section.jsx';

function makeModel(i) {
  return {
    id: `model-${i}`,
    real_name: `model-${i}`,
    display_name: `Model ${i}`,
    enabled: true,
    capabilities: ['text'],
    input_cost_per_million: 1.5,
    output_cost_per_million: 3,
    context_window: 1_000_000,
    source: 'static',
    // 同步/overlay 模型才允许从详情表删除(全局目录模型按钮禁用)
    synced: true,
  };
}

const API_ROW = {
  api_id: 'deepseek', display_name: 'DeepSeek', kind: 'openai_compat',
  base_url: 'https://api.deepseek.com/v1', enabled: true,
  models: Array.from({ length: 6 }, (_, i) => makeModel(i)),
};
const CRED = {
  api_id: 'deepseek', has_credential: true, configured: true, enabled: true,
  key_hint: '·sk-…a8d2', base_url_override: '', auth_mode: 'api_key',
};

function installMocks(overrides = {}) {
  window.RPG_AUTH = { authed: true };
  window.api = {
    models: {
      list: vi.fn().mockResolvedValue({ models: { apis: [overrides.apiRow || API_ROW] } }),
      syncRemote: vi.fn().mockResolvedValue({ ok: true, models: [], remote_total: 0, synced: 0 }),
      upsertApi: vi.fn().mockResolvedValue({ ok: true }),
      probe: vi.fn().mockResolvedValue({ ok: true, latency_ms: 123, status_detail: 'ok' }),
      meDeleteModel: vi.fn().mockResolvedValue({ ok: true, deleted: 1 }),
      meVisibility: vi.fn().mockResolvedValue({ ok: true, updated: 1 }),
    },
    credentials: {
      list: vi.fn().mockResolvedValue({ items: [CRED] }),
      set: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
  window.__apiToast = vi.fn();
  window.__confirm = vi.fn().mockResolvedValue(true);
}

async function openDetail() {
  render(<ModelsSection />);
  const name = await screen.findByText('DeepSeek');
  // Cloudscape table 的行点击挂在 tr 上,点文本会冒泡到行。
  fireEvent.click(name.closest('tr'));
  await screen.findByText('Model 0');
}

describe('API 设置 — 详情表上下文/来源、价格列隐藏与工具栏', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
    window.RPG_AUTH = undefined;
    autoSyncState.lastProbedAt.clear();
    autoSyncState.lastConnectivity.clear();
  });

  it('价格 / 来源 / 上下文列已隐藏', async () => {
    installMocks();
    // 已探测过 → 跳过自动同步,观察初始 /api/models 的字段映射
    autoSyncState.lastProbedAt.set('deepseek', Date.now());

    await openDetail();

    // 三类列已按需求隐藏:表头与模型行都不再输出。
    expect(screen.queryByText('价格 /M')).toBeNull();
    expect(screen.queryByText('$1.500 / $3.000')).toBeNull();
    expect(screen.queryByText('来源')).toBeNull();
    expect(screen.queryByText('静态价表')).toBeNull();
    expect(screen.queryByText('上下文')).toBeNull();
    expect(screen.queryByText('1M')).toBeNull();
    // 探查 / 编辑 / 开关 / 删除列有列标题。
    const headers = [...document.querySelectorAll('th')].map((el) => el.textContent.trim());
    expect(headers).toContain('探查');
    expect(headers).toContain('编辑');
    expect(headers).toContain('开关');
    expect(headers).toContain('删除');
  });

  it('同步返回的模型同样不渲染价格/来源/上下文', async () => {
    installMocks();
    window.api.models.syncRemote = vi.fn().mockResolvedValue({
      ok: true, remote_total: 1, synced: 1,
      models: [{
        id: 'model-0', real_name: 'model-0', display_name: 'Model 0', enabled: true,
        capabilities: ['text'], input_cost_per_million: 2.5, output_cost_per_million: 5,
        context_window: 128_000, source: 'LiveApi',
      }],
    });

    await openDetail();
    await waitFor(() => expect(window.api.models.syncRemote).toHaveBeenCalled());

    expect(screen.queryByText('$2.500 / $5.000')).toBeNull();
    expect(screen.queryByText('Live API')).toBeNull();
    expect(screen.queryByText('128K')).toBeNull();
  });

  it('单模型探查会调用 /api/models/probe 并弹出结果', async () => {
    installMocks();
    autoSyncState.lastProbedAt.set('deepseek', Date.now());

    await openDetail();

    const row = screen.getByText('Model 0').closest('tr');
    fireEvent.click(row.querySelector('button.pl-model-probe'));

    await waitFor(() => expect(window.api.models.probe).toHaveBeenCalledWith({
      api_id: 'deepseek', model: 'model-0', timeout: 45,
    }));
    // 明确提示:探查是最小直连请求,不带 system / 采样 / 思考参数。
    expect(screen.getByText(/不带 system/)).toBeTruthy();
    await waitFor(() => expect(window.__apiToast).toHaveBeenCalledWith(
      expect.stringContaining('可用'),
      expect.objectContaining({ kind: 'ok' }),
    ));
  });

  it('删除模型按钮调用 per-user 删除端点并把行移出列表', async () => {
    installMocks();
    autoSyncState.lastProbedAt.set('deepseek', Date.now());

    await openDetail();

    const row = screen.getByText('Model 0').closest('tr');
    fireEvent.click(row.querySelector('button.pl-model-delete'));

    await waitFor(() => expect(window.api.models.meDeleteModel).toHaveBeenCalledWith({
      api_id: 'deepseek', real_name: 'model-0',
    }));
    await waitFor(() => expect(screen.queryByText('Model 0')).toBeNull());
  });

  it('同步模型的开关走 per-user 可见性端点', async () => {
    installMocks();
    autoSyncState.lastProbedAt.set('deepseek', Date.now());

    await openDetail();

    const row = screen.getByText('Model 0').closest('tr');
    fireEvent.click(row.querySelector('button.pl-cap-toggle'));

    await waitFor(() => expect(window.api.models.meVisibility).toHaveBeenCalledWith({
      api_id: 'deepseek', model: 'model-0', visible: false,
    }));
  });

  it('搜索框旁不再有排序下拉', async () => {
    installMocks();
    autoSyncState.lastProbedAt.set('deepseek', Date.now());

    await openDetail();

    const toolbar = document.querySelector('.pl-model-toolbar');
    expect(toolbar).toBeTruthy();
    expect(toolbar.querySelector('input')).toBeTruthy();
    expect(toolbar.querySelector('select')).toBeNull();
  });

  it('搜索支持名称 / ID / 能力 ID / 能力中文标签', async () => {
    const models = Array.from({ length: 6 }, (_, i) => ({
      ...makeModel(i),
      capabilities: i % 2 === 0 ? ['text'] : ['vision'],
    }));
    installMocks({ apiRow: { ...API_ROW, models } });
    autoSyncState.lastProbedAt.set('deepseek', Date.now());

    await openDetail();
    const input = document.querySelector('.pl-model-toolbar input');

    // 能力 ID: vision → 只剩奇数号(1/3/5)
    fireEvent.change(input, { target: { value: 'vision' } });
    await waitFor(() => expect(screen.queryByText('Model 0')).toBeNull());
    expect(screen.getByText('Model 1')).toBeTruthy();
    expect(screen.getByText('Model 3')).toBeTruthy();

    // 能力中文标签: 视觉 → 同一批结果
    fireEvent.change(input, { target: { value: '视觉' } });
    await waitFor(() => expect(screen.queryByText('Model 0')).toBeNull());
    expect(screen.getByText('Model 1')).toBeTruthy();

    // 模型 ID 仍可搜
    fireEvent.change(input, { target: { value: 'model-3' } });
    await waitFor(() => expect(screen.queryByText('Model 0')).toBeNull());
    expect(screen.getByText('Model 3')).toBeTruthy();
  });
});
