// permission-mode.js — LLM 写入权限的后端/前端模式归一。
//
// 后端 state.permissions.mode 会 normalize 成 read_only / default / auto_review / full_access,
// 而 Game Console 的 PermissionPopover 选项 id 是 read_only / default / review / full_access。
// 不归一时:「自动审查」(review) 写回后端变成 auto_review,下一次 /api/state 回填后找不到
// 对应选项 → chip 退回「默认权限」、popover 无选中态,看起来像设置没生效。

export const UI_PERMISSION_IDS = new Set(['read_only', 'default', 'review', 'full_access']);

export function normalizePermissionForUi(mode) {
  const v = String(mode || '').trim().toLowerCase();
  if (v === 'auto_review' || v === 'auto') return 'review';
  return UI_PERMISSION_IDS.has(v) ? v : 'full_access';
}
