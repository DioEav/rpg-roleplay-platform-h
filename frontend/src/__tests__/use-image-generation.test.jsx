/**
 * use-image-generation.test.jsx — 生图内核 hook 回归测试。
 *
 * GenerateImageModal 与 MediaStudio 的 generate + 每 2s 轮询 + creds 分类内核收口到
 * useImageGeneration。锁定逐字保留的两宿主语义:
 *   · generate → 轮询到 done → onDone(url)。
 *   · 轮询到 failed → 凭据错误分类(isCredentialsError)/普通错误。
 *   · GenerateImageModal:无 image_id → noImageIdMsg;轮询 catch 停并报错。
 *   · MediaStudio:inspect 拦 quota/creds;轮询 catch 重试(2500);done 需 r.url。
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImageGeneration } from '../hooks/useImageGeneration.js';

function setApi({ generate, get }) {
  window.api = { images: { generate, get } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete window.api; });

describe('useImageGeneration', () => {
  it('generate → 轮询 pending → done → onDone(url)', async () => {
    let getCalls = 0;
    setApi({
      generate: vi.fn(async () => ({ image_id: 'img1' })),
      get: vi.fn(async () => {
        getCalls += 1;
        return getCalls < 2 ? { status: 'pending' } : { status: 'done', url: 'http://x/y.png' };
      }),
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useImageGeneration({ onDone }));
    await act(async () => { await result.current.generate({ prompt: 'p' }, {}); });
    // 第一次 get = pending → 排 2s
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    // 契约:onDone(url, imageId) —— imageId 供调用方广播本地 image_ready 事件(见 hook 头注)
    expect(onDone).toHaveBeenCalledWith('http://x/y.png', 'img1');
    expect(result.current.generating).toBe(false);
  });

  it('轮询 failed 普通错误 → error 设置,非 creds', async () => {
    setApi({
      generate: vi.fn(async () => ({ image_id: 'imgF' })),
      get: vi.fn(async () => ({ status: 'failed', error: '上游 500' })),
    });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => { await result.current.generate({ prompt: 'p' }, { failFallback: '生成失败' }); });
    expect(result.current.error).toBe('上游 500');
    expect(result.current.credsMissing).toBe(false);
  });

  it('轮询 failed 凭据错误 → credsMissing=true + credsErrorText', async () => {
    setApi({
      generate: vi.fn(async () => ({ image_id: 'imgC' })),
      get: vi.fn(async () => ({ status: 'failed', error: 'credentials_required' })),
    });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => {
      await result.current.generate({ prompt: 'p' }, { credsErrorText: '请先配置 Key' });
    });
    expect(result.current.credsMissing).toBe(true);
    expect(result.current.error).toBe('请先配置 Key');
  });

  it('GenerateImageModal 语义:无 image_id → noImageIdMsg', async () => {
    setApi({
      generate: vi.fn(async () => ({})),  // 无 image_id
      get: vi.fn(),
    });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => {
      await result.current.generate({ prompt: 'p' }, { noImageIdMsg: '服务端未返回任务 ID' });
    });
    expect(result.current.error).toBe('服务端未返回任务 ID');
  });

  it('MediaStudio 语义:inspect 拦 quota → onFail', async () => {
    setApi({
      generate: vi.fn(async () => ({ code: 'quota_exceeded' })),
      get: vi.fn(),
    });
    const onFail = vi.fn();
    const { result } = renderHook(() => useImageGeneration({ onFail }));
    await act(async () => {
      await result.current.generate({ prompt: 'p' }, {
        inspect: (r, { fail }) => {
          if (r && r.code === 'quota_exceeded') { fail('今日生图次数已达上限'); return true; }
          return false;
        },
      });
    });
    expect(onFail).toHaveBeenCalled();
    expect(onFail.mock.calls[0][0]).toBe('今日生图次数已达上限');
  });

  it('MediaStudio 语义:done 需 r.url(requireUrl)+ doneFromStatus(r.ok)', async () => {
    let n = 0;
    setApi({
      generate: vi.fn(async () => ({ image_id: 'imgU' })),
      get: vi.fn(async () => { n += 1; return n < 2 ? { ok: true } /*无 url → 继续轮询*/ : { ok: true, url: 'u://ok' }; }),
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useImageGeneration({ onDone }));
    await act(async () => {
      await result.current.generate({ prompt: 'p' }, {
        doneFromStatus: (r) => r && (r.status || (r.ok && 'done')),
        requireUrl: true,
      });
    });
    // 第一次 get: ok 但无 url → status='done' 但 requireUrl 不满足 → 继续轮询
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(onDone).toHaveBeenCalledWith('u://ok', 'imgU');
  });

  it('stop():卸载/关闭后不再继续轮询', async () => {
    const get = vi.fn(async () => ({ status: 'pending' }));
    setApi({ generate: vi.fn(async () => ({ image_id: 'imgS' })), get });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => { await result.current.generate({ prompt: 'p' }, {}); });
    const callsAfterGen = get.mock.calls.length; // 1
    act(() => { result.current.stop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(get.mock.calls.length).toBe(callsAfterGen); // 没有新增轮询
  });

  /* ── 以下三条对应「后端一直在打 GET /api/images/N」的收口 ────────────────── */

  it('成功后就地广播 rpg-image-updated(没配 Redis 时聊天也能实时追加)', async () => {
    // 生图跑在独立进程(postproc worker)里,它的 SSE 事件跨进程投递要 Redis;
    // 未配 Redis 的形态下浏览器收不到 → 聊天里的图要刷新才出现。这一枪由前端自己补,
    // 负载形状必须与 state-event-bridge 产出的完全一致(消费方按 image_id 去重)。
    const seen = [];
    const onEvt = (e) => seen.push(e.detail);
    window.addEventListener('rpg-image-updated', onEvt);
    try {
      setApi({
        generate: vi.fn(async () => ({ image_id: 'imgEv' })),
        get: vi.fn(async () => ({ status: 'done', url: 'https://cdn/e.png' })),
      });
      const { result } = renderHook(() => useImageGeneration({}));
      await act(async () => { await result.current.generate({ prompt: 'p', kind: 'game' }, {}); });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({
        op: 'ready',
        payload: { image_id: 'imgEv', url: 'https://cdn/e.png', kind: 'game' },
        ts: expect.any(Number),
      });
    } finally {
      window.removeEventListener('rpg-image-updated', onEvt);
    }
  });

  it('cancelled 是终态:停止轮询并报错', async () => {
    // 后端取消接口 / wait_for_image 都把 cancelled 当终态,前端此前只认 done/failed →
    // 移动端取消过的图在桌面端会被永远 2s 轮询(状态不会再变)。后端写入的 error =「用户取消」。
    const get = vi.fn(async () => ({ status: 'cancelled', error: '用户取消' }));
    setApi({ generate: vi.fn(async () => ({ image_id: 'imgX' })), get });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => { await result.current.generate({ prompt: 'p' }, {}); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe('用户取消');
    expect(result.current.generating).toBe(false);
  });

  it('僵尸回归:请求在途时 stop(),响应回来不得复活轮询链', async () => {
    // 关闭弹窗/卸载发生在请求 in-flight 时:stop() 只 clearTimeout 清不到它,而响应回来时
    // 陈旧守卫(此前只看 genIdRef)仍然通过 → 又挂上新的 timeout,链条活在一个已死组件的 ref 里,
    // 之后再也无人能 stop。这正是「界面早关了,后端还在一直 GET」。
    let resolveInflight = null;
    let calls = 0;
    const get = vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ status: 'pending' });
      return new Promise((res) => { resolveInflight = res; });   // 第 2 次:挂住不回
    });
    setApi({ generate: vi.fn(async () => ({ image_id: 'imgZ' })), get });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => { await result.current.generate({ prompt: 'p' }, {}); });   // 第 1 次: pending
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });             // 第 2 次: 发出并挂住
    expect(get).toHaveBeenCalledTimes(2);

    act(() => { result.current.stop(); });                                          // 关弹窗 / 卸载
    await act(async () => { resolveInflight({ status: 'pending' }); });             // 迟到的响应

    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(get).toHaveBeenCalledTimes(2);   // 旧实现会在这里变成 3、4、5…
  });

  it('轮询超过上限必须停止并报错(兜住永远到不了终态的记录)', async () => {
    const get = vi.fn(async () => ({ status: 'pending' }));
    setApi({ generate: vi.fn(async () => ({ image_id: 'imgT' })), get });
    const { result } = renderHook(() => useImageGeneration({}));
    await act(async () => {
      await result.current.generate({ prompt: 'p' }, { maxPollAttempts: 3 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBe('生图超时:未能确认结果');
    expect(result.current.generating).toBe(false);
  });
});
