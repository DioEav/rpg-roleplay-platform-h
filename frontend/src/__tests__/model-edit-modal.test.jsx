import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ModelEditModal from '../components/settings/model-edit-modal.jsx';

const API = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'openai_compat',
};

const MODEL = {
  id: 'deepseek-v4-pro',
  real_name: 'deepseek-v4-pro',
  display: 'DeepSeek V4-Pro',
  capabilities: ['text', 'streaming', 'reasoning'],
  reasoning: {
    supported: true,
    dialect: 'deepseek',
    levels: ['auto', 'off', 'low', 'medium', 'high'],
    source: 'builtin',
  },
};

function installMocks() {
  window.api = {
    models: {
      getModelConfig: vi.fn().mockResolvedValue({
        ok: true,
        mode: 'auto',
        capabilities: ['text', 'streaming', 'reasoning'],
        effective: MODEL.reasoning,
      }),
    },
  };
}

describe('ModelEditModal — 用户级模型编辑', () => {
  beforeEach(() => {
    installMocks();
  });

  it('自动模式保存时提交 reasoning=null，并带上能力标签', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelEditModal
        open
        api={API}
        model={MODEL}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    expect(await screen.findByText('能力标签')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0];
    expect(payload.api.id).toBe('deepseek');
    expect(payload.model.real_name).toBe('deepseek-v4-pro');
    expect(payload.capabilities).toContain('reasoning');
    expect(payload.reasoning).toBeNull();
  });

  it('自定义模式会生成可提交的思考 spec', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelEditModal
        open
        api={API}
        model={MODEL}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    await screen.findByText('能力标签');
    fireEvent.click(screen.getByRole('button', { name: '自定义' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const reasoning = onSave.mock.calls[0][0].reasoning;
    expect(reasoning.enabled).toBe(true);
    expect(reasoning.dialect).toBe('openai_effort');
    expect(reasoning.levels).toContain('high');
    expect(reasoning.effort_values.high).toBeTruthy();
  });

  it('发送方式与默认档位使用 CSSelect，选择结果会写入提交的 spec', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelEditModal
        open
        api={API}
        model={MODEL}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    await screen.findByText('能力标签');
    fireEvent.click(screen.getByRole('button', { name: '自定义' }));

    // 两个原生 <select> 已替换为 Cloudscape 下拉：触发器在 mouseDown 打开，
    // 选项在 mouseUp 时落选（见 @cloudscape-design/components/select/utils/use-select.js）。
    fireEvent.mouseDown(screen.getByRole('button', { name: /发送方式/ }));
    fireEvent.mouseUp(await screen.findByRole('option', { name: 'DeepSeek · reasoning_effort + thinking' }));

    fireEvent.mouseDown(screen.getByRole('button', { name: /默认档位/ }));
    fireEvent.mouseUp(await screen.findByRole('option', { name: '高' }));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const reasoning = onSave.mock.calls[0][0].reasoning;
    expect(reasoning.dialect).toBe('deepseek');
    expect(reasoning.default_level).toBe('high');
  });

  it('切换发送方式时保留已编辑的默认档位/可用档位,不整体重置为自动', async () => {
    window.api.models.getModelConfig = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'custom',
      capabilities: ['text', 'streaming', 'reasoning'],
      override: {
        enabled: true,
        supported: true,
        dialect: 'mimo_thinking',
        can_disable: true,
        levels: ['auto', 'off', 'high'],
        default_level: 'high',
        effort_values: {},
        budget_tokens: {},
        params_by_level: {},
        reasoning_counts_in_output: false,
        output_reserve_tokens: 512,
      },
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelEditModal
        open
        api={API}
        model={MODEL}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    await screen.findByText('能力标签');
    // 切到新方言(OpenAI 不支持 off,high 应保留;default_level 仍为高)。
    fireEvent.mouseDown(screen.getByRole('button', { name: /发送方式/ }));
    fireEvent.mouseUp(await screen.findByRole('option', { name: 'OpenAI · reasoning_effort' }));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const reasoning = onSave.mock.calls[0][0].reasoning;
    expect(reasoning.dialect).toBe('openai_effort');
    expect(reasoning.default_level).toBe('high');
    expect(reasoning.levels).toContain('high');
    expect(reasoning.levels).not.toContain('off');
  });

  it('旧 spec 的映射为空时,用当前方言默认值补齐,保存不报缺映射', async () => {
    window.api.models.getModelConfig = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'custom',
      capabilities: ['text', 'streaming', 'reasoning'],
      override: {
        enabled: true,
        supported: true,
        dialect: 'openai_effort',
        can_disable: false,
        levels: ['auto', 'high'],
        default_level: 'high',
        // saveDialect 只换 dialect 时会留下旧方言的空映射。
        effort_values: {},
        budget_tokens: {},
        params_by_level: {},
      },
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelEditModal
        open
        api={API}
        model={MODEL}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    await screen.findByText('能力标签');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const reasoning = onSave.mock.calls[0][0].reasoning;
    expect(reasoning.effort_values.high).toBe('high');
  });
});
