/**
 * agent-model-picker-loading.test.jsx — 模块模型页加载体验回归。
 *
 * 用户上报的两个症状与本文件锁死的不变量:
 *   ① 每次进页闪「尚未配置任何 API key」、已存配置迟迟不上屏
 *      → 根因是空状态判定不区分「加载中」与「真没配」+ 16 picker × 3 请求的风暴。
 *      锁:加载中只出「加载中」占位;共享 store 保证同页 N 实例只发 1 组请求;
 *          localStorage 快照让已保存选择在请求返回前就上屏。
 *   ② 「去配置 Key」把用户带到「开发接口」文档页
 *      → 根因是 module-models-section 把 configHash 覆盖成了 "apis"。
 *      锁:告警按钮跳 settings-models,且源码里不再有 configHash="apis"。
 *   ③ 附加:拉取失败不再静默吞成永久空状态 → 错误态 + 重试按钮。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import AgentModelPicker, {
  invalidatePickerSnapshot,
  _resetPickerStoreForTests,
} from '../components/AgentModelPicker.jsx';
import { plGoto } from '../router.js';

vi.mock('../router.js', () => ({ plGoto: vi.fn() }));

// ── 桩数据(形状对齐后端真实响应) ────────────────────────────────────────────
const CATALOG = {
  models: {
    apis: [{
      api_id: 'deepseek', display_name: 'DeepSeek', enabled: true,
      models: [{ real_name: 'deepseek-v4-pro', display_name: 'DeepSeek V4-Pro', enabled: true, capabilities: ['text'] }],
    }],
    selected: { api_id: 'deepseek', model_id: 'deepseek-v4-pro' },
  },
};
const CREDS = { items: [{ api_id: 'deepseek', configured: true, enabled: true, auth_mode: 'api_key' }] };
const PREFS = { 'extractor.api_id': 'deepseek', 'extractor.model_real_name': 'deepseek-v4-pro' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 三个接口各自一个可手动 resolve 的 deferred(默认永不 resolve = 模拟慢/挂起)。 */
function installHangingApi() {
  const d = { models: deferred(), creds: deferred(), profile: deferred() };
  window.api = {
    account: {
      profile: vi.fn(() => d.profile.promise),
      preferences: vi.fn().mockResolvedValue({ ok: true }),
      getPreferences: vi.fn().mockResolvedValue({ preferences: {} }),
    },
    models: { list: vi.fn(() => d.models.promise) },
    credentials: { list: vi.fn(() => d.creds.promise) },
  };
  return d;
}

/** 第 N 次调用按脚本返回(reject → resolve),避免 upfront rejected promise 的 unhandled warning。 */
function installSequentialApi() {
  let modelsCalls = 0, credsCalls = 0;
  window.api = {
    account: {
      profile: vi.fn().mockResolvedValue({ preferences: {} }),
      preferences: vi.fn().mockResolvedValue({ ok: true }),
      getPreferences: vi.fn().mockResolvedValue({ preferences: {} }),
    },
    models: {
      list: vi.fn(() => {
        modelsCalls += 1;
        return modelsCalls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(CATALOG.models);
      }),
    },
    credentials: {
      list: vi.fn(() => {
        credsCalls += 1;
        return credsCalls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(CREDS);
      }),
    },
  };
  return { calls: () => ({ modelsCalls, credsCalls }) };
}

function Picker(props = {}) {
  return <AgentModelPicker prefPrefix="extractor" variant="bare" {...props} />;
}

beforeEach(() => {
  _resetPickerStoreForTests();
  window.localStorage.clear();
  plGoto.mockClear();
});

describe('AgentModelPicker — 加载状态机', () => {
  it('加载中只显示占位,绝不闪「尚未配置任何 API key」', async () => {
    installHangingApi();  // 永不 resolve
    render(<Picker />);
    expect(await screen.findByText('正在加载模型配置…')).toBeTruthy();
    expect(screen.queryByText('尚未配置任何 API key')).toBeNull();
    // 表单在加载中不渲染(不出现「禁用下拉」的假象)
    expect(screen.queryByText('供应商')).toBeNull();
  });

  it('加载完成且真的没配 key → 才显示告警;「去配 key」跳 settings-models', async () => {
    const d = installHangingApi();
    render(<Picker />);
    d.models.resolve({ models: { apis: [] } });
    d.creds.resolve({ items: [] });
    d.profile.resolve({ preferences: {} });
    const alert = await screen.findByText('尚未配置任何 API key');
    expect(alert).toBeTruthy();
    fireEvent.click(screen.getByText('去配 key'));
    expect(plGoto).toHaveBeenCalledWith('settings-models');
  });

  it('配了 key → 正常渲染下拉,不显示告警', async () => {
    const d = installHangingApi();
    render(<Picker />);
    d.models.resolve(CATALOG);
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: PREFS });
    await waitFor(() => expect(screen.queryByText('尚未配置任何 API key')).toBeNull());
    expect(await screen.findByText('DeepSeek V4-Pro')).toBeTruthy();
  });

  it('配了 key 但目录为空 → popover 显示"供应商无模型"而非甩锅 key 的旧文案', async () => {
    const d = installHangingApi();
    render(<AgentModelPicker prefPrefix="extractor" variant="popover" />);
    d.models.resolve({ models: { apis: [] } });   // 目录为空但请求成功
    d.creds.resolve(CREDS);                        // 有凭据
    d.profile.resolve({ preferences: {} });
    const msg = await screen.findByText(/没有可显示的模型/);
    expect(msg).toBeTruthy();
    expect(screen.queryByText('没有可用模型（先配 API key）')).toBeNull();
  });

  it('stale 快照上屏期间显示同步提示,校真完成后消失', async () => {
    localStorage.setItem('agent_picker_snapshot_v1', JSON.stringify({
      ts: Date.now(), models: CATALOG, creds: CREDS, prefs: PREFS,
    }));
    const d = installHangingApi();  // 先挂起:快照已上屏、后台校真未完成
    render(<Picker />);
    expect(await screen.findByText('DeepSeek V4-Pro')).toBeTruthy();
    expect(screen.getByText(/正在同步最新模型列表/)).toBeTruthy();
    // 校真完成 → 提示消失
    d.models.resolve(CATALOG);
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: PREFS });
    await waitFor(() => expect(screen.queryByText(/正在同步最新模型列表/)).toBeNull());
  });

  it('目录腿失败(凭据成功)→ 错误态,而不是拿空目录显示"供应商无模型"', async () => {
    const d = installHangingApi();
    render(<AgentModelPicker prefPrefix="extractor" variant="popover" />);
    d.models.reject(new Error('boom'));
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: {} });
    expect(await screen.findByText('模型配置加载失败')).toBeTruthy();
    expect(screen.queryByText(/没有可显示的模型/)).toBeNull();
  });

  it('部分失败快照不被当作新鲜:下一挂载会重新拉取而非空转 TTL', async () => {
    // 第一轮: models 失败、creds 成功 → 部分结果不许进快照(错误态,不落缓存)
    const d = installHangingApi();
    const first = render(<Picker />);
    d.models.reject(new Error('boom'));
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: {} });
    await screen.findByText('模型配置加载失败');
    first.unmount();
    // 第二轮: 重挂载(快照缓存里没有残缺结果)→ 重新拉取,成功后错误态消失
    const d2 = installHangingApi();
    const second = render(<Picker />);
    d2.models.resolve(CATALOG);
    d2.creds.resolve(CREDS);
    d2.profile.resolve({ preferences: {} });
    await waitFor(() => expect(screen.queryByText('模型配置加载失败')).toBeNull());
    expect(screen.getByText(/没有可显示的模型|供应商/)).toBeTruthy();
    second.unmount();
  });

  it('拉取失败 → 错误态 + 重试;重试成功后恢复(不再静默吞成永久空状态)', async () => {
    const seq = installSequentialApi();
    render(<Picker />);
    await screen.findByText('模型配置加载失败');
    expect(screen.getByText('重试')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(screen.queryByText('模型配置加载失败')).toBeNull());
    await screen.findByText('DeepSeek V4-Pro');
    expect(seq.calls().modelsCalls).toBe(2);
  });
});

describe('AgentModelPicker — 共享 store(请求去重 + 快照上屏)', () => {
  it('同页 2 个 picker → models/credentials/profile 各只请求 1 次', async () => {
    const d = installHangingApi();
    render(
      <>
        <AgentModelPicker prefPrefix="extractor" variant="bare" />
        <AgentModelPicker prefPrefix="gm" variant="bare" allowInherit />
      </>,
    );
    d.models.resolve(CATALOG);
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: {} });
    await waitFor(() => expect(screen.getAllByText('供应商').length).toBe(2));
    expect(window.api.models.list).toHaveBeenCalledTimes(1);
    expect(window.api.credentials.list).toHaveBeenCalledTimes(1);
    expect(window.api.account.profile).toHaveBeenCalledTimes(1);
  });

  it('localStorage 快照 → 请求未返回也已保存选择即上屏(stale-while-revalidate)', async () => {
    localStorage.setItem('agent_picker_snapshot_v1', JSON.stringify({
      ts: Date.now(), models: CATALOG, creds: CREDS, prefs: PREFS,
    }));
    installHangingApi();  // 网络挂起 —— 上屏不允许依赖它
    render(<Picker />);
    expect(await screen.findByText('DeepSeek V4-Pro')).toBeTruthy();
    expect(screen.queryByText('尚未配置任何 API key')).toBeNull();
  });

  it('配过 key 的快照在凭据接口挂起时也不闪「尚未配置」(stale 优先于错误)', async () => {
    localStorage.setItem('agent_picker_snapshot_v1', JSON.stringify({
      ts: Date.now(), models: CATALOG, creds: CREDS, prefs: PREFS,
    }));
    installHangingApi();
    render(<Picker />);
    await screen.findByText('DeepSeek V4-Pro');
    // stale 在屏期间不渲染告警
    expect(screen.queryByText('尚未配置任何 API key')).toBeNull();
  });
});

describe('AgentModelPicker — init 回声(父组件拿值提交)', () => {
  /** 预热共享 store:渲染一次并把三个接口都 resolve → _shared 变新鲜(下次挂载走 early return)。 */
  async function warmSharedStore() {
    const d = installHangingApi();
    const first = render(<Picker />);
    d.models.resolve(CATALOG);
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: PREFS });
    await screen.findByText('DeepSeek V4-Pro');
    first.unmount();
  }

  it('内存快照新鲜(早退、不发校真请求)时,父组件仍必须收到 init 回声', async () => {
    await warmSharedStore();
    // 第二次挂载:_shared 新鲜 → 0 请求直达,不会走 authoritative 那一趟
    installHangingApi();
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0]).toBe('deepseek');
    expect(onChange.mock.calls[0][1]).toBe('deepseek-v4-pro');
    expect(onChange.mock.calls[0][2]).toBe('init');
    // 早退路径确实没打网络(否则这条用例锁的就不是快照路径了)
    expect(window.api.models.list).not.toHaveBeenCalled();
  });

  it('快照路径即使传了 persistOnMount 也不写库(临时值绝不落库)', async () => {
    await warmSharedStore();
    installHangingApi();
    render(<Picker persistOnMount />);
    await waitFor(() => expect(window.api.account.preferences).not.toHaveBeenCalled());
  });

  it('stale 快照 + 校真值不同 → 两次 init 回声,顺序为「快照值 → 校真值」', async () => {
    localStorage.setItem('agent_picker_snapshot_v1', JSON.stringify({
      ts: Date.now() - 30 * 60 * 1000,   // 过期 → 会走校真
      models: CATALOG, creds: CREDS,
      prefs: { 'extractor.api_id': 'deepseek', 'extractor.model_real_name': 'old-model-x' },
    }));
    const d = installHangingApi();
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    // 第一枪:快照画屏时立刻回声(旧值)
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    d.models.resolve(CATALOG);
    d.creds.resolve(CREDS);
    d.profile.resolve({ preferences: PREFS });   // 校真给出 deepseek-v4-pro
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['old-model-x', 'init'],
      ['deepseek-v4-pro', 'init'],
    ]);
  });
});

describe('AgentModelPicker — 用户操作与在途校真的竞争', () => {
  // popover 变体的模型是**普通按钮**(内联渲染,不走 Cloudscape 虚拟下拉),所以这里能驱动
  // 一次真实的"用户选模型"——这是唯一可自动化的用户操作入口。
  const TWO_MODEL_CATALOG = {
    models: {
      apis: [{
        api_id: 'deepseek', display_name: 'DeepSeek', enabled: true,
        models: [
          { real_name: 'deepseek-v4-pro', display_name: 'DeepSeek V4-Pro', enabled: true, capabilities: ['text'] },
          { real_name: 'deepseek-v4-flash', display_name: 'DeepSeek V4-Flash', enabled: true, capabilities: ['text'] },
        ],
      }],
      selected: { api_id: 'deepseek', model_id: 'deepseek-v4-pro' },
    },
  };
  const PREFS_PRO = { 'extractor.api_id': 'deepseek', 'extractor.model_real_name': 'deepseek-v4-pro' };

  /** 每次调用给一个独立 deferred,测试自己决定第几次拉取返回什么(模拟"重拉拿到不同数据")。 */
  function installMultiFetchApi() {
    const mk = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
    const slots = { models: [], creds: [], profile: [] };
    const grab = (arr) => vi.fn(() => { const d = mk(); arr.push(d); return d.promise; });
    window.api = {
      account: {
        profile: grab(slots.profile),
        preferences: vi.fn().mockResolvedValue({ ok: true }),
        getPreferences: vi.fn().mockResolvedValue({ preferences: {} }),
      },
      models: { list: grab(slots.models) },
      credentials: { list: grab(slots.creds) },
    };
    return {
      fetchCount: () => slots.models.length,
      resolveFetch(n, { models, creds, prefs }) {
        slots.models[n].resolve(models);
        slots.creds[n].resolve(creds);
        slots.profile[n].resolve({ preferences: prefs || {} });
      },
    };
  }

  function seedStaleSnapshot(prefs = PREFS_PRO, models = TWO_MODEL_CATALOG) {
    localStorage.setItem('agent_picker_snapshot_v1', JSON.stringify({
      ts: Date.now() - 30 * 60 * 1000, models, creds: CREDS, prefs,
    }));
  }

  it('在途校真带着改前的旧值回来时,不得覆盖用户刚选的模型', async () => {
    seedStaleSnapshot();
    const api = installMultiFetchApi();
    const onChange = vi.fn();
    render(<Picker variant="popover" onChange={onChange} />);

    // 快照先画 → 直接点另一个模型(用户操作)
    fireEvent.click(await screen.findByText('DeepSeek V4-Flash'));
    await waitFor(() => expect(window.api.account.preferences).toHaveBeenCalled());
    const callsAfterPick = onChange.mock.calls.length;
    expect(onChange).toHaveBeenLastCalledWith('deepseek', 'deepseek-v4-flash', 'user');

    // 校真回来,带着**改前**的偏好(deepseek-v4-pro)
    await act(async () => {
      api.resolveFetch(0, { models: TWO_MODEL_CATALOG, creds: CREDS, prefs: PREFS_PRO });
      await new Promise((r) => setTimeout(r, 30));   // 让校真落地
    });

    expect(onChange.mock.calls.length, '校真不该再补一枪回声').toBe(callsAfterPick);
    expect(onChange).toHaveBeenLastCalledWith('deepseek', 'deepseek-v4-flash', 'user');
  });

  it('用户选过之后,换/删 Key 触发的重拉仍必须生效(守卫不能把它一起挡掉)', async () => {
    seedStaleSnapshot();
    const api = installMultiFetchApi();
    render(<Picker variant="popover" />);

    fireEvent.click(await screen.findByText('DeepSeek V4-Flash'));
    await waitFor(() => expect(window.api.account.preferences).toHaveBeenCalled());
    await act(async () => {
      api.resolveFetch(0, { models: TWO_MODEL_CATALOG, creds: CREDS, prefs: PREFS_PRO });
      await new Promise((r) => setTimeout(r, 30));
    });

    // 换/删 API Key → 广播 → 组件必须重新拉一轮(这不是"在途的旧响应",而是新的事实)
    await act(async () => {
      window.dispatchEvent(new Event('rpg-credentials-updated'));
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(api.fetchCount()).toBe(2));
    await act(async () => {
      api.resolveFetch(1, {
        models: {
          apis: [
            ...TWO_MODEL_CATALOG.models.apis,
            { api_id: 'moonshot', display_name: 'Moonshot', enabled: true,
              models: [{ real_name: 'kimi-x', display_name: 'Kimi X', enabled: true, capabilities: ['text'] }] },
          ],
          selected: { api_id: 'deepseek', model_id: 'deepseek-v4-pro' },
        },
        creds: { items: [...CREDS.items, { api_id: 'moonshot', configured: true, enabled: true, auth_mode: 'api_key' }] },
        prefs: PREFS_PRO,
      });
      await new Promise((r) => setTimeout(r, 30));
    });

    // 新 provider 的模型出现在列表里 = 这一轮重拉被应用了
    expect(await screen.findByText('Kimi X')).toBeTruthy();
  });
});

describe('module-models-section — 「去配 key」跳转目标回归锁', () => {
  it('configHash 必须是 settings-models,且不再有 "apis" 覆盖', () => {
    const src = readFileSync(resolve(__dirname, '../components/settings/module-models-section.jsx'), 'utf-8');
    expect(src).toContain('configHash="settings-models"');
    expect(src).not.toContain('configHash="apis"');
  });
});
