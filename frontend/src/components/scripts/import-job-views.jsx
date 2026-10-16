/* 导入任务横幅 / 结果 / 预算视图。
   从 ScriptsImport.jsx 二次拆出(纯机械搬家,JSX 逐字节不变、零行为变化)。 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { plNavigate } from '../../router.js';
import { fmtN } from '../../platform-app.jsx';
import { SPLIT_RULES, IMPORT_JOB_TERMINAL_STATUSES } from './shared.js';
import CSHeader from '@cloudscape-design/components/header';
import CSTable from '@cloudscape-design/components/table';
import CSContainer from '@cloudscape-design/components/container';
import CSSpaceBetween from '@cloudscape-design/components/space-between';
import CSButton from '@cloudscape-design/components/button';
import CSBox from '@cloudscape-design/components/box';
import CSStatusIndicator from '@cloudscape-design/components/status-indicator';
import CSKeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import CSAlert from '@cloudscape-design/components/alert';
import CSProgressBar from '@cloudscape-design/components/progress-bar';

// ImportJobBanner 现在是 SSE 真值 view:
//  - 接 job (含 id) + 回调 onUpdate / onDone / onError / onCancel
//  - 进 mount 后立即对 job.id 订 /api/scripts/import-jobs/{id}/stream
//  - 每帧把 SSE 推上来的 job 对象交给 onUpdate(jb) 由 wizard merge 进 state
//  - 结束 (done event) 时调 onDone 让 wizard 发 toast
//  - 进度条 / stage 状态 / tokens 全部直接 read 自 props.job (wizard 已 merge)
//  - 绝不在前端推断 status / progress / tokens_used — SSE 没推就显示 pending
function ImportJobBanner({ job, onCancel, onUpdate, onDone, onError }) {
  const { t } = useTranslation();
  const esRef = React.useRef(null);
  const pollRef = React.useRef(null);
  const jobId = job && job.id;
  const dispatchFailed = !!(job && job.dispatch_failed);

  React.useEffect(() => {
    // dispatch 失败的"假 job" — 没有真 job_id,不订 SSE
    if (!jobId || dispatchFailed) return undefined;
    if (typeof jobId === 'string' && jobId.startsWith('imp_dispatch_failed_')) return undefined;
    let stopped = false;
    const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    const startPoll = () => {
      // SSE 断开降级:2s 轮询 jobStatus,stages 字段仍取后端真值,绝不强翻 done
      if (pollRef.current) return;
      const tick = async () => {
        if (stopped) return;
        try {
          const resp = await window.api.scripts.jobStatus(jobId);
          if (stopped) return;
          const jb = resp && (resp.job || resp);
          if (jb && jb.status) {
            if (onUpdate) onUpdate(jb);
            if (IMPORT_JOB_TERMINAL_STATUSES.has(jb.status)) {
              stopPoll();
              if (onDone) onDone();
            }
          }
        } catch (_) { /* 单次失败不影响下次 */ }
      };
      tick();
      pollRef.current = setInterval(tick, 2000);
    };
    try {
      esRef.current = window.api.scripts.streamImport(jobId, {
        on_message: (jb) => { if (onUpdate) onUpdate(jb); },
        on_update: (jb) => { if (onUpdate) onUpdate(jb); },
        on_done: () => { stopPoll(); if (onDone) onDone(); },
        on_error: (err) => {
          if (onError) onError(err);
          startPoll();
        },
      });
    } catch (e) {
      if (onError) onError(e);
      startPoll();
    }
    return () => {
      stopped = true;
      stopPoll();
      try { esRef.current && esRef.current.close && esRef.current.close(); } catch (_) {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const stages = Array.isArray(job.stages) ? job.stages : [];
  // 进度条 100% 由后端 overall_progress / overall_total 推。前端不算 derived 假值。
  const overallProgress = Number(job.overall_progress || 0);
  const overallTotal = Math.max(1, Number(job.overall_total || stages.length || 1));
  const overallPct = Math.min(100, Math.max(0, Math.round((overallProgress / overallTotal) * 100)));
  const elapsed = job.started_at ? Math.round((Date.now() - job.started_at) / 1000) : 0;
  const currentStage = job.stage || null;
  const stageProgress = Number(job.stage_progress || 0);
  const stageTotal = Number(job.stage_total || 0);
  const usage = job.usage_actual || null;

  // task #65: 排队中状态分支
  const isQueued = job.status === 'queued';
  const queuePos = isQueued && job.queue_position != null ? Number(job.queue_position) : 0;
  const queueEta = Math.max(1, queuePos) * 8; // 8 分钟/任务保守估算

  return (
    <CSContainer
      header={
        <CSHeader
          variant="h2"
          description={isQueued
            ? t('scripts.import.queued_desc', { n: queuePos, eta: queueEta })
            : t('scripts.import.banner_desc', { id: jobId, elapsed })}
          actions={<CSButton iconName="close" onClick={onCancel}>{t('scripts.import.cancel_import')}</CSButton>}
        >
          <CSStatusIndicator type={isQueued ? 'pending' : 'in-progress'}>
            {isQueued ? t('scripts.import.queued') : t('scripts.import.importing')} · {job.title}
          </CSStatusIndicator>
        </CSHeader>
      }
    >
      <CSSpaceBetween size="m">
        {isQueued ? (
          /* task #65: 排队中 — 灰色脉冲条 + 队列信息;阶段灯暗 */
          <div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              {t('scripts.import.overall_progress')}
            </div>
            <div className="pl-import-progress-bar" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div
                className="pl-import-progress-fill"
                style={{
                  width: '100%',
                  background: 'rgba(180,180,180,0.25)',
                  animation: 'pulse 1.8s ease-in-out infinite',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted-2)', marginTop: 5 }}>
              {t('scripts.import.queued_desc', { n: queuePos, eta: queueEta })}
            </div>
          </div>
        ) : (
          <CSProgressBar
            value={overallPct}
            label={t('scripts.import.overall_progress')}
            additionalInfo={currentStage ? `${currentStage}${stageTotal ? ` ${stageProgress}/${stageTotal}` : ''}` : ''}
            status="in-progress"
          />
        )}
        {/* task #65: 排队中时不展示阶段灯,等 running 后才亮 */}
        {!isQueued && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {stages.map((s, i) => {
              // 严格 SSE 真值:status 必须是 'done'/'running'/'error'/'failed' 之一,
              // 任何其他值/缺失一律视作 pending,绝不强转 done。
              let type = 'pending';
              if (s.status === 'done') type = 'success';
              else if (s.status === 'running') type = 'in-progress';
              else if (s.status === 'error' || s.status === 'failed') type = 'error';
              // 进度文案完全由后端字段决定:有 count 显示 count,有 stage_progress 显示 x/y,
              // 否则保持空 — 不再 Math.round(progress*100) 假装百分比
              let meta = '';
              if (typeof s.count === 'number') meta = `${fmtN(s.count)}`;
              else if (typeof s.tokens_used === 'number') meta = `${fmtN(s.tokens_used)} tok`;
              else if (s.status === 'running' && s.id === currentStage && stageTotal) meta = `${stageProgress}/${stageTotal}`;
              const errDetail = (s.status === 'error' || s.status === 'failed') ? (s.error || '') : '';
              return (
                <div key={s.id || i}>
                  <CSStatusIndicator type={type}>{String(i + 1).padStart(2, '0')} · {s.label || s.id}</CSStatusIndicator>
                  <CSBox fontSize="body-s" color={errDetail ? 'text-status-error' : 'text-body-secondary'}>
                    {errDetail || `${s.hint || ''}${meta ? ' · ' + meta : ''}`}
                  </CSBox>
                </div>
              );
            })}
          </div>
        )}
        {usage && (
          <CSBox fontSize="body-s" color="text-body-secondary">
            {usage.usd != null ? `$${Number(usage.usd).toFixed(3)}` : ''}
            {usage.input_tokens != null ? ` · in ${Number(usage.input_tokens).toLocaleString()}` : ''}
            {usage.output_tokens != null ? ` · out ${Number(usage.output_tokens).toLocaleString()}` : ''}
            {usage.llm_calls != null ? ` · ${usage.llm_calls} calls` : ''}
            {usage.live ? ' · live' : ''}
          </CSBox>
        )}
      </CSSpaceBetween>
    </CSContainer>
  );
}

function ImportJobResult({ job, onDismiss, onReuse }) {
  const { t } = useTranslation();
  const ok = job.status === "done";
  const cancelled = job.status === "cancelled";
  const failed = job.status === "failed" || job.dispatch_failed;
  const partial = job.status === "partial" || job.status === "done_with_errors";
  const stages = Array.isArray(job.stages) ? job.stages : [];
  // 失败 stage 明细 — 给用户看清楚是哪一步崩
  const errored = stages.filter(s => s && (s.status === 'error' || s.status === 'failed'));
  // 真实 token 数:优先用 usage_actual (后端官方账),否则降级到 stages 累加
  const usage = job.usage_actual || {};
  const totalTokens = usage.input_tokens != null
    ? (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))
    : stages.reduce((a, s) => a + (Number(s.tokens_used) || 0), 0);
  const type = ok ? 'success' : failed ? 'error' : partial ? 'warning' : 'warning';
  const headerKey = ok ? 'scripts.import.result_done'
    : failed ? 'scripts.toast.import_fail'
    : partial ? 'scripts.toast.import_partial'
    : 'scripts.import.result_cancelled';
  return (
    <CSAlert
      type={type}
      dismissible
      onDismiss={onDismiss}
      header={`${t(headerKey)} · ${job.title || ''}`}
      action={
        <CSSpaceBetween direction="horizontal" size="xs">
          {ok && <CSButton variant="primary" onClick={() => { onDismiss && onDismiss(); plNavigate('scripts'); }}>{t('scripts.import.go_manage')}</CSButton>}
          <CSButton onClick={onReuse}>{ok ? t('scripts.import.import_another') : t('scripts.import.retry')}</CSButton>
        </CSSpaceBetween>
      }
    >
      {ok && t('scripts.import.tok_consumed', { n: fmtN(totalTokens) })}
      {cancelled && t('scripts.import.result_cancelled_detail', { id: job.id })}
      {(failed || partial) && (
        <CSSpaceBetween size="xxs">
          <CSBox>{job.error || (errored.length ? `${errored.length} stage(s) failed` : `job ${job.id}`)}</CSBox>
          {errored.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {errored.map((s, i) => (
                <li key={i}>{(s.id || s.label || '?')}: {s.error || t('scripts.toast.unknown_error')}</li>
              ))}
            </ul>
          )}
        </CSSpaceBetween>
      )}
    </CSAlert>
  );
}

function ImportEstimateView({ estimate, rule, onCancel, onConfirm, hideActions = false }) {
  const { t } = useTranslation();
  const ruleEntry = SPLIT_RULES.find(r => r.id === rule);
  const ruleLabel = ruleEntry ? t(ruleEntry.labelKey) : rule;
  return (
    <CSContainer
      header={
        <CSHeader
          variant="h2"
          description={t('scripts.import.estimate_desc', { file: estimate.file.name, rule: ruleLabel, model: estimate.model })}
          actions={hideActions ? undefined : (
            <CSSpaceBetween direction="horizontal" size="xs">
              <CSButton onClick={onCancel}>{t('common.cancel')}</CSButton>
              <CSButton variant="primary" iconName="check" onClick={onConfirm}>{t('scripts.import.confirm_import_bg')}</CSButton>
            </CSSpaceBetween>
          )}
        >{t('scripts.import.estimate_title')}</CSHeader>
      }
    >
      <CSSpaceBetween size="l">
        {/* est_cost 金额行(2026-10-16)与 est_time 预计耗时行(2026-10-17)已移除:
            金额=固定 $0.75/M 单价失真;耗时=tokens/800 固定吞吐假设,均无实测标定,展示误导。
            token 行是真实标定系数的外推,保留。与 ScriptsImport 导入页同步。 */}
        <CSKeyValuePairs columns={5} items={[
          { label: t('scripts.my.chapters'), value: String(estimate.chapters) },
          { label: t('scripts.my.words'), value: `${(estimate.words / 10000).toFixed(1)} ${t('scripts.my.wan')}` },
          { label: t('scripts.import.est_tokens'), value: fmtN(estimate.totalTokens) },
        ]} />
        <CSTable
          variant="embedded"
          items={estimate.stages}
          trackBy="id"
          columnDefinitions={[
            { id: 'n', header: '#', cell: (s) => estimate.stages.indexOf(s) + 1, width: 50 },
            { id: 'label', header: t('scripts.import.stage_col'), cell: (s) => <CSBox fontWeight="bold">{s.label}</CSBox> },
            { id: 'hint', header: t('scripts.import.hint_col'), cell: (s) => s.hint },
            { id: 'tok', header: t('scripts.import.est_tokens'), cell: (s) => fmtN(s.tokens_est) },
          ]}
        />
        {estimate.warnings?.length > 0 && (
          <CSAlert type="warning" header={t('scripts.import.warnings_header')}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {estimate.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </CSAlert>
        )}
      </CSSpaceBetween>
    </CSContainer>
  );
}

export { ImportJobBanner, ImportJobResult, ImportEstimateView };
