/* Extracted from pages/MobileSaves.jsx — mechanical split, byte-for-byte. */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons.jsx';
import { API } from './helpers.js';

/* ── 存档设置表单(内嵌) ─────────────────────────────────── */
function SaveSettingsPane({ saveId, onToast }) {
  const { t } = useTranslation();
  const [schema, setSchema] = useState(null);
  const [vals, setVals] = useState({});
  const [init, setInit] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [loadErr, setLoadErr] = useState('');

  useEffect(() => {
    let dead = false; setSchema(null); setErr(''); setLoadErr('');
    fetch(`${API()}/api/saves/${saveId}/settings`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (dead) return;
        if (d.ok !== false) {
          setSchema(d.schema);
          const v = {};
          (d.schema?.fields || []).forEach(f => { v[f.key] = (d.settings && d.settings[f.key]) ?? f.default; });
          setVals(v); setInit(v);
        } else setLoadErr(d.error || t('mobile.saves.settings.load_failed'));
      })
      .catch(e => { if (!dead) setLoadErr(String(e)); });
    return () => { dead = true; };
  }, [saveId]);

  if (loadErr) return (
    <div className="pl-empty"><p>{loadErr}</p></div>
  );
  if (!schema) return (
    <div className="pl-empty" style={{ padding: 32 }}>
      <div className="ic"><Icon name="settings" size={22} /></div>
      <p>{t('mobile.saves.settings.loading')}</p>
    </div>
  );

  const fields = schema.fields || [];
  const dirty = JSON.stringify(vals) !== JSON.stringify(init);

  const save = async () => {
    const changed = {};
    Object.keys(vals).forEach(k => { if (vals[k] !== init[k]) changed[k] = vals[k]; });
    if (!Object.keys(changed).length) return;
    setSaving(true); setErr('');
    try {
      const r = await fetch(`${API()}/api/saves/${saveId}/settings`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: changed, is_create: false }),
      }).then(x => x.json());
      if (r.applied !== undefined) {
        setInit(vals);
        const rej = r.rejected && Object.keys(r.rejected);
        if (rej && rej.length) onToast(t('mobile.saves.settings.partial_locked', { fields: rej.join('/') }), 'warn');
        else onToast(t('mobile.saves.settings.saved'), 'ok');
      } else { setErr(r.error || t('mobile.saves.settings.save_failed')); }
    } catch (e) { setErr(String(e)); }
    setSaving(false);
  };

  return (
    <div style={{ padding: '4px 0' }}>
      {fields.map(f => (
        <div key={f.key} className="pl-field" style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12.5, color: 'var(--text-quiet)', fontWeight: 500 }}>{f.label}</label>
          {/* help 描述不再显示(2026-10-16):选项已本地化为自解释中文标签,与桌面 SavesList 同步 */}
          {f.options ? (
            <select
              value={vals[f.key] ?? ''}
              onChange={e => setVals(p => ({ ...p, [f.key]: e.target.value }))}
              style={{ width: '100%', height: 46, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 16, padding: '0 14px', outline: 'none' }}
            >
              {/* 枚举选项显示本地化标签(与桌面 SavesList 同键),存储值仍是原始英文枚举 */}
              {f.options.map(o => <option key={o} value={o}>{t(`saves.settings_opt.${f.key}.${o}`, { defaultValue: o })}</option>)}
            </select>
          ) : (
            <input
              className="pl-input"
              value={vals[f.key] ?? ''}
              onChange={e => setVals(p => ({ ...p, [f.key]: e.target.value }))}
              style={{ fontSize: 16 }}
            />
          )}
        </div>
      ))}
      {err && (
        <div style={{
          color: 'var(--danger)', padding: '9px 12px', borderRadius: 10,
          background: 'var(--danger-soft)', border: '1px solid rgba(200,103,93,0.3)',
          fontSize: 13, marginBottom: 12,
        }}>{err}</div>
      )}
      <button
        className="pl-btn-primary"
        disabled={!dirty || saving}
        onClick={save}
        style={{ opacity: (!dirty || saving) ? 0.5 : 1 }}
      >
        {saving ? t('mobile.saves.settings.saving') : t('mobile.saves.settings.save_btn')}
      </button>
    </div>
  );
}

export { SaveSettingsPane };
