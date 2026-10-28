/* game-settings-auto-pace.test.js — 存档级「自动节奏推进」开关的前端契约。
 *
 * 后端已有 auto_pace_advance 设置 + anchor_reconcile 消费;这里锁前端三件事:
 *   1. 打开设置弹窗时必须从 /settings 读 auto_pace_advance 真值;
 *   2. 切换时必须 PATCH {updates:{auto_pace_advance}};
 *   3. UI 必须渲染 auto_pace_label(否则用户找不到开关)。
 * 源代码结构断言,不挂载 React 组件。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(
  resolve(__dirname, '../components/game/GameSettingsModal.jsx'),
  'utf-8',
);

describe('GameSettingsModal — 自动节奏推进开关', () => {
  it('打开时读取 auto_pace_advance 真值', () => {
    expect(SRC).toMatch(/d\.settings\.auto_pace_advance/);
  });

  it('切换时 PATCH auto_pace_advance', () => {
    expect(SRC).toMatch(/updates:\s*\{\s*auto_pace_advance:\s*v\s*\}/);
    expect(SRC).toMatch(/rejected\.auto_pace_advance/);
  });

  it('渲染开关标签/描述', () => {
    expect(SRC).toMatch(/auto_pace_label/);
    expect(SRC).toMatch(/auto_pace_desc/);
  });
});
