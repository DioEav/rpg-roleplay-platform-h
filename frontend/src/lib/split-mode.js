/* 切分模式标签本地化。
   后端 import_report 同时带机器可读的 mode 和中文 mode_label:machine 字段用于
   i18n,label 只作为旧数据(缺 mode)的兜底,避免英文界面直接显示中文。 */

const SPLIT_MODE_LABEL_KEYS = {
  empty: 'scripts.split_mode_labels.empty',
  custom_pattern: 'scripts.split_mode_labels.custom_pattern',
  numbered_sections: 'scripts.split_mode_labels.numbered_sections',
  pagination_headings: 'scripts.split_mode_labels.pagination_headings',
  adaptive_fusion: 'scripts.split_mode_labels.adaptive_fusion',
  rule_chapter_cn: 'scripts.split_mode_labels.rule_chapter_cn',
  rule_corpus: 'scripts.split_mode_labels.rule_corpus',
  rule_chapter_en: 'scripts.split_mode_labels.rule_chapter_en',
  rule_number_dot: 'scripts.split_mode_labels.rule_number_dot',
  rule_paren_num: 'scripts.split_mode_labels.rule_paren_num',
  strong_headings: 'scripts.split_mode_labels.strong_headings',
  weak_headings: 'scripts.split_mode_labels.weak_headings',
  fallback_window: 'scripts.split_mode_labels.fallback_window',
  quality_fallback_window: 'scripts.split_mode_labels.quality_fallback_window',
};

/** report = import_report(或 normalizeScript 的等价结构);t = i18next 翻译函数。 */
export function splitModeLabel(report, t) {
  if (!report) return '—';
  const mode = String(report.mode || '').trim();
  const key = mode && SPLIT_MODE_LABEL_KEYS[mode];
  if (key && typeof t === 'function') {
    return t(key, { defaultValue: report.mode_label || mode });
  }
  return report.mode_label || mode || '—';
}

export { SPLIT_MODE_LABEL_KEYS };
