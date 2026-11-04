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
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('cards:不再提供“保留已有卡面内容”开关（改为自动手编保护）', () => {
    renderModal(LLM, 'cards');
    expect(screen.queryByLabelText(/保留已有卡面内容/)).toBeNull();
    // 改为常驻提示：手编字段自动保护，刷新走编辑器里的“手编”标签
    expect(screen.getByText(/自动保护/)).toBeTruthy();
  });

  it('worldbook_enrich:勾选 include_editor 会下发覆盖手编开关', () => {
    const onOptionsChange = vi.fn();
    render(
      <RebuildEstimateModal
        open
        module="worldbook_enrich"
        scriptId={1}
        estimate={{ ...LLM, prereqs: [] }}
        loading={false}
        options={null}
        onOptionsChange={onOptionsChange}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/连手编条目一起覆盖/));
    expect(onOptionsChange).toHaveBeenCalledWith({ include_editor: true });
  });

  it('canon:勾选“强制覆盖手编字段”会下发 force_overwrite_manual', () => {
    const onOptionsChange = vi.fn();
    render(
      <RebuildEstimateModal
        open
        module="canon"
        scriptId={1}
        estimate={{ ...LLM, prereqs: [] }}
        loading={false}
        options={null}
        onOptionsChange={onOptionsChange}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/强制覆盖手编字段/));
    expect(onOptionsChange).toHaveBeenCalledWith({ force_overwrite_manual: true });
  });

  it('cards:切换 LLM 时显式下发 chapter_max:null / mode（配合 hook 合并）', () => {
    const onOptionsChange = vi.fn();
    render(
      <RebuildEstimateModal
        open
        module="cards"
        scriptId={1}
        estimate={{ ...LLM, prereqs: [] }}
        loading={false}
        options={null}
        onOptionsChange={onOptionsChange}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/LLM 丰富重建/));
    expect(onOptionsChange).toHaveBeenCalledWith({ chapter_max: null, mode: 'llm' });
  });

  it('facts_refine:默认增量,取消后下发 only_missing:false;强制全量下发 force', () => {
    const onOptionsChange = vi.fn();
    render(
      <RebuildEstimateModal
        open
        module="facts_refine"
        scriptId={1}
        estimate={{ ...LLM, prereqs: [] }}
        loading={false}
        options={null}
        onOptionsChange={onOptionsChange}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    const inc = screen.getByTestId('facts-refine-incremental');
    expect(inc.checked).toBe(true);
    fireEvent.click(inc);
    expect(onOptionsChange).toHaveBeenCalledWith({ only_missing: false, force: false });
    fireEvent.click(screen.getByTestId('facts-refine-force'));
    expect(onOptionsChange).toHaveBeenCalledWith({ force: true, only_missing: false });
  });

  it('chunks:默认增量,取消后下发 incremental:false', () => {
    const onOptionsChange = vi.fn();
    render(
      <RebuildEstimateModal
        open
        module="chunks"
        scriptId={1}
        estimate={{ ...ZERO, prereqs: [] }}
        loading={false}
        options={null}
        onOptionsChange={onOptionsChange}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    const cb = screen.getByLabelText(/增量重切/);
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(onOptionsChange).toHaveBeenCalledWith({ incremental: false });
  });
});
