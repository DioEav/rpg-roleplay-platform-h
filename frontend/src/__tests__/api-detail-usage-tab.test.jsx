/**
 * api-detail-usage-tab.test.jsx — 设置页「API 用量」页签必须显示本供应商的用量。
 *
 * 用户上报:「API 设置界面里面的 API 用量没有显示内容,明明在用量页有数据的」。
 * 根因是**取错了端点的返回形状**:本页签调的是用户级 `GET /api/me/usage`,它返回
 * totals / by_model / by_scenario / recent_turns —— 没有按供应商的汇总;而这里写成
 * `(r.by_api || r.apis).find(...)`,那是**管理员**端点 `GET /api/admin/usage` 的形状
 * (by_api 行的字段名 requests/input_tokens/output_tokens/cost_usd 与面板期望逐字一致)。
 * 用户端点上 by_api 恒 undefined → find 落空 → setUsage({}) → 四项全渲染成「—」。
 *
 * 不变量(本文件锁死):
 *   · 数字来自 by_model 按 api_id 的汇总,且**只统计本供应商**(别的供应商不许混进来);
 *   · 键要归一 —— token_usage.api_id 存历史别名(AgentPlatform / AlibabaQwen …),
 *     而面板的 api.id 是 catalog canonical(vertex_ai),不归一历史行对不上。
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApiDetailPanel } from '../components/settings/model-list.jsx';

const VERTEX_API = {
  id: 'vertex_ai',            // catalog canonical;用量行里存的是别名 AgentPlatform
  name: 'Agent Platform',
  base_url: '', key_hint: '·sa-json', key_set: true, enabled: true,
  auth_mode: 'api_key', proxy: 'direct', proxy_url: '', models: [],
};

// 后端 /api/me/usage 的真实形状:只有 by_model,没有 by_api
const USAGE_RESPONSE = {
  ok: true,
  window_days: 30,
  totals: { input_tokens: 0, output_tokens: 0, cost_usd: 0, turns: 0 },
  by_model: [
    { api_id: 'AgentPlatform', model: 'gemini-2.5-flash', input_tokens: 1234, output_tokens: 567, cost_usd: 0.5, turns: 13 },
    { api_id: 'AgentPlatform', model: 'gemini-3.8-flash', input_tokens: 456, output_tokens: 89, cost_usd: 0.25, turns: 7 },
    // 别的供应商,绝不能计进本面板
    { api_id: 'deepseek', model: 'deepseek-v4-pro', input_tokens: 99999, output_tokens: 99999, cost_usd: 99, turns: 99 },
  ],
  by_scenario: [],
  recent_turns: [],
};

const num = (n) => Number(n).toLocaleString();

describe('ApiDetailPanel — API 用量页签', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.api = undefined;
    window.__apiToast = vi.fn();
  });

  it('按 api_id 汇总 by_model,并只统计本供应商(含历史别名归一)', async () => {
    window.api = { account: { usage: vi.fn().mockResolvedValue(USAGE_RESPONSE) } };
    render(<ApiDetailPanel api={VERTEX_API} onEdit={() => {}} onVisibility={() => {}} onValidate={() => {}} onDeleteKey={() => {}} onToggleModel={() => {}} onRenameModel={() => {}} onAddModel={() => {}} />);

    fireEvent.click(screen.getByText('API 用量'));

    // AgentPlatform(别名)两行的合计,deepseek 那行不算
    await waitFor(() => expect(screen.getByText(num(20))).toBeTruthy());     // 请求数 13+7
    expect(screen.getByText(num(1690))).toBeTruthy();                       // 输入 1234+456
    expect(screen.getByText(num(656))).toBeTruthy();                        // 输出 567+89
    expect(screen.getByText('$0.75')).toBeTruthy();                         // 成本 0.5+0.25

    // 别的供应商的用量不许混进来
    expect(screen.queryByText(num(99999))).toBeNull();
    expect(screen.queryByText('$99.00')).toBeNull();
  });
});
