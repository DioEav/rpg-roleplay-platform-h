// ChapterHistory.jsx — 章节版本历史(checkpoints)(机械搬出,逐字节不变)。
import React from 'react';
import { useTranslation } from 'react-i18next';
import { api, toast } from './helpers.js';
const { useState, useEffect } = React;

// 章节版本历史(checkpoints):列 AI 改动 + 一键回滚到历史任意版本之前。
function ChapterHistory({ scriptId, chapterIndex, onClose, onRestored }) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = React.useCallback(async () => {
    try {
      const r = await api().scripts.chapterHistory(scriptId, chapterIndex);
      setVersions(r && r.ok ? (r.versions || []) : []);
    } catch (_) { setVersions([]); }
  }, [scriptId, chapterIndex]);
  useEffect(() => { load(); }, [load]);
  const restore = async (cid) => {
    if (busy) return; setBusy(true);
    try {
      const r = await api().scripts.chapterRestore(scriptId, chapterIndex, cid);
      if (r && r.ok) {
        toast(t('md_editor.history.restored', { defaultValue: '已恢复到该版本之前' }), {
          kind: 'ok',
          // 正文不会立即回灌到编辑器(同标签不回灌的既有约定)→ 明确引导怎么看变化。
          detail: t('md_editor.history.restored_hint', { defaultValue: '关闭并重新打开该章节标签即可看到恢复后的正文' }),
          duration: 3600,
        });
        onRestored && onRestored();
      }
      else toast((r && r.error) || t('md_editor.history.restore_fail', { defaultValue: '恢复失败' }), { kind: 'error' });
    } catch (_) { toast(t('md_editor.history.restore_fail', { defaultValue: '恢复失败' }), { kind: 'error' }); }
    finally { setBusy(false); }
  };
  // 删除单条记录:只删审计记录与快照,正文不受影响;删后刷新列表。
  const del = async (v) => {
    if (busy) return;
    const ok = await window.__confirm?.({
      title: t('md_editor.history.delete_confirm', { defaultValue: '删除这条历史记录?' }),
      message: t('md_editor.history.delete_confirm_msg', { defaultValue: '只删这条记录及其改前快照,不会改动正文。删除后无法恢复。' }),
      danger: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api().scripts.commitDelete(scriptId, v.id);
      if (r && r.ok) { toast(t('md_editor.history.deleted', { defaultValue: '已删除该记录' }), { kind: 'ok' }); await load(); }
      else toast((r && r.error) || t('md_editor.history.delete_fail', { defaultValue: '删除失败' }), { kind: 'error' });
    } catch (_) { toast(t('md_editor.history.delete_fail', { defaultValue: '删除失败' }), { kind: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="mde-qopen-scrim" onMouseDown={onClose}>
      <div className="mde-history" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mde-history-head">{t('md_editor.history.title', { n: chapterIndex, defaultValue: '第{{n}}章 · 改动历史' })}</div>
        <div className="mde-history-list">
          {versions === null ? <div className="mde-qopen-empty">{t('common.loading')}</div>
            : versions.length === 0 ? <div className="mde-qopen-empty">{t('md_editor.history.none', { defaultValue: '本章暂无改动历史' })}</div>
              : versions
                // 隐藏无快照的「回滚」标记:它们不可再操作、只是噪音(数据仍在库里)。
                // 带快照的回滚记录(撤销/恢复自身也会存快照)可再次恢复 → 保留显示,形成可逆链。
                .filter((v) => v.kind !== 'chapter_revert' || v.has_before)
                .map((v) => (
                <div key={v.id} className="mde-history-item">
                  <div className="mde-history-meta">
                    <div className="mde-history-line">
                      <span className="mde-history-msg">{v.message || v.kind}</span>
                      {/* 合并计数:编辑器按「编辑会话」合并连续保存(一次连续编辑 = 一条记录)。
                          save_count 动态递增 → 必须在此处渲染,不能写死在后端 message 里。 */}
                      {v.save_count > 1 && (
                        <span className="mde-history-count">
                          {t('md_editor.history.save_count', { n: v.save_count, defaultValue: '含 {{n}} 次保存' })}
                        </span>
                      )}
                    </div>
                    <span className="mde-history-time">{v.created_at ? new Date(v.created_at).toLocaleString() : ''}</span>
                  </div>
                  <div className="mde-history-actions">
                    {/* 有改前快照且未被撤销 → 可恢复(手动编辑/AI 改写/带快照的恢复记录皆同) */}
                    {v.has_before && !v.undone
                      ? <button type="button" className="mde-history-restore" disabled={busy} onMouseDown={() => restore(v.id)}>{t('md_editor.history.restore', { defaultValue: '恢复到此前' })}</button>
                      : <span className="mde-history-tag">{v.undone ? t('md_editor.history.undone', { defaultValue: '已撤销' }) : ''}</span>}
                    <button type="button" className="mde-history-del" disabled={busy} onMouseDown={() => del(v)}>{t('md_editor.history.delete', { defaultValue: '删除' })}</button>
                  </div>
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}

export { ChapterHistory };
