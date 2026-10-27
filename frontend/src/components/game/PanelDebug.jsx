/* 调试面板(调试 tab)—— 纯机械从 game-panels.jsx 搬出,零行为变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';

function PanelDebug({ state }) {
  const { t } = useTranslation();
  // task 48：原代码全是硬编码（韩司直.tone / 童氏与南陵同源 / model gpt-4o-mini / latency 7.4s）。
  // 改为读 state.memory.last_context_agent.steps 当 SSE 流；state.permissions.audit_log 当权限日志。
  const memory = (state && state.memory) || {};
  const lastAgent = memory.last_context_agent || {};
  const steps = Array.isArray(lastAgent.steps) ? lastAgent.steps : [];
  const permissions = (state && state.permissions) || {};
  const audit = Array.isArray(permissions.audit_log) ? permissions.audit_log : [];
  return (
    <div className="gp-stack">
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.debug.agent_steps')}</h3><span className="pill mono">{t('game.debug.latest_round')}</span></div>
        <ul className="gp-sse">
          {steps.length === 0 && <li><span className="muted-2">{t('game.debug.no_steps')}</span></li>}
          {steps.map((s, i) => (
            <li key={i}>
              <span className={`mono ${s.status === "done" ? "ok" : s.status === "stopped" ? "danger" : "accent"}`}>{s.phase || "step"}</span>
              <span className="mono muted-2">{(s.message || "").slice(0, 80)} {typeof s.elapsed_ms === "number" ? `· ${(s.elapsed_ms/1000).toFixed(1)}s` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.debug.current_request')}</h3></div>
        <div className="gp-kv">
          {(() => {
            const ctx = memory.last_context || {};
            // last_context 只写 estimated_tokens,不写 tokens_out / retrieval_chunks(旧版这里恒 0)。
            // 输入 token 用真实估算值,「chunks」改用真实的上下文层数。
            const tokens = `in ${ctx.estimated_tokens || 0}`;
            const layerCount = Array.isArray(ctx.layers) ? ctx.layers.length : 0;
            // Q 三贤者分层缓存:tier_tokens / cache_plan 来自 build_context_bundle 的 debug
            // (set_last_context 落 memory.last_context;结构因写入路径或带 .debug 子键,两处都试)。
            const dbg = ctx.debug || ctx;
            const tt = dbg.tier_tokens;
            const cp = dbg.cache_plan || {};
            const ratio = cp.estimated_cacheable_ratio;
            // 记忆 section 明细（本次记忆修复）: MemoryProvider.debug.sections =
            // [{id, selected, available, dropped, tokens}]，看哪一段被预算丢了。
            const contributions = Array.isArray(dbg.contributions) ? dbg.contributions : [];
            const memDebug = ((contributions.find((c) => c && c.provider_id === "memory") || {}).debug) || {};
            const memSections = Array.isArray(memDebug.sections) ? memDebug.sections : [];
            return (
              <>
                <div className="gp-row"><span className="gp-label">{t('game.debug.context_layers')}</span><span className="mono">{layerCount}</span></div>
                <div className="gp-row"><span className="gp-label">tokens</span><span className="mono">{tokens}</span></div>
                {tt && (
                  <div className="gp-row">
                    <span className="gp-label">{t('game.debug.cache_tiers', { defaultValue: '缓存分层 (会话/场景/动态)' })}</span>
                    <span className="mono">A {tt.A || 0} · B {tt.B || 0} · C {tt.C || 0}</span>
                  </div>
                )}
                {ratio != null && (
                  <div className="gp-row">
                    <span className="gp-label">{t('game.debug.cacheable_ratio', { defaultValue: '可缓存比例' })}</span>
                    <span className="mono">{Math.round(ratio * 100)}%</span>
                  </div>
                )}
                {memSections.length > 0 && (
                  <div className="gp-row">
                    <span className="gp-label">{t('game.debug.memory_sections', { defaultValue: '记忆分桶 (选中/可用)' })}</span>
                    <span className="mono" style={{fontSize: 10.5, textAlign: "right"}}>
                      {memSections.map((s) => (
                        `${s.id} ${s.selected}/${s.available} (${s.tokens || 0}t)${s.dropped ? ` ↓${s.dropped}` : ""}`
                      )).join(' · ')}
                    </span>
                  </div>
                )}
                {memSections.length > 0 && (
                  <div style={{padding: "2px 0 6px"}}>
                    {memSections.map((s) => {
                      const pct = s.available > 0 ? Math.round(100 * (s.selected || 0) / s.available) : 0;
                      return (
                        <div key={`bar-${s.id}`} style={{marginBottom: 3}}>
                          <div style={{display: "flex", justifyContent: "space-between", fontSize: 10}}>
                            <span className="mono">{s.id}</span>
                            <span className="muted-2">{pct}% · {s.tokens || 0}t</span>
                          </div>
                          <div style={{height: 4, background: "var(--line, #333)", borderRadius: 2, overflow: "hidden"}}>
                            <div style={{width: `${pct}%`, height: "100%", background: "var(--accent, #6a9)"}} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {memDebug.token_budget != null && (
                  <div className="gp-row">
                    <span className="gp-label">{t('game.debug.memory_budget', { defaultValue: '记忆 token' })}</span>
                    <span className="mono">{memDebug.token_used || 0} / {memDebug.token_budget}
                      {memDebug.token_estimate_factor != null && memDebug.token_estimate_factor !== 1
                        ? ` ×${memDebug.token_estimate_factor}` : ""}
                    </span>
                  </div>
                )}
                {memDebug.stats && Object.keys(memDebug.stats).length > 0 && (
                  <div className="gp-row">
                    <span className="gp-label">{t('game.debug.memory_stats', { defaultValue: '记忆生命周期' })}</span>
                    <span className="mono" style={{fontSize: 10.5, textAlign: "right"}}>
                      {Object.entries(memDebug.stats).map(([k, v]) => `${k} ${v}`).join(' · ')}
                    </span>
                  </div>
                )}
                {(() => {
                  const pending = (memory.summary_pending || {});
                  const qlen = Array.isArray(pending.queue) ? pending.queue.length : 0;
                  const arcTurn = memory.arc_refresh_turn;
                  if (!qlen && (arcTurn == null || arcTurn < 0)) return null;
                  return (
                    <div className="gp-row">
                      <span className="gp-label">{t('game.debug.memory_queue', { defaultValue: '摘要队列 / arc' })}</span>
                      <span className="mono">{qlen} · arc T{arcTurn ?? -1}</span>
                    </div>
                  );
                })()}
                <div className="gp-row"><span className="gp-label">turn</span><span className="mono">{(state && state.turn) ?? 0}</span></div>
              </>
            );
          })()}
        </div>
      </div>
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.debug.permission_log')}</h3><span className="muted-2 mono" style={{fontSize: 11}}>{audit.length}</span></div>
        <ul className="gp-flat-list">
          {audit.length === 0 && <li><span className="muted-2">{t('game.debug.no_audit')}</span></li>}
          {audit.slice(-8).reverse().map((a, i) => (
            <li key={i}>
              <span className={`mono ${a.source === "user:/set" ? "accent" : ""}`}>{a.source || "auto"}</span>
              <span className="muted">{a.path}{a.value != null ? `: ${String(a.value).slice(0, 60)}` : ""}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export { PanelDebug };
