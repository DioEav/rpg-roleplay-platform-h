// agent-pending.js — 把服务端持久化的待确认项合并回会话历史。
//
// 之前 pending_confirmations 只存在于实时 SSE 事件里:刷新页面/切走再切回来时
// 后端仍存着待确认,前端历史却只有一个没有按钮的工具块,用户再也无法批准/拒绝。
// 这里做纯合并:优先挂到包含同一 call_id 的那条 assistant 消息;找不到就挂到最近
// 一条 assistant;都没有就新建一条。多个 pending 落到同一条消息时各占一条,避免覆盖。

function cloneMessages(messages) {
  return (messages || []).map((m) => ({
    ...m,
    tools: Array.isArray(m.tools) ? m.tools.map((tc) => ({ ...tc })) : [],
  }));
}

/**
 * @param {Array} messages 历史消息 [{role,text,tools}]
 * @param {Array} pendings 服务端返回的 pending_confirmations
 * @param {(pending: object) => object|null} makePending 把 pending 转成 UI 的 pendingConfirm 形状
 * @returns {Array} 新数组(不修改入参)
 */
function mergePendingCards(messages, pendings, makePending) {
  const out = cloneMessages(messages);
  for (const p of (pendings || [])) {
    if (!p || !p.call_id || typeof makePending !== 'function') continue;
    let pc = null;
    try { pc = makePending(p); } catch (_) { pc = null; }
    if (!pc) continue;
    let idx = -1;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const tools = out[i].tools || [];
      if (tools.some((tc) => tc && tc.call_id === p.call_id)) { idx = i; break; }
    }
    if (idx < 0) {
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].role === 'assistant') { idx = i; break; }
      }
    }
    if (idx >= 0 && !out[idx].pendingConfirm) {
      out[idx] = { ...out[idx], pendingConfirm: pc };
    } else {
      // 同一条消息已有一张卡(多个历史 pending)或完全没有 assistant 消息:
      // 单独补一条,保证每张卡都能被看到/处理。
      out.push({ role: 'assistant', text: '', tools: [], pendingConfirm: pc });
    }
  }
  return out;
}

export { mergePendingCards };
