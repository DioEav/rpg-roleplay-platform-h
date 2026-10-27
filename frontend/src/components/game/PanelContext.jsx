/* 上下文面板 + DemandLedger 可视化(上下文 tab)—— 纯机械从 game-panels.jsx 搬出,零行为变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';

// task 26: 把可能是 string / number / null / { value | text | label | ... } 的字段
// 安全格式化成 React 能渲染的字符串。优先抓常见语义字段，最后兜底 JSON.stringify。
function _renderVarValue(v) {
  if (v == null) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // 数组里也可能套对象：递归取摘要
    return v.map(_renderVarValue).join("，") || "—";
  }
  if (typeof v === "object") {
    // 富对象常见 schema：{value, locked, source, turn, updated_at}（变量）
    // 或 {text, time, turn, validated, variables}（推演结果）
    if ("value" in v && v.value != null) return _renderVarValue(v.value);
    if ("text" in v && v.text != null) return _renderVarValue(v.text);
    if ("label" in v && v.label != null) return _renderVarValue(v.label);
    if ("name" in v && v.name != null) return _renderVarValue(v.name);
    try { return JSON.stringify(v); } catch (_) { return "[object]"; }
  }
  return String(v);
}

// task 86：DemandLedger（curator 子代理 14 字段输出）右侧面板可视化。
// 数据源：state.last_context_agent.curator_plan（task 79 写入）。
// 真实部署里这个字段嵌在 state.memory.last_context_agent 下；spec 给的 prop
// 顺序是 state.last_context_agent → state.last_context.debug → 兜底 {}。
// 这里组件本身只接收 plan + audit_log，由调用方负责挑路径。
function DemandLedgerPanel({ curator_plan, audit_log }) {
  const { t } = useTranslation();
  const plan = (curator_plan && typeof curator_plan === "object") ? curator_plan : {};
  const log = Array.isArray(audit_log) ? audit_log : [];

  const intent = (typeof plan.intent === "string" && plan.intent.trim()) ? plan.intent.trim() : "";
  const activeGoal = (typeof plan.active_goal === "string" && plan.active_goal.trim()) ? plan.active_goal.trim() : "";
  const hardConstraints = Array.isArray(plan.hard_constraints) ? plan.hard_constraints : [];
  const softPreferences = Array.isArray(plan.soft_preferences) ? plan.soft_preferences : [];
  const candidateActions = Array.isArray(plan.candidate_actions) ? plan.candidate_actions : [];
  const acceptance = Array.isArray(plan.acceptance) ? plan.acceptance : [];
  const riskFlags = Array.isArray(plan.risk_flags) ? plan.risk_flags : [];
  const clarifying = (typeof plan.clarifying_question === "string" && plan.clarifying_question.trim()) ? plan.clarifying_question.trim() : "";

  const confidenceRaw = plan.confidence;
  const hasConfidence = typeof confidenceRaw === "number" && isFinite(confidenceRaw);
  const confidence = hasConfidence ? Math.max(0, Math.min(1, confidenceRaw)) : null;
  const confidenceColor = confidence == null
    ? "var(--muted-2)"
    : confidence >= 0.7 ? "var(--ok)"
    : confidence >= 0.5 ? "var(--warn)"
    : "var(--danger)";

  // 判断 plan 是否完全为空：任一关键数组/字符串字段非空就算"有计划"
  const hasAny =
    intent || activeGoal || clarifying ||
    hardConstraints.length || softPreferences.length || candidateActions.length ||
    acceptance.length || riskFlags.length || hasConfidence;

  // task 81：acceptance 验证未通过会写 audit_log kind=acceptance_unmet，
  // hint 形如 "未通过验收：{item[:160]}"。逐条 acceptance 用 substring 匹配。
  // 只看最近 30 条 audit_log 避免上一轮的残留误判当前轮（用户切换面板时尤其要紧）。
  const recentAudit = log.slice(-30);
  const unmetHints = recentAudit
    .filter(a => a && a.kind === "acceptance_unmet" && typeof a.hint === "string")
    .map(a => a.hint);
  const isUnmet = (clause) => {
    if (typeof clause !== "string" || !clause.trim()) return false;
    // hint 截到 160 字符；short clause 完整命中，长 clause 用前 80 字符做子串保险
    const probe = clause.trim().slice(0, 80);
    return unmetHints.some(h => h.indexOf(probe) >= 0 || (probe.length >= 12 && h.indexOf(probe.slice(0, 40)) >= 0));
  };

  // 字段全空的兜底信息
  if (!hasAny) {
    return (
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.context.curator_title')}</h3></div>
        <div className="empty-line">{t('game.context.curator_empty')}</div>
      </div>
    );
  }

  const renderItem = (v, i, prefix) => {
    const text = typeof v === "string" ? v : (v && (v.text || v.label || v.name)) || JSON.stringify(v);
    return <li key={prefix + ":" + i}><span>{text}</span></li>;
  };

  return (
    <div className="gp-section">
      <div className="section-head">
        <h3>{t('game.context.curator_title')}</h3>
        <span className="muted-2 mono" style={{fontSize: 11}}>{t('game.context.curator_demand')}</span>
      </div>

      {/* 意图 + active_goal */}
      {(intent || activeGoal) && (
        <div className="gp-kv" style={{marginBottom: 4}}>
          <div className="gp-row">
            <span className="gp-label">{t('game.context.intent')}</span>
            <span className="serif">{intent || activeGoal}</span>
          </div>
          {activeGoal && activeGoal !== intent && (
            <div className="gp-row">
              <span className="gp-label">{t('game.context.goal')}</span>
              <span style={{color: "var(--text-quiet)"}}>{activeGoal}</span>
            </div>
          )}
        </div>
      )}

      {/* 置信度进度条 */}
      {hasConfidence && (
        <div className="gp-row" style={{display: "grid", gridTemplateColumns: "64px 1fr auto", gap: 8, alignItems: "center"}}>
          <span className="gp-label">{t('game.context.confidence')}</span>
          <div style={{height: 4, borderRadius: 999, background: "var(--line-soft)", overflow: "hidden"}}>
            <div style={{width: Math.round(confidence * 100) + "%", height: "100%", background: confidenceColor}} />
          </div>
          <span className="mono" style={{fontSize: 11, color: "var(--muted)"}}>{Math.round(confidence * 100)}%</span>
        </div>
      )}

      {/* 澄清问题（confidence 低时常出现，单独提示） */}
      {clarifying && (
        <div className="gp-quote" style={{borderLeftColor: "var(--warn)", fontSize: 12.5}}>
          <strong className="warn" style={{marginRight: 6}}>{t('game.context.clarify')}</strong>{clarifying}
        </div>
      )}

      {/* 硬约束 */}
      {hardConstraints.length > 0 && (
        <div style={{display: "grid", gap: 6}}>
          <span className="gp-label">{t('game.context.hard_constraints')}</span>
          <ul className="gp-flat-list">
            {hardConstraints.map((v, i) => {
              const text = typeof v === "string" ? v : (v && (v.text || v.label)) || JSON.stringify(v);
              return (
                <li key={"hc:" + i}>
                  <span>
                    <Icon name="lock" size={12} style={{verticalAlign: "-2px", marginRight: 6, color: "var(--accent)"}} />
                    {text}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 软偏好 */}
      {softPreferences.length > 0 && (
        <div style={{display: "grid", gap: 6}}>
          <span className="gp-label">{t('game.context.soft_preferences')}</span>
          <ul className="gp-flat-list">
            {softPreferences.map((v, i) => {
              const text = typeof v === "string" ? v : (v && (v.text || v.label)) || JSON.stringify(v);
              return (
                <li key={"sp:" + i} style={{borderStyle: "dashed"}}>
                  <span className="muted">{text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 候选动作（编号列表，复用 gp-events 序号样式） */}
      {candidateActions.length > 0 && (
        <div style={{display: "grid", gap: 6}}>
          <span className="gp-label">{t('game.context.candidate_actions')}</span>
          <ol className="gp-events">
            {candidateActions.map((v, i) => {
              const text = typeof v === "string" ? v : (v && (v.text || v.label || v.name)) || JSON.stringify(v);
              return <li key={"ca:" + i}>{text}</li>;
            })}
          </ol>
        </div>
      )}

      {/* 验收（含通过/未通过状态） */}
      {acceptance.length > 0 && (
        <div style={{display: "grid", gap: 6}}>
          <span className="gp-label">{t('game.context.acceptance')}</span>
          <ul className="gp-flat-list">
            {acceptance.map((v, i) => {
              const text = typeof v === "string" ? v : (v && (v.text || v.label)) || JSON.stringify(v);
              const unmet = isUnmet(text);
              const mark = unmet
                ? <span className="danger mono" style={{marginRight: 6, fontWeight: 600}}>{t('game.context.acceptance_unmet_mark')}</span>
                : <span className="ok mono" style={{marginRight: 6, fontWeight: 600}}>{t('game.context.acceptance_passed_mark')}</span>;
              return (
                <li key={"ac:" + i}>
                  <span>{mark}{text}</span>
                  <span className={`mono ${unmet ? "danger" : "ok"}`} style={{fontSize: 10.5}}>
                    {unmet ? t('game.context.acceptance_unmet') : t('game.context.acceptance_passed')}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 风险标记 — 现在是整句提示(非短标签),用可换行的整行卡片堆叠,不能用定高 chip(会重叠) */}
      {riskFlags.length > 0 && (
        <div style={{display: "grid", gap: 6}}>
          <span className="gp-label">{t('game.context.risk_flags')}</span>
          <div className="gp-warns">
            {riskFlags.map((v, i) => {
              const text = typeof v === "string" ? v : (v && (v.text || v.label)) || JSON.stringify(v);
              return (
                <div key={"rf:" + i} className="gp-warn">
                  <Icon name="warn" size={12} />
                  <span className="gp-warn-text">{text}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PanelContext({ state }) {
  const { t } = useTranslation();
  // task 33：真实 /api/state 下 memory.last_context 可能是 undefined / {} / 缺字段，
  // 原代码直读 .tokens_used / .retrieval_chunks / .chapter_refs.map 会触发
  // "Cannot read properties of undefined (reading 'map')"，右侧"上下文"tab 整 panel 崩。
  // 全部兜底到安全默认值。
  const memory = (state && state.memory) || {};
  const lastCtxRaw = memory.last_context || {};
  // 兼容两种落法：直接是 debug，或 {debug: {...}}（与 PanelDebug 同口径）。
  const lastCtx = lastCtxRaw.debug || lastCtxRaw;
  // tokens_used / retrieval_chunks 是后端从不写入的死字段(恒 0)。改读真实值:
  // estimated_tokens 由 context_engine 每轮写入;层数取 layers 数组长度。
  const tokensUsed = lastCtx.estimated_tokens || 0;
  const layerCount = Array.isArray(lastCtx.layers) ? lastCtx.layers.length : 0;
  // task 86：curator_plan 真实写入路径是 state.memory.last_context_agent.curator_plan；
  // spec prop 顺序是 state.last_context_agent → state.last_context.debug → memory.last_context_agent → {}
  const curatorPlan =
    (state && state.last_context_agent && state.last_context_agent.curator_plan) ||
    (state && state.last_context && state.last_context.debug && state.last_context.debug.curator_plan) ||
    (memory && memory.last_context_agent && memory.last_context_agent.curator_plan) ||
    {};
  const auditLog = (state && state.permissions && Array.isArray(state.permissions.audit_log))
    ? state.permissions.audit_log : [];
  // 本次展示增强：memory.last_memory_injection 是记忆层真正注入的文本；
  // last_retrieval 是小说检索层，两者不能混。这里把记忆注入做成“摘要 + 可展开”。
  const lastMemInjection = String(memory.last_memory_injection || "");
  const _memPrefixes = [
    "固定记忆：", "主线：", "当前目标：", "笔记：", "事实：",
    "相关记忆：", "相关笔记：", "概要：", "篇章：", "能力：", "资源：",
    "【记忆优先级",
  ];
  const memLines = lastMemInjection
    ? lastMemInjection.split("\n").filter((l) => _memPrefixes.some((p) => l.startsWith(p)))
    : [];
  const contributions = Array.isArray(lastCtx.contributions) ? lastCtx.contributions : [];
  const memoryContrib = contributions.find((c) => c && c.provider_id === "memory") || {};
  const memDebug = (memoryContrib && memoryContrib.debug) || {};
  const memSections = Array.isArray(memDebug.sections) ? memDebug.sections : [];
  const memTokenUsed = memDebug.token_used || Math.ceil(lastMemInjection.length / 2);
  const memTokenBudget = memDebug.token_budget || 0;
  return (
    <div className="gp-stack">
      <div className="gp-section">
        <div className="section-head">
          <h3>{t('game.context.title')}<span className="muted-2" style={{marginLeft: 8, fontSize: 11, textTransform: "none"}}>{t('game.context.tokens', { count: tokensUsed })}</span></h3>
          <span className="pill mono">{t('game.context.layers_count', { count: layerCount })}</span>
        </div>
        <ul className="gp-flat-list">
          {/* task 48：原硬编码『固定记忆 · 2 段』和『历史摘要 · 最近 8 回合』改为读 state 真值 */}
          <li>
            <span><Icon name="memory" size={12} style={{verticalAlign: "-2px", marginRight: 6}} />{t('game.context.pinned_count', { count: Array.isArray(memory.pinned) ? memory.pinned.length : 0 })}</span>
            <span className="muted-2 mono" style={{fontSize: 11}}>—</span>
          </li>
          <li>
            <span><Icon name="user" size={12} style={{verticalAlign: "-2px", marginRight: 6}} />{t('game.context.history_turns', { count: (lastCtx && lastCtx.history_turns) || (state && Array.isArray(state.history) ? Math.floor(state.history.length / 2) : 0) })}</span>
            <span className="muted-2 mono" style={{fontSize: 11}}>—</span>
          </li>
        </ul>
      </div>
      {/* 本次展示增强：记忆层实际注入（摘要 + 展开全文 + 分桶条形图）。
          注意这不是 last_retrieval（小说检索层），而是 MemoryProvider 真正写进
          prompt 的「长期记忆」层文本。 */}
      <div className="gp-section">
        <div className="section-head">
          <h3>{t('game.context.memory_injection', { defaultValue: '记忆层注入' })}</h3>
          <span className="pill mono">
            {t('game.context.memory_injection_meta', {
              defaultValue: '{{lines}} 行 · 约 {{tokens}} token',
              lines: memLines.length,
              tokens: memTokenUsed,
            })}
          </span>
        </div>
        {memTokenBudget > 0 && (
          <div className="gp-row">
            <span className="gp-label">{t('game.context.memory_budget', { defaultValue: 'token 预算' })}</span>
            <span className="mono">{memTokenUsed} / {memTokenBudget}
              {memDebug.token_estimate_factor != null && memDebug.token_estimate_factor !== 1
                ? ` ×${memDebug.token_estimate_factor}` : ""}
            </span>
          </div>
        )}
        {memDebug.deduped_across_sections > 0 && (
          <div className="gp-row">
            <span className="gp-label">{t('game.context.memory_deduped', { defaultValue: '跨 section 去重' })}</span>
            <span className="mono" data-tip={t('game.context.memory_deduped_tip', {
              defaultValue: '同一句话同时出现在笔记/事实/摘要等 section 时只注入一次，这里是被省掉的行数',
            })}>
              ↓{memDebug.deduped_across_sections}
            </span>
          </div>
        )}
        {memSections.length > 0 && (
          <div style={{margin: "6px 0"}}>
            {memSections.map((s) => {
              const pct = s.available > 0 ? Math.round(100 * (s.selected || 0) / s.available) : 0;
              return (
                <div key={s.id} style={{marginBottom: 4}}>
                  <div style={{display: "flex", justifyContent: "space-between", fontSize: 11}}>
                    <span className="mono">{s.id}</span>
                    <span className="muted-2">
                      {s.selected}/{s.available} · {s.tokens || 0}t
                      {s.dropped ? ` · ↓${s.dropped}` : ""}
                    </span>
                  </div>
                  <div style={{height: 4, background: "var(--line, #333)", borderRadius: 2, overflow: "hidden"}}>
                    <div style={{width: `${pct}%`, height: "100%", background: "var(--accent, #6a9)"}} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {lastMemInjection ? (
          <details>
            <summary className="muted-2" style={{cursor: "pointer", fontSize: 12}}>
              {t('game.context.memory_injection_expand', { defaultValue: '展开完整注入文本' })}
            </summary>
            <pre className="gp-quote mono" style={{maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap", marginTop: 6}}>
              {lastMemInjection}
            </pre>
          </details>
        ) : (
          <div className="empty-line">{t('game.context.memory_injection_empty', { defaultValue: '本轮尚无记忆层注入记录' })}</div>
        )}
      </div>
      {/* task 86：本轮 Curator 决策（DemandLedger 可视化） */}
      <DemandLedgerPanel curator_plan={curatorPlan} audit_log={auditLog} />
      <div className="gp-section">
        <div className="section-head"><h3>{t('game.context.retrieval_preview')}</h3></div>
        {/* task 48：原 pre 硬编码『顾承砚 · 漂流的史官 / 北港码头 / 申时三刻 · 霜降前两日 / 雾港事件第二日清晨』
            完全和当前剧本无关。改为读 state.memory.last_retrieval（context_agent + retrieve_context 后写入）。 */}
        <pre className="gp-quote mono" style={{maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap"}}>
{(memory.last_retrieval && String(memory.last_retrieval).trim()) || t('game.context.retrieval_empty')}
        </pre>
      </div>
    </div>
  );
}

export { PanelContext };
