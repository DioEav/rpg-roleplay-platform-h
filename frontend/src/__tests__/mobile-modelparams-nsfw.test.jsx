/**
 * mobile-modelparams-nsfw.test.jsx — 移动端模型参数页的内容尺度读取。
 *
 * 与桌面端同源的两件事,移动端此前没有测试覆盖:
 *   · 白名单与后端 content_policy.MODES 必须一致(漏档 → 静默换档);
 *   · 旧版嵌套 settings.nsfw 可能是 null —— 不加守卫会在 useEffect 里抛,整页静默退回默认值。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ModelParamsSection } from '../mobile/settings/modelparams-section.jsx';

function installMocks(prefs) {
  window.api = {
    account: { profile: vi.fn().mockResolvedValue({ preferences: prefs }), preferences: vi.fn().mockResolvedValue({ ok: true }) },
    models: { list: vi.fn().mockResolvedValue({ models: { selected: null }, selected: null }) },
  };
  window.toast = vi.fn();
}

describe('移动端 ModelParamsSection — 内容尺度', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
  });

  it('「不介入」档显示说明文案,不显示强度与附加约束', async () => {
    installMocks({ 'settings.nsfw_mode': 'none' });
    render(<ModelParamsSection />);
    await waitFor(() => expect(screen.getByText(/平台不发送任何内容尺度设定/)).toBeTruthy());
    expect(screen.queryByText('NSFW 强度')).toBeNull();
  });

  it('选了具体档位则不显示「不介入」的说明', async () => {
    installMocks({ 'settings.nsfw_mode': 'open' });
    render(<ModelParamsSection />);
    await waitFor(() => expect(screen.queryByText(/平台不发送任何内容尺度设定/)).toBeNull());
    expect(screen.getByText('NSFW 强度')).toBeTruthy();
  });

  it('旧版嵌套 settings.nsfw 为 null 时不抛异常(该档按不介入显示)', async () => {
    installMocks({ 'settings.nsfw': null });
    render(<ModelParamsSection />);
    await waitFor(() => expect(screen.getByText(/平台不发送任何内容尺度设定/)).toBeTruthy());
  });

  it('未设过这一组 → 不介入(与后端一致)', async () => {
    installMocks({ 'settings.temperature': 0.5 });
    render(<ModelParamsSection />);
    await waitFor(() => expect(screen.getByText(/平台不发送任何内容尺度设定/)).toBeTruthy());
  });
});
