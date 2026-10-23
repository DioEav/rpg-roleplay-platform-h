/* Game Console composer — 模型浮层(ModelPopover)/ Effort 档位(EffortSection)/ 权限浮层(PermissionPopover)
   + 权限常量。纯机械从 game-composer.jsx 搬出,DOM/视觉/行为零变化。 */
import React from 'react';
import { useState as useStateC, useRef as useRefC } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import AgentModelPicker from '../AgentModelPicker.jsx';
import { useDismissOnOutsideOrEscape } from '../../hooks/useDismissOnOutsideOrEscape.js';

// task 39 收尾：MODEL_OPTIONS（GPT-4o · RPG / Claude Opus 4.1 / Gemini 3 Flash ...）
// 是早期 mock fallback；只要它存在，任何 fallback 路径都可能让用户误以为"模型列表是 mock"。
// 现在 ModelPopover 强绑 catalog（gameState.models or /api/models）；当前模型标签强绑
// gameState.app.model。删掉这个 constant，彻底杜绝 mock 出现的可能。
//
// 历史回顾：原来 5 项是
//   gpt-4o-mini-rpg / claude-opus-4-1 / gemini-3-flash / qwen-max / deepseek-r1
// 后端 model_registry 里现在的真名是
//   vertex_ai/gemini-3.5-flash, anthropic/claude-opus-4-7, openai/gpt-5.5, ...
// 不一致 → mock 就是 mock，不当 fallback。

// task 53：补 read_only 模式（对齐 codex suggest）；id 用后端 normalize 接受的形式。
// 注意 "review" 对应后端 auto_review；保持 backward-compat。
const PERMISSION_OPTIONS = [
  { id: "read_only",   labelKey: "game.permission.read_only_label",   descKey: "game.permission.read_only_desc",   icon: "eye" },
  { id: "default",     labelKey: "game.permission.default_label",     descKey: "game.permission.default_desc",     icon: "lock" },
  { id: "review",      labelKey: "game.permission.review_label",      descKey: "game.permission.review_desc",      icon: "shield" },
  { id: "full_access", labelKey: "game.permission.full_access_label", descKey: "game.permission.full_access_desc", icon: "unlock" },
];

// Effort/深度思考控件已改为**能力驱动**(2026-10):显示条件不再看 provider 白名单,
// 而是看 /api/models 下发的 `model.reasoning` 描述(spec.supported + levels + can_disable)。
// 这样自建中转站 / GLM / Kimi / Qwen / Grok / 豆包 等只要模型被识别出思考能力,
// 就能在同一个控件里配置;未知模型显示为空,不再谎报「已启用」。

/* ModelPopover — 游戏内底栏「模型」浮层。
   重构:模型列表 / 已配 key 过滤 / health / pricing / 切换落库(/api/models/select)
   全部委托给全站唯一规范组件 AgentModelPicker(variant="popover")。本组件只保留游戏台
   专属的浮层外壳:向上展开定位、点外/Esc 关闭、存档级 saveId、底部 EffortSection。
   AgentModelPicker.onChange(api_id, model) 回填本地选中态,供 EffortSection + onPick 用。 */
function ModelPopover({ current, onPick, align = "left", gameState, onClose, triggerRef, persist = null }) {
  const { t } = useTranslation();
  // A1: 取当前存档 id（从 /api/state 的 gameState.save_id）用于存档级模型切换
  const saveId = (gameState && gameState.save_id != null)
    ? gameState.save_id
    : (gameState && gameState._raw && gameState._raw.save_id != null)
      ? gameState._raw.save_id
      : null;
  const menuRef = useRefC(null);
  // 当前选中态(api_id::model_real_name) — 由 AgentModelPicker onChange 回填,供 EffortSection 用。
  const [selectedKey, setSelectedKey] = useStateC("");
  useDismissOnOutsideOrEscape(menuRef, triggerRef, onClose);
  // task 141 / Bug fix: max-height 自适应 trigger 上方可用空间,popover 不冲出 viewport 顶。
  React.useLayoutEffect(() => {
    if (!menuRef.current || !triggerRef?.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    const aboveSpace = Math.min(rect.top - 16, Math.round(vh * 0.6), 480);
    menuRef.current.style.maxHeight = Math.max(200, aboveSpace) + "px";
    menuRef.current.style.display = "flex";
    menuRef.current.style.flexDirection = "column";
  }, []);

  // AgentModelPicker 选中变化:① 回填 selectedKey 给 EffortSection;② 通知父组件刷新底部标签。
  // source='init' 是「挂载时解析出当前模型」的回声(并非用户换模型)—— 此时只回填 selectedKey,
  // 【绝不】onPick(=toggleModel 关闭浮层)或刷新,否则浮层一打开就被这条回声立刻关掉(用户反馈:
  // 点开闪一下「无模型」就消失)。只有 source='user'(用户真的点选/手填)才关闭并刷新。
  const handlePicked = (apiId, modelReal, source) => {
    if (!apiId || !modelReal) return;
    setSelectedKey(`${apiId}::${modelReal}`);
    if (source !== 'user') return;
    // 存档级切换也要刷新当前 tab gameState,让底部标签立刻看到新模型。
    try { window.dispatchEvent(new CustomEvent("game-state-refresh")); } catch (_) {}
    // 带上 provider:底层标签按 (api_id, model) 精确解析,同名模型不会串到别的渠道。
    onPick && onPick(modelReal, apiId);
  };

  return (
    <div ref={menuRef} className={`gc-menu gc-pop-menu ${align === "right" ? "gc-menu-right" : ""}`}>
      <div className="gc-menu-head" style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 10, paddingBottom: 8 }}>
        <Icon name="sparkle" size={12} /><span>{t('game.composer.model_placeholder')}</span>
      </div>
      {/* 统一规范组件:模型池 = 已配 key 的 provider 真实模型;health/价格;选中即 /api/models/select。
          persistShape="models_select" + saveId → 有存档时存档级切换,否则改全局 gm 偏好。 */}
      <AgentModelPicker
        prefPrefix={persist?.prefPrefix || "gm"}
        persistShape={persist?.persistShape || "models_select"}
        dictKey={persist?.dictKey || null}
        allowInherit={persist?.allowInherit || false}
        inheritLabel={persist?.inheritLabel || null}
        saveId={persist ? null : saveId}
        variant="popover"
        showHealth
        showPricing
        onChange={handlePicked}
      />
      {/* task 141 / 2026-10: Effort 段 — 能力驱动;有存档时写本存档作用域 */}
      <EffortSection selectedKey={selectedKey} saveId={saveId} gameState={gameState} />
    </div>
  );
}


const EFFORT_LABELS = {
  auto: 'Auto',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra: 'Extra',
  max: 'Max',
};

function normalizeEffortLevel(level, spec) {
  const lv = String(level || 'auto').toLowerCase();
  const levels = (spec && spec.levels) || [];
  if (levels.includes(lv)) return lv;
  if (['low', 'medium', 'extra', 'max'].includes(lv) && levels.includes('high')) return 'high';
  if (lv === 'off' && spec && !spec.can_disable) return 'auto';
  const fallback = (spec && spec.default_level) || 'auto';
  if (levels.includes(fallback)) return fallback;
  return levels.includes('auto') ? 'auto' : (levels[0] || 'auto');
}

function effortDesc(spec, id, t) {
  if (id === 'auto') return t('game.composer.effort_auto_desc', { defaultValue: 'Follow the provider default' });
  if (id === 'off') return t('game.composer.effort_off_desc');
  const budget = spec && spec.budget_tokens && spec.budget_tokens[id];
  if (budget) return `${Math.round(budget / 1000)}k tokens`;
  if (id === 'high') {
    return t('game.composer.effort_on_desc', { defaultValue: 'Enable thinking' });
  }
  if (id === 'max') return t('game.composer.effort_max_desc');
  return id;
}

function EffortSection({ selectedKey, saveId, gameState }) {
  const { t } = useTranslation();
  const hasSaveScope = saveId != null && Number(saveId) > 0;
  // selectedKey 格式: "api_id::model_real_name" — backend pref key 用 "api_id:model_id"
  const prefKey = React.useMemo(() => {
    if (!selectedKey) return '';
    const [api, model] = selectedKey.split('::');
    return api && model ? `${api}:${model}` : '';
  }, [selectedKey]);

  const [spec, setSpec] = useStateC(null);
  const [effort, setEffort] = useStateC('auto');
  const [busy, setBusy] = useStateC(false);
  const cancelledRef = React.useRef(false);  // 卸载守卫:卸载后跳过 setBusy
  const reqIdRef = React.useRef(0);          // RMW 竞态守卫:只让最新请求写回
  React.useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);

  // 能力描述来自 /api/models 的 model.reasoning(后端 model_reasoning 统一推断)。
  React.useEffect(() => {
    if (!prefKey) { setSpec(null); return; }
    let cancelled = false;
    setSpec(null);
    (async () => {
      try {
        const d = await window.api.models.list().catch(() => ({}));
        if (cancelled) return;
        const colon = prefKey.indexOf(':');
        const apiId = prefKey.slice(0, colon);
        const modelKey = prefKey.slice(colon + 1);
        const api = ((d && d.models && d.models.apis) || []).find((a) => a.id === apiId);
        const m = ((api && api.models) || []).find((mm) => (mm.real_name || mm.id) === modelKey || mm.id === modelKey);
        setSpec((m && m.reasoning) || null);
      } catch (_) { if (!cancelled) setSpec(null); }
    })();
    return () => { cancelled = true; };
  }, [prefKey]);

  // gameState 来自 /api/state(已把 session_reasoning 透出);_raw 是某些宿主的原始信封。
  // 折成稳定字符串再进依赖,避免父组件每次渲染的新对象把 effect 反复触发。
  const sessionReasoningKey = React.useMemo(() => {
    const sr = gameState && (gameState.session_reasoning
      || (gameState._raw && gameState._raw.session_reasoning));
    return sr && sr.api_id && sr.model_id && sr.level
      ? `${sr.api_id}::${sr.model_id}::${sr.level}`
      : '';
  }, [gameState]);

  // 当前档位:本存档覆盖优先;否则用户级 model_effort;否则 spec 默认。
  React.useEffect(() => {
    if (!prefKey) return;
    let cancelled = false;
    (async () => {
      const colon = prefKey.indexOf(':');
      const apiId = prefKey.slice(0, colon);
      const modelKey = prefKey.slice(colon + 1);
      const [srApi, srModel, srLevel] = sessionReasoningKey.split('::');
      if (hasSaveScope && srApi === apiId && srModel === modelKey && srLevel) {
        if (!cancelled) setEffort(normalizeEffortLevel(srLevel, spec));
        return;
      }
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const p = (r && r.preferences) || {};
        const m = p.model_effort || {};
        const cur = m[prefKey] || (spec && spec.default_level) || 'auto';
        setEffort(normalizeEffortLevel(cur, spec));
      } catch (_) {
        if (!cancelled) setEffort(normalizeEffortLevel(null, spec));
      }
    })();
    return () => { cancelled = true; };
  }, [prefKey, saveId, hasSaveScope, sessionReasoningKey, spec]);

  const onPickEffort = async (id) => {
    if (!prefKey || busy) return;
    const prevEffort = effort;
    const myReq = ++reqIdRef.current;  // 竞态守卫:只让最新请求的结果生效
    setBusy(true);
    setEffort(id);  // 乐观更新
    const colon = prefKey.indexOf(':');
    const apiId = prefKey.slice(0, colon);
    const modelId = prefKey.slice(colon + 1);
    try {
      if (hasSaveScope) {
        // 本存档作用域:只影响当前对话主 GM。
        await window.api.models.reasoning({
          save_id: saveId, api_id: apiId, model_id: modelId, level: id,
        });
        try { window.dispatchEvent(new CustomEvent('game-state-refresh')); } catch (_) {}
      } else {
        // 无存档(或调用方明确不要存档作用域)→ 用户级 model_effort,兼容旧行为。
        const profileR = await window.api.account.profile();
        if (reqIdRef.current !== myReq) return;  // 被更新请求取代,bail out
        const existing = ((profileR && profileR.preferences && profileR.preferences.model_effort) || {});
        const next = { ...existing, [prefKey]: id };
        await window.api.account.preferences({ preferences: { model_effort: next } });
      }
      if (reqIdRef.current !== myReq) return;  // 再次确认
      window.__apiToast?.(t('game.composer.effort_saved', { id }), { kind: 'ok', duration: 1500 });
    } catch (e) {
      // 回滚到点击前的档位,避免 UI 显示已生效而后端拒绝。
      setEffort(prev => (prev === id ? prevEffort : prev));
      window.__apiToast?.(t('game.composer.effort_save_failed'), { kind: 'danger', detail: e?.message });
    } finally { if (!cancelledRef.current) setBusy(false); }
  };

  // 能力驱动:未声明 / 只有一个档位(只有 auto)时整体隐藏,不再按 provider 白名单。
  if (!prefKey || !spec || !spec.supported) return null;
  const levels = (spec.levels || ['auto']).filter((id) => id !== 'off' || spec.can_disable);
  if (levels.length <= 1) return null;
  const scopeLabel = hasSaveScope
    ? t('game.composer.effort_scope_save', { defaultValue: 'This conversation' })
    : t('game.composer.effort_scope_model', { defaultValue: 'All conversations' });
  return (
    <div style={{
      padding: '10px 12px',
      borderTop: '1px solid var(--line-soft)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div className="muted-2" style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span>Effort</span>
        <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.75 }}>· {scopeLabel}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {levels.map((id) => {
          const active = id === effort;
          return (
            <button
              key={id}
              onClick={() => onPickEffort(id)}
              disabled={busy}
              title={effortDesc(spec, id, t)}
              style={{
                padding: '4px 10px',
                borderRadius: 999,
                fontSize: 11.5,
                border: active ? '1px solid var(--accent)' : '1px solid var(--line)',
                background: active ? 'rgba(201, 100, 66, 0.18)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text)',
                cursor: busy ? 'wait' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {id === 'auto'
                ? t('game.composer.effort_auto', { defaultValue: 'Auto' })
                : (EFFORT_LABELS[id] || id)}
            </button>
          );
        })}
      </div>
    </div>
  );
}


function PermissionPopover({ current, onPick, onClose, triggerRef, optionIds = null }) {
  const { t } = useTranslation();
  const OPTS = Array.isArray(optionIds) && optionIds.length
    ? PERMISSION_OPTIONS.filter((p) => optionIds.includes(p.id))
    : PERMISSION_OPTIONS;
  const menuRef = useRefC(null);
  // PR #14: 55vh 上限 + resize,防止权限菜单过高挡界面。
  const calcPermHeight = React.useCallback(() => {
    if (!menuRef.current || !triggerRef?.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const aboveSpace = Math.max(160, rect.top - 16);
    menuRef.current.style.maxHeight = Math.min(aboveSpace, window.innerHeight * 0.55) + "px";
    menuRef.current.style.overflowY = "auto";
  }, [triggerRef]);
  React.useLayoutEffect(calcPermHeight, [calcPermHeight]);
  React.useEffect(() => {
    window.addEventListener("resize", calcPermHeight);
    return () => window.removeEventListener("resize", calcPermHeight);
  }, [calcPermHeight]);
  useDismissOnOutsideOrEscape(menuRef, triggerRef, onClose);

  return (
    <div ref={menuRef} className="gc-menu gc-pop-menu">
      <div className="gc-menu-head">
        <Icon name="lock" size={12} /><span>{t('game.composer.perm_title')}</span>
      </div>
      <ul className="gc-pop-list">
        {OPTS.map(p => (
          <li key={p.id}>
            <button onClick={() => onPick(p.id)} className={p.id === current ? "active" : ""}>
              <div>
                <Icon name={p.icon} size={12} style={{verticalAlign: "-2px", marginRight: 6, color: "var(--muted)"}} />
                <strong>{t(p.labelKey)}</strong>
              </div>
              <span className="muted" style={{fontSize: 12}}>{t(p.descKey)}</span>
              {p.id === current && <Icon name="check" size={14} style={{color: "var(--accent)"}} />}
            </button>
          </li>
        ))}
      </ul>
      <div className="gc-menu-foot">
        <span className="muted" style={{fontSize: 11.5}}>
          {t('game.composer.perm_footer')}
        </span>
      </div>
    </div>
  );
}

export { PERMISSION_OPTIONS, ModelPopover, PermissionPopover };
