/**
 * state-event-bridge.test.jsx — SSE 桥的空闲重连行为。
 *
 * 日志里那条第 ~45 秒出现一次的 `GET /api/state_events` 就是这里来的:后端 25s 发一次
 * keepalive,但发的是 SSE **注释**(`: keepalive`),而 EventSource 没有任何 API 能观察注释
 * → 前端的 watchdog 只认「收到过事件」,于是空闲连接每 45s 被判死、强断重连一次。
 *
 * 现在后端改发具名 `event: keepalive`,桥这边把它当存活信号(只更新时间戳,不派发 UI 事件)。
 * 另修:排队中的重连此前没有句柄可清,切到后台(隐藏即断连)之后仍会在隐藏标签页里把连接建回来。
 *
 * 不变量(本文件锁死):
 *   · 持续收到 keepalive → 不触发强断重连(只应存在 1 个 EventSource 实例);
 *   · 切到后台 → 排队中的重连被取消(不再新建连接)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = {};
    this.readyState = 0;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  close() { this.closed = true; }
  emit(type, data) {
    for (const fn of (this.listeners[type] || [])) {
      fn({ type, data: JSON.stringify(data === undefined ? {} : data) });
    }
  }
}

async function loadBridge() {
  window.__rpg_state_bridge_inited__ = false;
  vi.resetModules();
  await import('../state-event-bridge.js');
  return FakeEventSource.instances[FakeEventSource.instances.length - 1];
}

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('state-event-bridge — SSE 空闲重连', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    window.EventSource = FakeEventSource;
    window.RPG_AUTH = { authed: true };
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.EventSource;
    delete window.RPG_AUTH;
    delete window.__rpg_state_bridge_inited__;
    delete window.__rpgStateEventBridge;
  });

  it('持续收到 keepalive 时,空闲连接不被 watchdog 判死重连', async () => {
    const es = await loadBridge();
    expect(FakeEventSource.instances.length).toBe(1);

    es.emit('hello', { user_id: 1 });
    // 每 30s 一条 keepalive,持续 150s(远超 45s 的无事件阈值)
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(30000);
      es.emit('keepalive', { ts: Date.now() });
    }
    await vi.advanceTimersByTimeAsync(5000);

    expect(FakeEventSource.instances.length).toBe(1);   // 没有重连
    expect(es.closed).toBe(false);                      // 连接还在
  });

  it('切到后台会取消排队中的重连(不在隐藏标签页里把连接建回来)', async () => {
    const es = await loadBridge();
    expect(FakeEventSource.instances.length).toBe(1);

    es.emit('error', {});            // error 路径 → 退避 1s 后排一次重连
    setVisibility('hidden');         // 紧接着切到后台
    await vi.advanceTimersByTimeAsync(10000);

    expect(FakeEventSource.instances.length).toBe(1);   // 排队的那次没有兑现
  });
});
