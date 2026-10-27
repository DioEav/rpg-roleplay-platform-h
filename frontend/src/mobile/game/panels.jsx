/* panels.jsx — 移动原生世界面板(P2)。
   对齐电脑端 game-panels.jsx 的 8 个 tab(状态/规则/记忆/世界书/人物/时间线/上下文/调试),
   读同一份真实 `state`,但 UI 是移动原生(不复用电脑端 RightPanel)。
   字段防御性读取;空态明确提示。调试 tab 仅 devmode。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { Icon } from '../icons.jsx';
import { lsGet } from '../../lib/storage.js';
import { anchorStatuses } from '../../lib/timeline-status.js';
// /set 强制设定管理(列出 + 逐条删 + 清空)复用电脑端同一组件:单一来源(worldline.remove + 配对 pinned +
// game-state-refresh),移动端 MobileGame 复用 game-console run-loop,故 __confirm/__apiToast/刷新事件都可用。
import { ForcedSetSection, WorldbookOverlaySection } from '../../game-panels.jsx';

export const MOBILE_PANEL_TABS = [
  { id: 'status', label: i18n.t('mobile.game_panels.tab.status'), icon: 'status' },
  // 「5E 规则」tab 已隐藏(与桌面 RightPanel PANEL_TABS 同步;恢复时解注释即可)。
  // { id: 'rules', label: i18n.t('mobile.game_panels.tab.rules'), icon: 'dice' },
  { id: 'memory', label: i18n.t('mobile.game_panels.tab.memory'), icon: 'memory' },
  { id: 'worldbook', label: i18n.t('mobile.game_panels.tab.worldbook'), icon: 'world' },
  { id: 'cards', label: i18n.t('mobile.game_panels.tab.cards'), icon: 'cards' },
  { id: 'timeline', label: i18n.t('mobile.game_panels.tab.timeline'), icon: 'timeline' },
  { id: 'context', label: i18n.t('mobile.game_panels.tab.context'), icon: 'gauge' },
  ...(lsGet('rpg_devmode') === '1'
    ? [{ id: 'debug', label: i18n.t('mobile.game_panels.tab.debug'), icon: 'braces' }] : []),
];

const Empty = ({ children }) => <div className="mp-empty">{children}</div>;
const Sec = ({ title, count, children }) => (
  <div className="mp-sec">
    {title && <div className="mp-sec-head"><span>{title}</span>{count != null && <span className="mono">{count}</span>}</div>}
    {children}
  </div>
);
const KV = ({ k, v }) => (v == null || v === '') ? null : (
  <div className="mp-kv"><span className="mp-k">{k}</span><span className="mp-v">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></div>
);

function StatusPanel({ s }) {
  const { t } = useTranslation();
  const p = s.player || {}; const w = s.world || {};
  const wl = s.worldline || {}; const vars = wl.variables || wl.vars || {};
  const varEntries = Object.entries(vars);
  return (
    <>
      <Sec title={t('mobile.game_panels.status.section_character')}>
        <KV k={t('mobile.game_panels.status.kv_name')} v={p.name || p.display_name} />
        <KV k={t('mobile.game_panels.status.kv_role')} v={p.role} />
        <KV k={t('mobile.game_panels.status.kv_location')} v={p.current_location || p.location} />
        {p.background ? <div className="mp-para">{p.background}</div> : null}
        {!p.name && !p.role ? <Empty>{t('mobile.game_panels.status.empty_character')}</Empty> : null}
      </Sec>
      <Sec title={t('mobile.game_panels.status.section_world')}>
        <KV k={t('mobile.game_panels.status.kv_time')} v={w.time} />
        <KV k={t('mobile.game_panels.status.kv_weather')} v={w.weather} />
        {Array.isArray(w.known_events) && w.known_events.length ? (
          // known_events 是尾部 append：取最近 8 条（slice(-8)），不能用 slice(0,8)
          // 否则长局永远只显示开局事件。
          <div className="mp-list">{w.known_events.slice(-8).map((e, i) => <div key={i} className="mp-li">· {typeof e === 'string' ? e : (e.text || e.title || JSON.stringify(e))}</div>)}</div>
        ) : null}
      </Sec>
      {varEntries.length > 0 && (
        <Sec title={t('mobile.game_panels.status.section_worldline_vars')} count={varEntries.length}>
          {varEntries.slice(0, 20).map(([k, v]) => <KV key={k} k={k} v={v} />)}
        </Sec>
      )}
      {/* /set 强制设定管理(删改已设):复用电脑端组件,单一来源 */}
      <ForcedSetSection state={s} />
    </>
  );
}

function RulesPanel({ s }) {
  const { t } = useTranslation();
  const rs = s.ruleset || {}; const sc = s.scene || {}; const enc = s.encounter || {};
  const pc = s.player_character || {}; const dice = Array.isArray(s.dice_log) ? s.dice_log : [];
  const hasRules = rs.id || rs.name || sc.module_id || enc.id || dice.length;
  if (!hasRules) return <Empty>{t('mobile.game_panels.rules.empty')}</Empty>;
  return (
    <>
      {(rs.id || rs.name) && <Sec title={t('mobile.game_panels.rules.section_ruleset')}><KV k="ruleset" v={rs.name || rs.id} /></Sec>}
      {pc && (pc.hp != null || pc.level != null) && (
        <Sec title={t('mobile.game_panels.rules.section_pc')}>
          <KV k={t('mobile.game_panels.rules.kv_level')} v={pc.level} /><KV k="HP" v={pc.hp != null ? `${pc.hp}/${pc.max_hp ?? '?'}` : null} />
          <KV k="AC" v={pc.ac} />
        </Sec>
      )}
      {sc.module_id && <Sec title={t('mobile.game_panels.rules.section_scene')}><KV k={t('mobile.game_panels.rules.kv_module')} v={sc.module_id} /><KV k={t('mobile.game_panels.rules.kv_location')} v={sc.location} /></Sec>}
      {enc.id && <Sec title={t('mobile.game_panels.rules.section_encounter')}><KV k="encounter" v={enc.id} /><KV k={t('mobile.game_panels.rules.kv_round')} v={enc.round} /></Sec>}
      {dice.length > 0 && (
        <Sec title={t('mobile.game_panels.rules.section_dice')} count={dice.length}>
          {dice.slice(-12).reverse().map((d, i) => <div key={i} className="mono mp-li">{typeof d === 'string' ? d : `${d.expr || ''} → ${d.total ?? d.result ?? ''}`}</div>)}
        </Sec>
      )}
    </>
  );
}

function MemoryPanel({ s }) {
  const { t } = useTranslation();
  const m = s.memory || {};
  const facts = Array.isArray(m.facts) ? m.facts : [];
  // facts 桶是尾部 append；取 slice(0,30) 会永远显示最旧的 30 条。移动端窗口
  // 只展示“最近 30 条”，并倒序（最新在上），与桌面面板/注入窗口方向一致。
  const recentFacts = facts.slice(-30).reverse();
  const updates = Array.isArray(m.last_structured_updates) ? m.last_structured_updates : [];
  return (
    <>
      <Sec title={t('mobile.game_panels.memory.section_mode')}><KV k="mode" v={m.mode || 'normal'} />{m.current_objective ? <KV k={t('mobile.game_panels.memory.kv_objective')} v={m.current_objective} /> : null}</Sec>
      <Sec title={t('mobile.game_panels.memory.section_facts')} count={facts.length}>
        {recentFacts.length ? recentFacts.map((f, i) => <div key={i} className="mp-li">· {typeof f === 'string' ? f : (f.text || f.content || JSON.stringify(f))}</div>) : <Empty>{t('mobile.game_panels.memory.empty_facts')}</Empty>}
      </Sec>
      {updates.length > 0 && (
        <Sec title={t('mobile.game_panels.memory.section_updates')} count={updates.length}>
          {updates.map((u, i) => <div key={i} className="mono mp-li">{typeof u === 'string' ? u : (u.field ? `${u.field}: ${u.value ?? ''}` : JSON.stringify(u))}</div>)}
        </Sec>
      )}
    </>
  );
}

function WorldbookPanel({ s }) {
  const { t } = useTranslation();
  const w = s.world || {};
  const p = s.player || {};
  const tl = w.timeline || {};
  // /api/state 没有 worldbook/world_book 字段;真实可用的是 world/player/worldline
  // + save 级 overlay。旧版只读不存在的 key → 主列表永远空,只剩 overlay 段。
  const constraints = Array.isArray(s.worldline && s.worldline.constraints) ? s.worldline.constraints : [];
  const knownEvents = Array.isArray(w.known_events) ? w.known_events : [];
  // 兼容未来/旧 state 形状:若后端某天把世界书条目透传进 state,仍优先展示。
  const wb = s.worldbook || s.world_book || (s.content_pack && s.content_pack.worldbook) || [];
  const entries = Array.isArray(wb) ? wb : (wb.entries || []);
  const hasWorld = !!(p.current_location || p.location || w.time || w.weather || tl.current_phase
    || constraints.length || knownEvents.length || entries.length);
  return (
    <>
      {/* /set 同款:世界书 overlay 管理(复用电脑端组件,单一来源)。反馈#93 添加入口 */}
      <WorldbookOverlaySection saveId={s && s._raw ? s._raw.save_id : null} />
      <Sec title={t('mobile.game_panels.status.section_world')}>
        <KV k={t('mobile.game_panels.status.kv_location')} v={p.current_location || p.location} />
        <KV k={t('mobile.game_panels.status.kv_time')} v={w.time} />
        <KV k={t('mobile.game_panels.status.kv_weather')} v={w.weather} />
        <KV k={t('game.worldbook.phase_label')} v={tl.current_phase} />
      </Sec>
      {constraints.length > 0 && (
        <Sec title={t('game.worldbook.world_rules')} count={constraints.length}>
          {constraints.map((c, i) => (
            <div key={i} className="mp-li">· {typeof c === 'string' ? c : (c && (c.text || c.label)) || JSON.stringify(c)}</div>
          ))}
        </Sec>
      )}
      {knownEvents.length > 0 && (
        <Sec title={t('game.worldbook.known_events')} count={knownEvents.length}>
          {knownEvents.slice(-20).map((e, i) => (
            <div key={i} className="mp-li">· {typeof e === 'string' ? e : (e && (e.text || e.title)) || JSON.stringify(e)}</div>
          ))}
        </Sec>
      )}
      {entries.length > 0 && (
        <Sec title={t('mobile.game_panels.tab.worldbook')} count={entries.length}>
          {entries.slice(0, 40).map((e, i) => (
            <div key={i} className="mp-card">
              <div className="mp-card-t">{e.key || e.title || e.name || (t('mobile.game_panels.worldbook.entry_fallback', { index: i }))}</div>
              {(e.content || e.text) ? <div className="mp-card-b">{String(e.content || e.text).slice(0, 200)}</div> : null}
            </div>
          ))}
        </Sec>
      )}
      {!hasWorld && <Empty>{t('mobile.game_panels.worldbook.empty')}</Empty>}
    </>
  );
}

function CardsPanel({ s }) {
  const { t } = useTranslation();
  const onStage = Array.isArray(s.active_entities) ? s.active_entities : [];
  const rel = s.relationships || {};
  const relEntries = Object.entries(rel);
  return (
    <>
      <Sec title={t('mobile.game_panels.cards.section_on_stage')} count={onStage.length}>
        {onStage.length ? onStage.map((c, i) => {
          const nm = c.name || c.id || (t('mobile.game_panels.cards.entity_fallback', { index: i }));
          return <div key={i} className="mp-row"><span className="mp-av serif">{String(nm).slice(0, 1)}</span><span className="mp-row-tx"><strong>{nm}</strong>{c.role || c.status ? <span>{c.role || c.status}</span> : null}</span></div>;
        }) : <Empty>{t('mobile.game_panels.cards.empty_on_stage')}</Empty>}
      </Sec>
      <Sec title={t('mobile.game_panels.cards.section_relationships')} count={relEntries.length}>
        {relEntries.length ? relEntries.slice(0, 30).map(([name, r]) => (
          <div key={name} className="mp-kv"><span className="mp-k">{name}</span><span className="mp-v">{typeof r === 'object' ? (r.tone || r.status || r.value || JSON.stringify(r)) : String(r)}</span></div>
        )) : <Empty>{t('mobile.game_panels.cards.empty_relationships')}</Empty>}
      </Sec>
    </>
  );
}

// M8 修复:原来把 w.timeline 当数组/{events:[]}读,真实形状是对象(w.timeline.current_phase 等),
// 恒退化到 known_events → 手机端看不到剧本期望线/锚点/当前章进度。
// 改为与电脑端 game-panels.jsx PanelTimeline 同契约:按需 fetch GET /api/saves/:id/timeline,
// 渲染当前章 + 期望线锚点(label/章号/状态:已度过|当前|待解锁),known_events 保留作附加段。
function TimelinePanel({ s }) {
  const { t } = useTranslation();
  const { useEffect, useState, useRef } = React;
  const saveId = s?._raw?.save_id ?? null;
  const [data, setData] = useState(null);   // null = 未加载
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const lastFetchKey = useRef(null);

  // 回合结束(桌面 App 会广播 game-state-refresh)后当前章号可能变化;时间线来自独立
  // /timeline 请求,不随 SSE 的 state 更新,监听事件重新拉取,避免手机面板停在上一章。
  useEffect(() => {
    const bump = () => setRefreshTick((k) => k + 1);
    window.addEventListener('game-state-refresh', bump);
    return () => window.removeEventListener('game-state-refresh', bump);
  }, []);

  useEffect(() => {
    if (!saveId) { setData(null); setError(''); return; }
    const fetchKey = `${saveId}:${refreshTick}`;
    if (lastFetchKey.current === fetchKey && data !== null) return;  // 已加载且无变化
    lastFetchKey.current = fetchKey;
    let cancelled = false;
    setLoading(true);
    setError('');
    const base = (typeof window !== 'undefined' && window.__API_BASE) || '';
    fetch(`${base}/api/saves/${saveId}/timeline`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => { if (!cancelled) { setData(json); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e?.message || e)); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveId, refreshTick]);

  const w = s.world || {};
  const knownEvents = Array.isArray(w.known_events) ? w.known_events : [];

  if (!saveId) return <Empty>{t('game.timeline.no_save')}</Empty>;
  if (error) return <Empty>{t('game.timeline.load_failed', { error })}</Empty>;
  if (loading || data === null) return <Empty>{t('game.timeline.loading')}</Empty>;

  const scriptAnchors = Array.isArray(data.script_anchors) ? data.script_anchors : [];
  const currentChapter = data.current_chapter ?? 1;
  const anchorStatus_ = anchorStatuses(scriptAnchors, currentChapter);

  return (
    <>
      <Sec title={t('mobile.game_panels.tab.timeline')}>
        <KV k={t('game.timeline.chapter_label', { chapter: currentChapter })} v={currentChapter} />
      </Sec>
      <Sec title={t('game.timeline.expected')} count={scriptAnchors.length}>
        {scriptAnchors.length === 0 ? (
          <Empty>{t('game.timeline.no_anchors')}</Empty>
        ) : scriptAnchors.slice(0, 60).map((a, i) => {
          const chMin = a.chapter_min;
          const chMax = a.chapter_max != null ? a.chapter_max : a.chapter_min;
          // 与桌面 PanelTimeline 共用 anchorStatuses:锚点区间允许嵌套重叠,「当前」只能有一条
          // (群反馈「世界线有三个当前」);包住当前章的外层弧标「进行中」。
          const st = anchorStatus_[i];
          const mainTitle = a.story_time_label || a.phase_label
            || (chMin != null ? t('game.timeline.chapter_label', { chapter: chMin }) : '');
          const chapterRange = chMin != null
            ? `${t('game.timeline.chapter_label', { chapter: chMin })}${chMax != null && chMax !== chMin ? `–${chMax}` : ''}`
            : '';
          const statusLabel = st === 'current' ? t('game.timeline.current_pill')
            : st === 'ongoing' ? t('game.timeline.in_progress_pill')
            : st === 'done' ? t('game.timeline.done_label')
            : t('game.timeline.pending_label');
          return (
            <div key={i} className="mp-tl">
              <span className="mp-tl-dot" />
              <div className="mp-tl-tx">
                <strong>{mainTitle}</strong>
                <span>{chapterRange}{chapterRange ? ' · ' : ''}{statusLabel}</span>
              </div>
            </div>
          );
        })}
      </Sec>
      {knownEvents.length > 0 && (
        <Sec title={t('mobile.game_panels.status.section_world')} count={knownEvents.length}>
          {knownEvents.slice(-8).map((e, i) => (
            <div key={i} className="mp-li">· {typeof e === 'string' ? e : (e.text || e.title || JSON.stringify(e))}</div>
          ))}
        </Sec>
      )}
    </>
  );
}

function ContextPanel({ s }) {
  const { t } = useTranslation();
  // /api/state 没有 state.context.segments;真实数据在 memory.last_context /
  // memory.last_context_agent / memory.last_retrieval(桌面 PanelContext 同源)。
  const mem = s.memory || {};
  const ctx = mem.last_context || {};
  const tokens = Number(ctx.estimated_tokens) || 0;
  const layers = Array.isArray(ctx.layers) ? ctx.layers.length : 0;
  const refs = Array.isArray(ctx.chapter_refs) ? ctx.chapter_refs : [];
  const pinned = Array.isArray(mem.pinned) ? mem.pinned.length : 0;
  const historyTurns = Number(ctx.history_turns)
    || (Array.isArray(s.history) ? Math.floor(s.history.length / 2) : 0);
  const plan = (s.last_context_agent && s.last_context_agent.curator_plan)
    || (mem.last_context_agent && mem.last_context_agent.curator_plan) || {};
  const retrieval = String(mem.last_retrieval || '').trim();
  const planKeys = plan && typeof plan === 'object' ? Object.keys(plan).length : 0;
  const hasData = !!(tokens || layers || refs.length || pinned || historyTurns || retrieval || planKeys);
  if (!hasData) return <Empty>{t('mobile.game_panels.context.empty')}</Empty>;
  return (
    <>
      <Sec title={t('game.context.title')} count={tokens ? `${tokens} tok` : undefined}>
        <KV k="tokens" v={tokens} />
        <KV k={t('game.debug.context_layers')} v={layers} />
        <KV k={t('game.memory.pinned')} v={pinned} />
        <KV k="turn" v={historyTurns} />
      </Sec>
      {refs.length > 0 && (
        <Sec title={t('game.context.title')} count={refs.length}>
          {refs.slice(0, 20).map((c, i) => (
            <div key={i} className="mp-li">· {typeof c === 'string' ? c : (c && (c.title || c.label)) || JSON.stringify(c)}</div>
          ))}
        </Sec>
      )}
      {(plan.intent || plan.active_goal) && (
        <Sec title={t('game.context.curator_title')}>
          <KV k={t('game.context.intent')} v={plan.intent || plan.active_goal} />
          {plan.confidence != null && Number.isFinite(Number(plan.confidence)) && (
            <KV k={t('game.context.confidence')} v={`${Math.round(Number(plan.confidence) * 100)}%`} />
          )}
        </Sec>
      )}
      {retrieval && (
        <Sec title={t('game.context.retrieval_preview')}>
          <div className="mp-para mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, maxHeight: 240, overflow: 'auto' }}>
            {retrieval}
          </div>
        </Sec>
      )}
    </>
  );
}

function DebugPanel({ s }) {
  const { t } = useTranslation();
  return (
    <Sec title={t('mobile.game_panels.debug.section_raw_state')}>
      <pre className="mp-pre">{JSON.stringify(s, null, 2)}</pre>
    </Sec>
  );
}

const PANELS = {
  status: StatusPanel, rules: RulesPanel, memory: MemoryPanel, worldbook: WorldbookPanel,
  cards: CardsPanel, timeline: TimelinePanel, context: ContextPanel, debug: DebugPanel,
};

export function MobilePanel({ tab, state }) {
  const P = PANELS[tab] || StatusPanel;
  return <div className="mp-root">{<P s={state || {}} />}</div>;
}

export default MobilePanel;
