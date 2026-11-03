import { describe, it, expect } from 'vitest';
import { splitModeLabel } from '../lib/split-mode.js';
import en from '../i18n/locales/en.json';
import zhCN from '../i18n/locales/zh-CN.json';

// 用最小翻译器模拟 i18next:点路径查找 → 参数替换,缺键回退 defaultValue。
function makeT(dict) {
  return (key, opts = {}) => {
    const raw = key.split('.').reduce((cur, part) => (cur == null ? cur : cur[part]), dict);
    if (typeof raw !== 'string') return opts.defaultValue ?? key;
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name) => (opts[name] ?? `{{${name}}}`));
  };
}

describe('splitModeLabel', () => {
  it('按 mode 标识返回英文标签,不泄漏后端中文 mode_label', () => {
    const t = makeT(en);
    expect(splitModeLabel({ mode: 'adaptive_fusion', mode_label: '规则融合自适应' }, t))
      .toBe('Adaptive rule fusion');
    expect(splitModeLabel({ mode: 'rule_chapter_cn', mode_label: '中文章节规则' }, t))
      .toBe('Chinese chapter rule');
  });

  it('中文界面返回中文标签', () => {
    const t = makeT(zhCN);
    expect(splitModeLabel({ mode: 'strong_headings', mode_label: '标准章节标题' }, t))
      .toBe('标准章节标题');
  });

  it('旧报告缺 mode 时回退 mode_label', () => {
    const t = makeT(en);
    expect(splitModeLabel({ mode_label: '标准章节标题' }, t)).toBe('标准章节标题');
  });

  it('未知 mode 也回退 mode_label/原始标识', () => {
    const t = makeT(en);
    expect(splitModeLabel({ mode: 'legacy_rule', mode_label: '旧规则' }, t)).toBe('旧规则');
    expect(splitModeLabel({ mode: 'legacy_rule' }, t)).toBe('legacy_rule');
  });

  it('空报告返回占位符', () => {
    expect(splitModeLabel(null, makeT(en))).toBe('—');
  });
});
