// editor-storage.js — MD 编辑器的本地缓存归属守卫。
//
// 背景:编辑器的 mde.* 键(scriptId / tabs / drafts / conv / 分栏宽度…)是浏览器级
// localStorage,不区分账号。此前用户 A 未保存的草稿在登出后仍留在磁盘上:同一浏览器
// 换用户 B 登录时,编辑器会先按 mde.scriptId 恢复 A 的草稿(甚至在剧本归属校验之前),
// 随后发现该剧本不可编辑又只切 scriptId、不清标签,导致 A 的内容继续挂在新剧本下。
//
// 这个 helper 只做一件事:记录最近一次使用编辑器的用户 id;一旦账号变化,清空所有
// mde.* 键(保留归属标记本身)。调用方必须在**读取 scriptId / 恢复草稿之前**调用它。

const OWNER_KEY = 'mde.owner';
const WINDOW_KEY = 'mde.winId';
const EDITOR_PREFIX = 'mde.';
// 真正涉及用户内容/会话归属的键。只有这些键会触发“首次升级未归属”的询问;
// 分栏宽度/折叠状态等 UI 偏好不应让用户看到“可能是别人草稿”的提示。
const _CONTENT_KEY_PREFIXES = [
  'mde.scriptId', 'mde.tabs.', 'mde.drafts.', 'mde.activeKey.', 'mde.conv.',
];

function _newWindowId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) { /* 老浏览器 / 非安全上下文 */ }
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 当前标签页的窗口 id(放 sessionStorage:同一 tab 刷新后不变,不同 tab 不同)。
 * 草稿/标签缓存必须按窗口隔离,否则两个窗口会互相整键覆盖对方的未保存内容。
 * sessionStorage 不可用时退回 'w0'(退化为共享,但不崩溃)。
 */
function getWindowId(storage) {
  if (!storage) return 'w0';
  try {
    let v = storage.getItem(WINDOW_KEY);
    if (!v) {
      v = _newWindowId();
      storage.setItem(WINDOW_KEY, v);
    }
    return v;
  } catch (_) {
    return 'w0';
  }
}

/**
 * 当前窗口的编辑器存储键,同时给出旧版无窗口后缀的键(用于一次性迁移)。
 * @param {number|string} sid 剧本 id
 * @param {string} winId getWindowId 的返回
 */
function editorStorageKeys(sid, winId) {
  const w = winId || 'w0';
  return {
    drafts: `mde.drafts.${sid}.${w}`,
    tabs: `mde.tabs.${sid}.${w}`,
    active: `mde.activeKey.${sid}.${w}`,
    // 旧版本键:首次读取时迁移到当前窗口,避免升级后丢上次会话。
    legacyDrafts: `mde.drafts.${sid}`,
    legacyTabs: `mde.tabs.${sid}`,
    legacyActive: `mde.activeKey.${sid}`,
  };
}

function editorKeys(storage) {
  const keys = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(EDITOR_PREFIX) && k !== OWNER_KEY) keys.push(k);
    }
  } catch (_) { /* 隐私模式/读取异常:没有可清理的键 */ }
  return keys;
}

/** 是否存在需要账号归属判断的旧缓存(草稿/标签/激活项/对话绑定/剧本文档)。 */
function hasUnownedEditorState(storage) {
  if (!storage) return false;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && _CONTENT_KEY_PREFIXES.some((p) => k === p || k.startsWith(p))) return true;
    }
  } catch (_) { /* 读取失败:按没有旧缓存处理 */ }
  return false;
}

/**
 * 确保本地编辑缓存属于 userId。
 * @param {Storage} storage 通常是 window.localStorage(测试可注入假实现)
 * @param {number|string|null|undefined} userId 当前登录用户 id;拿不到时不做任何判断
 * @returns {{changed: boolean, cleared: number, unowned?: boolean}}
 *   changed=是否检测到账号切换并清理;unowned=没有归属标记但已有旧缓存,
 *   需要调用方决定「保留(当前用户)」还是「清理(共享浏览器/换账号)」。
 */
function ensureEditorStorageOwner(storage, userId) {
  if (!storage || userId == null || userId === '') return { changed: false, cleared: 0 };
  const want = String(userId);
  let prev = null;
  try { prev = storage.getItem(OWNER_KEY); } catch (_) { prev = null; }
  if (prev === want) return { changed: false, cleared: 0 };
  if (!prev) {
    // 首次运行(或从旧版本升级)。没有归属标记时不能静默把旧缓当归给当前账号:
    // 共享浏览器上可能是上一个账号的草稿。只有草稿/标签/对话等“内容键”才需要
    // 询问;纯 UI 偏好(分栏宽度等)直接认领,避免每次升级都弹安全提示。
    if (hasUnownedEditorState(storage)) return { changed: false, cleared: 0, unowned: true };
    try { storage.setItem(OWNER_KEY, want); } catch (_) { /* 配额/隐私模式:下次再试 */ }
    return { changed: false, cleared: 0 };
  }
  const cleared = clearEditorStorage(storage);
  try { storage.setItem(OWNER_KEY, want); } catch (_) { /* 标记写失败:最坏下次重复清理 */ }
  return { changed: true, cleared };
}

/** 清理所有 mde.* 编辑器缓存(保留归属标记)。返回清理数量。 */
function clearEditorStorage(storage) {
  let cleared = 0;
  for (const k of editorKeys(storage)) {
    try { storage.removeItem(k); cleared += 1; } catch (_) { /* 单个键失败不影响其余 */ }
  }
  return cleared;
}

/** 把归属标记写成指定用户(用于首次升级时用户确认“旧缓存是我的”)。 */
function setEditorStorageOwner(storage, userId) {
  if (!storage || userId == null || userId === '') return false;
  try { storage.setItem(OWNER_KEY, String(userId)); return true; }
  catch (_) { return false; }
}

export {
  OWNER_KEY, WINDOW_KEY, ensureEditorStorageOwner, getWindowId, editorStorageKeys,
  clearEditorStorage, setEditorStorageOwner, hasUnownedEditorState,
};
