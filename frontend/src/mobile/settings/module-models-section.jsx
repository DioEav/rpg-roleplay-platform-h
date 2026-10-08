import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import AgentModelPicker from '../../components/AgentModelPicker.jsx';
import { MODULES as AGENT_MODULES, MODULE_GROUPS, FEATURES as AGENT_FEATURES, featureInitialEnabled } from '../../agent-modules.js';
import { Toggle, usePrefSave } from './shared.jsx';

/* ────────────────────────────────────────────────────────────────── */
/* SECTION: 模块分配 (modules)                                         */
/* ────────────────────────────────────────────────────────────────── */
// 模块清单与桌面端同构。每行用统一规范组件 AgentModelPicker(不再自造 <select>)。
//   flat 模块走 prefPrefix(<prefPrefix>.api_id / .model_real_name);
//   dict 模块(sub_agent / console)走 persistShape="dict" + dictKey={api_id, model};
//   embedder / image_gen allowInherit=false(必须自己选);其它可「跟随主 GM」。
// 结构字段走单一来源 AGENT_MODULES;移动端 label/tip 文案精简(与桌面端不同),保留本地按 id 取。
const MODULES = AGENT_MODULES.map((m) => ({ ...m }));

/* FeatureToggleM — 移动端引擎特性开关。写 user_preferences["<key>.enabled"],
   与桌面端、后端 core.feature_flags 同键。initial 必须是父组件经
   featureInitialEnabled() 解析后的布尔(defaultOff 键未设偏好时显示关)。 */
const _FEAT_LABEL_DEF = {
  ctx_tiered: '分层上下文缓存', recorder_unified: '史官三合一', narrator_slim: '文宗精简(去工具循环)',
  rag_gate: 'RAG 检索闸', anchor_pace: '世界线锚点节奏', kb_state: '存档知识库 DB 化',
  consequence_ledger: '后果账本', world_heartbeat: '世界心跳', channel_fallback: '跨渠道自动备援',
  npc_agenda: 'NPC 议程',
};
const _FEAT_DESC_DEF = {
  ctx_tiered: '分层稳定前缀,命中前缀缓存,显著省 token。',
  recorder_unified: '状态提取 + 锚点判定合并为一次 LLM 调用。',
  narrator_slim: '主叙事单次成文、不带工具循环,状态交史官。',
  rag_gate: '司命判定本回合是否需检索,不需则跳过省 token。',
  anchor_pace: '按对话节奏推进锚点、逐个标记、死亡失效 —— 治跳章。',
  kb_state: '存档状态以数据库行存储(单一来源),便于检索维护。',
  consequence_ledger: '承诺/欠债到期或抵达指定地点时,提醒 GM 主动兑现。',
  world_heartbeat: '每隔几回合生成不在场处的世界小事,之后以传闻方式浮现。',
  channel_fallback: '主渠道持续故障时自动切换你配置的其他渠道(明确提示)。',
  npc_agenda: 'NPC 带持续演化的议程(想要什么/对玩家什么态度),跨回合连续。',
};
function FeatureToggleM({ featureKey, i18nKey, initial }) {
  const { t } = useTranslation();
  const [on, setOn] = useState(!!initial);
  const save = usePrefSave(featureKey);
  useEffect(() => { setOn(!!initial); }, [initial]);
  return (
    <div className="pl-card" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <strong style={{ fontSize: 14 }}>{t(`settings.features.${i18nKey}.label`, { defaultValue: _FEAT_LABEL_DEF[featureKey] || featureKey })}</strong>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>{t(`settings.features.${i18nKey}.desc`, { defaultValue: _FEAT_DESC_DEF[featureKey] || '' })}</div>
      </div>
      <Toggle on={on} onChange={(v) => { setOn(v); save('enabled', v); }} />
    </div>
  );
}

function ModuleModelsSection({ nav }) {
  const { t } = useTranslation();
  // embedder 平台兜底状态:仅 admin/vip 显示平台 vertex embedding(后端已 _is_admin gate)。
  const [embedStatus, setEmbedStatus] = useState(null);
  useEffect(() => {
    fetch('/api/me/embedder/status', { credentials:'include' })
      .then(r => r.json()).then(es => setEmbedStatus(es?.ok ? es : null)).catch(() => {});
  }, []);
  const platformVertexAllowed = !!(embedStatus && embedStatus.platform_fallback_available);

  // 一次性读取特性偏好(各开关初值)。
  const [featPrefs, setFeatPrefs] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { const r = await window.api.account.profile(); if (!cancelled && r && r.preferences) setFeatPrefs(r.preferences); } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="pl-sec-note" style={{ marginBottom: 14 }}>
        {t('mobile.settings.modules.intro')}
      </div>
      {MODULE_GROUPS.map(grp => {
        const items = MODULES.filter(m => (m.group || 'misc') === grp.id);
        const feats = (AGENT_FEATURES || []).filter(f => f.group === grp.id);
        if (!items.length && !feats.length) return null;
        const groupLabel = t(`mobile.settings.modules.group.${grp.id}`, {
          defaultValue: { core: '对话核心（三贤者）', script: '剧本与角色卡', world: '世界模拟', gen: '检索与生成', misc: '通用兜底' }[grp.id] || grp.id,
        });
        return (
        <React.Fragment key={grp.id}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent, #0972d3)', margin: '14px 0 6px' }}>{groupLabel}</div>
          {feats.map(f => (
            <FeatureToggleM key={f.key} featureKey={f.key} i18nKey={f.i18nKey} initial={featureInitialEnabled(f, featPrefs[`${f.key}.enabled`])} />
          ))}
          {items.map(mod => (
        <div key={mod.id} className="pl-card" style={{ marginBottom: 10 }}>
          <div style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 14 }}>{t(`mobile.settings.modules.label.${mod.id}`)}</strong>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t(`mobile.settings.modules.tip.${mod.id}`)}</div>
          </div>
          <AgentModelPicker
            prefPrefix={mod.prefPrefix}
            persistShape={mod.persistShape || 'flat'}
            dictKey={mod.dictKey || null}
            capabilityFilter={mod.capabilityFilter || null}
            allowInherit={!!mod.inherit}
            defaultModel={mod.defaultModel || null}
            preferProvider={mod.preferProvider || null}
            fallbackPrefix={mod.fallbackPrefix || null}
            platformVertexAllowed={mod.id === 'embedder' ? platformVertexAllowed : false}
            variant="bare"
            configHash="apis"
          />
          {mod.id==='embedder' && embedStatus && !embedStatus.user_configured && !platformVertexAllowed && (
            <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 8, lineHeight: 1.5 }}>
              {t('mobile.settings.modules.embedder_no_key')}
            </div>
          )}
        </div>
          ))}
        </React.Fragment>
        );
      })}
      <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 8 }}>
        {t('mobile.settings.modules.embedder_switch_note')}
      </div>
    </>
  );
}

export { ModuleModelsSection };
