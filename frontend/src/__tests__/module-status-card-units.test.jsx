/**
 * module-status-card-units.test.jsx — 模块卡计数单位回归测试。
 *
 * 背景:chunks 卡的 done/total 是跨单位比值(块数/章数,后端 listing.py 把 total
 * 定成 chapter_count 作"每章至少 1 块"的下限校验),渲染成「4499/1487」+ 百分比
 * 进度条看起来像"超 100%"。现在跨单位模块(chunks/chapter_facts)改渲染
 * 「4499 块 · 覆盖 1487 章」并隐藏进度条;其余模块计数带各自单位(张/个/条)。
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModuleStatusCard } from '../components/ModuleStatusCard.jsx';

function renderCard(props) {
  return render(<ModuleStatusCard module="chunks" scriptId={1} {...props} />);
}

describe('ModuleStatusCard 计数单位', () => {
  it('chunks:done/total 跨单位时渲染「N 块 · 覆盖 N 章」,无分数无百分比进度条', () => {
    renderCard({ module: 'chunks', doneCount: 4499, totalCount: 1487, status: 'ready' });
    expect(screen.getByText('4499')).toBeTruthy();
    expect(screen.getByText('块')).toBeTruthy();
    expect(screen.getByText('覆盖 1487 章')).toBeTruthy();
    // 不应再出现「1487/」式分数分母与百分比进度条
    expect(screen.queryByText('1487')).toBeNull();
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('chapter_facts:同样走覆盖格式(条 · 覆盖 N 章)', () => {
    renderCard({ module: 'chapter_facts', doneCount: 1487, totalCount: 1487, status: 'ready' });
    expect(screen.getByText('1487')).toBeTruthy();
    expect(screen.getByText('条')).toBeTruthy();
    expect(screen.getByText('覆盖 1487 章')).toBeTruthy();
  });

  it('cards:单数字带单位「张」(无 total 概念)', () => {
    renderCard({ module: 'cards', doneCount: 12, totalCount: 0, status: 'ready' });
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('张')).toBeTruthy();
  });

  it('cards:来源标签是「可选 LLM」(默认零 LLM,勾选才烧 API),不是「LLM」', () => {
    renderCard({ module: 'cards', doneCount: 12, totalCount: 0, status: 'ready' });
    expect(screen.getByText('可选 LLM')).toBeTruthy();
  });

  it('canon:单数字带单位「个」', () => {
    renderCard({ module: 'canon', doneCount: 321, totalCount: 0, status: 'ready' });
    expect(screen.getByText('321')).toBeTruthy();
    expect(screen.getByText('个')).toBeTruthy();
  });

  it('embeddings:done/total 同单位(块向量),保留分数 + 百分比进度条', () => {
    renderCard({ module: 'embeddings', doneCount: 100, totalCount: 200, status: 'partial' });
    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('个')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('chunks 缺 total 时退回单数字 + 单位,不渲染覆盖文案', () => {
    renderCard({ module: 'chunks', doneCount: 4499, totalCount: 0, status: 'ready' });
    expect(screen.getByText('4499')).toBeTruthy();
    expect(screen.getByText('块')).toBeTruthy();
    expect(screen.queryByText(/覆盖/)).toBeNull();
  });
});
