/* overrides 编辑弹窗 OverridesModal(从 ScriptsList.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useState as useStatePL } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../game-icons.jsx';
import Modal from '../Modal.jsx';

/* B3: overrides editor — GET/POST /api/v1/scripts/{id}/overrides (JSONB)。
   显示当前 script_overrides 的 raw JSON，支持 edit/save。 */
function OverridesModal({ script, onClose }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useStatePL("");
  const [loading, setLoading] = useStatePL(false);
  const [saving, setSaving] = useStatePL(false);
  const [err, setErr] = useStatePL("");
  const [dirty, setDirty] = useStatePL(false);

  React.useEffect(() => {
    if (!script) return;
    setLoading(true); setErr(""); setRaw(""); setDirty(false);
    (async () => {
      try {
        const r = await window.api.scripts.getOverrides(script.id);
        const data = r?.data ?? r ?? {};
        setRaw(JSON.stringify(data, null, 2));
      } catch (e) {
        setErr(e?.message || t('scripts.editor.load_fail'));
        setRaw("{}");
      } finally {
        setLoading(false);
      }
    })();
  }, [script?.id]);

  if (!script) return null;

  const onSave = async () => {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      window.__apiToast?.(t('scripts.editor.json_error'), { kind: "danger", detail: e.message });
      return;
    }
    setSaving(true);
    try {
      await window.api.scripts.saveOverrides(script.id, parsed);
      window.__apiToast?.(t('scripts.toast.saved'), { kind: "ok" });
      setDirty(false);
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.save_fail'), { kind: "danger", detail: e?.message });
    } finally {
      setSaving(false);
    }
  };

  let jsonValid = true;
  try { JSON.parse(raw); } catch (_) { jsonValid = false; }

  return (
    // 收口到共享 <Modal>(产同构 DOM,零视觉变化):panelStyle 保 width/maxHeight/flex,
    // footerStyle 保原 marginTop:12,eyebrow/title/close 与原手写一致。
    <Modal
      open
      onClose={onClose}
      eyebrow={<>{t('scripts.editor.overrides_eyebrow')} · {script.title}</>}
      title={loading ? t('common.loading') : "script_overrides JSONB"}
      panelStyle={{ width: "min(700px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      footerStyle={{ marginTop: 12 }}
      footer={(
        <>
          <span className="muted-2" style={{fontSize: 11.5}}>
            GET/POST /api/v1/scripts/{script.id}/overrides
          </span>
          <div style={{display: "flex", gap: 8}}>
            <button className="btn ghost" onClick={onClose}>{t('common.close')}</button>
            <button className="btn primary" onClick={onSave} disabled={saving || !dirty || !jsonValid}>
              {saving ? <><Icon name="spinner" size={12} className="spin" /> {t('scripts.editor.saving')}</> : <><Icon name="check" size={12} /> {t('common.save')}</>}
            </button>
          </div>
        </>
      )}
    >
      {err && <div style={{padding: "8px 16px", color: "var(--danger)", fontSize: 13}}>{err}</div>}
      {!loading && (
        <div style={{flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "0 16px 0"}}>
          <div style={{fontSize: 11.5, color: "var(--muted-2)", marginBottom: 6, paddingTop: 12}}>
            {t('scripts.editor.overrides_hint')}
            {!jsonValid && <span style={{color: "var(--danger)", marginLeft: 8}}>{t('scripts.editor.json_invalid')}</span>}
          </div>
          <textarea
            value={raw}
            onChange={(e) => { setRaw(e.target.value); setDirty(true); }}
            spellCheck={false}
            style={{
              flex: 1, minHeight: 320, fontFamily: "var(--font-mono, monospace)", fontSize: 12.5,
              lineHeight: 1.55, resize: "vertical", background: "var(--bg-deep)",
              border: "1px solid " + (jsonValid ? "var(--line-soft)" : "var(--danger)"),
              borderRadius: "var(--r-2)", padding: "10px 12px", color: "var(--text)",
              outline: "none",
            }}
          />
        </div>
      )}
    </Modal>
  );
}

export { OverridesModal };
