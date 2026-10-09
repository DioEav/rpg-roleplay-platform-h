/* 章节管理弹窗 ChaptersModal(从 ScriptsList.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useState as useStatePL } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import Modal from '../Modal.jsx';
import { PromptModal } from '../../platform-app.jsx';
import { SPLIT_RULES } from './shared.js';

/* task 52：之前剧本只有"alert 章节前 400 字"假预览。补一个真章节浏览/编辑器：
   - GET /api/scripts/{id}/chapters 分页列出
   - GET /api/scripts/{id}/chapter-facts 拿事实摘要（如果有）
   - POST /api/scripts/{id}/chapters/{idx} 重命名 / 改正文
   - POST /api/scripts/{id}/chapters/merge 合并相邻章节
   - POST /api/scripts/{id}/chapters/{idx}/split 拆分单章
   - POST /api/scripts/{id}/resplit 整本重切（rule+pattern）
   全部 BE wrappers 已存，但 FE 之前无入口。 */
function ChaptersModal({ script, onClose, onChanged }) {
  const { t } = useTranslation();
  const [chapters, setChapters] = useStatePL([]);
  const [loading, setLoading] = useStatePL(false);
  const [err, setErr] = useStatePL("");
  const [activeIdx, setActiveIdx] = useStatePL(0);
  const [edit, setEdit] = useStatePL(null); // {idx, title, content}
  const [resplitOpen, setResplitOpen] = useStatePL(false);
  const [reloadTick, setReloadTick] = useStatePL(0);
  // 当前选中章节的完整正文(lazy fetch — 列表 API 只回 180 字符 preview)
  const [activeContent, setActiveContent] = useStatePL("");
  const [activeLoading, setActiveLoading] = useStatePL(false);
  React.useEffect(() => {
    if (!script) return;
    setLoading(true); setErr(""); setActiveIdx(0);
    (async () => {
      try {
        // 一次拉完整本(后端 limit 上限已放到 5000)
        const r = await window.api.scripts.chapters(script.id, { limit: 5000 });
        const list = (r && (r.chapters || r.items)) || [];
        setChapters(list);
      } catch (e) { setErr(e?.message || t('scripts.editor.fetch_fail')); }
      finally { setLoading(false); }
    })();
  }, [script?.id, reloadTick]);
  // 选中章节变化时,lazy fetch 真正文(不预拉全文,避免一次性 12MB 响应)
  React.useEffect(() => {
    if (!script || chapters.length === 0) { setActiveContent(""); return; }
    const cur = chapters[activeIdx];
    if (!cur) { setActiveContent(""); return; }
    // 后端返字段是 chapter_index,不是 index
    const chIdx = cur.chapter_index ?? cur.index ?? activeIdx;
    setActiveLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.scripts.chapterDetail(script.id, chIdx);
        if (cancelled) return;
        setActiveContent((r && r.chapter && r.chapter.content) || "");
      } catch (_) {
        if (!cancelled) setActiveContent(cur.content_preview || "");
      } finally { if (!cancelled) setActiveLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [script?.id, activeIdx, chapters]);
  if (!script) return null;
  const cur = chapters[activeIdx];
  const curIdx = cur ? (cur.chapter_index ?? cur.index ?? activeIdx) : activeIdx;
  const onRename = async () => {
    if (!cur) return;
    const newTitle = await window.__prompt({ title: t('scripts.editor.rename_title'), label: t('scripts.editor.rename_label'), default: cur.title || '' });
    if (!newTitle || newTitle === cur.title) return;
    try {
      await window.api.scripts.updateChapter(script.id, curIdx, { title: newTitle });
      window.__apiToast?.(t('scripts.toast.renamed'), { kind: "ok" });
      setReloadTick(x => x + 1);
      onChanged && onChanged();
    } catch (e) { window.__apiToast?.(t('scripts.toast.op_fail'), { kind: "danger", detail: e?.message }); }
  };
  const onMergeNext = async () => {
    if (!cur || activeIdx >= chapters.length - 1) return;
    if (!await window.__confirm({ title: t('scripts.editor.merge_title'), message: t('scripts.editor.merge_msg', { a: activeIdx + 1, b: activeIdx + 2 }), confirmText: t('scripts.editor.merge_btn') })) return;
    try {
      const nextCh = chapters[activeIdx + 1];
      const nextIdx = nextCh ? (nextCh.chapter_index ?? nextCh.index ?? (activeIdx + 1)) : (activeIdx + 1);
      await window.api.scripts.mergeChapter(script.id, { first_index: curIdx, second_index: nextIdx });
      window.__apiToast?.(t('scripts.toast.merged'), { kind: "ok" });
      setReloadTick(x => x + 1);
      onChanged && onChanged();
    } catch (e) { window.__apiToast?.(t('scripts.toast.op_fail'), { kind: "danger", detail: e?.message }); }
  };
  // 合并上一章:把前面那章折进【当前章】,保留当前章标题(用户反馈:序章/前言没办法合并到第一章)。
  const onMergePrev = async () => {
    if (!cur || activeIdx <= 0) return;
    if (!await window.__confirm({ title: t('scripts.editor.merge_title'), message: t('scripts.editor.merge_prev_msg', { a: activeIdx, b: activeIdx + 1, defaultValue: `把第 ${activeIdx} 章合并进当前的第 ${activeIdx + 1} 章(保留当前章标题)?` }), confirmText: t('scripts.editor.merge_btn') })) return;
    try {
      const prevCh = chapters[activeIdx - 1];
      const prevIdx = prevCh ? (prevCh.chapter_index ?? prevCh.index ?? (activeIdx - 1)) : (activeIdx - 1);
      await window.api.scripts.mergeChapter(script.id, { first_index: prevIdx, second_index: curIdx, keep_title_index: curIdx });
      window.__apiToast?.(t('scripts.toast.merged'), { kind: "ok" });
      setReloadTick(x => x + 1);
      onChanged && onChanged();
    } catch (e) { window.__apiToast?.(t('scripts.toast.op_fail'), { kind: "danger", detail: e?.message }); }
  };
  const onSplit = async () => {
    if (!cur) return;
    const pos = await window.__prompt({ title: t('scripts.editor.split_title'), label: t('scripts.editor.split_label'), default: '' });
    const n = parseInt(pos, 10);
    if (!n || n < 1) return;
    try {
      await window.api.scripts.splitChapter(script.id, curIdx, { split_at: n });
      window.__apiToast?.(t('scripts.toast.split'), { kind: "ok" });
      setReloadTick(x => x + 1);
      onChanged && onChanged();
    } catch (e) { window.__apiToast?.(t('scripts.toast.op_fail'), { kind: "danger", detail: e?.message }); }
  };
  const onResplit = async (vals) => {
    try {
      await window.api.scripts.resplit(script.id, { split_rule: vals.rule || "auto", custom_pattern: vals.pattern || "" });
      window.__apiToast?.(t('scripts.toast.resplit'), { kind: "ok" });
      setResplitOpen(false);
      setReloadTick(x => x + 1);
      onChanged && onChanged();
    } catch (e) { window.__apiToast?.(t('scripts.toast.resplit_fail'), { kind: "danger", detail: e?.message }); }
  };
  return (
   <>
    {/* 收口到共享 <Modal>(产同构 DOM,零视觉变化):头部有额外「重切」按钮 → 用 header 自定义整头 +
        showClose=false 复刻原「标题区 | 重切+关闭」布局;panelStyle 保 width/maxHeight/flex。
        原本嵌在 backdrop 内的 resplit PromptModal 改成 <Modal> 的兄弟节点(自身独立浮层,视觉/行为不变)。 */}
    <Modal
      open
      onClose={onClose}
      showClose={false}
      panelStyle={{ width: "min(960px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      header={(
        <>
          <div>
            <div className="pl-modal-eyebrow">{t('scripts.editor.chapters_eyebrow')} · {script.title}</div>
            <h2 className="pl-modal-title">{loading ? t('common.loading') : t('scripts.editor.chapters_title', { total: chapters.length, cur: activeIdx + 1 })}</h2>
          </div>
          <div style={{display: "flex", gap: 6}}>
            <button className="btn ghost" onClick={() => setResplitOpen(true)} title={t('scripts.editor.resplit_tip')}><Icon name="refresh" size={12} /> {t('scripts.editor.resplit_btn')}</button>
            <button className="iconbtn" onClick={onClose} data-tip={t('common.close')}><Icon name="close" size={14} /></button>
          </div>
        </>
      )}
      footer={(
        <>
          <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
        </>
      )}
    >
        {err && <div className="pl-model-empty" style={{padding: "16px"}}><span className="danger">{t('scripts.editor.load_fail_detail', { err })}</span></div>}
        {!err && chapters.length === 0 && !loading && (
          <div className="pl-model-empty" style={{padding: "24px"}}>{t('scripts.editor.chapters_empty')}</div>
        )}
        {chapters.length > 0 && (
          <div style={{display: "grid", gridTemplateColumns: "220px 1fr", gap: 0, flex: 1, minHeight: 0}}>
            <div style={{borderRight: "1px solid var(--line-soft)", overflow: "auto", maxHeight: 480}}>
              {chapters.map((c, i) => (
                <button key={c.chapter_index ?? c.index ?? i}
                  className="btn ghost"
                  style={{display: "flex", justifyContent: "flex-start", width: "100%", padding: "8px 12px", borderRadius: 0,
                    background: i === activeIdx ? "var(--accent-soft)" : "transparent",
                    fontWeight: i === activeIdx ? 600 : 400,
                    borderBottom: "1px solid var(--line-soft)"}}
                  onClick={() => setActiveIdx(i)}>
                  <span className="muted-2 mono" style={{minWidth: 36, fontSize: 11}}>#{String(i + 1).padStart(3, "0")}</span>
                  <span style={{overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left", fontSize: 12.5}}>
                    {c.title || t('scripts.editor.unnamed_chapter')}
                  </span>
                </button>
              ))}
            </div>
            <div style={{overflow: "auto", padding: 16, maxHeight: 480}}>
              {cur && <>
                <div style={{display: "flex", alignItems: "center", gap: 8, marginBottom: 12}}>
                  <strong style={{fontSize: 15}}>{cur.title || t('scripts.editor.unnamed_chapter')}</strong>
                  {/* 字数读 word_count 列(后端 import 时已计算),不要算 content.length —
                      列表 API 只回 180 字符 preview,算出来全是 0 字 */}
                  <span className="muted-2 mono" style={{fontSize: 11}}>
                    {(cur.word_count || 0).toLocaleString()} {t('scripts.my.char_unit')}
                  </span>
                  <div style={{marginLeft: "auto", display: "flex", gap: 6}}>
                    <button className="btn ghost" onClick={onRename}><Icon name="edit" size={12} /> {t('scripts.editor.rename_btn')}</button>
                    <button className="btn ghost" onClick={onSplit}><Icon name="branch" size={12} /> {t('scripts.editor.split_chapter_btn')}</button>
                    {activeIdx > 0 && (
                      <button className="btn ghost" onClick={onMergePrev}><Icon name="link" size={12} /> {t('scripts.editor.merge_prev_btn', { defaultValue: '合并上一章' })}</button>
                    )}
                    {activeIdx < chapters.length - 1 && (
                      <button className="btn ghost" onClick={onMergeNext}><Icon name="link" size={12} /> {t('scripts.editor.merge_next_btn')}</button>
                    )}
                  </div>
                </div>
                {/* 正文 lazy 加载;先放 preview,等 chapterDetail 回来再换全文 */}
                <pre style={{whiteSpace: "pre-wrap", fontFamily: "var(--font-serif)", fontSize: 13.5, lineHeight: 1.7, margin: 0}}>
                  {activeLoading
                    ? (cur.content_preview || "") + "\n\n" + t('common.loading')
                    : (activeContent || cur.content_preview || "").slice(0, 8000)
                       + ((activeContent && activeContent.length > 8000) ? t('scripts.editor.content_truncated') : "")}
                </pre>
              </>}
            </div>
          </div>
        )}
    </Modal>
      <PromptModal
        open={resplitOpen}
        eyebrow={t('scripts.editor.resplit_btn')}
        title={`${script.title} · ${t('scripts.editor.resplit_prompt_title')}`}
        fields={[
          // 复用与「导入」完全一致的规则列表(= 后端 chapter_splitter.RULE_PATTERNS 的真实键)。
          // 旧版这里硬编码了 blank/marker/regex,后端没有这些规则 → 静默退化成 auto、且 regex
          // 不等于 custom 导致自定义正则被忽略(用户反馈:整本重切识别不出第X章,导入却能)。
          { key: "rule", label: t('scripts.import.field_rule'), type: "select", default: "auto",
            options: SPLIT_RULES.map(r => ({ value: r.id, label: t(r.labelKey) })) },
          { key: "pattern", label: t('scripts.import.field_custom_regex'), placeholder: t('scripts.import.field_custom_regex_placeholder') },
        ]}
        submitLabel={t('scripts.editor.resplit_submit')}
        onClose={() => setResplitOpen(false)}
        onConfirm={onResplit}
      />
   </>
  );
}

export { ChaptersModal };
