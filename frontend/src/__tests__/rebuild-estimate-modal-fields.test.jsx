/**
 * rebuild-estimate-modal-fields.test.jsx — 重做估算弹窗的信息密度规则。
 *
 * 群反馈:零 LLM 重做(免费)弹窗里显示 Tokens/预估成本/模型全是 0/—,没有信息量;
 * 「影响的表」(worldbook_entries 等)对用户是天书,所有弹窗都不该显示。
 * 规则:① 零 LLM(estimate 全 0)→ 隐藏 Tokens/预估成本/模型 KV 行;
 *      ② 任何弹窗不渲染「影响的表」区块。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RebuildEstimateModal } from '../components/RebuildEstimateModal.jsx';

const ZERO = { ok: true, tokens_est: 0, cost_est: 0, affects: ['document_chunks'], prereqs: [] };
const LLM = { ok: true, tokens_est: 45000, cost_est: 0.02, approximate: true, model: 'mimo-v2.6-flash', affects: ['kb_canon_entities'], prereqs: [] };

function renderModal(estimate, module = 'canon') {
  return render(
    <RebuildEstimateModal
      open
      module={module}
      scriptId={1}
      estimate={estimate}
      loading={false}
      options={null}
      onOptionsChange={() => {}}
      onClose={() => {}}
      onConfirm={() => {}}
    />,
  );
}

describe('RebuildEstimateModal 信息密度', () => {
  it('零 LLM:不显示 Tokens/预估成本/模型,不显示影响的表', () => {
    renderModal(ZERO, 'chunks');
    expect(screen.queryByText('Tokens')).toBeNull();
    expect(screen.queryByText('预估成本')).toBeNull();
    expect(screen.queryByText('模型')).toBeNull();
    expect(screen.queryByText('影响的表')).toBeNull();
    expect(screen.queryByText('document_chunks')).toBeNull();
  });

  it('LLM 路径:显示 Tokens/模型,但按需求隐藏预估成本,也不显示影响的表', () => {
    renderModal(LLM, 'canon');
    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('mimo-v2.6-flash')).toBeTruthy();
    expect(screen.queryByText('预估成本')).toBeNull();
    expect(screen.queryByText('kb_canon_entities')).toBeNull();
  });
});
