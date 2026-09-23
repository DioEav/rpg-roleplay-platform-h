/**
 * image-gen-modal.test.jsx — 生图弹窗两条用户上报的回归。
 *
 * ① 「明明显示已经选好生图模型,点生成却报『请先选择模型』,必须重新选一次才成功」
 *    → 根因在**共用**的 AgentModelPicker:内存快照新鲜时它会 early return(0 请求直达),
 *      而 init 回声当时只发在"校真那一趟" → 选择器自己拿快照把模型画上屏,父组件的
 *      selModel 却一直是空 → 被弹窗的本地校验拦下。
 *      本文件用「新鲜 localStorage 快照 + 三个接口全部挂起」把这条路径钉死:
 *      只有回声恢复后(快照路径也发),请求体才会带上模型。
 * ② 「生成成功看不到图,弹窗直接就关了」
 *    → onDone 里紧跟 onClose(),宿主 onDone 又是空实现,URL 直接被丢弃。
 *      现在成功后留在弹窗里就地展示结果,并把「再生成一张 / 关闭」作为下一步。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import GenerateImageModal from '../components/GenerateImageModal.jsx';
import { _resetPickerStoreForTests } from '../components/AgentModelPicker.jsx';
import { chatImageAnchor } from '../components/game/chat-image-anchor.js';

vi.mock('../router.js', () => ({ plGoto: vi.fn() }));

const SNAPSHOT_KEY = 'agent_picker_snapshot_v1';
const IMG_URL = 'https://cdn.example.com/gen/1.png';

// 形状对齐后端真实响应(capability 带 image_gen,凭据里有该 provider)
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
const CREDS = { items: [{ api_id: 'deepseek', configured: true, enabled: true, auth_mode: 'api_key' }] };
const PREFS = { 'image_gen.api_id': 'deepseek', 'image_gen.model_real_name': 'deepseek-v4-pro' };

/** 新鲜快照(本会话内已拉过一次目录) —— 复现"重新进入弹窗"那条路径。 */
function seedFreshSnapshot() {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
    ts: Date.now(), models: CATALOG, creds: CREDS, prefs: PREFS,
  }));
}

/** 目录/凭据/偏好三腿全挂起:迫使选择器只能靠快照上屏(作者称之为 stale-while-revalidate)。 */
function installApi({ poll } = {}) {
  const generate = vi.fn().mockResolvedValue({ image_id: 7, status: 'pending' });
  const get = vi.fn().mockResolvedValue(
    poll || { id: 7, status: 'done', url: IMG_URL, kind: 'game' },
  );
  window.api = {
    account: {
      profile: vi.fn(() => new Promise(() => {})),
      preferences: vi.fn().mockResolvedValue({ ok: true }),
      getPreferences: vi.fn().mockResolvedValue({ preferences: {} }),
    },
    models: { list: vi.fn(() => new Promise(() => {})) },
    credentials: { list: vi.fn(() => new Promise(() => {})) },
    images: { generate, get, list: vi.fn().mockResolvedValue({ ok: true, images: [] }) },
  };
  return { generate, get };
}

/** 打开弹窗并填好 prompt(与真实使用一致:先描述、再点生成)。 */
function openWithPrompt(prompt = '一只在窗台上的猫', extraProps = {}) {
  const onClose = vi.fn();
  render(<GenerateImageModal open kind="game" onClose={onClose} {...extraProps} />);
  const ta = document.querySelector('textarea');
  expect(ta, '弹窗里应有 prompt 文本域').toBeTruthy();
  fireEvent.change(ta, { target: { value: prompt } });
  return { onClose, prompt };
}

beforeEach(() => {
  _resetPickerStoreForTests();
  window.localStorage.clear();
  chatImageAnchor.lastAsstKey = null;   // 每例清干净,免得跨例污染(单例是模块级的)
});

afterEach(() => {
  delete window.api;
  window.localStorage.clear();
});

describe('生图弹窗 — 模型回声', () => {
  it('快照路径下不重选模型也能生成(请求体带上模型,不再报「请先选择模型」)', async () => {
    seedFreshSnapshot();
    const { generate } = installApi();
    const { prompt } = openWithPrompt();

    // 快照即时上屏(这是"看起来已经选好了"的来源)
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());

    fireEvent.click(screen.getByText('生成'));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][0]).toMatchObject({
      prompt,
      kind: 'game',
      api_id: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    expect(screen.queryByText('请先选择模型')).toBeNull();
  });
});

describe('生图弹窗 — 消息索引绑定', () => {
  it('saveId 场景:点击生成时带锚点的 message_index(图绑到当时最后一条助手消息)', async () => {
    seedFreshSnapshot();
    const { generate } = installApi();
    chatImageAnchor.lastAsstKey = '7';     // 聊天视图发布"当前最后一条助手消息索引 7"
    openWithPrompt('绑定消息的图', { saveId: '9' });
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());

    fireEvent.click(screen.getByText('生成'));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][0]).toMatchObject({ save_id: '9', message_index: 7 });
  });

  it('锚点为空(还没有助手消息)→ 不带 message_index 字段', async () => {
    seedFreshSnapshot();
    const { generate } = installApi();
    openWithPrompt('没有锚点', { saveId: '9' });
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());

    fireEvent.click(screen.getByText('生成'));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect('message_index' in generate.mock.calls[0][0]).toBe(false);
  });
});

describe('生图弹窗 — 成功后就地看结果', () => {
  it('生成成功不关弹窗,就地显示图片 + 「再生成一张 / 关闭」', async () => {
    seedFreshSnapshot();
    installApi();
    const { onClose } = openWithPrompt();
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());

    fireEvent.click(screen.getByText('生成'));

    // 结果视图(不依赖轮询计时:第一枪 get 立即返回 done)
    expect(await screen.findByText('生成结果')).toBeTruthy();
    expect(document.querySelector(`img[src="${IMG_URL}"]`)).toBeTruthy();
    expect(screen.getByText('再生成一张')).toBeTruthy();
    expect(screen.getByText('关闭')).toBeTruthy();
    // 表单态的按钮组已让位;以及**弹窗没有被关掉**
    expect(screen.queryByText('生成')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「再生成一张」回到表单,且 prompt 保留', async () => {
    seedFreshSnapshot();
    installApi();
    const { prompt } = openWithPrompt();
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());
    fireEvent.click(screen.getByText('生成'));
    await screen.findByText('生成结果');

    fireEvent.click(screen.getByText('再生成一张'));

    await waitFor(() => expect(screen.getByText('生成')).toBeTruthy());
    expect(document.querySelector(`img[src="${IMG_URL}"]`)).toBeNull();
    expect(document.querySelector('textarea').value).toBe(prompt);
  });

  it('轮询返回 ref_dropped → 结果视图提示「参考图被忽略」', async () => {
    // 尝试链全部降级到纯 t2i 时,后端把 ref_dropped 写进记录、轮询带回 → 前端必须显式提示
    //(用户要求:不许静默忽略参考图)。图照常展示。
    seedFreshSnapshot();
    installApi({ poll: { id: 7, status: 'done', url: IMG_URL, kind: 'game', ref_dropped: true } });
    openWithPrompt();
    await waitFor(() => expect(screen.getByText('DeepSeek V4-Pro')).toBeTruthy());

    fireEvent.click(screen.getByText('生成'));

    expect(await screen.findByText('当前模型/中转站不支持参考图，本次生成已忽略参考图。')).toBeTruthy();
    expect(screen.getByText('生成结果')).toBeTruthy();
    expect(document.querySelector(`img[src="${IMG_URL}"]`)).toBeTruthy();
  });
});
