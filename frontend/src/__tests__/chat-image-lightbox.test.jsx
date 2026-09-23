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
import { render, fireEvent, waitFor } from '@testing-library/react';
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

// ── 大图工具条的下载/删除(对齐文件库)──────────────────────────────────────
// window.api 是 api-client 挂的全局;jsdom 里没有,按真实形状打桩。
function stubApi(overrides = {}) {
  const prev = window.api;
  window.api = {
    ...(prev || {}),
    images: {
      downloadUrl: (id) => `/api/images/${id}/download`,
      deleteImage: (id, confirm) => Promise.resolve({ ok: true, deleted: true, _id: id, _confirm: confirm }),
      ...(overrides.images || {}),
    },
  };
  return () => { window.api = prev; };
}

describe('ChatImageGroup — 大图工具条下载/删除', () => {
  it('点开大图后工具条出现「下载」「删除」', () => {
    const restore = stubApi();
    try {
      const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
      fireEvent.click(container.querySelector('.rpg-chat-img'));

      const btns = [...document.body.querySelectorAll('.ilb__bar .ilb__btn')].map((b) => b.textContent);
      expect(btns.some((x) => x.includes('下载')), `工具条应有下载按钮: ${btns}`).toBe(true);
      expect(btns.some((x) => x.includes('删除')), `工具条应有删除按钮: ${btns}`).toBe(true);
    } finally { restore(); }
  });

  it('点删除先出 ConfirmDialog,确认后才调 deleteImage(true) 并关闭预览', async () => {
    const calls = [];
    const restore = stubApi({
      images: {
        downloadUrl: (id) => `/api/images/${id}/download`,
        deleteImage: (id, confirm) => { calls.push({ id, confirm }); return Promise.resolve({ ok: true, deleted: true }); },
      },
    });
    try {
      const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
      fireEvent.click(container.querySelector('.rpg-chat-img'));

      const delBtn = [...document.body.querySelectorAll('.ilb__bar .ilb__btn')]
        .find((b) => b.textContent.includes('删除'));
      fireEvent.click(delBtn);

      // 确认弹窗(danger,portal 到 body)——不能一点删除就直接调接口
      const dialog = document.body.querySelector('.pl-modal');
      expect(dialog, '点删除应先弹确认框').toBeTruthy();
      expect(calls.length, '确认前不得调用删除接口').toBe(0);

      const confirmBtn = [...dialog.querySelectorAll('button')]
        .find((b) => b.className.includes('danger'));
      expect(confirmBtn, '确认框应有 danger 确认按钮').toBeTruthy();
      fireEvent.click(confirmBtn);

      expect(calls).toEqual([{ id: IMG.id, confirm: true }]);
      // onDelete 是 async(setLightbox(null) 在 resolve 后)——等 React 提交
      await waitFor(() => expect(document.body.querySelector('.ilb'), '删除成功后预览应关闭').toBeNull());
    } finally { restore(); }
  });

  it('downloadUrl/onDelete 缺失(如 window.api 未挂)时按钮隐藏,预览仍可用', () => {
    const restore = stubApi({
      images: { downloadUrl: undefined, deleteImage: undefined },
    });
    // 直接清掉 images 命名空间模拟 api 未实装
    try {
      window.api = { images: {} };
      const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
      fireEvent.click(container.querySelector('.rpg-chat-img'));

      const btns = [...document.body.querySelectorAll('.ilb__bar .ilb__btn')].map((b) => b.textContent);
      expect(btns.some((x) => x.includes('下载'))).toBe(false);
      expect(btns.some((x) => x.includes('删除'))).toBe(false);
      expect(document.body.querySelector('.ilb__close'), '关闭按钮不受影响').toBeTruthy();
    } finally { restore(); }
  });
});

// 用户报:点删除「没有弹框,似乎被遮挡了」。根因是层叠:
//   .ilb(lightbox 遮罩)        z-index: 10000,近黑不透明;
//   .pl-modal-backdrop(弹窗)   z-index: 50(platform.css) —— 且两者都 portal 到 body,
//   弹窗被 .ilb 整个盖住 = DOM 在但完全看不见。
// 修复 = media.css 的 `.ilb ~ .pl-modal-backdrop { z-index: 10001 }`。
// jsdom 不跑完整 CSS 层叠,锁得住的不变量是**选择器依赖的 DOM 顺序** + 规则本身。
describe('删除确认弹窗不被 lightbox 遮挡', () => {
  it('弹窗遮罩必须挂在 .ilb 之后(body 兄弟顺序,`.ilb ~` 才能命中)', () => {
    const restore = stubApi();
    try {
      const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
      fireEvent.click(container.querySelector('.rpg-chat-img'));
      fireEvent.click([...document.body.querySelectorAll('.ilb__bar .ilb__btn')]
        .find((b) => b.textContent.includes('删除')));

      const ilb = document.body.querySelector('.ilb');
      const backdrop = document.body.querySelector('.pl-modal-backdrop');
      expect(backdrop, '确认弹窗应存在').toBeTruthy();
      const order = [...document.body.children];
      expect(order.indexOf(backdrop), 'backdrop 必须在 .ilb 之后,否则通用兄弟选择器不命中 → 被遮罩盖住')
        .toBeGreaterThan(order.indexOf(ilb));
    } finally { restore(); }
  });

  it('源码锁:media.css 必须有把 backdrop 顶过 .ilb 的 z-index 规则', () => {
    const css = readFileSync(resolve(__dirname, '../media.css'), 'utf-8');
    const idx = css.indexOf('.ilb ~ .pl-modal-backdrop');
    expect(idx, '缺少 .ilb ~ .pl-modal-backdrop 规则 → 弹窗(z:50)被遮罩(z:10000)盖住').toBeGreaterThan(-1);
    const rule = css.slice(idx, css.indexOf('}', idx));
    const z = Number((rule.match(/z-index:\s*(\d+)/) || [])[1]);
    expect(z, 'backdrop 的 z-index 必须高于 .ilb 的 10000').toBeGreaterThan(10000);
  });

  it('点弹窗外部(backdrop)只关确认框,不关大图预览', () => {
    // React portal 事件沿 React 树冒泡:backdrop 在 DOM 上是 body 直下节点,
    // 但点击会冒到 .ilb 的 onClick —— 不拦截就把 lightbox 一起关了。
    const restore = stubApi();
    try {
      const { container } = render(<NarrativeBlock text="GM" images={[IMG]} />);
      fireEvent.click(container.querySelector('.rpg-chat-img'));
      fireEvent.click([...document.body.querySelectorAll('.ilb__bar .ilb__btn')]
        .find((b) => b.textContent.includes('删除')));
      expect(document.body.querySelector('.pl-modal-backdrop')).toBeTruthy();

      fireEvent.click(document.body.querySelector('.pl-modal-backdrop'));

      expect(document.body.querySelector('.pl-modal-backdrop'), '确认框应关闭').toBeNull();
      expect(document.body.querySelector('.ilb'), '大图预览必须还在(只取消确认)').toBeTruthy();
    } finally { restore(); }
  });
});
