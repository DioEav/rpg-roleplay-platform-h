/**
 * image-list-envelope.test.jsx — `/api/images/list` 的信封解析回归。
 *
 * 后端返回 `{ok, images, meta}`（api-client 的 GET 不解包），而两处消费方按裸数组写：
 *     const done = Array.isArray(list) ? list.filter(...) : [];
 * → 恒为空数组 → **刷新页面后聊天/酒馆里的生图全部消失**（图在库里、SSE 实时那条也在，
 * 只有"重新拉历史"这条是坏的，所以平时不容易发现）。这里锁两层：
 *   ① lib/image-list.js 的形状归一（信封 / 裸数组 / 空值）;
 *   ② useSaveImages 真的能把信封里的行映射成 { msgKey: images[] }。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { imagesFromResponse } from '../lib/image-list.js';
import { useSaveImages } from '../components/game/GameChatMessages.jsx';

describe('imagesFromResponse', () => {
  it('信封 { ok, images } → 取出 images', () => {
    const rows = [{ id: 1, url: 'u', status: 'done' }];
    expect(imagesFromResponse({ ok: true, images: rows, meta: {} })).toBe(rows);
  });

  it('裸数组(老形状/中间层 unwrap 过) → 原样返回', () => {
    const rows = [{ id: 2, url: 'v', status: 'done' }];
    expect(imagesFromResponse(rows)).toBe(rows);
  });

  it('null / undefined / 形状不认识 → 空数组(不抛)', () => {
    expect(imagesFromResponse(null)).toEqual([]);
    expect(imagesFromResponse(undefined)).toEqual([]);
    expect(imagesFromResponse({ ok: false })).toEqual([]);
    expect(imagesFromResponse('nope')).toEqual([]);
  });
});

describe('useSaveImages — 历史图片按 message_index 还原', () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { delete window.api; });

  it('信封里的 done 行会被映射到对应消息(此前恒空 → 刷新后图全丢)', async () => {
    window.api = {
      images: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          images: [
            { id: 11, url: 'https://cdn/a.png', kind: 'game', status: 'done', message_index: 3 },
            { id: 12, url: 'https://cdn/b.png', kind: 'game', status: 'pending', message_index: 4 },
          ],
          meta: {},
        }),
      },
    };

    const { result } = renderHook(() => useSaveImages('42', { current: 9 }));

    await waitFor(() => expect(Object.keys(result.current)).toContain('3'));
    expect(result.current['3'].map((im) => im.id)).toEqual([11]);   // pending 行被过滤
  });

  it('收到 image/deleted(文件库删除广播)→ 对应图从聊天气泡里移除', async () => {
    // 用户上报:文件库删图后聊天里只剩一个 404 的空图位。
    // 后端删除资产时广播 op=deleted(带 url);useSaveImages 必须按 url 尾段匹配并移除。
    window.api = {
      images: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          images: [
            { id: 21, url: '/api/storage/ai_images/keep.png', kind: 'game', status: 'done', message_index: 1 },
            { id: 22, url: '/api/storage/ai_images/deleted.png', kind: 'game', status: 'done', message_index: 2 },
          ],
          meta: {},
        }),
      },
    };

    const { result } = renderHook(() => useSaveImages('42', { current: 9 }));
    await waitFor(() => expect(Object.keys(result.current).length).toBeGreaterThan(0));

    // 模拟 state-event-bridge 派发的删除事件(storage_key 形态也能匹配 —— 尾段一致)
    await act(async () => {
      window.dispatchEvent(new CustomEvent('rpg-image-updated', {
        detail: { op: 'deleted', payload: { image_id: 999, storage_key: 'ai_images/deleted.png' }, ts: Date.now() },
      }));
    });

    const remaining = Object.values(result.current).flat().map((im) => im.id);
    expect(remaining).toEqual([21]);
  });
});
