// 多窗口隔离:每个 tab 的 sessionStorage 窗口 id 不同,草稿/标签缓存键必须带后缀,
// 否则两个窗口会整键覆盖对方的未保存内容。
import { describe, it, expect } from 'vitest';
import { WINDOW_KEY, getWindowId, editorStorageKeys } from '../components/md-editor/editor-storage.js';

function fakeSessionStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    _map: map,
  };
}

describe('getWindowId', () => {
  it('同一个 sessionStorage 多次读取返回同一 id', () => {
    const s = fakeSessionStorage();
    const a = getWindowId(s);
    expect(a).toBeTruthy();
    expect(getWindowId(s)).toBe(a);
    expect(s.getItem(WINDOW_KEY)).toBe(a);
  });

  it('不同窗口(sessionStorage)得到不同 id', () => {
    const a = getWindowId(fakeSessionStorage());
    const b = getWindowId(fakeSessionStorage());
    expect(a).not.toBe(b);
  });

  it('sessionStorage 不可用时退回稳定占位,不抛错', () => {
    expect(getWindowId(null)).toBe('w0');
    expect(getWindowId({ getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } })).toBe('w0');
  });
});

describe('editorStorageKeys', () => {
  it('草稿/标签/激活键都带窗口后缀,并提供旧版键用于迁移', () => {
    expect(editorStorageKeys(42, 'win-a')).toEqual({
      drafts: 'mde.drafts.42.win-a',
      tabs: 'mde.tabs.42.win-a',
      active: 'mde.activeKey.42.win-a',
      legacyDrafts: 'mde.drafts.42',
      legacyTabs: 'mde.tabs.42',
      legacyActive: 'mde.activeKey.42',
    });
  });

  it('不同窗口的键互不相同', () => {
    const a = editorStorageKeys(42, 'a');
    const b = editorStorageKeys(42, 'b');
    expect(a.drafts).not.toBe(b.drafts);
    expect(a.tabs).not.toBe(b.tabs);
  });
});
