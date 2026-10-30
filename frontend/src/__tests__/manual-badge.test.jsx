/**
 * manual-badge.test.jsx — 手编标签 + 精确解锁弹层（2026-10）
 * 字段级 manual_fields 非空 → 显示并可逐字段解锁；旧数据 source='editor' 提供整行解锁；无标记不渲染。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ManualBadge } from '../components/ManualBadge.jsx';

describe('ManualBadge', () => {
  it('manual_fields 非空 → 显示「手编」并提示中文字段名', () => {
    render(<ManualBadge fields={['identity', 'aliases']} kind="card" />);
    expect(screen.getByText('手编')).toBeTruthy();
    expect(screen.getByTitle(/身份/)).toBeTruthy();
  });

  it('旧数据 source=editor 且无 manual_fields → 仍显示整行保护提示', () => {
    render(<ManualBadge source="editor" />);
    expect(screen.getByText('手编')).toBeTruthy();
    expect(screen.getByTitle(/旧数据/)).toBeTruthy();
  });

  it('无标记 → 不渲染', () => {
    const { container } = render(<ManualBadge source="extracted" />);
    expect(container.textContent).toBe('');
  });

  it('manual_fields=[] + 旧 source=editor → 不算整行保护，不渲染', () => {
    const { container } = render(<ManualBadge fields={[]} source="editor" />);
    expect(container.textContent).toBe('');
  });

  it('点击标签列出中文字段，取消勾选调用 onUnlock(原始字段 key)', async () => {
    const onUnlock = vi.fn(async () => {});
    render(<ManualBadge fields={['identity', 'aliases']} kind="card" onUnlock={onUnlock} />);
    fireEvent.click(screen.getByText('手编'));
    expect(screen.getByText('身份')).toBeTruthy();
    expect(screen.getByText('别名')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('identity'));
  });

  it('旧数据点击后可整行解锁（onUnlock(null)），成功后标签消失', async () => {
    const onUnlock = vi.fn(async () => {});
    const { container } = render(<ManualBadge source="editor" onUnlock={onUnlock} />);
    fireEvent.click(screen.getByText('手编'));
    fireEvent.click(screen.getByText('取消整行手编'));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith(null));
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
