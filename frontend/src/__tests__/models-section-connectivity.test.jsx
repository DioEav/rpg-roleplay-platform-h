/**
 * models-section-connectivity.test.jsx — 进页面探测行为 + 启用开关的写入对象。
 *
 * 用户上报三条:
 *   1「联通性为什么都是不可访问」
 *   2「开关是不是前端看似启用、后端其实还是禁用」
 *   3「重新进入时界面加载很慢」
 *
 * 对应三条不变量(本文件锁死):
 *   · 进页面自动同步必须 force=false(让后端 60s 模型缓存生效)且 3 分钟内不重复探;
 *     手动点刷新不受节流影响,始终真探。
 *   · 探测失败的原因要显示在界面上 —— 此前 error 只存在 state 里,全前端无渲染点,
 *     于是「缺 SA」「base_url 被拒」「超时」三种病因长得一模一样。
 *   · 「没等到响应」(网络层/超时)不能标成「不可访问」,它是 未响应(超时)。
 *   · 启用开关读写必须是**同一个对象**:页面读的是用户凭据,开关也必须写凭据;
 *     写失败要回滚,不能留下假状态。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelsSection, autoSyncState } from '../components/settings/models-section.jsx';

const API_ROW = {
  api_id: 'deepseek', display_name: 'DeepSeek', kind: 'openai_compat',
  base_url: 'https://api.deepseek.com/v1', enabled: true, models: [],
};
const CRED = {
  api_id: 'deepseek', has_credential: true, configured: true, enabled: true,
  key_hint: '·sk-…a8d2', base_url_override: '', auth_mode: 'api_key',
};

function installMocks(overrides = {}) {
  const syncRemote = overrides.syncRemote || vi.fn().mockResolvedValue({ ok: true, models: [], remote_total: 0, synced: 0 });
  const credSet = overrides.credSet || vi.fn().mockResolvedValue({ ok: true });
  const upsertApi = vi.fn().mockResolvedValue({ ok: true });
  const toast = vi.fn();
  window.RPG_AUTH = { authed: true };
  window.api = {
    models: { list: vi.fn().mockResolvedValue({ models: { apis: [API_ROW] } }), syncRemote, upsertApi },
    credentials: { list: vi.fn().mockResolvedValue({ items: [CRED] }), set: credSet },
  };
  window.__apiToast = toast;
  return { syncRemote, credSet, upsertApi, toast };
}

/** 渲染到供应商行出现为止(此时 loadConfiguredApis 已完成) */
async function renderReady() {
  render(<ModelsSection />);
  await screen.findByText('DeepSeek');
}

const providerToggle = () => document.querySelector('.pl-cap-toggle');

describe('API 设置 — 进页面探测与启用开关', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
    window.RPG_AUTH = undefined;
    // 模块级状态跨用例共享,必须清空(否则前一个用例的节流/结果会影响后一个)
    autoSyncState.lastProbedAt.clear();
    autoSyncState.lastConnectivity.clear();
  });

  it('自动同步带 force=false(走后端 60s 缓存),而不是每次都强制真探', async () => {
    const { syncRemote } = installMocks();
    await renderReady();
    await waitFor(() => expect(syncRemote).toHaveBeenCalled());
    expect(syncRemote).toHaveBeenCalledWith(expect.objectContaining({ api_id: 'deepseek', force: false }));
  });

  it('3 分钟内重进不再重探,并直接显示上次结果', async () => {
    const { syncRemote } = installMocks();
    autoSyncState.lastProbedAt.set('deepseek', Date.now());
    autoSyncState.lastConnectivity.set('deepseek', { status: 'err', checked_at: Date.now(), error: '上次的真实失败原因' });

    await renderReady();
    // 结果先于探测可见
    expect(screen.getByText('上次的真实失败原因')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60));   // 给 effect 足够时间犯错
    expect(syncRemote).not.toHaveBeenCalled();
  });

  it('探测失败的原因显示在界面上(此前 error 无处可见)', async () => {
    installMocks({ syncRemote: vi.fn().mockResolvedValue({ ok: false, error: 'base_url 解析到私有/本地/保留地址，已拒绝' }) });
    await renderReady();
    expect(await screen.findByText('base_url 解析到私有/本地/保留地址，已拒绝')).toBeTruthy();
  });

  it('没等到响应 → 标「未响应(超时)」而不是「不可访问」', async () => {
    const netErr = Object.assign(new Error('网络异常：The operation was aborted'), { code: 'network' });
    installMocks({ syncRemote: vi.fn().mockRejectedValue(netErr) });
    await renderReady();
    expect(await screen.findByText('未响应(超时)')).toBeTruthy();
    expect(screen.queryByText('不可访问')).toBeNull();
  });

  it('启用开关写的是用户凭据(不是全局 catalog),且保留密钥与 override 状态', async () => {
    const { credSet, upsertApi } = installMocks();
    await renderReady();

    fireEvent.click(providerToggle());

    await waitFor(() => expect(credSet).toHaveBeenCalled());
    expect(credSet).toHaveBeenCalledWith(expect.objectContaining({
      api_id: 'deepseek', enabled: false, keep_key: true, no_auth: false,
      base_url_override: '',      // 用户没设过 override → 原样回传空串,不把 catalog 默认地址固化下来
    }));
    // 全局 catalog 是 admin 专属,普通用户写它只会 403 后被吞掉 —— 不该再走这条路
    expect(upsertApi).not.toHaveBeenCalled();
  });

  it('开关写失败要回滚并提示,不能留下假状态', async () => {
    const { credSet, toast } = installMocks({ credSet: vi.fn().mockRejectedValue(new Error('需要登录')) });
    await renderReady();
    const toggle = providerToggle();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(toggle);

    await waitFor(() => expect(credSet).toHaveBeenCalled());
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'));   // 乐观翻转已回滚
    expect(toast).toHaveBeenCalledWith('启用状态保存失败', expect.anything());
  });
});
