/* ManualBadge — 手编数据提示标签 + 精确解锁弹层（2026-10）.
   · 字段级手编：manual_fields 非空 → 显示「手编」；点击弹层逐字段取消保护。
   · 旧数据只有 source='editor'、没有 manual_fields → 显示「手编」；弹层提供整行取消。
   · onUnlock(field|null) 由父组件提供，返回 Promise；成功后本组件才移除本地字段。
   · 弹层用 portal + fixed 定位，避免被表格单元格/滚动容器裁切。
*/
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

const POPOVER_WIDTH = 250;

export function ManualBadge({ fields, source, kind, style, title, onUnlock }) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  // 本地隐藏：旧数据整行解锁成功后，父组件 reload 前不应继续显示「手编」。
  // （后端解锁会把 source 改成 platform/extracted；若 reload 失败，下次 prop
  //  变化 effect 会复位，仍能重新提示。）
  const [hidden, setHidden] = React.useState(false);
  const [localFields, setLocalFields] = React.useState(
    Array.isArray(fields) ? fields.filter(Boolean) : [],
  );
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  const btnRef = React.useRef(null);
  const popRef = React.useRef(null);

  React.useEffect(() => {
    setHidden(false);
    setLocalFields(Array.isArray(fields) ? fields.filter(Boolean) : []);
  }, [fields, source]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 只有“完全没有字段清单”的旧数据才算整行保护。manual_fields=[] 是字段级
  // 清单（只是当前没有受保护字段），不能因为 source 仍是 editor 就误显示旧数据提示。
  const hasFieldList = Array.isArray(fields);
  const legacy = !hasFieldList && String(source || '') === 'editor';
  if (hidden || (localFields.length === 0 && !legacy)) return null;
  const canUnlock = typeof onUnlock === 'function';

  // 字段名本地化：manual.fields.<kind>.<field>；缺翻译时回退原始 key。
  // kind 由四个调用方传入（card / canon / worldbook），锚点走行级不传。
  const fieldLabel = (f) => t(`manual.fields.${kind}.${f}`, { defaultValue: f });
  const labels = localFields.map(fieldLabel);

  const tip = localFields.length
    ? t('manual.tip_fields', {
        defaultValue: '手编字段：{{fields}}',
        fields: labels.join('、'),
      })
    : t('manual.tip_legacy', { defaultValue: '手编内容（旧数据，整行保护）' });

  const toggle = (e) => {
    if (!canUnlock) return;
    e.stopPropagation();
    const r = (e.currentTarget || btnRef.current).getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - 8));
    const top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 300));
    setPos({ top, left });
    setOpen((v) => !v);
  };

  const unlock = async (field) => {
    if (!canUnlock) return;
    // 取消勾选立即调用 onUnlock（用户确认：解锁即生效，无需二次确认）。
    // 父组件负责 API + reload + toast；失败时保留本地字段。
    try {
      await onUnlock(field);
    } catch (_) {
      return; // 父组件负责 toast；失败时保留本地字段
    }
    if (field) {
      setLocalFields((prev) => prev.filter((f) => f !== field));
    } else {
      setLocalFields([]);
      setHidden(true);
      setOpen(false);
    }
  };

  return (
    <>
      <span
        ref={btnRef}
        role={canUnlock ? 'button' : undefined}
        tabIndex={canUnlock ? 0 : undefined}
        title={title || tip}
        onClick={toggle}
        onKeyDown={(e) => {
          if (canUnlock && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggle(e);
          }
        }}
        style={{
          display: 'inline-block',
          marginLeft: 6,
          padding: '0 6px',
          fontSize: 11,
          lineHeight: '18px',
          borderRadius: 3,
          border: '1px solid var(--accent, #8a6d3b)',
          color: 'var(--accent, #8a6d3b)',
          verticalAlign: 'middle',
          whiteSpace: 'nowrap',
          cursor: canUnlock ? 'pointer' : 'default',
          ...(style || {}),
        }}
      >
        {t('manual.badge', { defaultValue: '手编' })}
      </span>
      {open && canUnlock && createPortal(
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            maxHeight: 300,
            overflow: 'auto',
            zIndex: 9999,
            background: 'var(--bg, #fff)',
            color: 'var(--text, #222)',
            border: '1px solid var(--border, #d8d2c4)',
            borderRadius: 6,
            boxShadow: '0 8px 28px rgba(0,0,0,.18)',
            padding: 10,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {t('manual.unlock_title', { defaultValue: '手编字段（勾选 = 受保护）' })}
          </div>
          {legacy ? (
            <>
              <div style={{ fontSize: 11, color: 'var(--muted, #777)', marginBottom: 8 }}>
                {t('manual.legacy_hint', {
                  defaultValue: '旧数据没有字段清单，整行受保护。取消后允许重建覆盖。',
                })}
              </div>
              <button
                type="button"
                onClick={() => unlock(null)}
                style={{
                  padding: '4px 10px', fontSize: 12, cursor: 'pointer',
                  border: '1px solid var(--danger, #b4483c)',
                  color: 'var(--danger, #b4483c)',
                  background: 'transparent', borderRadius: 4,
                }}
              >
                {t('manual.unlock_all', { defaultValue: '取消整行手编' })}
              </button>
            </>
          ) : (
            <>
              {localFields.map((f) => (
                <label
                  key={f}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 12, padding: '3px 0', cursor: 'pointer',
                  }}
                >
                  <input type="checkbox" checked onChange={() => unlock(f)} />
                  <span>{fieldLabel(f)}</span>
                </label>
              ))}
              <div style={{ fontSize: 11, color: 'var(--muted, #777)', marginTop: 4 }}>
                {t('manual.unlock_hint', {
                  defaultValue: '取消勾选后，该字段允许下一次重建用 LLM 结果覆盖。',
                })}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

export default ManualBadge;
