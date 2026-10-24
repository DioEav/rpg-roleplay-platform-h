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
            const tokens = `in ${ctx.estimated_tokens || 0}${ctx.tokens_out ? ` · out ${ctx.tokens_out}` : ""}`;
            // Q 三贤者分层缓存:tier_tokens / cache_plan 来自 build_context_bundle 的 debug
            // (set_last_context 落 memory.last_context;结构因写入路径或带 .debug 子键,两处都试)。
            const dbg = ctx.debug || ctx;
            const tt = dbg.tier_tokens;
            const cp = dbg.cache_plan || {};
            const ratio = cp.estimated_cacheable_ratio;
            return (
              <>
                <div className="gp-row"><span className="gp-label">{t('game.debug.retrieval_chunks')}</span><span className="mono">{ctx.retrieval_chunks || 0}</span></div>
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
