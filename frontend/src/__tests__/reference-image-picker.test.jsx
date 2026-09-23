/**
 * reference-image-picker.test.jsx — 参考图选择器的「从图库选」链路。
 *
 * 用户上报:生图弹窗里「从图库选」提示「图库还没有可用图片」,但文件库页面明明有图。
 * 两处调的是**同一个** GET /api/library(返回信封 {ok, items}),唯一差别是 picker 多一层
 * kind 白名单过滤(ai_image|card_image|avatar|cover)。本文件用**后端真实响应形状**驱动:
 *   · 信封 {ok, items} → 网格渲染,非图片 kind(script_txt)被滤掉;
 *   · 勾选 → 确认 → onChange 回传所选 URL(不超 max);
 *   · 接口失败 → 空列表而非挂死。
 * 若这些全绿而线上仍空,问题在运行时数据(见交付说明的诊断步骤),不在组件。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import ReferenceImagePicker from '../components/ReferenceImagePicker.jsx';

// 形状 = rpg/platform_app/library.py list_assets 的真实返回(user_assets 行: id/kind/url/...)
const LIB_RESPONSE = {
  ok: true,
  items: [
    { id: 1, kind: 'ai_image', url: '/api/storage/ai_images/gen-1.png', storage_key: 'ai_images/gen-1.png' },
    { id: 2, kind: 'cover', url: '/api/storage/ai_images/cover-2.png', storage_key: 'ai_images/cover-2.png' },
    { id: 3, kind: 'script_txt', url: '', storage_key: 'scripts/x.txt' },   // 非图片 → 应被滤掉
    { id: 4, kind: 'ai_image', url: '', storage_key: 'ai_images/no-url.png' }, // 无 url → 应被滤掉
  ],
  total_count_hint: 4,
};

// 未知 kind + 图片扩展名 —— FileLibrary 对未知 kind 是兜底展示, picker 的过滤必须同样宽
// (用户上报:「文件库里有图,从图库选却是空」—— 最可能就是这种 kind 不在白名单里的行被滤掉了)
const LIB_RESPONSE_UNKNOWN_KIND = {
  ok: true,
  items: [
    { id: 9, kind: 'image_gen_src', url: '/api/storage/ai_images/unknown-kind.png' },
    { id: 10, kind: 'whatever', url: '/api/images/file/legacy.jpg' },
  ],
};

function renderPicker(props = {}) {
  const onChange = vi.fn();
  render(<ReferenceImagePicker refs={[]} onChange={onChange} {...props} />);
  return { onChange };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => { delete window.api; });

describe('ReferenceImagePicker — 从图库选', () => {
  it('拉取信封 {ok,items} → 过滤出图片类资产并渲染网格', async () => {
    const list = vi.fn().mockResolvedValue(LIB_RESPONSE);
    window.api = { library: { list } };

    renderPicker();
    fireEvent.click(screen.getByText('从图库选'));

    // script_txt 与无 url 的行被过滤 → 只剩 2 张(alt="" 的 img 不进可访问性树,按类名查)
    await waitFor(() => expect(document.querySelectorAll('.rif__lib .ms-lib__cell img')).toHaveLength(2));
    // 确认按钮显示的是当前勾选数(未勾 = 0),不是图库条数
    expect(screen.getByText('确认（0）')).toBeTruthy();
    expect(list).toHaveBeenCalledWith();
  });

  it('勾选 → 确认 → onChange 回传所选 url;超过 max 在确认时截断并提示', async () => {
    const list = vi.fn().mockResolvedValue(LIB_RESPONSE);
    window.api = { library: { list } };
    const { onChange } = renderPicker({ max: 1 });   // 上限 1:勾 2 张,确认时只收 1 并提示

    fireEvent.click(screen.getByText('从图库选'));
    await waitFor(() => expect(document.querySelectorAll('.rif__lib .ms-lib__cell img')).toHaveLength(2));
    const cells = document.querySelectorAll('.rif__lib .ms-lib__cell');
    fireEvent.click(cells[0]);
    fireEvent.click(cells[1]);
    // 图库面板内允许多勾(上限在确认时生效) → 按钮显示勾选数 2
    fireEvent.click(screen.getByText('确认（2）'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['/api/storage/ai_images/gen-1.png']);   // room=1,只收第一张
    expect(screen.getByText(/最多只能选/)).toBeTruthy();   // over_limit 提示
  });

  it('接口失败 → 显示空态,不挂死', async () => {
    window.api = { library: { list: vi.fn().mockRejectedValue(new Error('boom')) } };
    renderPicker();

    fireEvent.click(screen.getByText('从图库选'));
    await waitFor(() => expect(screen.getByText('图库还没有可用图片')).toBeTruthy());
  });

  it('未知 kind 但 url 是图片扩展名的资产,同样进网格(与文件库口径一致)', async () => {
    window.api = { library: { list: vi.fn().mockResolvedValue(LIB_RESPONSE_UNKNOWN_KIND) } };
    renderPicker();

    fireEvent.click(screen.getByText('从图库选'));
    await waitFor(() => expect(document.querySelectorAll('.rif__lib .ms-lib__cell img')).toHaveLength(2));
  });
});
