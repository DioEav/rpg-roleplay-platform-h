// rebuild_script_module 的脏标签影响范围:别名归一 + 未知模块保守按章节。
import { describe, it, expect } from 'vitest';
import { rebuildDirtyKinds } from '../components/md-editor/rebuild-scope.js';

describe('rebuildDirtyKinds', () => {
  it('卡片/世界书/canon/时间线映射到对应编辑器 kind', () => {
    expect(rebuildDirtyKinds('cards')).toEqual(['card']);
    expect(rebuildDirtyKinds('角色卡')).toEqual(['card']);
    expect(rebuildDirtyKinds('worldbook')).toEqual(['worldbook']);
    expect(rebuildDirtyKinds('世界书')).toEqual(['worldbook']);
    expect(rebuildDirtyKinds('canon')).toEqual(['canon']);
    expect(rebuildDirtyKinds('规范实体')).toEqual(['canon']);
    expect(rebuildDirtyKinds('anchors')).toEqual(['anchor']);
    expect(rebuildDirtyKinds('timeline')).toEqual(['anchor']);
  });

  it('章节派生模块和未知模块按章节检查', () => {
    expect(rebuildDirtyKinds('chapter-facts')).toEqual(['chapter']);
    expect(rebuildDirtyKinds('chunks')).toEqual(['chapter']);
    expect(rebuildDirtyKinds('embeddings')).toEqual(['chapter']);
    expect(rebuildDirtyKinds('unknown')).toEqual(['chapter']);
    expect(rebuildDirtyKinds(null)).toEqual(['chapter']);
  });
});
