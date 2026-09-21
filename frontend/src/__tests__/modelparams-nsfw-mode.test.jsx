/**
 * modelparams-nsfw-mode.test.jsx — 「不介入」档位不能被前端白名单静默改回 soft。
 *
 * 背景:内容尺度有 5 个档位(block/soft/open/explicit/none),而读取偏好时的白名单此前只列了
 * 前 4 个 —— 存过「不介入」的用户下次打开设置页会被强制显示成「含蓄」,后端却仍按不介入跑。
 * 这与我们在修的其它问题同源(界面显示与实际行为不一致),所以单独立测锁住。
 *
 * 同时锁住:选中档位的按钮是 primary 样式,没选中的不是 —— 白名单一退化,断言就会挂。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelParamsSection } from '../components/settings/modelparams-section.jsx';

const MODES = [
  ['禁止', 'block'],
  ['含蓄', 'soft'],
  ['开放', 'open'],
  ['露骨', 'explicit'],
  ['不介入', 'none'],
];

function installMocks(prefs) {
  window.api = {
    account: { profile: vi.fn().mockResolvedValue({ preferences: prefs }), preferences: vi.fn().mockResolvedValue({ ok: true }) },
    models: { list: vi.fn().mockResolvedValue({ models: { selected: { api_id: 'vertex_ai', real_name: 'gemini-2.5-flash', capabilities: [] } }, selected: { api_id: 'vertex_ai', real_name: 'gemini-2.5-flash' } }) },
  };
  window.toast = vi.fn();
  window.__apiToast = vi.fn();
}

const selectedModeLabel = () =>
  MODES.map(([label]) => label).find((label) => screen.getByText(label).closest('button').className.includes('primary'));

describe('ModelParamsSection — 内容尺度档位', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
  });

  it.each(MODES)('存了 %s 档 → 重新加载后仍选中 %s(不被降级)', async (label, mode) => {
    installMocks({ 'settings.nsfw_mode': mode });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe(label));
  });

  it('旧版嵌套 settings.nsfw.mode 也能读出来', async () => {
    installMocks({ 'settings.nsfw': { mode: 'explicit' } });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('露骨'));
  });

  // 下面三条是"界面显示 = 后端真实行为"的锁:以前未设过时界面显示「含蓄」而后端什么都不发。
  it('从未设过这一组 → 显示「不介入」(后端此时也确实什么都不发)', async () => {
    installMocks({ 'settings.temperature': 0.5 });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('不介入'));
  });

  it('设过强度但没写 mode → 按界面默认「含蓄」(不丢用户的附加约束)', async () => {
    installMocks({ 'settings.nsfw_intensity': 0.9 });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('含蓄'));
  });

  it('认不出的档位 → 走「不介入」,绝不假装某一档在生效', async () => {
    installMocks({ 'settings.nsfw_mode': 'weird-value' });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('不介入'));
  });

  it('旧版嵌套对象存成 null 也不炸(整页不该因此退回默认值)', async () => {
    installMocks({ 'settings.nsfw': null, 'settings.temperature': 0.5 });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('不介入'));
  });

  it('完全不介入时隐藏强度与附加约束(该档语义 = 本组设置全部不生效)', async () => {
    installMocks({ 'settings.nsfw_mode': 'none' });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('不介入'));
    expect(screen.queryByText('NSFW 强度')).toBeNull();
    expect(screen.queryByText('NSFW 额外约束')).toBeNull();
  });

  it('非不介入档仍显示强度与附加约束', async () => {
    installMocks({ 'settings.nsfw_mode': 'open' });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('开放'));
    expect(screen.getByText('NSFW 强度')).toBeTruthy();
    expect(screen.getByText('NSFW 额外约束')).toBeTruthy();
  });

  it('强度是二值按钮:存 0.9 → 「可主动推进」选中;点低档 → 落库 0', async () => {
    installMocks({ 'settings.nsfw_mode': 'open', 'settings.nsfw_intensity': 0.9 });
    render(<ModelParamsSection />);
    const low = await screen.findByText('仅玩家明确请求');
    const high = screen.getByText('可主动推进');
    expect(low.closest('button').className.includes('primary')).toBe(false);
    expect(high.closest('button').className.includes('primary')).toBe(true);

    fireEvent.click(low);
    // useAutoSave 有 250ms debounce
    await waitFor(() => expect(window.api.account.preferences).toHaveBeenCalledWith(
      expect.objectContaining({ 'settings.nsfw_intensity': 0 }),
    ), { timeout: 2000 });
    expect(low.closest('button').className.includes('primary')).toBe(true);
  });

  it('强度按钮:历史存值 0.3(滑块时代)按 >0.5 阈值归到「仅玩家明确请求」', async () => {
    installMocks({ 'settings.nsfw_mode': 'soft', 'settings.nsfw_intensity': 0.3 });
    render(<ModelParamsSection />);
    await screen.findByText('仅玩家明确请求');
    expect(screen.getByText('仅玩家明确请求').closest('button').className.includes('primary')).toBe(true);
    expect(screen.getByText('可主动推进').closest('button').className.includes('primary')).toBe(false);
  });

  it('禁止档不显示强度按钮(没有推进可言),但显示附加约束', async () => {
    installMocks({ 'settings.nsfw_mode': 'block' });
    render(<ModelParamsSection />);
    await waitFor(() => expect(selectedModeLabel()).toBe('禁止'));
    expect(screen.queryByText('仅玩家明确请求')).toBeNull();
    expect(screen.getByText('NSFW 额外约束')).toBeTruthy();
  });
});
