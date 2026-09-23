/**
 * file-library-rename.test.jsx — 文件库「重命名」按钮 + 弹框链路。
 *
 * 用户需求:文件库里要有按钮和弹框来更改图片名称。
 * 语义边界(与后端契约一致):
 *   · 只改显示名(user_assets.name),不动文件本体;
 *   · 保存前本地校验:trim 后非空、≤100 字符,否则保存禁用;
 *   · 成功 → 就地更新卡片名 + toast,弹框关闭;失败 → toast 报错,弹框关闭。
 *
 * window.api 是 api-client 挂的全局;jsdom 里没有,按真实形状打桩。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import FileLibrary from '../components/FileLibrary.jsx';

const ASSET = {
  id: 11,
  kind: 'ai_image',
  name: '',                              // 未重命名 → 卡片回退 storage_key
  storage_key: 'ai_images/ai_7_abc123.png',
  url: '/api/storage/ai_images/ai_7_abc123.png',
  source: 'image_gen',
  size: 2048,
  created_at: '2026-09-23T10:07:00+08:00',
};

function stubApi({ renameImpl } = {}) {
  const calls = [];
  const prev = window.api;
  window.api = {
    ...(prev || {}),
    library: {
      list: vi.fn().mockResolvedValue({ ok: true, items: [{ ...ASSET }] }),
      downloadUrl: (id) => `/api/library/asset/${id}/download`,
      renameAsset: vi.fn((id, name) => {
        calls.push({ id, name });
        return renameImpl
          ? renameImpl(id, name)
          : Promise.resolve({ ok: true, asset: { ...ASSET, name } });
      }),
      deleteAsset: vi.fn().mockResolvedValue({ ok: false, needs_confirm: true, references: [] }),
    },
  };
  return { calls, restore: () => { window.api = prev; } };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => { delete window.api; });

describe('FileLibrary — 重命名', () => {
  it('卡片有「重命名」按钮,点开弹框并回填当前名(storage_key 回退)', async () => {
    stubApi();
    render(<FileLibrary />);

    // 卡片名:asset.name 为空 → 显示 storage_key
    expect(await screen.findByText(ASSET.storage_key)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /重命名/ }));

    // 弹框出现,输入框回填当前展示名
    const input = await screen.findByRole('textbox');
    expect(input.value).toBe(ASSET.storage_key);
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument();
  });

  it('输入新名 → 保存 → renameAsset(id, trimmed) 被调,卡片名就地更新', async () => {
    const { calls } = stubApi();
    render(<FileLibrary />);

    fireEvent.click(await screen.findByRole('button', { name: /重命名/ }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '  夏日海滩  ' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(calls).toEqual([{ id: ASSET.id, name: '夏日海滩' }]));
    // 卡片显示新名(就地更新,不重拉)
    expect(await screen.findByText('夏日海滩')).toBeInTheDocument();
    // 弹框关闭
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('空名/纯空白 → 保存禁用(不发请求)', async () => {
    const { calls } = stubApi();
    render(<FileLibrary />);

    fireEvent.click(await screen.findByRole('button', { name: /重命名/ }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
    expect(calls).toEqual([]);
  });

  it('超 100 字符 → 保存禁用 + 错误提示', async () => {
    stubApi();
    render(<FileLibrary />);

    fireEvent.click(await screen.findByRole('button', { name: /重命名/ }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'x'.repeat(101) } });

    expect(screen.getByRole('button', { name: /保存/ })).toBeDisabled();
    expect(await screen.findByText(/不能超过 100/)).toBeInTheDocument();
  });

  it('后端失败(ok:false)→ 弹框关闭且报错 toast,不假装成功', async () => {
    stubApi({ renameImpl: () => Promise.resolve({ ok: false, error: 'not_found' }) });
    const toast = vi.fn();
    window.toast = toast;
    render(<FileLibrary />);

    fireEvent.click(await screen.findByRole('button', { name: /重命名/ }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '新名' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('重命名失败'),
      expect.objectContaining({ kind: 'danger' }),
    );
    // 失败不得改卡片名 → 仍显示 storage_key
    expect(screen.getByText(ASSET.storage_key)).toBeInTheDocument();
    delete window.toast;
  });

  it('取消 → 不发请求,弹框关闭', async () => {
    const { calls } = stubApi();
    render(<FileLibrary />);

    fireEvent.click(await screen.findByRole('button', { name: /重命名/ }));
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(calls).toEqual([]);
  });
});

// 用户报:删除按钮两次改红色都没生效。根因:CSButton 的 style 不是 React CSS 对象,
// 而是 Cloudscape 结构化 {root:{color:{default,hover,active}}} —— getButtonStyles 只认
// style.root,传扁平 {'--x': …} 直接返回 undefined、连 DOM 都上不了。
// 锁两条:卡片删除按钮(inline-link 文字色)与确认弹窗按钮(primary 背景色)必须把
// -esndbs 后缀变量真正写进 style 属性(getButtonStyles 的映射产物)。
describe('FileLibrary — 删除按钮红色(结构化 style 落地)', () => {
  it('卡片删除按钮 style 含 --awsui-style-color-default-esndbs: #d63031', async () => {
    stubApi();
    render(<FileLibrary />);
    const btn = await screen.findByRole('button', { name: /删除/ });
    const style = btn.getAttribute('style') || '';
    expect(style, `扁平 CSS 变量被 getButtonStyles 丢弃,实际 style=${style}`)
      .toContain('--awsui-style-color-default-esndbs');
    expect(style).toContain('#d63031');
    // hover/active 必须同时设,否则悬停回退默认蓝
    expect(style).toContain('--awsui-style-color-hover-esndbs');
    expect(style).toContain('--awsui-style-color-active-esndbs');
  });

  it('确认删除弹窗按钮(style.root.background)写进 --awsui-style-background-default-esndbs', async () => {
    const { calls } = stubApi({
      renameImpl: undefined,
      // 让删除探测走进弹窗:startDelete 的 probe 返回 needs_confirm
    });
    // 覆写 deleteAsset 走确认弹窗链路
    window.api.library.deleteAsset = vi.fn((id, confirm, probe) =>
      probe
        ? Promise.resolve({ ok: false, needs_confirm: true, references: [] })
        : Promise.resolve({ ok: true, deleted: true }),
    );
    window.toast = vi.fn();
    render(<FileLibrary />);

    fireEvent.click(await screen.findByRole('button', { name: /删除/ }));
    const confirmBtn = await screen.findByRole('button', { name: /确认删除/ });
    const style = confirmBtn.getAttribute('style') || '';
    expect(style, `扁平 --btn-bg 被丢弃,实际 style=${style}`)
      .toContain('--awsui-style-background-default-esndbs');
    expect(style).toContain('#d63031');
    delete window.toast;
  });
});
