/* ModuleStatusCard — Editorial × 古籍数字化 重设计版.
   保持所有 props contract 不变 (module / status / doneCount / totalCount / lastJobId /
   lastRebuiltAt / source / onRebuild / onViewDetail / activeJobId / extraActions /
   title / description / metadata).
   去除 Cloudscape 依赖 — 纯 CSS module + inline style.
*/

import React from 'react';
import { useTranslation } from 'react-i18next';
import s from './editorial.module.css';

/* ── Source tag text (小型 dotted label) ── */
const SOURCE_LABEL_KEY = { llm: 'LLM', zero_llm: 'module_status.source_zero_llm', mixed: 'module_status.source_mixed_llm' };
const SOURCE_CSS   = { llm: s.sourceTagLlm, zero_llm: s.sourceTagZero, mixed: s.sourceTagMixed };

const MODULE_META = {
  chunks:        { source: 'zero_llm' },
  chapter_facts: { source: 'zero_llm' },
  canon:         { source: 'llm' },
  /* cards 与 worldbook 同款「可选 LLM」:默认 rebuild_cards_from_canon 零 LLM(从
     canon/facts 反推,恒免费),仅勾选「LLM 丰富重建」(mode=llm)才烧 API。 */
  cards:         { source: 'mixed' },
  worldbook:     { source: 'mixed' },
  anchors:       { source: 'zero_llm' },
  embeddings:    { source: 'zero_llm' },
  story_phase:   { source: 'llm' },
};

/* 每模块的计数单位(替代通用「条」)。
   cover: true = done/total 是跨单位比值(块数/章数、事实数/章数),不渲染成
   「4499/1487」分数和百分比进度条(看起来像超 100%),改渲染「4499 块 · 覆盖 1487 章」。
   后端 chunks 的 total 就是章节数(listing.py _build),只作"每章至少 1 块"的下限校验。 */
const MODULE_UNITS = {
  chunks:        { unitKey: 'module_status.unit_chunks',     cover: true },
  chapter_facts: { unitKey: 'module_status.unit_facts',      cover: true },
  canon:         { unitKey: 'module_status.unit_canon' },
  cards:         { unitKey: 'module_status.unit_cards' },
  worldbook:     { unitKey: 'module_status.unit_worldbook' },
  anchors:       { unitKey: 'module_status.unit_anchors' },
  embeddings:    { unitKey: 'module_status.unit_embeddings' },
  story_phase:   { unitKey: 'module_status.unit_chapters' },
};

/* ── Status badge helpers ── */
function statusGlyph(status) {
  switch (status) {
    case 'ready':   return '✓';
    case 'partial': return '◑';
    case 'missing': return '○';
    case 'running': return '◷';
    case 'stale':   return '△';
    default:        return '·';
  }
}

function statusCls(status) {
  switch (status) {
    case 'ready':   return s.ok;
    case 'partial':
    case 'stale':   return s.warn;
    case 'missing': return s.danger;
    case 'running': return s.run;
    default:        return s.dim;
  }
}

function statusText(t, status) {
  switch (status) {
    case 'ready':   return t('modules.status.ready',   { defaultValue: '就绪' });
    case 'partial': return t('modules.status.partial', { defaultValue: '部分' });
    case 'missing': return t('modules.status.missing', { defaultValue: '缺失' });
    case 'running': return t('modules.status.running', { defaultValue: '运行中' });
    case 'stale':   return t('modules.status.stale',   { defaultValue: '已过期' });
    default:        return t('modules.status.unknown', { defaultValue: '未知' });
  }
}

/* ── Character progress bar (10 blocks) ── */
const BLOCK_FULL  = '▰';
const BLOCK_EMPTY = '▱';
const BAR_CELLS   = 10;

function charProgressBar(done, total) {
  if (done == null || total == null || total === 0) return null;
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * BAR_CELLS);
  const bar    = BLOCK_FULL.repeat(filled) + BLOCK_EMPTY.repeat(BAR_CELLS - filled);
  const pct    = Math.round(ratio * 100);
  return { bar, pct };
}

/* ── Time-since helper ── */
function fmtCountdown(iso, t) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const m = Math.floor((Date.now() - d.getTime()) / 60000);
    if (m < 1)  return t('module_status.time_just_now');
    if (m < 60) return t('module_status.time_minutes_ago', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('module_status.time_hours_ago', { count: h });
    return t('module_status.time_days_ago', { count: Math.floor(h / 24) });
  } catch (_) { return null; }
}

/* ── Zhuyin (朱印) protagonist badge ── */
function ZhuyinBadge({ t }) {
  return (
    <div className={s.zhuyinBadge} title={t('module_status.protagonist_badge_title')}>
      <span className={s.zhuyinChar}>主</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────── */

export function ModuleStatusCard({
  module,
  scriptId,
  status = 'unknown',
  doneCount,
  totalCount,
  lastJobId,
  lastRebuiltAt,
  source: sourceOverride,
  onRebuild,
  onViewDetail,
  activeJobId,
  extraActions,
  title,
  description,
  metadata,        /* { is_protagonist? } — 后端已写 */
}) {
  const { t } = useTranslation();
  const meta   = MODULE_META[module] || {};
  const source = sourceOverride || meta.source || 'unknown';

  const displayTitle = title
    || t(`modules.${module}.title`, { defaultValue: module });
  const displayDesc  = description
    || t(`modules.${module}.desc`, { defaultValue: '' });

  const sinceStr       = fmtCountdown(lastRebuiltAt, t);
  const rebuildDisabled = !!activeJobId || status === 'running';
  const isProtagonist  = metadata && metadata.is_protagonist;

  /* ── count display parts ── */
  const hasBoth = doneCount != null && totalCount != null && totalCount > 0;
  const hasDone = doneCount != null;

  /* ── 单位与跨单位(cover)展示 ── */
  const unitInfo = MODULE_UNITS[module] || null;
  const unitStr = unitInfo
    ? t(unitInfo.unitKey, { defaultValue: t('module_status.count_unit', { defaultValue: '条' }) })
    : t('module_status.count_unit', { defaultValue: '条' });
  // cover 格式只在 done/total 都有值时用;缺 total 时退回单数字 + 单位
  const useCover = !!(unitInfo && unitInfo.cover && hasBoth);

  /* ── progress bar ── */
  // cover 格式下 done/total 是跨单位比值(块数/章数),百分比无意义,不渲染进度条
  const progress = useCover ? null : charProgressBar(doneCount, totalCount);

  /* ── card root class ── */
  let cardCls = s.card;
  if (status === 'running') cardCls += ' ' + s.cardRunning;
  if (status === 'missing') cardCls += ' ' + s.cardMissing;

  /* ── action label ── */
  const rebuildLabel = status === 'missing'
    ? t('modules.action.build',   { defaultValue: '生成' })
    : t('modules.action.rebuild', { defaultValue: '重做' });

  return (
    <div className={cardCls}>
      {/* 朱印 — rendered absolutely inside card */}
      {isProtagonist && <ZhuyinBadge t={t} />}

      {/* ── Head row: title + source tag + actions ── */}
      <div className={s.cardHead}>
        <div className={s.cardTitleGroup}>
          <span className={s.cardTitle}>{displayTitle}</span>
          {source !== 'unknown' && (
            <span className={`${s.sourceTag} ${SOURCE_CSS[source] || ''}`}>
              {source === 'llm' ? 'LLM' : SOURCE_LABEL_KEY[source] ? t(SOURCE_LABEL_KEY[source]) : source}
            </span>
          )}
        </div>
        <div className={s.cardActions}>
          {onViewDetail && (
            <button
              className={s.detailLink}
              onClick={() => onViewDetail({ module, scriptId, lastJobId })}
              type="button"
            >
              {t('module_status.action_detail')} ↗
            </button>
          )}
          {onRebuild && (
            <button
              className={s.rebuildBtn}
              disabled={rebuildDisabled}
              onClick={() => onRebuild({ module, scriptId, source })}
              type="button"
            >
              <span className={s.rebuildArrow}>↻</span>
              {rebuildLabel}
            </button>
          )}
        </div>
      </div>

      {/* ── Description ── */}
      {displayDesc && (
        <div className={s.cardDesc}>{displayDesc}</div>
      )}

      {/* ── Body: big serif count + status badge + time ── */}
      <div className={s.cardBody}>
        {/* Count */}
        <div className={s.countBlock}>
          {useCover ? (
            <>
              {/* 跨单位格式:「4499 块 · 覆盖 1487 章」— done 与 total 单位不同,不渲染成分数 */}
              <span className={s.countNum}>{doneCount}</span>
              <span className={s.countUnit}>{unitStr}</span>
              <span className={s.countSep}>·</span>
              <span className={s.countTotal}>
                {t('module_status.cover_chapters', { total: totalCount, defaultValue: `覆盖 ${totalCount} 章` })}
              </span>
            </>
          ) : hasBoth ? (
            <>
              <span className={s.countNum}>{doneCount}</span>
              <span className={s.countSep}>/</span>
              <span className={s.countTotal}>{totalCount}</span>
              <span className={s.countUnit}>{unitStr}</span>
            </>
          ) : hasDone ? (
            <>
              <span className={s.countNum}>{doneCount}</span>
              <span className={s.countUnit}>{unitStr}</span>
            </>
          ) : (
            <span className={s.countDash}>—</span>
          )}
        </div>

        {/* Status */}
        <div className={s.statusArea}>
          <span className={s.statusLabel}>
            {t('modules.field.status', { defaultValue: '状态' })}
          </span>
          <span className={`${s.statusBadge} ${statusCls(status)}`}>
            {statusGlyph(status)}&nbsp;{statusText(t, status)}
          </span>
        </div>

        {/* Time since */}
        {sinceStr && (
          <span className={s.timeLabel}>{sinceStr}</span>
        )}
      </div>

      {/* ── Character progress bar ── */}
      {progress && (
        <div className={s.progressArea}>
          <span className={s.progressBar}>{progress.bar}</span>
          <span className={s.progressPct}>{progress.pct}%</span>
        </div>
      )}

      {/* ── Extra actions (e.g. worldbook double-button) ── */}
      {extraActions && (
        <div className={s.extraActionsRow}>
          {extraActions}
        </div>
      )}
    </div>
  );
}

export default ModuleStatusCard;
