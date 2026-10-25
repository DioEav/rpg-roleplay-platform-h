// md-continue 的草稿本地侧还原:待定区里的文本是未接受的 AI 生成,不能直接进草稿。
import { describe, it, expect } from 'vitest';
import { pendingLocalTextFromParts } from '../lib/md-continue.js';

describe('pendingLocalTextFromParts', () => {
  it('continue:去掉待定区插入段,还原 AI 介入前的文档', () => {
    // '前' + 'AI生成' + '后' → 去掉 [1,5) → '前后'
    expect(pendingLocalTextFromParts('前AI生成后', 1, 5, '')).toBe('前后');
  });

  it('rewrite:用被替换的原文换回生成段', () => {
    // '前' + '新文' + '后',原选中 '旧段' → '前旧段后'
    expect(pendingLocalTextFromParts('前新文后', 1, 3, '旧段')).toBe('前旧段后');
  });

  it('越界位置被夹到文档长度内(并发编辑/状态映射异常时不抛)', () => {
    expect(pendingLocalTextFromParts('abc', 99, 120, 'x')).toBe('abcx');
    expect(pendingLocalTextFromParts('abc', -5, 2, '')).toBe('c');
  });
});
