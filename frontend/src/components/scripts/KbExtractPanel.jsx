/* LLM 知识提取面板 KbExtractPanel(从 ScriptDetail.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useState as useStatePL } from 'react';
import { useTranslation } from 'react-i18next';
import AgentModelPicker from '../AgentModelPicker.jsx';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSFormField from '@cloudscape-design/components/form-field';
import CSInput from '@cloudscape-design/components/input';
import CSAlert from '@cloudscape-design/components/alert';
import CSProgressBar from '@cloudscape-design/components/progress-bar';
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';
import CSColumnLayout from '@cloudscape-design/components/column-layout';
import CSSegmentedControl from '@cloudscape-design/components/segmented-control';
import CSKeyValuePairs from '@cloudscape-design/components/key-value-pairs';

/* ── LLM 知识提取(异步 job + import-jobs SSE) ─────────────────
   后端 POST /scripts/{id}/llm-extract 立即返 job_id,kind='llm_extract',
   复用 streamImport SSE。4 阶段:seed / arc_extract(或 per_chapter)/ resolve / embed。
   完成后剧本 review_status 自动重置为 unreviewed(需复核)。 */
const _EXTRACT_STAGE_LABEL_KEYS = {
  seed: 'scripts.review.stage_seed',
  arc_extract: 'scripts.review.stage_arc_extract',
  per_chapter: 'scripts.review.stage_per_chapter',
  resolve: 'scripts.review.stage_resolve',
  embed: 'scripts.review.stage_embed',
};
function _stageIndicator(status) {
  if (status === 'done') return 'success';
  if (status === 'running') return 'in-progress';
  if (status === 'error' || status === 'failed') return 'error';
  return 'pending';
}

function KbExtractPanel({ script, onDone }) {
  const { t } = useTranslation();
  const sid = script.id;
  // 收敛处置⑥:scope 收窄到唯一值 'full'——worldbook_only/anchors_only/embed_only
  // 与知识库中心的单模块重做(rebuild/{module})完全重复,已删除。本面板只承担
  // "一键全量重新提取"(重跑整套 LLM 抽取流水线)。
  const scope = 'full';
  const [algorithm, setAlgorithm] = useStatePL('arc');
  // Provider/Model 统一由 AgentModelPicker(prefPrefix=extractor)管理:它解析用户
  // 已配凭据 + 偏好后通过 onChange 回传 {api_id, model_real_name},这里只持有回传值
  // 用于拼请求体。与本文件「提取模型」(L3047)同一套实现,不再自造平行选择器。
  const [model, setModel] = useStatePL('');
  const [apiId, setApiId] = useStatePL('');
  const [targetArcs, setTargetArcs] = useStatePL('100');
  const [concurrency, setConcurrency] = useStatePL('15');
  const [authorEra, setAuthorEra] = useStatePL('');
  // 成本硬上限按需求停用(输入框隐藏 + 恒发极大值让后端成本闸永不触发);恢复=取消注释
  // const [maxUsd, setMaxUsd] = useStatePL('10');
  // 章节范围(可空 → 全书);用户想"只重做第 1-50 章"时用
  const [chapterMin, setChapterMin] = useStatePL('');
  const [chapterMax, setChapterMax] = useStatePL('');
  const [estimate, setEstimate] = useStatePL(null);
  // 强制估算 — 这个 hash 记估算时的参数,跟当前参数不一致 → 开始按钮锁死
  const [estimatedHash, setEstimatedHash] = useStatePL('');
  const [estimating, setEstimating] = useStatePL(false);
  const [job, setJob] = useStatePL(null);
  const [phase, setPhase] = useStatePL('config'); // config | running | done | error
  const [err, setErr] = useStatePL('');
  const esRef = React.useRef(null);

  React.useEffect(() => () => { try { esRef.current && esRef.current.close && esRef.current.close(); } catch (_) {} }, []);

  // 切走标签页又切回来时,extract 流被本组件 unmount 切断 — 这里复活:
  // 拉本剧本最近一条 import_job;若 pending/running,直接重新订 SSE,
  // 让用户能继续看进度而不是空表 + 不知道 token 在不在烧。
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.scripts.activeJob(sid);
        if (cancelled || !r || !r.ok || !r.active) return;
        const jb = r.job || {};
        const jid = jb.job_id || jb.id;
        if (!jid) return;
        // 立即把已有快照塞进去,SSE 还在建连接时也能先看到进度
        setJob({ ...jb, job_id: jid });
        startStream(jid);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const cfgBody = () => {
    const body = {
      scope,
      algorithm,
      // model/api_id 来自 AgentModelPicker(extractor 偏好)解析的用户已配凭据;
      // 不再硬编码 deepseek 兜底(那会让没配 deepseek key 的用户提交到无凭据 provider)。
      model: (model || '').trim(),
      api_id: (apiId || '').trim(),
      target_arcs: Number(targetArcs) || 40,
      concurrency: Number(concurrency) || 15,
      author_era: (authorEra || '').trim(),
      // 成本硬上限停用:1e6 = 永不触发后端的 needs_confirm 拦截
      max_book_usd: 1000000,
    };
    const cMin = Number(chapterMin);
    const cMax = Number(chapterMax);
    if (chapterMin && Number.isFinite(cMin)) body.chapter_min = cMin;
    if (chapterMax && Number.isFinite(cMax)) body.chapter_max = cMax;
    return body;
  };

  // 估算参数指纹 — 用来锁定"必须估算才能开始"
  const _paramsHash = () => JSON.stringify(cfgBody());

  const doEstimate = async () => {
    setEstimating(true); setEstimate(null); setErr('');
    try {
      const r = await window.api.scripts.llmExtractEstimate(sid, cfgBody());
      setEstimate(r);
      setEstimatedHash(_paramsHash());
    } catch (e) {
      setErr((e && (e.payload?.error || e.message)) || t('scripts.review.estimate_fail'));
      setEstimatedHash('');
    } finally { setEstimating(false); }
  };

  // 当前参数 vs 估算时参数:不一致(用户改了参数)= stale,需要重新估算
  const _estimateStale = !estimatedHash || estimatedHash !== _paramsHash();
  // scope 恒为 'full',永远走 LLM,必须先估算才能开始。
  const _canStart = !_estimateStale && estimate && estimate.ok !== false;

  const startStream = (jobId) => {
    setPhase('running');
    setJob((j) => j || { kind: 'llm_extract', status: 'running', stages: [], job_id: jobId });
    esRef.current = window.api.scripts.streamImport(jobId, {
      on_message: (jb) => { if (jb && typeof jb === 'object') setJob({ ...jb, job_id: jb.job_id || jb.id || jobId }); },
      on_done: () => {
        setPhase('done');
        window.__apiToast?.(t('scripts.review.extract_done'), { kind: 'ok', detail: t('scripts.review.extract_done_detail'), duration: 3200 });
        try { window.dispatchEvent(new CustomEvent('rpg-scripts-updated')); } catch (_) {}
        onDone && onDone();
      },
      on_error: () => { /* SSE 在 done 后会正常关闭,不当错误处理 */ },
    });
  };

  const doStart = async () => {
    setErr('');
    try {
      const r = await window.api.scripts.llmExtract(sid, { ...cfgBody(), confirmed: true });
      const jid = r && (r.job_id || r.id);
      if (jid) startStream(jid);
      else { setErr((r && r.error) || t('scripts.review.dispatch_fail')); setPhase('error'); }
    } catch (e) {
      const p = (e && e.payload) || {};
      if (p.job_id) { startStream(p.job_id); return; } // 409 复用已在跑的任务
      setErr(p.error || (e && e.message) || t('scripts.review.dispatch_fail'));
      setPhase('error');
    }
  };

  const doCancel = async () => {
    const jid = job && job.job_id;
    if (!jid) return;
    try { await window.api.scripts.jobCancel(jid); window.__apiToast?.(t('scripts.review.cancel_requested'), { kind: 'warn', duration: 2400 }); } catch (_) {}
  };

  const stages = (job && Array.isArray(job.stages)) ? job.stages : [];
  const overall = job ? (job.overall_progress || 0) : 0;
  const overallTotal = job ? (job.overall_total || 4) : 4;
  const usage = job && job.usage_actual;

  return (
    <CSSpaceBetween size="l">
      <CSSpaceBetween direction="horizontal" size="xs">
        {phase === 'config' && (
          <CSButton onClick={doEstimate} loading={estimating} variant={_estimateStale ? 'primary' : 'normal'}>{t('scripts.review.estimate_cost')}</CSButton>
        )}
        {(phase === 'config' || phase === 'error') && (
          <CSButton variant={!_estimateStale ? 'primary' : 'normal'} iconName="gen-ai"
            onClick={doStart} disabled={!_canStart}>
            {t('scripts.review.start_extract')}
          </CSButton>
        )}
        {phase === 'running' && <CSButton onClick={doCancel}>{t('scripts.review.cancel_job')}</CSButton>}
      </CSSpaceBetween>
      {phase === 'config' && _estimateStale && (
        <CSAlert type="info">{t('scripts.review.must_estimate_first')}</CSAlert>
      )}
      {err && <CSAlert type="error">{err}</CSAlert>}

        {(phase === 'config' || phase === 'error') && (
          <CSSpaceBetween size="l">
            <CSBox color="text-body-secondary" fontSize="body-s">
              {t('scripts.review.desc')}
            </CSBox>
            {/* 收敛处置⑥:scope 选择器已删——本面板只剩「全量重新提取」一种模式,
                worldbook_only/anchors_only/embed_only 与知识库中心矩阵卡片完全重复。 */}
            <CSFormField label={t('scripts.review.algorithm')}>
              <CSSegmentedControl selectedId={algorithm}
                options={[{ id: 'arc', text: t('scripts.review.algo_arc') }, { id: 'per_chapter', text: t('scripts.review.algo_per_chapter') }]}
                onChange={({ detail }) => setAlgorithm(detail.selectedId)} />
            </CSFormField>
            <CSColumnLayout columns={2}>
              <CSFormField label={t('scripts.review.chapter_min')}
                description={t('scripts.review.chapter_range_desc')}>
                <CSInput type="number" value={chapterMin}
                  placeholder={t('scripts.review.chapter_min_placeholder')}
                  onChange={({ detail }) => setChapterMin(detail.value)} />
              </CSFormField>
              <CSFormField label={t('scripts.review.chapter_max')}>
                <CSInput type="number" value={chapterMax}
                  placeholder={t('scripts.review.chapter_max_placeholder')}
                  onChange={({ detail }) => setChapterMax(detail.value)} />
              </CSFormField>
            </CSColumnLayout>
            <CSSpaceBetween size="l">
                {/* Provider+Model:全站唯一实现 AgentModelPicker(extractor 偏好)。
                    它只列出用户已配凭据的 provider、给「未配 key」告警、解析后通过
                    onChange 回传 {api_id, model_real_name} 供 cfgBody() 拼请求体;
                    persistOnMount 把解析出的默认写回 extractor.* 偏好,与 L3047
                    导入侧「提取模型」完全同源、同持久化键。 */}
                <AgentModelPicker
                  prefPrefix="extractor"
                  preferProvider="deepseek"
                  defaultModel={null}
                  variant="bare"
                  persistOnMount
                  configHash="settings-models"
                  description={t('scripts.review.model_desc')}
                  onChange={(api_id, model_real_name) => { setApiId(api_id || ''); setModel(model_real_name || ''); }}
                />
                <CSColumnLayout columns={2}>
                  {algorithm === 'arc' && (
                    <CSFormField label={t('scripts.review.target_arcs')} description={t('scripts.review.target_arcs_desc')}><CSInput type="number" value={targetArcs} onChange={({ detail }) => setTargetArcs(detail.value)} /></CSFormField>
                  )}
                  <CSFormField label={t('scripts.review.concurrency')}><CSInput type="number" value={concurrency} onChange={({ detail }) => setConcurrency(detail.value)} /></CSFormField>
                  <CSFormField label={t('scripts.review.author_era')} description={t('scripts.review.author_era_desc')}><CSInput value={authorEra} onChange={({ detail }) => setAuthorEra(detail.value)} /></CSFormField>
                  {/* 成本硬上限输入框按需求隐藏,恢复=取消注释(需同时恢复上方 maxUsd state 并把 body 的 1000000 改回 Number(maxUsd) || 10) */}
                  {/* <CSFormField label={t('scripts.review.max_usd')}><CSInput type="number" value={maxUsd} onChange={({ detail }) => setMaxUsd(detail.value)} /></CSFormField> */}
                </CSColumnLayout>
              </CSSpaceBetween>

            {estimate && estimate.ok !== false && (
              <CSAlert type="info" header={t('scripts.review.cost_estimate')}>
                <CSKeyValuePairs columns={4} items={[
                  // 预估成本按需求隐藏:价目表不含第三方中转模型,金额恒 $0.000 或失真
                  { label: t('scripts.review.arcs'), value: estimate.arcs != null ? String(estimate.arcs) : '—' },
                  { label: t('scripts.review.input_tokens'), value: estimate.est_input_tokens != null ? Number(estimate.est_input_tokens).toLocaleString() : '—' },
                  { label: t('scripts.review.output_tokens'), value: estimate.est_output_tokens != null ? Number(estimate.est_output_tokens).toLocaleString() : '—' },
                ]} />
                {/* note(约 $x(106 弧 × 模型)…校准说明)按需求隐藏,恢复=取消注释 */}
                {/* <CSBox fontSize="body-s" color="text-body-secondary" padding={{ top: 'xs' }}>{estimate.note}</CSBox> */}
              </CSAlert>
            )}
            {estimate && estimate.ok === false && <CSAlert type="warning">{estimate.error || estimate.note || t('scripts.review.cannot_estimate')}</CSAlert>}
          </CSSpaceBetween>
        )}

        {(phase === 'running' || phase === 'done') && (
          <CSSpaceBetween size="m">
            <CSProgressBar value={overallTotal ? Math.round(overall / overallTotal * 100) : 0}
              label={t('scripts.review.overall_progress')} additionalInfo={t('scripts.review.stage_info', { cur: overall, total: overallTotal })}
              status={phase === 'done' ? 'success' : 'in-progress'} />
            <CSSpaceBetween size="xs">
              {stages.map((st) => (
                <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <CSStatusIndicator type={_stageIndicator(st.status)}>
                    {st.label || (_EXTRACT_STAGE_LABEL_KEYS[st.id] ? t(_EXTRACT_STAGE_LABEL_KEYS[st.id]) : st.id)}
                  </CSStatusIndicator>
                  {st.stage_total ? <CSBox fontSize="body-s" color="text-body-secondary">{st.stage_progress || 0} / {st.stage_total}</CSBox> : null}
                </div>
              ))}
              {stages.length === 0 && <CSBox color="text-body-secondary" fontSize="body-s">{t('scripts.review.dispatching')}</CSBox>}
            </CSSpaceBetween>
            {job && job.budget_estimate && job.budget_estimate.arcs ? (
              <CSBox fontSize="body-s" color="text-body-secondary">{t('scripts.review.split_arcs', { n: job.budget_estimate.arcs })}</CSBox>
            ) : null}
            {/* 用量/花费(花费/tokens/调用次数)按需求隐藏,恢复=取消注释。
                数据仍在后端记账(token_usage),只是不再展示。 */}
            {/* {usage && (
              <CSAlert type={phase === 'done' ? 'success' : 'info'} header={t('scripts.review.usage')}>
                <CSKeyValuePairs columns={4} items={[
                  { label: t('scripts.review.spent'), value: usage.usd != null ? `$${Number(usage.usd).toFixed(3)}` : '—' },
                  { label: t('scripts.review.input_tokens'), value: usage.input_tokens != null ? Number(usage.input_tokens).toLocaleString() : '—' },
                  { label: t('scripts.review.output_tokens'), value: usage.output_tokens != null ? Number(usage.output_tokens).toLocaleString() : '—' },
                  { label: t('scripts.review.llm_calls'), value: usage.llm_calls != null ? String(usage.llm_calls) : '—' },
                ]} />
              </CSAlert>
            )} */}
            {phase === 'done' && <CSAlert type="success">{t('scripts.review.extract_complete')}</CSAlert>}
          </CSSpaceBetween>
        )}
      </CSSpaceBetween>
  );
}

export { KbExtractPanel };
