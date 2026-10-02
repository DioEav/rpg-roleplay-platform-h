/**
 * lightbox-host-click-leak.test.jsx — 灯箱关闭点击不得泄漏给宿主祖先。
 *
 * 用户报的 bug:概览封面点开大图预览,右上角大叉「点了没反应」。
 * 根因:ImageLightbox portal 到 body,但 React 合成事件沿 **React 树**冒泡 —— 封面
 * 容器(CoverFrame .mh-hero)有 onClick=setLight(true) 且是灯箱的 React 祖先,
 * 关闭按钮的点击冒泡上去 → 灯箱关闭后瞬间被重新打开(表现为点了没反应)。
 * 修复:.ilb 根节点与关闭按钮 stopPropagation,全屏浮层吞掉事件不外泄。
 * 不变量:点关闭按钮 → onClose 恰好一次,宿主祖先的 onClick **不被触发**。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import ImageLightbox from '../components/ImageLightbox.jsx';

function renderInClickableHost(props) {
  const hostClick = vi.fn();
  const { container } = render(
    <div onClick={hostClick} data-testid="host">
      <ImageLightbox open src="/img/x.png" onClose={() => {}} {...props} />
    </div>,
  );
  return { hostClick, container };
}

describe('ImageLightbox 关闭点击不泄漏', () => {
  it('点右上角大叉:onClose 触发,宿主祖先 onClick 不触发', () => {
    const onClose = vi.fn();
    const { hostClick } = renderInClickableHost({ onClose });
    fireEvent.click(document.body.querySelector('.ilb__close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hostClick, '点击不得冒泡到宿主可点击祖先(mh-hero 重开灯箱病灶)').not.toHaveBeenCalled();
  });

  it('点遮罩空白处关闭:同样不泄漏给宿主祖先', () => {
    const onClose = vi.fn();
    const { hostClick } = renderInClickableHost({ onClose });
    fireEvent.click(document.body.querySelector('.ilb'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hostClick).not.toHaveBeenCalled();
  });

  it('点工具条关闭按钮(stage 内):不泄漏给宿主祖先', () => {
    const onClose = vi.fn();
    const { hostClick } = renderInClickableHost({ onClose });
    const buttons = [...document.body.querySelectorAll('.ilb__btn')];
    const closeBtn = buttons.find((b) => b.textContent.includes('关闭') || b.className.includes('ghost'));
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(hostClick).not.toHaveBeenCalled();
  });
});
