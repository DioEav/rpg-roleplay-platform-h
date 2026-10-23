import { describe, it, expect } from 'vitest';
import { _currentModelLabel } from '../game-composer.jsx';

/* 底部「模型」标签解析:同名模型跨 provider 时,必须去候选自己的 provider 下解析。
   回归场景:opencode-go 的 deepseek-v4.1-flash 与已停用的 funhpc 同名;旧实现只按名字
   取目录里第一个命中(funhpc,has_credential=false)→ 标签回退占位符「模型」。 */

const t = (k) => (k === 'game.composer.model_placeholder' ? '模型' : k);

const funhpc = {
  id: 'funhpc',
  has_credential: false,
  models: [{ id: 'deepseek-v4.1-flash', real_name: 'deepseek-v4.1-flash' }],
};
const opencodeGo = {
  id: 'opencode-go',
  has_credential: true,
  models: [{
    id: 'deepseek-v4.1-flash',
    real_name: 'deepseek-v4.1-flash',
    display_name: 'DeepSeek V4.1 Flash',
  }],
};
const silentProvider = {
  id: 'silent-relay',
  has_credential: false,
  models: [{ id: 'glm-5.1', real_name: 'glm-5.1' }],
};

describe('_currentModelLabel', () => {
  it('按 session_model.api_id 去对应 provider 下解析,不被前面的同名无 key provider 遮蔽', () => {
    const gameState = {
      models: { apis: [funhpc, opencodeGo] },
      session_model: { api_id: 'opencode-go', model_id: 'deepseek-v4.1-flash' },
    };
    expect(_currentModelLabel(gameState, null, t)).toBe('DeepSeek V4.1 Flash');
  });

  it('本地乐观选择带 api_id 时,立刻显示该 provider 下的标签', () => {
    const gameState = { models: { apis: [silentProvider, opencodeGo] } };
    expect(_currentModelLabel(gameState, 'deepseek-v4.1-flash', t, 'opencode-go'))
      .toBe('DeepSeek V4.1 Flash');
  });

  it('localModel 为移动端对象形态时按对象里的 api_id 解析,不把对象当模型名', () => {
    const gameState = { models: { apis: [silentProvider, opencodeGo] } };
    const mobileModel = { id: 'deepseek-v4.1-flash', api_id: 'opencode-go', label: 'x' };
    expect(_currentModelLabel(gameState, mobileModel, t)).toBe('DeepSeek V4.1 Flash');
  });

  it('本地值缺 api_id 时全局扫描也优先有凭证的命中(向后兼容)', () => {
    const gameState = { models: { apis: [silentProvider, opencodeGo] } };
    // glm-5.1 只在无 key 的 silent-relay 里 → 维持占位符语义,不能谎报可用
    expect(_currentModelLabel(gameState, 'glm-5.1', t)).toBe('模型');
    // deepseek-v4.1-flash 同时存在 → 选有凭证的 opencode-go
    expect(_currentModelLabel(gameState, 'deepseek-v4.1-flash', t)).toBe('DeepSeek V4.1 Flash');
  });

  it('app.api_id 同样参与解析', () => {
    const gameState = {
      models: { apis: [funhpc, opencodeGo] },
      app: { api_id: 'opencode-go', model: 'deepseek-v4.1-flash' },
    };
    expect(_currentModelLabel(gameState, null, t)).toBe('DeepSeek V4.1 Flash');
  });

  it('所有 provider 都无凭证时仍回退占位符', () => {
    const gameState = {
      models: { apis: [funhpc, silentProvider] },
      session_model: { api_id: 'opencode-go', model_id: 'deepseek-v4.1-flash' },
    };
    expect(_currentModelLabel(gameState, null, t)).toBe('模型');
  });

  it('完全不在目录里的自定义模型直接显示 id', () => {
    const gameState = { models: { apis: [opencodeGo] } };
    expect(_currentModelLabel(gameState, 'my-local-model', t)).toBe('my-local-model');
  });
});
