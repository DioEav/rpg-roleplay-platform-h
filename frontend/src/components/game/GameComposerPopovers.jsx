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

// Effort/深度思考控件的显示门槛(2026-10,与 settings modelparams-section 同规则):
// 供应商白名单(后端真正消费 model_effort:anthropic/vertex_ai 走 budget_tokens,
// openai/deepseek 走 reasoning_effort)**且**模型目录声明 reasoning 能力。
// 其余(中转/本地/非推理模型)后端静默忽略该偏好,显示档位=「已启用」谎报,caps 缺失按不支持隐藏。
const THINKING_EFFORT_PROVIDERS = ["anthropic", "vertex_ai", "openai", "deepseek"];

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
    onPick && onPick(modelReal);
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
      {/* task 141: Effort 段 — 每个模型独立配置 thinking budget 档位 */}
      <EffortSection selectedKey={selectedKey} />
    </div>
  );
}


function EffortSection({ selectedKey }) {
  const { t } = useTranslation();
  const EFFORT_OPTIONS = [
    { id: 'off',    label: 'Off',    desc: t('game.composer.effort_off_desc') },
    { id: 'low',    label: 'Low',    desc: '1k tokens' },
    { id: 'medium', label: 'Medium', desc: '4k tokens' },
    { id: 'high',   label: 'High',   desc: t('game.composer.effort_high_desc') },
    { id: 'extra',  label: 'Extra',  desc: '16k tokens' },
    { id: 'max',    label: 'Max',    desc: t('game.composer.effort_max_desc') },
  ];
  // selectedKey 格式: "api_id::model_real_name" — backend pref key 用 "api_id:model_id"
  const [effort, setEffort] = useStateC('high');
  const [busy, setBusy] = useStateC(false);
  // 显示门槛:供应商白名单 + 模型目录声明 reasoning 能力(缺数据按不支持隐藏)
  const [capsOk, setCapsOk] = useStateC(false);
  const cancelledRef = React.useRef(false);  // 卸载守卫:卸载后跳过 setBusy
  const reqIdRef = React.useRef(0);          // RMW 竞态守卫:只让最新请求写回
  React.useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);
  const prefKey = React.useMemo(() => {
    if (!selectedKey) return '';
    const [api, model] = selectedKey.split('::');
    return api && model ? `${api}:${model}` : '';
  }, [selectedKey]);

  React.useEffect(() => {
    if (!prefKey) { setCapsOk(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const d = await window.api.models.list().catch(() => ({}));
        if (cancelled) return;
        const colon = prefKey.indexOf(':');
        const apiId = prefKey.slice(0, colon);
        const modelKey = prefKey.slice(colon + 1);
        const api = ((d && d.models && d.models.apis) || []).find((a) => a.id === apiId);
        const m = ((api && api.models) || []).find((mm) => (mm.real_name || mm.id) === modelKey || mm.id === modelKey);
        const caps = Array.isArray(m && m.capabilities)
          ? m.capabilities
          : (m && m.capabilities ? Object.keys(m.capabilities) : []);
        setCapsOk(THINKING_EFFORT_PROVIDERS.includes(apiId) && caps.includes('reasoning'));
      } catch (_) { if (!cancelled) setCapsOk(false); }
    })();
    return () => { cancelled = true; };
  }, [prefKey]);

  React.useEffect(() => {
    if (!prefKey) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.account.profile();
        if (cancelled) return;
        const p = (r && r.preferences) || {};
        const m = p.model_effort || {};
        const cur = (m[prefKey] || 'high').toString().toLowerCase();
        if (EFFORT_OPTIONS.some(e => e.id === cur)) setEffort(cur);
        else setEffort('high');
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [prefKey]);

  const onPickEffort = async (id) => {
    if (!prefKey || busy) return;
    const myReq = ++reqIdRef.current;  // 竞态守卫:只让最新请求的结果生效
    setBusy(true);
    setEffort(id);  // 乐观更新
    try {
      // 先拉现有 model_effort 字典,patch 后整段 POST 回去
      const profileR = await window.api.account.profile();
      if (reqIdRef.current !== myReq) return;  // 被更新请求取代,bail out
      const existing = ((profileR && profileR.preferences && profileR.preferences.model_effort) || {});
      const next = { ...existing, [prefKey]: id };
      await window.api.account.preferences({ preferences: { model_effort: next } });
      if (reqIdRef.current !== myReq) return;  // 再次确认
      window.__apiToast?.(t('game.composer.effort_saved', { id }), { kind: 'ok', duration: 1500 });
    } catch (e) {
      window.__apiToast?.(t('game.composer.effort_save_failed'), { kind: 'danger', detail: e?.message });
    } finally { if (!cancelledRef.current) setBusy(false); }
  };

  if (!prefKey || !capsOk) return null;
  return (
    <div style={{
      padding: '10px 12px',
      borderTop: '1px solid var(--line-soft)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div className="muted-2" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        Effort
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {EFFORT_OPTIONS.map((opt) => {
          const active = opt.id === effort;
          return (
            <button
              key={opt.id}
              onClick={() => onPickEffort(opt.id)}
              disabled={busy}
              title={opt.desc}
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
              {opt.label}
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
