/* MobileMe · VIEW 用量统计 Usage —— 从 pages/MobileMe.jsx 拆出,逐字节不变。 */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { fmtN } from './helpers.js';
import { PageHead } from './shared.jsx';

/* ═══════════════════════════════════════════════════════════════════
   VIEW: 用量统计 Usage
   ═══════════════════════════════════════════════════════════════════ */
const USAGE_RANGES = [
  { id: '7d', labelKey: 'mobile.me.usage.range_7d', days: 7 },
  { id: '30d', labelKey: 'mobile.me.usage.range_30d', days: 30 },
  { id: '90d', labelKey: 'mobile.me.usage.range_90d', days: 90 },
];

function BarChart({ buckets, valueKey, color, height = 60 }) {
  if (!buckets || buckets.length === 0) return null;
  const vals = buckets.map(b => Number(b[valueKey] || 0));
  const maxV = Math.max(...vals, 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height, padding: '0 2px' }}>
      {vals.map((v, i) => (
        <div key={i} title={`${buckets[i]?.date || i}: ${fmtN(v)}`} style={{
          flex: 1, minWidth: 2, borderRadius: '2px 2px 0 0',
          height: Math.max(2, Math.round((v / maxV) * height)),
          background: color || 'var(--accent)',
          opacity: 0.8,
        }} />
      ))}
    </div>
  );
}

function ViewUsage({ nav }) {
  const { t } = useTranslation();
  const [range, setRange] = useState('30d');
  const [data, setData] = useState(null);
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const days = USAGE_RANGES.find(r => r.id === range)?.days || 30;

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr('');
    (async () => {
      try {
        const [u, t] = await Promise.all([
          window.api.account.usage(days),
          window.api.account.usageTimeline(days, 'day'),
        ]);
        if (!cancelled) { setData(u || null); setSeries(t || null); }
      } catch (e) {
        if (!cancelled) setErr(e?.message || t('mobile.me.usage.load_error'));
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [days]);

  const totals = data?.totals || {};
  const byModel = data?.by_model || [];
  const forecast = data?.forecast || null;
  const buckets = series?.series || [];
  // 「消费预测」「按场景拆分」已隐藏(2026-10):恢复 = 改回 true。(与桌面 UsagePage 同款开关)
  const SHOW_USAGE_FORECAST_SCENARIO = false;
  // 成本相关金额显示(总成本卡/缓存节省/趋势成本曲线/模型行内金额)已隐藏(2026-10)。
  const SHOW_USAGE_COST = false;
  // 后端 by_scenario 是数组([{scenario,...}]),按 dict 消费会让卡片标签显示下标 "0/1/2"。
  // 归一成 {scenario: row} 字典,兼容旧 dict 形态(与桌面 UsagePage 同款修复)。
  const byScenarioRaw = data?.by_scenario || null;
  const byScenario = Array.isArray(byScenarioRaw)
    ? byScenarioRaw.reduce((acc, it) => { if (it && it.scenario) acc[it.scenario] = it; return acc; }, {})
    : byScenarioRaw;

  const totalTurns = Number(totals.turns || 0);
  const totalTokIn = Number(totals.input_tokens || 0);
  const totalTokOut = Number(totals.output_tokens || 0);
  const totalCost = Number(totals.cost_usd || 0);
  const totalCachedIn = Number(totals.cached_input_tokens || 0);

  const SCENARIO_META = {
    chat: { l: t('mobile.me.usage.scenario_chat'), ic: 'feedback' },
    opening: { l: t('mobile.me.usage.scenario_opening'), ic: 'play' },
    extract: { l: t('mobile.me.usage.scenario_extract'), ic: 'search' },
    embedding: { l: t('mobile.me.usage.scenario_embedding'), ic: 'layers' },
    assistant: { l: t('mobile.me.usage.scenario_assistant'), ic: 'sparkle' },
    tool: { l: t('mobile.me.usage.scenario_tool'), ic: 'plug' },
  };

  return (
    <>
      <PageHead
        title={t('mobile.me.usage.title')}
        onBack={() => nav.go('me')}
        actions={
          <button className="pl-headbtn" onClick={() => setRange(r => { const idx = USAGE_RANGES.findIndex(x => x.id === r); return USAGE_RANGES[(idx + 1) % USAGE_RANGES.length].id; })} aria-label={t('mobile.me.usage.range_toggle')}>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{t(USAGE_RANGES.find(r2 => r2.id === range)?.labelKey || '')}</span>
          </button>
        }
      />
      <div className="pl-body tabbed">
        <div className="pl-pad">

          {/* 时间范围选择 */}
          <div style={{ display: 'flex', gap: 7, marginBottom: 14 }}>
            {USAGE_RANGES.map(r => (
              <button key={r.id} onClick={() => setRange(r.id)} style={{
                flex: 1, height: 34, borderRadius: 999, fontSize: 12.5, fontWeight: 500,
                background: range === r.id ? 'var(--accent-soft)' : 'var(--panel-2)',
                color: range === r.id ? 'var(--accent)' : 'var(--muted)',
                border: '1px solid ' + (range === r.id ? 'var(--accent-edge)' : 'var(--line-soft)'),
              }}>{t(r.labelKey)}</button>
            ))}
          </div>

          {err && (
            <div className="pl-row" style={{ margin: '0 0 14px', background: 'var(--danger-soft)', borderRadius: 10 }}>
              <span className="pl-row-ic warn"><Icon name="warn" size={16} /></span>
              <span className="pl-row-tx"><strong>{err}</strong></span>
            </div>
          )}

          {loading && !data && <div className="pl-empty">{t('common.loading')}</div>}

          {/* 核心统计 */}
          <div className="pl-stats" style={{ marginBottom: 14 }}>
            <div className="pl-stat">
              <span className="n accent">{fmtN(totalTurns)}</span>
              <div className="l">{t('mobile.me.usage.requests')}{totalTurns ? <span style={{ display: 'block', fontSize: 9 }}>{t('mobile.me.usage.daily_avg', { n: Math.round(totalTurns/days) })}</span> : ''}</div>
            </div>
            <div className="pl-stat">
              <span className="n">{fmtN(totalTokIn)}</span>
              <div className="l">{t('mobile.me.usage.input_tokens')}</div>
            </div>
            <div className="pl-stat">
              <span className="n">{fmtN(totalTokOut)}</span>
              <div className="l">{t('mobile.me.usage.output_tokens')}</div>
            </div>
            {/* 总成本卡已隐藏(2026-10):SHOW_USAGE_COST 开关控制 */}
            {SHOW_USAGE_COST && <div className="pl-stat">
              <span className="n">${totalCost.toFixed(2)}</span>
              <div className="l">{t('mobile.me.usage.cost')}</div>
            </div>}
          </div>
          <div className="pl-stats" style={{ marginBottom: 16 }}>
            <div className="pl-stat">
              <span className="n">{totalCachedIn ? fmtN(totalCachedIn) : '—'}</span>
              <div className="l">{t('mobile.me.usage.cached_input')}{totalTokIn > 0 && totalCachedIn ? <span style={{ display: 'block', fontSize: 9 }}>{Math.round(totalCachedIn/totalTokIn*100)}%</span> : ''}</div>
            </div>
            {/* 缓存节省(金额)已隐藏(2026-10):SHOW_USAGE_COST 开关控制 */}
            {SHOW_USAGE_COST && <div className="pl-stat">
              <span className="n">
                {totalCachedIn > 0 && totalTokIn > 0 ? '$' + ((totalCachedIn / totalTokIn) * totalCost * 0.75).toFixed(3) : '—'}
              </span>
              <div className="l">{t('mobile.me.usage.cache_savings')}</div>
            </div>}
            {/* 消费预测两格已隐藏(2026-10):SHOW_USAGE_FORECAST_SCENARIO 开关控制 */}
            {SHOW_USAGE_FORECAST_SCENARIO && forecast && <div className="pl-stat">
              <span className="n">${Number(forecast.avg_daily_cost_usd || 0).toFixed(3)}</span>
              <div className="l">{t('mobile.me.usage.daily_cost')}</div>
            </div>}
            {SHOW_USAGE_FORECAST_SCENARIO && forecast && <div className="pl-stat">
              <span className="n">${Number(forecast.projected_30d_cost || 0).toFixed(2)}</span>
              <div className="l">{t('mobile.me.usage.forecast_30d')}</div>
            </div>}
          </div>

          {/* 趋势图 */}
          {buckets.length > 0 && (
            <div className="pl-sec">
              <div className="pl-sec-head"><h2>{t('mobile.me.usage.trend')}</h2></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>{t('mobile.me.usage.requests')} <span className="mono" style={{ float: 'right' }}>{fmtN(buckets.reduce((a, b) => a + Number(b.turns || 0), 0))}</span></div>
                  <BarChart buckets={buckets} valueKey="turns" color="var(--accent)" />
                </div>
                {/* 成本曲线已隐藏(2026-10):SHOW_USAGE_COST 开关控制 */}
                {SHOW_USAGE_COST && <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>{t('mobile.me.usage.cost')} $<span className="mono" style={{ float: 'right' }}>{buckets.reduce((a, b) => a + Number(b.cost_usd || 0), 0).toFixed(2)}</span></div>
                  <BarChart buckets={buckets} valueKey="cost_usd" color="var(--ok)" />
                </div>}
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>{t('mobile.me.usage.input_tokens')} <span className="mono" style={{ float: 'right' }}>{fmtN(buckets.reduce((a, b) => a + Number(b.input_tokens || 0), 0))}</span></div>
                  <BarChart buckets={buckets} valueKey="input_tokens" color="var(--info)" />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 5 }}>{t('mobile.me.usage.output_tokens')} <span className="mono" style={{ float: 'right' }}>{fmtN(buckets.reduce((a, b) => a + Number(b.output_tokens || 0), 0))}</span></div>
                  <BarChart buckets={buckets} valueKey="output_tokens" color="var(--warn)" />
                </div>
              </div>
            </div>
          )}

          {/* 按场景拆分(已隐藏,2026-10):SHOW_USAGE_FORECAST_SCENARIO 开关控制 */}
          {SHOW_USAGE_FORECAST_SCENARIO && byScenario && Object.keys(byScenario).length > 0 && (
            <div className="pl-sec">
              <div className="pl-sec-head"><h2>{t('mobile.me.usage.by_scenario')}</h2></div>
              {(() => {
                const keys = Object.keys(byScenario);
                const totalSc = keys.reduce((s, k) => s + Number(byScenario[k]?.turns || 0), 0) || 1;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {keys.map(k => {
                      const meta = SCENARIO_META[k] || { l: k, ic: 'chart' };
                      const sc = byScenario[k] || {};
                      const turns = Number(sc.turns || 0);
                      const cost = Number(sc.cost_usd || 0);
                      const pct = Math.round(turns / totalSc * 100);
                      return (
                        <div key={k} style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--line-soft)' }}>
                          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{meta.l}</div>
                          <div className="mono" style={{ fontSize: 17, fontWeight: 700 }}>{fmtN(turns)}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>${cost.toFixed(3)}</div>
                          <div style={{ marginTop: 6, height: 3, borderRadius: 999, background: 'var(--panel-3)', overflow: 'hidden' }}>
                            <div style={{ width: pct + '%', height: '100%', background: 'var(--accent)', borderRadius: 999 }} />
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--muted-2)', marginTop: 2 }}>{pct}%</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* 按模型拆分 */}
          {byModel.length > 0 && (
            <div className="pl-sec">
              <div className="pl-sec-head"><h2>{t('mobile.me.usage.by_model')}</h2></div>
              {byModel.map((m, i) => (
                <div key={i} className="pl-row" style={{ margin: '0 0 5px', pointerEvents: 'none' }}>
                  <span className="pl-row-ic info"><Icon name="sparkle" size={15} /></span>
                  <span className="pl-row-tx">
                    <strong className="mono" style={{ fontSize: 12 }}>{m.model_id || m.api_id || '—'}</strong>
                    <span className="mono" style={{ fontSize: 11 }}>
                      {fmtN(Number(m.turns || 0))} {t('m_me_extra.usage_times_unit')} · {fmtN(Number(m.input_tokens || 0))}↑ {fmtN(Number(m.output_tokens || 0))}↓{SHOW_USAGE_COST ? ` · $${Number(m.cost_usd || 0).toFixed(3)}` : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export { ViewUsage };
