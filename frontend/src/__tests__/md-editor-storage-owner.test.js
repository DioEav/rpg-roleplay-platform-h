// editor-storage 的归属守卫:账号切换时清理 mde.*,避免上一个账号的草稿/标签
// 在同一浏览器上被下一个账号恢复。纯逻辑测试,不需要挂载编辑器。
import { describe, it, expect } from 'vitest';
import {
  OWNER_KEY, ensureEditorStorageOwner, clearEditorStorage, setEditorStorageOwner,
  hasUnownedEditorState,
} from '../components/md-editor/editor-storage.js';

function fakeStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _map: map,
  };
}

describe('ensureEditorStorageOwner', () => {
  it('首次运行且没有旧缓存:直接写入归属标记', () => {
    const s = fakeStorage({ 'other.key': 'x' });
    expect(ensureEditorStorageOwner(s, 7)).toEqual({ changed: false, cleared: 0 });
    expect(s.getItem(OWNER_KEY)).toBe('7');
    expect(s.getItem('other.key')).toBe('x');
  });

  it('首次运行只有 UI 偏好:直接认领,不弹未归属提示', () => {
    const s = fakeStorage({
      'mde.leftW': '260', 'mde.rightOpen': '1', 'mde.tree.expanded2': '["chapter"]',
    });
    expect(hasUnownedEditorState(s)).toBe(false);
    expect(ensureEditorStorageOwner(s, 7)).toEqual({ changed: false, cleared: 0 });
    expect(s.getItem(OWNER_KEY)).toBe('7');
    expect(s.getItem('mde.leftW')).toBe('260');
  });

  it('首次运行有草稿/标签/脚本选择/对话绑定时需要询问', () => {
    for (const key of ['mde.scriptId', 'mde.tabs.1.w1', 'mde.drafts.1.w1',
      'mde.activeKey.1.w1', 'mde.conv.1']) {
      const s = fakeStorage({ [key]: 'x' });
      expect(hasUnownedEditorState(s)).toBe(true);
      expect(ensureEditorStorageOwner(s, 7)).toEqual({ changed: false, cleared: 0, unowned: true });
      expect(s.getItem(OWNER_KEY)).toBeNull();
    }
  });

  it('首次运行但有旧缓存:返回 unowned 交给调用方询问,不静默认领', () => {
    const s = fakeStorage({ 'mde.drafts.1': 'draft', 'other.key': 'x' });
    expect(ensureEditorStorageOwner(s, 7)).toEqual({ changed: false, cleared: 0, unowned: true });
    expect(s.getItem(OWNER_KEY)).toBeNull();
    expect(s.getItem('mde.drafts.1')).toBe('draft');
    expect(s.getItem('other.key')).toBe('x');
  });

  it('用户确认保留后 setEditorStorageOwner 认领,旧草稿保留', () => {
    const s = fakeStorage({ 'mde.drafts.1': 'draft' });
    ensureEditorStorageOwner(s, 7);   // unowned
    expect(setEditorStorageOwner(s, 7)).toBe(true);
    expect(s.getItem(OWNER_KEY)).toBe('7');
    expect(s.getItem('mde.drafts.1')).toBe('draft');
  });

  it('clearEditorStorage 清空 mde.* 但保留归属标记与其它键', () => {
    const s = fakeStorage({
      [OWNER_KEY]: '7', 'mde.drafts.1': 'draft', 'mde.tabs.1': '[]', 'other.key': 'keep',
    });
    expect(clearEditorStorage(s)).toBe(2);
    expect(s.getItem('mde.drafts.1')).toBeNull();
    expect(s.getItem('mde.tabs.1')).toBeNull();
    expect(s.getItem(OWNER_KEY)).toBe('7');
    expect(s.getItem('other.key')).toBe('keep');
  });

  it('同一账号不做任何清理', () => {
    const s = fakeStorage({ [OWNER_KEY]: '7', 'mde.drafts.1': 'draft' });
    expect(ensureEditorStorageOwner(s, 7)).toEqual({ changed: false, cleared: 0 });
    expect(s.getItem('mde.drafts.1')).toBe('draft');
  });

  it('账号切换时清空所有 mde.*(保留归属标记),不影响其它键', () => {
    const s = fakeStorage({
      [OWNER_KEY]: '7',
      'mde.scriptId': '42',
      'mde.tabs.42': '[]',
      'mde.drafts.42': 'secret draft',
      'mde.conv.42': 'cid',
      'mde.leftW': '260',
      'other.key': 'keep',
    });
    const res = ensureEditorStorageOwner(s, 8);
    expect(res.changed).toBe(true);
    expect(res.cleared).toBe(5);
    expect(s.getItem(OWNER_KEY)).toBe('8');
    for (const k of ['mde.scriptId', 'mde.tabs.42', 'mde.drafts.42', 'mde.conv.42', 'mde.leftW']) {
      expect(s.getItem(k)).toBeNull();
    }
    expect(s.getItem('other.key')).toBe('keep');
  });

  it('拿不到用户 id 时不做判断(避免误清当前用户草稿)', () => {
    const s = fakeStorage({ [OWNER_KEY]: '7', 'mde.drafts.1': 'draft' });
    expect(ensureEditorStorageOwner(s, null)).toEqual({ changed: false, cleared: 0 });
    expect(s.getItem('mde.drafts.1')).toBe('draft');
    expect(s.getItem(OWNER_KEY)).toBe('7');
  });
});
