/**
 * data-loader-userlists.test.jsx — 登录用户三份业务列表的并行拉取(fetchUserLists)。
 *
 * 背景:游戏控制台 splash 门控等 hydratePlatform 完成,而它此前把 scripts / saves /
 * library 三个互不依赖的请求**顺序 await** —— 总耗时 = 三次往返之和。抽出的
 * fetchUserLists 改为并行,本文件锁死:
 *   · 并发性:三个请求必须**同时发出**(顺序实现下,首请求 resolve 前第二个不会被调用);
 *   · 隔离性:任一请求 reject 只让自己的列表落空数组,不拖垮另外两个;
 *   · 形态归一:数组 / {items} / {scripts|saves} 三种后端返回形态全兼容;
 *   · library 语义:>8 条取前 8 条并映射字段,空 → []。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchUserLists } from '../data-loader.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 三个请求各挂一个手动放行的 deferred,并记录调用顺序。 */
function makeApi() {
  const d = { scripts: deferred(), saves: deferred(), library: deferred() };
  const calls = [];
  const api = {
    scripts: { list: vi.fn(() => { calls.push('scripts'); return d.scripts.promise; }) },
    saves: { list: vi.fn(() => { calls.push('saves'); return d.saves.promise; }) },
    library: { list: vi.fn(() => { calls.push('library'); return d.library.promise; }) },
  };
  return { api, d, calls };
}

const SCRIPT = { id: 1, title: '测试剧本', chapter_count: 3 };
const SAVE = { id: 7, title: '测试存档', branch_count: 2 };
const ENTRY = { name: 'a.png', size: 10, updated_at: '2026-01-01T00:00:00Z' };

beforeEach(() => { vi.clearAllMocks(); });

describe('fetchUserLists — 并发与结果', () => {
  it('三个请求同时发出(首请求 resolve 前第三个必须已被调用)', async () => {
    const { api, d, calls } = makeApi();
    const p = fetchUserLists(api);
    // call 经 Promise.resolve().then(fn) 包了一层微任务(同步抛错兜底),先冲刷微任务再断言。
    // 核心判别力不变:顺序实现下冲刷后仍只有 ['scripts'](saves 要等 scripts resolve 才发)。
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['scripts', 'saves', 'library']);

    // 逆序放行,结果不受完成顺序影响
    d.library.resolve({ entries: [ENTRY] });
    d.saves.resolve({ items: [SAVE] });
    d.scripts.resolve([SCRIPT]);
    const out = await p;
    expect(out.scripts).toHaveLength(1);
    expect(out.scripts[0].title).toBe('测试剧本');
    expect(out.saves).toHaveLength(1);
    expect(out.saves[0].title).toBe('测试存档');
    expect(out.recent_assets).toHaveLength(1);
    expect(out.recent_assets[0].name).toBe('a.png');
  });

  it('失败隔离:scripts reject 只让它自己落空数组,不拖垮另外两个', async () => {
    const { api, d } = makeApi();
    const p = fetchUserLists(api);
    d.scripts.reject(new Error('boom'));
    d.saves.resolve({ items: [SAVE] });
    d.library.resolve({ entries: [ENTRY] });
    const out = await p;
    expect(out.scripts).toEqual([]);
    expect(out.saves).toHaveLength(1);
    expect(out.recent_assets).toHaveLength(1);
  });

  it('契约:fetchUserLists 永不 reject —— api 方法同步抛错也算失败落空', async () => {
    // api-client 的方法正常都返回 promise,但防御性契约要立住:同步抛错(而非 rejected
    // promise)时 .catch 挂不上,必须经 Promise.resolve().then 包裹才能被兜住。
    const throwingApi = {
      scripts: { list() { throw new Error('sync boom'); } },
      saves: { list: () => Promise.resolve({ items: [SAVE] }) },
      library: { list: () => Promise.resolve({ entries: [ENTRY] }) },
    };
    const out = await fetchUserLists(throwingApi);
    expect(out.scripts).toEqual([]);
    expect(out.saves).toHaveLength(1);
    expect(out.recent_assets).toHaveLength(1);
  });

  it('负载畸形:一份列表的坏形态只让它自己落空,不拖垮另外两份(与旧版逐段 try/catch 同语义)', async () => {
    const d = { scripts: deferred(), saves: deferred(), library: deferred() };
    const api = {
      scripts: { list: () => d.scripts.promise },
      saves: { list: () => d.saves.promise },
      library: { list: () => d.library.promise },
    };
    const p = fetchUserLists(api);
    d.scripts.resolve({ items: {} });            // items 非数组 → scripts 落空
    d.saves.resolve({ items: [SAVE, null] });    // 含 null 项 → 剔除 null 项,其余保留
    d.library.resolve({ entries: { length: 3 } }); // entries 非数组 → recent_assets 落空
    const out = await p;
    expect(out.scripts).toEqual([]);
    expect(out.saves).toHaveLength(1);
    expect(out.recent_assets).toEqual([]);
  });
});

describe('fetchUserLists — 形态归一', () => {
  it('裸数组 / {saves} / {items} 三种返回形态全兼容', async () => {
    const d = { scripts: deferred(), saves: deferred(), library: deferred() };
    const api = {
      scripts: { list: () => d.scripts.promise },
      saves: { list: () => d.saves.promise },
      library: { list: () => d.library.promise },
    };
    const p = fetchUserLists(api);
    d.scripts.resolve([SCRIPT]);                    // 裸数组
    d.saves.resolve({ saves: [SAVE] });             // {saves}
    d.library.resolve({ items: [ENTRY] });          // {items}
    const out = await p;
    expect(out.scripts).toHaveLength(1);
    expect(out.saves).toHaveLength(1);
    expect(out.recent_assets).toHaveLength(1);
  });
});

describe('fetchUserLists — library 语义', () => {
  it('>8 条只取前 8 条,并映射 name/kind', async () => {
    const d = { scripts: deferred(), saves: deferred(), library: deferred() };
    const api = {
      scripts: { list: () => d.scripts.promise },
      saves: { list: () => d.saves.promise },
      library: { list: () => d.library.promise },
    };
    const p = fetchUserLists(api);
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.png`, size: i }));
    d.scripts.resolve([]);
    d.saves.resolve([]);
    d.library.resolve({ entries });
    const out = await p;
    expect(out.recent_assets).toHaveLength(8);
    expect(out.recent_assets[0].name).toBe('f0.png');
    expect(out.recent_assets[0].kind).toBe('image');   // guessKind 按扩展名推断
  });

  it('library 空列表 → recent_assets = [](不残留 baseline mock)', async () => {
    const d = { scripts: deferred(), saves: deferred(), library: deferred() };
    const api = {
      scripts: { list: () => d.scripts.promise },
      saves: { list: () => d.saves.promise },
      library: { list: () => d.library.promise },
    };
    const p = fetchUserLists(api);
    d.scripts.resolve([]);
    d.saves.resolve([]);
    d.library.resolve({ entries: [] });
    const out = await p;
    expect(out.recent_assets).toEqual([]);
  });
});
