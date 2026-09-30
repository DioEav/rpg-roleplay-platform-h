/**
 * rebuild-estimate-worldbook-llm.test.jsx — 世界书重建「可选 LLM」回归测试。
 *
 * 背景:世界书卡片标着「可选 LLM」,但估算弹窗从未给出口子 —— 点重做永远发空参数,
 * 后端按默认走 canon 聚合(零 LLM),用户看不到任何选择(群反馈)。现在弹窗加勾选:
 * 勾上 → options {source:'llm'} → 估算显示 token/成本 → 确认后走 LLM 抽取。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RebuildEstimateModal } from '../components/RebuildEstimateModal.jsx';

const OK_ZERO = { ok: true, tokens_est: 0, cost_est: 0, affects: ['worldbook_entries'], prereqs: [] };
const OK_LLM = { ok: true, tokens_est: 45000, cost_est: 0.02, approximate: true, model: 'mimo-v2.6-flash', affects: ['worldbook_entries'], prereqs: [] };

function renderModal(props) {
  return render(
    <RebuildEstimateModal
      open
      module="worldbook"
      scriptId={1}
      estimate={OK_ZERO}
      loading={false}
      options={null}
      onOptionsChange={() => {}}
      onClose={() => {}}
      onConfirm={() => {}}
      {...props}
    />,
  );
}

describe('RebuildEstimateModal 世界书 LLM 选项', () => {
  it('默认未勾选,显示 canon(零 LLM)帮助文案', () => {
    renderModal();
    const box = screen.getByRole('checkbox');
    expect(box.checked).toBe(false);
    expect(screen.getByText(/知识库人物/)).toBeTruthy();
  });

  it('勾选 → onOptionsChange({source:"llm"}) 并切换帮助文案', () => {
    const onOptionsChange = vi.fn();
    renderModal({ onOptionsChange });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onOptionsChange).toHaveBeenCalledWith({ source: 'llm' });
  });

  it('再次取消 → onOptionsChange({}) 回到 canon 路径', () => {
    const onOptionsChange = vi.fn();
    renderModal({ onOptionsChange, options: { source: 'llm' }, estimate: OK_LLM });
    const box = screen.getByRole('checkbox');
    expect(box.checked).toBe(true); // 打开时按 options 回显
    fireEvent.click(box);
    expect(onOptionsChange).toHaveBeenCalledWith({});
  });

  it('打开时 options.source=llm → 勾选态回显正确', () => {
    renderModal({ options: { source: 'llm' }, estimate: OK_LLM });
    expect(screen.getByRole('checkbox').checked).toBe(true);
  });
});
