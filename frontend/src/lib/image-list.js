/**
 * image-list.js — `/api/images/list` 响应的形状归一。
 *
 * 后端返回的是**信封** `{ok, images, meta}`（`rpg/platform_app/api/images.py` 的
 * `json_response({"ok": True, "images": results})`，`meta` 由 `_deps.json_response` 统一注入），
 * 而 api-client 的 `GET` 只做 `return payload`、不解包。历史上两处消费方按裸数组写：
 *     const done = Array.isArray(list) ? list.filter(...) : [];
 * → `Array.isArray({ok, images})` 恒为 false → 结果恒空 → **刷新页面后聊天/酒馆里的生图全部消失**
 * （图在库里、SSE 实时那条也在，只有"重新拉历史"这条是坏的，所以平时不容易发现）。
 *
 * 这里只做一件事：把"可能是信封、也可能是裸数组、也可能是 null"的输入统一成数组。
 * 两种形状都兼容是刻意的 —— 后端哪天改回裸数组（或中间层加了 unwrap）也不会再静默丢图。
 */

/** @param {unknown} res  `/api/images/list` 的原始响应（信封 / 裸数组 / 空值）
 *  @returns {Array<object>} 图片行数组（拿不到就是空数组） */
export function imagesFromResponse(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.images)) return res.images;
  return [];
}

export default imagesFromResponse;
