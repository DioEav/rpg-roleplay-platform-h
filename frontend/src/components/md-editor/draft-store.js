// draft-store.js — 编辑器未保存草稿的 localStorage 写入器。
//
// 旧实现直接 lsSet 并吞掉所有异常:配额满/隐私模式时草稿根本没写进去,用户却以为
// 已经缓存;SPA 路由一离开就丢内容。这里把结果显式返回,调用方负责警告用户;
// 同时对单次载荷设上限,避免把几 MB 正文塞进 5MB 配额导致后续所有写入失败。

const MAX_DRAFT_CHARS = 2_000_000;   // JSON 字符数(UTF-16),给同一域名其它键留余量

/**
 * @param {Storage} storage
 * @param {string} key
 * @param {Array} drafts 已序列化前的草稿数组;空数组表示没有草稿 → 删除该键
 * @returns {{ok: boolean, removed?: boolean, size?: number, reason?: 'quota'|'too_large'}}
 */
function writeDrafts(storage, key, drafts) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (!list.length) {
    try { storage.removeItem(key); return { ok: true, removed: true }; }
    catch (_) { return { ok: false, reason: 'quota' }; }
  }
  let json;
  try { json = JSON.stringify(list); }
  catch (_) { return { ok: false, reason: 'too_large' }; }
  const size = json.length;
  if (size > MAX_DRAFT_CHARS) return { ok: false, reason: 'too_large', size };
  try {
    storage.setItem(key, json);
    return { ok: true, size };
  } catch (_) {
    // QuotaExceededError / 隐私模式 / 存储被禁用都走这里。
    return { ok: false, reason: 'quota', size };
  }
}

export { MAX_DRAFT_CHARS, writeDrafts };
