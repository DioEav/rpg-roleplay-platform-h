/**
 * models-api-modal-close.test.jsx — 保存 API Key 后弹框必须立刻关闭,不能等模型同步。
 *
 * 用户上报:「添加 API Key 成功后,弹框并不会消失,而是一直存在」。
 * 根因不在写入 —— 凭证早已落库、「已新增 API」提示也已弹出 —— 而是 onConfirm 把
 * `setEditingApi(null) / setAddingApi(false)` 排在了 `await loadConfiguredApis()` /
 * `await syncRemoteModels(...)` 之后。后者是对该供应商 /models 的**实时探测**
 * (api-client 默认 15s 超时,对方不响应就挂满),于是用户看到的是
 * 「提示添加成功,弹框纹丝不动十几秒」。
 *
 * 不变量(本文件锁死):`syncRemote` 永不 resolve 的前提下,点保存后弹框也必须消失。
 * 添加与编辑共用同一个 onConfirm(同一段收尾代码),这里走**编辑**路径驱动 ——
 * 「添加」路径要先操作 Cloudscape Select,而它的下拉是虚拟列表,jsdom 里一个 option
 * 都不渲染(实测 role=option 计数恒为 0),无法驱动。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelsSection } from '../components/settings/models-section.jsx';

const BASE_URL_INPUT_PLACEHOLDER = 'https://your-relay.example.com/v1';

function installMocks() {
  const syncRemote = vi.fn(() => new Promise(() => {}));  // 永不 resolve = 探测一直不回来
  const credSet = vi.fn().mockResolvedValue({ ok: true });
  const toast = vi.fn();
  window.RPG_AUTH = { authed: true };
  window.api = {
    models: {
      list: vi.fn().mockResolvedValue({
        models: { apis: [{
          api_id: 'deepseek', display_name: 'DeepSeek', kind: 'openai_compat',
          base_url: 'https://api.deepseek.com/v1', enabled: true, models: [],
        }] },
      }),
      syncRemote,
      upsertApi: vi.fn().mockResolvedValue({ ok: true }),
    },
    credentials: {
      list: vi.fn().mockResolvedValue({ items: [{
        api_id: 'deepseek', has_credential: true, configured: true, enabled: true,
        key_hint: '·sk-…a8d2', base_url_override: 'https://api.deepseek.com/v1',
        auth_mode: 'api_key',
      }] }),
      set: credSet,
    },
  };
  window.__apiToast = toast;
  return { syncRemote, credSet, toast };
}

async function openEditModal() {
  render(<ModelsSection />);
  // 已配置的 provider 出现在供应商表里
  fireEvent.click(await screen.findByText('DeepSeek'));
  // 详情面板 → 编辑
  fireEvent.click(await screen.findByText('编辑'));
  return screen.findByPlaceholderText(BASE_URL_INPUT_PLACEHOLDER);
}

describe('EditApiModal — 保存后立即关闭,不等供应商模型探测', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
    window.RPG_AUTH = undefined;
  });

  it('syncRemote 永不返回时,保存后弹框依然消失(不被探测阻塞)', async () => {
    const { syncRemote, toast } = installMocks();
    const baseUrlInput = await openEditModal();

    // 改一下 Base URL,确保走的是「真的保存了东西」那条路径
    fireEvent.change(baseUrlInput, { target: { value: 'https://relay.example.com/v1' } });

    const saveBtn = screen.getByText('保存');
    fireEvent.click(saveBtn);

    // 关键断言:探测还没回来(永远也回不来),弹框就必须已经没了。
    // 旧实现把关闭排在 await syncRemoteModels 之后 → 这里会 waitFor 超时。
    await waitFor(() => expect(screen.queryByText('保存')).toBeNull());
    expect(syncRemote).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('已保存', expect.anything());
  });
});
