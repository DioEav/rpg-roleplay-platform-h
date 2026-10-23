import React, { useCallback, useRef } from 'react';
import { Toggle } from '../Toggle.jsx';  // 权威单一实现(语义统一);caps/shared.jsx 同源 re-export。settings 侧 11 处调用均不传 disabled,行为逐字一致

// K/M 缩写统一到 window.__fmt.compact(data-loader.js;语义统一 #30),保留本地别名免改调用点。
function fmtCtx(n) {
  if (window.__fmt && window.__fmt.compact) return window.__fmt.compact(n);
  if (!n) return '—';
  if (n>=1_000_000) return `${(n/1_000_000).toFixed(0)}M`;
  if (n>=1_000) return `${(n/1_000).toFixed(0)}K`;
  return String(n);
}

/* ── 可复用小件 ─────────────────────────────────────────────────── */
function SetGroup({ title, children, action }) {
  return (
    <div className="pl-sec">
      <div className="pl-sec-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="pl-group">{children}</div>
    </div>
  );
}

function MSlider({ label, desc, value, min, max, step, onChange, disabled = false }) {
  const decimals = step < 1 ? (String(step).split('.')[1]||'').length : 0;
  return (
    <div className="pl-field" style={{ opacity: disabled ? 0.55 : 1 }}>
      <div className="pl-slider-head">
        <span className="lab">{label}</span>
        <span className="val">{Number(value).toFixed(decimals)}</span>
      </div>
      {desc && <span className="desc" style={{ fontSize: 11, color: 'var(--muted-2)', marginBottom: 6, display: 'block' }}>{desc}</span>}
      <input
        className="pl-slider"
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div className="pl-seg2">
      {options.map(([id, label]) => (
        <button
          key={id}
          className={value === id ? 'active accent' : ''}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* 存入 user_preferences 的自动保存 helper — 直接 POST 用户偏好 */
function usePrefSave(namespace) {
  const timerRef = useRef(null);
  const pendRef = useRef({});
  const save = useCallback((key, value) => {
    const fullKey = namespace ? `${namespace}.${key}` : key;
    pendRef.current[fullKey] = value;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const batch = pendRef.current;
      pendRef.current = {};
      try {
        await window.api.account.preferences(batch);
      } catch (_) {}
    }, 400);
  }, [namespace]);
  return save;
}

export { fmtCtx, Toggle, SetGroup, MSlider, Seg, usePrefSave };
