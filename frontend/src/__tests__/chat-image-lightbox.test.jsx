/**
 * chat-image-lightbox.test.jsx — 聊天里的图片点开全屏预览必须走 portal。
 *
 * 用户报的 bug:在游戏聊天里点图片「查看详情」直接黑屏。
 * 根因:那处全屏层是**手写的 `<div className="mlb-backdrop">`(内联 position:fixed)**,而它挂在
 * 消息气泡 `.gc-msg` 里 —— 该元素带 `animation: m-stagger … forwards`,按 CSS 规范,forwards
 * 填充的动画会让元素成为 fixed 后代的**包含块**,于是"全屏层"被关进气泡:黑幕只盖住聊天列、
 * 大图与关闭按钮被顶到视口外 ⇒ 用户只看到黑屏。
 * 同一个坑本仓修过一次(commit fced032:把内联 lightbox 全换成 portal 化的 ImageLightbox),
 * 聊天图片这一处是当时漏掉的。
 *
 * jsdom 不做布局与层叠计算,渲染不出"黑屏";能锁住的不变量是**挂载位置**:
 * 预览层必须在 document.body 直下(portal),而不是留在消息容器里。
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// 走已导出的 NarrativeBlock(它内部渲染 ChatImageGroup),这样在旧代码上失败是**行为性**的
// (预览层不在 body 下),而不是"组件没导出"导致的无法运行。
import { NarrativeBlock } from '../components/game/GameChatMessages.jsx';

const IMG = { id: 7, url: 'https://cdn.example.com/chat.png', kind: 'game' };

describe('ChatImageGroup — 全屏预览', () => {
  it('点缩略图后,预览层挂在 document.body 下(而非消息容器内)', () => {
    const { container } = render(<NarrativeBlock text="GM 说了一句话" images={[IMG]} />);

    const thumb = container.querySelector('.rpg-chat-img');
    expect(thumb, '助手气泡里应有图片缩略图按钮').toBeTruthy();
    expect(container.querySelector(`img[src="${IMG.url}"]`)).toBeTruthy();

    fireEvent.click(thumb);

    const portalLayer = document.body.querySelector('.ilb');
    expect(portalLayer, '预览层必须是 portal 化的 ImageLightbox(.ilb)').toBeTruthy();
    expect(container.contains(portalLayer), '预览层留在消息容器里 → 会被 .gc-msg 的动画包含块困住').toBe(false);
    // 预览里显示的是同一张图
    expect(portalLayer.querySelector(`img[src="${IMG.url}"]`)).toBeTruthy();
  });

  it('右上角关闭按钮用 SVG 图标(几何居中),不再用文本 ×', () => {
    // 用户上报:「大叉没在白色圆心的中心」。文本 × 的落位 = 字体度量 + 行盒 + button 的 UA
    // 默认 padding 三者叠加,定高圆里必然偏;SVG 在 24×24 viewBox 内几何居中,与 Modal 同做法。
    const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
    fireEvent.click(container.querySelector('.rpg-chat-img'));

    const close = document.body.querySelector('.ilb__close');
    expect(close, '预览层应有关闭按钮').toBeTruthy();
    expect(close.querySelector('svg'), '关闭按钮应为 SVG 图标').toBeTruthy();
    expect(close.textContent.trim(), '不该再有文本 × 参与居中').toBe('');
  });

  it('图片 404(onError)时就地移除,不留空图位', () => {
    // 兜底:文件库删图但本页没收到 deleted 事件(多 worker 未配 Redis / SSE 断开)时,
    // 刷新后历史列表仍含该行 → <img> 对 404 触发 onError → 必须把自己从气泡里拿掉。
    const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
    const img = container.querySelector(`img[src="${IMG.url}"]`);
    expect(img).toBeTruthy();

    fireEvent.error(img);

    expect(container.querySelector(`img[src="${IMG.url}"]`)).toBeNull();
    expect(container.querySelector('.rpg-chat-imgs')).toBeNull();  // 全挂了 → 整组不渲染
  });
});

describe('.ilb__close 的居中样式(源码锁)', () => {
  it('必须显式 flex 居中并清掉 UA 默认 padding', () => {
    const css = readFileSync(resolve(__dirname, '../media.css'), 'utf-8');
    const block = css.slice(css.indexOf('.ilb__close'));
    const rule = block.slice(0, block.indexOf('}'));
    expect(rule).toContain('display: flex');
    expect(rule).toContain('align-items: center');
    expect(rule).toContain('justify-content: center');
    expect(rule).toContain('padding: 0');
  });
});
