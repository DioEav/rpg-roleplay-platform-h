// draft-store:草稿写入必须显式反馈失败,不能像旧 lsSet 一样静默吞掉配额错误。
import { describe, it, expect } from 'vitest';
import { MAX_DRAFT_CHARS, writeDrafts } from '../components/md-editor/draft-store.js';

function fakeStorage({ throwOnSet = false, throwOnRemove = false } = {}) {
  const map = new Map();
  return {
    _map: map,
    setItem(k, v) { if (throwOnSet) throw new Error('QuotaExceededError'); map.set(k, v); },
    removeItem(k) { if (throwOnRemove) throw new Error('nope'); map.delete(k); },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
  };
}

describe('writeDrafts', () => {
  it('正常写入并返回大小', () => {
    const s = fakeStorage();
    const res = writeDrafts(s, 'k', [{ key: 'chapter:1', content: '正文' }]);
    expect(res.ok).toBe(true);
    expect(res.size).toBeGreaterThan(0);
    expect(s.getItem('k')).toContain('正文');
  });

  it('空草稿列表 → 删除旧键', () => {
    const s = fakeStorage();
    s.setItem('k', 'old');
    expect(writeDrafts(s, 'k', [])).toEqual({ ok: true, removed: true });
    expect(s.getItem('k')).toBeNull();
  });

  it('超过单次上限 → too_large,不写也不删旧值', () => {
    const s = fakeStorage();
    s.setItem('k', 'old');
    const huge = [{ content: 'x'.repeat(MAX_DRAFT_CHARS + 10) }];
    const res = writeDrafts(s, 'k', huge);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('too_large');
    expect(s.getItem('k')).toBe('old');
  });

  it('配额/隐私模式异常 → quota,由调用方警告', () => {
    const s = fakeStorage({ throwOnSet: true });
    const res = writeDrafts(s, 'k', [{ content: '正文' }]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('quota');
  });
});
