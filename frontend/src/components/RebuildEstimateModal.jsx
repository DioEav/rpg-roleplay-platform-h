/* RebuildEstimateModal — 重做前的估算+确认弹窗.
   Editorial × 古籍数字化:保留 CSModal shell (portal/focus-trap),
   内容层全部替换为 editorial.module.css 风格.
*/

import React from 'react';
import { useTranslation } from 'react-i18next';
import CSModal from '@cloudscape-design/components/modal';
import CSButton from '@cloudscape-design/components/button';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import s from './editorial.module.css';

/* embeddings 的可选重嵌类型 —— 顺序/取值必须与后端默认 include 一致:
   rebuild_worker._rebuild_embeddings / rebuild_scheduler(estimate)两处的
   `body.get("include") or ["chunks","cards","worldbook","canon"]`。 */
const EMBED_KINDS = ['chunks', 'cards', 'worldbook', 'canon'];

export function RebuildEstimateModal({ open, module, scriptId, estimate, loading, options, onOptionsChange, onClose, onConfirm }) {
  const { t } = useTranslation();
  const isCards = module === 'cards';
  const isEmbeddings = module === 'embeddings';
  const isWorldbook = module === 'worldbook';
  const isWorldbookEnrich = module === 'worldbook_enrich';
  const isCanon = module === 'canon';
  const isWorldKey = module === 'world_key';
  const isAnchors = module === 'anchors';
  // 有字段级手编保护的模块：显示「强制覆盖手编字段」开关（worldbook_enrich 用它自己的
  // include_editor 开关，不重复显示）。
  const showForce = ['cards', 'canon', 'worldbook', 'anchors'].includes(module);

  // 进度感知角色卡:cards 重建的「重建到第 N 章」+「LLM 丰富」本地状态。
  // 改动 → debounce 后回调 onOptionsChange(带 chapter_max / mode)重估。
  const [chapterMax, setChapterMax] = React.useState('');
  const [llmEnrich, setLlmEnrich] = React.useState(false);
  // 世界书:默认 canon 聚合(零 LLM);勾选后走单次 LLM 抽取(source='llm')。
  const [wbLlm, setWbLlm] = React.useState(false);
  // 世界书条目充实:默认跳过高编条目;勾选后连手编一起覆盖(include_editor)。
  const [wbEnrichEditor, setWbEnrichEditor] = React.useState(false);
  // 知识库人物:默认全量 LLM 重抽;勾选后只从 chapter_facts 零 LLM 重聚类。
  const [canonResolveOnly, setCanonResolveOnly] = React.useState(false);
  // 世界观切分:默认结构先验(零 LLM);勾选后追加 LLM 窄确认(use_llm)。
  const [wkLlm, setWkLlm] = React.useState(false);
  // 强制覆盖手编字段（默认关闭）：cards/canon/worldbook/anchors 共用。
  const [forceOverwrite, setForceOverwrite] = React.useState(false);
  // 按类型重嵌:embeddings 的 include 勾选本地态。默认全选 = 后端不传 include 时的行为,
  // 所以打开弹窗时不需要额外重估一次。
  const [embedKinds, setEmbedKinds] = React.useState(EMBED_KINDS);
  // 弹窗每次打开(module 变化)重置本地态,避免上次残留。
  React.useEffect(() => {
    if (open && isCards) {
      setChapterMax(options && options.chapter_max != null ? String(options.chapter_max) : '');
      setLlmEnrich(!!(options && (options.mode === 'llm' || options.source === 'llm')));
    }
    if (open && isEmbeddings) {
      const inc = options && Array.isArray(options.include) ? options.include.filter((k) => EMBED_KINDS.includes(k)) : null;
      setEmbedKinds(inc && inc.length ? inc : EMBED_KINDS);
    }
    if (open && isWorldbook) {
      setWbLlm(!!(options && (options.source === 'llm' || options.mode === 'llm')));
    }
    if (open && isWorldbookEnrich) {
      setWbEnrichEditor(!!(options && options.include_editor));
    }
    if (open && isCanon) {
      setCanonResolveOnly(!!(options && options.source === 'resolve_only'));
    }
    if (open && isWorldKey) {
      setWkLlm(!!(options && options.use_llm));
    }
    if (open) {
      setForceOverwrite(!!(options && options.force_overwrite_manual));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, module]);

  // 勾选变化立即重估(影响「将检查 N 条向量目标」与前置条件)。全空不重估——
  // 后端会把空 include 当成缺省的全选,估算数字会与用户所见勾选相反,故直接拦在确认按钮。
  const onEmbedKindToggle = (kind, checked) => {
    const next = checked
      ? EMBED_KINDS.filter((k) => k === kind || embedKinds.includes(k))  // 保持 EMBED_KINDS 顺序
      : embedKinds.filter((k) => k !== kind);
    setEmbedKinds(next);
    if (next.length && onOptionsChange) onOptionsChange({ include: next });
  };

  const emitOptions = React.useCallback((nextCh, nextLlm) => {
    if (!onOptionsChange) return;
    const n = parseInt(nextCh, 10);
    // 显式写 null/''：hook 侧是"合并"语义，缺键会保留上一次的值，清空操作必须覆盖成空。
    const opts = {
      chapter_max: (Number.isFinite(n) && n > 0) ? n : null,
      mode: nextLlm ? 'llm' : '',
    };
    // 手编保护已改为后端 automatic(manual_fields 字段级)：不再由弹窗传
    // preserve_existing。整批刷新用下方的 force_overwrite_manual。
    onOptionsChange(opts);
  }, [onOptionsChange]);

  // chapter_max 输入 debounce 重估(避免每个按键打一次估算请求)。
  const chDebounce = React.useRef(null);
  const onChapterMaxChange = (v) => {
    const cleaned = String(v || '').replace(/[^0-9]/g, '');
    setChapterMax(cleaned);
    if (chDebounce.current) clearTimeout(chDebounce.current);
    chDebounce.current = setTimeout(() => emitOptions(cleaned, llmEnrich), 500);
  };
  const onLlmToggle = (checked) => {
    setLlmEnrich(checked);
    emitOptions(chapterMax, checked);  // toggle 立即重估(影响 token/成本)
  };

  // 世界书来源切换:勾选 = LLM 抽取(source='llm');取消 = canon 聚合(零 LLM)。
  // 两者都立即重估(needs_llm / token 成本随 source 变化)。
  const onWbLlmToggle = (checked) => {
    setWbLlm(checked);
    // 显式空串：hook 侧是合并语义，{} 会保留上一次的 source。
    if (onOptionsChange) onOptionsChange({ source: checked ? 'llm' : '' });
  };

  // 世界书条目充实:默认跳过高编(editor)条目;勾选后连手编一起覆盖。
  const onWbEnrichEditorToggle = (checked) => {
    setWbEnrichEditor(checked);
    if (onOptionsChange) onOptionsChange({ include_editor: !!checked });
  };

  // 知识库人物:全量 LLM ↔ 仅从章节事实零 LLM 重聚类。
  const onCanonResolveToggle = (checked) => {
    setCanonResolveOnly(checked);
    if (onOptionsChange) onOptionsChange({ source: checked ? 'resolve_only' : '' });
  };

  // 世界观切分:结构先验(零 LLM) ↔ 追加 LLM 窄确认。
  const onWkLlmToggle = (checked) => {
    setWkLlm(checked);
    if (onOptionsChange) onOptionsChange({ use_llm: !!checked });
  };

  // 强制覆盖手编字段（cards/canon/worldbook/anchors 共用）。
  const onForceToggle = (checked) => {
    setForceOverwrite(checked);
    if (onOptionsChange) onOptionsChange({ force_overwrite_manual: !!checked });
  };

  if (!open) return null;

  const ok              = estimate && estimate.ok !== false;
  const tokens          = estimate?.tokens_est ?? estimate?.est_input_tokens;
  const cost            = estimate?.cost_est ?? estimate?.est_usd;
  const approx          = !!estimate?.approximate;  // LLM 路径=粗略估算,标「≈」避免看着像精确值
  const model           = estimate?.model;
  const prereqs         = Array.isArray(estimate?.prereqs) ? estimate.prereqs : [];
  const hasBlockingPrereq = prereqs.some(p => p && p.ok === false);
  const noEmbedKind     = isEmbeddings && embedKinds.length === 0;
  const isZeroLlm       = (tokens === 0 || tokens == null) && (cost === 0 || cost == null);

  const moduleName = t(`modules.${module}.title`, { defaultValue: module });

  return (
    <CSModal
      visible={open}
      onDismiss={onClose}
      header={
        <span style={{ fontFamily: 'var(--font-serif)', fontWeight: 600, letterSpacing: '0.03em' }}>
          {t('modules.estimate.title', { defaultValue: '重做估算' })}
          <span style={{ color: 'var(--accent)', marginLeft: 8 }}>· {moduleName}</span>
        </span>
      }
      footer={
        <CSSpaceBetween direction="horizontal" size="xs">
          <CSButton onClick={onClose} disabled={loading}>
            {t('common.cancel', { defaultValue: '取消' })}
          </CSButton>
          <CSButton
            variant="primary"
            disabled={loading || !ok || hasBlockingPrereq || noEmbedKind}
            onClick={() => onConfirm && onConfirm({ module, scriptId })}
          >
            {isZeroLlm
              ? t('modules.estimate.confirm_zero', { defaultValue: '确认重做（免费）' })
              : t('modules.estimate.confirm_llm',  { defaultValue: '确认重做（消耗 LLM）' })}
          </CSButton>
        </CSSpaceBetween>
      }
    >
      <div className={s.estimateBody}>
        {/* 按类型重嵌:embeddings 的 include 勾选(后端早就支持 body.include,只是 UI 一直没给口子) */}
        {isEmbeddings && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
              {t('modules.embeddings.include_label', { defaultValue: '重嵌哪些类型' })}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
              {EMBED_KINDS.map((kind) => (
                <label key={kind} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={embedKinds.includes(kind)}
                    onChange={(e) => onEmbedKindToggle(kind, e.target.checked)}
                    disabled={loading}
                  />
                  <span>{t(`scripts.editor.embed_kind_${kind}`, { defaultValue: kind })}</span>
                </label>
              ))}
            </div>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)' }}>
              {t('modules.embeddings.include_help', { defaultValue: '重做 = 先把选中类型的向量清空再全部重嵌;未勾选的类型原样保留。零 LLM,只消耗嵌入模型配额。' })}
            </span>
            {noEmbedKind && (
              <span style={{ fontSize: 11, color: 'var(--danger, #b4483c)' }}>
                {t('modules.embeddings.include_empty', { defaultValue: '至少选一个类型。' })}
              </span>
            )}
          </div>
        )}

        {/* 进度感知角色卡:cards 重建选项(重建到第 N 章 + LLM 丰富) */}
        {isCards && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 6 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                {t('modules.cards.chapter_max_label', { defaultValue: '重建到第 N 章' })}
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={chapterMax}
                placeholder={t('modules.cards.chapter_max_placeholder', { defaultValue: '留空 = 全书；填进度章可避免引入未登场角色' })}
                onChange={(e) => onChapterMaxChange(e.target.value)}
                disabled={loading}
                style={{ padding: '6px 10px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 4,
                         fontSize: 13, background: 'var(--bg, #fff)', color: 'var(--text, #222)' }}
              />
              <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)' }}>
                {t('modules.cards.chapter_max_help', { defaultValue: '只回填该章前已登场的角色，并保留每个角色的首次揭示章（防剧透）。' })}
              </span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={llmEnrich}
                onChange={(e) => onLlmToggle(e.target.checked)}
                disabled={loading}
              />
              <span>{t('modules.cards.llm_enrich_label', { defaultValue: 'LLM 丰富重建（消耗你的 API Key，产更丰富的该时期人设）' })}</span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)', marginLeft: 24 }}>
              {t('modules.cards.llm_enrich_help', { defaultValue: '默认零 LLM、免费。勾选后按区间重抽该时期态；无 Key 会自动降级到免费版。' })}
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)', marginLeft: 24 }}>
              {t('modules.cards.auto_protect_help', { defaultValue: '手编字段（identity/别名等）会自动保护；要刷新可点编辑器里的“手编”标签逐字段解锁，或勾选下方「强制覆盖手编字段」。' })}
            </span>
          </div>
        )}

        {/* 知识库人物:全量 LLM 重抽 vs 零 LLM 从章节事实重聚类 */}
        {isCanon && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={canonResolveOnly}
                onChange={(e) => onCanonResolveToggle(e.target.checked)}
                disabled={loading}
              />
              <span>{t('modules.canon.resolve_only_label', { defaultValue: '零 LLM 重新聚类（仅从章节事实重建实体，不调用 LLM）' })}</span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)', marginLeft: 24 }}>
              {canonResolveOnly
                ? t('modules.canon.resolve_only_help_on', { defaultValue: '免费、秒完成；只重组已落库的章节事实，不会发现新实体，也不会刷新实体摘要。' })
                : t('modules.canon.resolve_only_help_off', { defaultValue: '默认走全量 LLM 重抽（消耗 API Key），会重新阅读章节并产出更完整的实体与摘要。' })}
            </span>
          </div>
        )}

        {/* 世界观切分:结构先验(免费) vs 追加 LLM 窄确认 */}
        {isWorldKey && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={wkLlm}
                onChange={(e) => onWkLlmToggle(e.target.checked)}
                disabled={loading}
              />
              <span>{t('modules.world_key.llm_label', { defaultValue: '追加 LLM 窄确认（消耗你的 API Key）' })}</span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)', marginLeft: 24 }}>
              {wkLlm
                ? t('modules.world_key.llm_help_on', { defaultValue: '在结构先验之后，对每个段边界调用一次 LLM 复核；new_world 必须引用摘要原话举证，无证据降级为连续世界。' })
                : t('modules.world_key.llm_help_off', { defaultValue: '默认零 LLM：按卷/章标题结构先验切分多世界，免费；误判留给 LLM 窄确认修正。' })}
            </span>
          </div>
        )}

        {/* 世界书:canon 聚合(默认,零 LLM) vs LLM 抽取(可选) */}
        {isWorldbook && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={wbLlm}
                onChange={(e) => onWbLlmToggle(e.target.checked)}
                disabled={loading}
              />
              <span>{t('modules.worldbook.llm_label', { defaultValue: '用 LLM 抽取世界观条目（消耗你的 API Key）' })}</span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)' }}>
              {wbLlm
                ? t('modules.worldbook.llm_help_on', { defaultValue: '单次 LLM 调用从章节事实提炼设定条目(≤20 条,擅长关系/概念类设定)。与知识库人物聚合出的条目叠加共存,同名时保留先建的一条,不会互相覆盖;你手编的条目永远优先。' })
                : t('modules.worldbook.llm_help_off', { defaultValue: '默认从「知识库人物」聚合常驻设定条目,零 LLM、免费、秒完成;先重做「知识库人物」再点本项可同步最新实体。' })}
            </span>
          </div>
        )}

        {/* 世界书条目充实:默认跳过高编条目;显式勾选才覆盖 */}
        {isWorldbookEnrich && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--border, #d8d2c4)', borderRadius: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={wbEnrichEditor}
                onChange={(e) => onWbEnrichEditorToggle(e.target.checked)}
                disabled={loading}
              />
              <span>{t('modules.worldbook_enrich.include_editor_label', { defaultValue: '连手编条目一起覆盖（include_editor）' })}</span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)', marginLeft: 24 }}>
              {wbEnrichEditor
                ? t('modules.worldbook_enrich.include_editor_help_on', { defaultValue: '已开启：标题命中核心设定词的手编条目也会被 LLM 重写。请确认原措辞不再需要。' })
                : t('modules.worldbook_enrich.include_editor_help_off', { defaultValue: '默认跳过 metadata.source=editor 的手编条目；只有显式勾选才会覆盖。' })}
            </span>
          </div>
        )}

        {/* 强制覆盖手编字段（cards/canon/worldbook/anchors 共用） */}
        {showForce && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14,
                        padding: '12px 14px', border: '1px solid var(--danger, #b4483c)', borderRadius: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={forceOverwrite}
                onChange={(e) => onForceToggle(e.target.checked)}
                disabled={loading}
              />
              <span>{t('modules.force_overwrite_label', { defaultValue: '强制覆盖手编字段（默认关闭）' })}</span>
            </label>
            <span style={{ fontSize: 11, color: 'var(--muted-2, #9a8f78)', marginLeft: 24 }}>
              {t('modules.force_overwrite_help', { defaultValue: '勾选后本次重建会忽略手编保护，用 LLM/派生结果覆盖本次实际写到的字段；未覆盖的行/字段仍保留「手编」标记。建议先导出剧本 pack 备份。' })}
            </span>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className={s.estimateLoading}>
            {t('modules.estimate.loading', { defaultValue: '估算中…' })}
          </div>
        )}

        {/* Error state */}
        {!loading && estimate && estimate.ok === false && (
          <div className={s.estimateErrorBanner}>
            {estimate.error || estimate.note || t('modules.estimate.fail', { defaultValue: '无法估算' })}
          </div>
        )}

        {/* Loaded + ok */}
        {!loading && ok && (
          <>
            {/* KV grid: tokens / model —— 仅 LLM 路径显示;预估成本已按需求移除
                (单位倍数估算对第三方中转价目不可靠,实际用量以任务完成后的真实记账为准) */}
            {!isZeroLlm && (
              <div className={s.estimateKVRow}>
                <div className={s.estimateKVItem}>
                  <span className={s.estimateKVLabel}>
                    {t('modules.estimate.tokens', { defaultValue: 'Tokens' })}
                  </span>
                  <span className={`${s.estimateKVValue} ${isZeroLlm ? s.estimateKVValueFree : ''}`}>
                    {tokens != null ? `${approx ? '≈ ' : ''}${Number(tokens).toLocaleString()}` : '0'}
                  </span>
                </div>
                <div className={s.estimateKVItem}>
                  <span className={s.estimateKVLabel}>
                    {t('modules.estimate.model', { defaultValue: '模型' })}
                  </span>
                  <span className={`${s.estimateKVValue}`} style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {model || '—'}
                  </span>
                </div>
              </div>
            )}

            {/* Prereqs */}
            {prereqs.length > 0 && (
              <div>
                <div className={s.estimateSectionLabel}>
                  {t('modules.estimate.prereqs', { defaultValue: '前置条件' })}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                  {prereqs.map((p, i) => (
                    <div key={i} className={s.estimatePrereqRow}>
                      <span className={p.ok ? s.prereqOk : s.prereqWarn}>
                        {p.ok ? '✓' : '△'}
                      </span>
                      <span>
                        {p.label || p.key}
                        {p.total != null ? ` ${p.count || 0} / ${p.total}` : ''}
                      </span>
                      {p.hint && (
                        <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>{p.hint}</span>
                      )}
                    </div>
                  ))}
                </div>
                {hasBlockingPrereq && (
                  <div className={s.estimateBlockAlert} style={{ marginTop: 8 }}>
                    △ {t('modules.estimate.prereq_block_header', { defaultValue: '前置条件未满足' })}
                    <div style={{ fontWeight: 400, marginTop: 2, fontSize: 11, color: 'var(--muted)' }}>
                      {t('modules.estimate.prereq_block_body', { defaultValue: '请先重做上面缺失的模块。' })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Note */}
            {estimate.note && (
              <div className={s.estimateNote}>{estimate.note}</div>
            )}
          </>
        )}
      </div>
    </CSModal>
  );
}

export default RebuildEstimateModal;
