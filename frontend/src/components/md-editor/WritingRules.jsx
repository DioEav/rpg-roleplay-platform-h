// WritingRules.jsx — 写作规范(.cursorrules 风)(机械搬出,逐字节不变)。
import React from 'react';
import { useTranslation } from 'react-i18next';
import { api, toast } from './helpers.js';
const { useState, useEffect, useCallback, useRef } = React;

// 写作规范(.cursorrules 风):per-script 风格/连贯/禁忌规则,保存后注入编辑器 agent 最高优先上下文。
function WritingRules({ scriptId, onClose }) {
  const { t } = useTranslation();
  const [text, setText] = useState(null);
  // loaded = 最近一次成功读取/保存的原文,用于判断是否有未保存修改。
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async () => {
    setError(null);
    setText(null);
    setLoaded(null);
    try {
      const r = await api().scripts.writingRules(scriptId);
      if (!mountedRef.current) return;   // 加载期间已关闭:不要把结果写回已卸载组件
      if (!r || r.ok === false) throw new Error((r && r.error) || t('md_editor.rules.load_fail', { defaultValue: '读取写作规范失败' }));
      const v = r.rules || '';
      setText(v);
      setLoaded(v);
    } catch (e) {
      // 关键:加载失败不能把 text 当空串。旧实现失败后 text='',用户点保存就把原规范清空。
      if (mountedRef.current) setError(e?.message || String(e));
    }
  }, [scriptId, t]);

  useEffect(() => { load(); }, [load]);

  const dirty = text !== null && loaded !== null && text !== loaded;

  // 关闭前确认未保存修改(scrim / 取消 / Esc 共用)。旧实现直接 onClose,长文一键丢失。
  const requestClose = useCallback(async () => {
    if (busy) return;
    if (dirty) {
      const ok = window.__confirm
        ? window.__confirm({
            title: t('md_editor.rules.discard_title', { defaultValue: '放弃未保存的写作规范?' }),
            message: t('md_editor.rules.discard_msg', { defaultValue: '你有未保存的修改,关闭后无法恢复。' }),
            danger: true,
            confirmText: t('md_editor.rules.discard', { defaultValue: '放弃修改' }),
          })
        : Promise.resolve(window.confirm(t('md_editor.rules.discard_title', { defaultValue: '放弃未保存的写作规范?' })));
      if (!(await ok)) return;
    }
    onClose();
  }, [busy, dirty, onClose, t]);

  // Esc 关闭(与知识库抽屉一致;旧版只能点遮罩/取消)。
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  const save = async () => {
    if (busy || text === null || error) return;
    setBusy(true);
    try {
      const r = await api().scripts.saveWritingRules(scriptId, text || '');
      if (r && r.ok) {
        toast(t('md_editor.rules.saved', { defaultValue: '写作规范已保存,下次对话起生效' }), { kind: 'ok' });
        onClose();
      } else {
        toast((r && r.error) || t('md_editor.rules.fail', { defaultValue: '保存失败' }), { kind: 'danger' });
      }
    } catch (e) {
      toast(t('md_editor.rules.fail', { defaultValue: '保存失败' }), { kind: 'danger', detail: e?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mde-qopen-scrim" onMouseDown={requestClose}>
      <div className="mde-rules" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mde-rules-head">{t('md_editor.rules.title', { defaultValue: '写作规范(注入 AI 上下文,务必遵守)' })}</div>
        <div className="mde-rules-desc">{t('md_editor.rules.desc', { defaultValue: '这部剧本的写作规矩:风格/人称/视角、连贯禁忌、命名约定…续写与改写时最高优先遵守。' })}</div>
        {error ? (
          <div className="mde-qopen-empty">
            <div>{t('md_editor.rules.load_fail', { defaultValue: '读取写作规范失败' })}</div>
            <div className="muted" style={{ margin: '6px 0 10px' }}>{error}</div>
            <button type="button" className="mde-rules-save" onClick={load}>{t('common.retry', { defaultValue: '重试' })}</button>
          </div>
        ) : text === null ? <div className="mde-qopen-empty">{t('common.loading')}</div>
          : <>
              <textarea className="mde-rules-ta" value={text} maxLength={8000} onChange={(e) => setText(e.target.value)}
                placeholder={t('md_editor.rules.placeholder', { defaultValue: '例:全程第三人称限制视角(只跟主角)；禁止上帝视角剧透；地名统一用「云墟城」不用「云墟」；台词不带现代网络词。' })} />
              <div className="mde-rules-meta">
                <span>{t('md_editor.rules.limits', { defaultValue: '保存上限 8000 字；续写/改写注入前 4000 字，内联续写 1000 字' })}</span>
                <span>{text.length} / 8000{dirty ? ' · ' + t('md_editor.rules.unsaved', { defaultValue: '未保存' }) : ''}</span>
              </div>
            </>}
        <div className="mde-rules-btns">
          <button type="button" className="mde-rules-save" disabled={busy || text === null || !!error} onClick={save}>{t('common.save', { defaultValue: '保存' })}</button>
          <button type="button" className="mde-rules-cancel" onClick={requestClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

export { WritingRules };
