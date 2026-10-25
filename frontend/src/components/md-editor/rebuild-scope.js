// rebuild-scope.js — rebuild_script_module 的脏标签影响范围。
//
// 重建某个知识模块会读服务端派生数据;如果作者在确认期间还有同类标签未保存,
// 重建会基于旧数据执行,随后保存/刷新可能互相覆盖。确认卡需要按 module 统计
// 相关 kind 的 dirty 标签数,所以这里把 module 别名映射成编辑器节点 kind。

const MODULE_KIND = {
  cards: 'card', characters: 'card', character: 'card', card: 'card', '角色卡': 'card', '人设卡': 'card',
  worldbook: 'worldbook', wb: 'worldbook', world_book: 'worldbook', '世界书': 'worldbook',
  canon: 'canon', '规范实体': 'canon',
  anchors: 'anchor', anchor: 'anchor', timeline: 'anchor', '时间线': 'anchor',
  chunks: 'chapter', 'chapter-facts': 'chapter', facts: 'chapter', chapter_facts: 'chapter',
  embeddings: 'chapter', embedding: 'chapter', embed: 'chapter', vector: 'chapter',
};

/**
 * @param {string} module rebuild_script_module 的 module 参数(可能带别名)
 * @returns {string[]} 需要检查 dirty 的编辑器 kind 列表
 */
function rebuildDirtyKinds(module) {
  const m = String(module || '').trim().toLowerCase();
  // 未知模块保守按章节处理:至少不会在正文有未保存改动时放行重建。
  return [MODULE_KIND[m] || 'chapter'];
}

export { rebuildDirtyKinds };
