// agent-pending:刷新/切回对话后，把服务端仍挂着的待确认项合并回历史消息。
// 之前只恢复文本+工具块，pending 卡丢失 → 用户再也无法批准/拒绝。
import { describe, it, expect, vi } from 'vitest';
import { mergePendingCards } from '../components/md-editor/agent-pending.js';

const mkPc = (p) => ({ call_id: p.call_id, tool: p.tool, args: p.args, preview: p.preview });

describe('mergePendingCards', () => {
  it('优先挂到包含同一 call_id 的 assistant 消息', () => {
    const messages = [
      { role: 'user', text: '改一下', tools: [] },
      { role: 'assistant', text: '', tools: [{ call_id: 'c1', tool: 'update_script_chapter', status: 'running' }] },
    ];
    const out = mergePendingCards(messages, [
      { call_id: 'c1', tool: 'update_script_chapter', args: { chapter_index: 2 } },
    ], mkPc);
    expect(out[1].pendingConfirm.call_id).toBe('c1');
    expect(out[1].pendingConfirm.args.chapter_index).toBe(2);
    // 不修改入参
    expect(messages[1].pendingConfirm).toBeUndefined();
  });

  it('找不到 call_id 时挂到最近一条 assistant;没有则补一条', () => {
    const out = mergePendingCards([
      { role: 'assistant', text: '旧回复', tools: [] },
    ], [{ call_id: 'x', tool: 'resplit_script', args: {} }], mkPc);
    expect(out).toHaveLength(1);
    expect(out[0].pendingConfirm.call_id).toBe('x');

    const out2 = mergePendingCards([], [{ call_id: 'y', tool: 'x', args: {} }], mkPc);
    expect(out2).toHaveLength(1);
    expect(out2[0].role).toBe('assistant');
    expect(out2[0].pendingConfirm.call_id).toBe('y');
  });

  it('同一条消息已有卡时另起一条,不覆盖第一张卡', () => {
    const out = mergePendingCards(
      [{ role: 'assistant', text: '', tools: [] }],
      [
        { call_id: 'a', tool: 'x', args: {} },
        { call_id: 'b', tool: 'y', args: {} },
      ],
      mkPc,
    );
    const cards = out.map((m) => m.pendingConfirm && m.pendingConfirm.call_id).filter(Boolean);
    expect(cards).toEqual(['a', 'b']);
  });

  it('makePending 抛错/返回空时跳过该条,不影响其它', () => {
    const make = vi.fn((p) => (p.call_id === 'bad' ? null : mkPc(p)));
    const out = mergePendingCards(
      [{ role: 'assistant', text: '', tools: [] }],
      [{ call_id: 'bad', tool: 'x' }, { call_id: 'ok', tool: 'y' }],
      make,
    );
    expect(out[0].pendingConfirm.call_id).toBe('ok');
  });
});
