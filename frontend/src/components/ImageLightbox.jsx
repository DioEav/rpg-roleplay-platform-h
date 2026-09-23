import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../game-icons.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

/* ImageLightbox — 统一的图片全屏预览 + 裁剪。
   · createPortal 到 document.body：彻底逃离任何祖先(如 .msplit__media 的 sticky)
     造成的层叠上下文,根治"文字浮在预览图之上"的 z-index bug。
   · view 模式：contain 大图 + 工具条(裁剪 / 下载 / 删除 / 关闭)。
   · crop 模式：canvas 裁剪框(整框拖动 + 8 个 handle 缩放,box-shadow 暗化框外),
     「应用」→ 把裁剪区域画进 canvas → toBlob → onCrop(blob)。

   props:
     open       : 是否显示
     src        : 图片 URL
     alt        : 替代文本
     onClose()  : 关闭
     onCrop(blob) : 可选；提供则显示「裁剪」按钮,应用后回调裁剪结果 Blob(image/png)
     cropHint   : 裁剪态底部提示文案
     downloadUrl : 可选；提供则显示「下载」按钮(window.open 该 URL,后端返回 attachment)
     onDelete()  : 可选；async。提供则显示「删除」按钮,点击先过 ConfirmDialog(danger),
                   确认后 await onDelete()——失败抛错(toast 报错),成功由调用方自行 onClose
*/
export default function ImageLightbox({ open, src, alt = '', onClose, onCrop, cropHint, downloadUrl, onDelete }) {
  const { useState, useEffect, useRef, useCallback } = React;
  const { t } = useTranslation();
  const [mode, setMode] = useState('view');     // 'view' | 'crop'
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [delBusy, setDelBusy] = useState(false);
  const [box, setBox] = useState(null);          // 裁剪框(相对图片显示区的 px){x,y,w,h}
  const imgRef = useRef(null);
  const dragRef = useRef(null);                  // {type:'move'|handle, sx,sy, start:{...}, dims}

  // 打开时重置；Esc 关闭(crop 态先退回 view)
  useEffect(() => {
    if (!open) { setMode('view'); setBox(null); setBusy(false); setConfirmDel(false); setDelBusy(false); return; }
    const h = (e) => {
      if (e.key !== 'Escape') return;
      if (mode === 'crop') { setMode('view'); setBox(null); }
      else onClose && onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, mode, onClose]);

  // 锁滚动(预览/裁剪期间)
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const imgDims = useCallback(() => {
    const el = imgRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height,
             natW: el.naturalWidth || r.width, natH: el.naturalHeight || r.height };
  }, []);

  // 进入裁剪：初始化为居中 78% 框
  const enterCrop = useCallback(() => {
    const d = imgDims();
    if (!d) return;
    const w = d.w * 0.78, h = d.h * 0.78;
    setBox({ x: (d.w - w) / 2, y: (d.h - h) / 2, w, h });
    setMode('crop');
  }, [imgDims]);

  // 拖动 / 缩放
  const onPointerDown = (type) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const d = imgDims();
    if (!d || !box) return;
    dragRef.current = { type, sx: e.clientX, sy: e.clientY, start: { ...box }, dims: d };
    const move = (ev) => {
      const g = dragRef.current; if (!g) return;
      const dx = ev.clientX - g.sx, dy = ev.clientY - g.sy;
      const { w: IW, h: IH } = g.dims;
      let { x, y, w, h } = g.start;
      const MIN = 24;
      if (g.type === 'move') {
        x = Math.min(Math.max(0, x + dx), IW - w);
        y = Math.min(Math.max(0, y + dy), IH - h);
      } else {
        // handle: 含 n/s/e/w 任意组合
        const t = g.type;
        if (t.includes('e')) w = Math.min(Math.max(MIN, w + dx), IW - x);
        if (t.includes('s')) h = Math.min(Math.max(MIN, h + dy), IH - y);
        if (t.includes('w')) { const nx = Math.min(Math.max(0, x + dx), x + w - MIN); w += (x - nx); x = nx; }
        if (t.includes('n')) { const ny = Math.min(Math.max(0, y + dy), y + h - MIN); h += (y - ny); y = ny; }
      }
      setBox({ x, y, w, h });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const applyCrop = useCallback(async () => {
    const d = imgDims();
    if (!d || !box || !onCrop) return;
    setBusy(true);
    try {
      const scaleX = d.natW / d.w, scaleY = d.natH / d.h;
      const sx = Math.round(box.x * scaleX), sy = Math.round(box.y * scaleY);
      const sw = Math.max(1, Math.round(box.w * scaleX)), sh = Math.max(1, Math.round(box.h * scaleY));
      // 自动减小体积:裁剪区最长边限到 1280 等比缩放 + jpeg 0.85 压缩(头像/人设图无需透明通道)
      const MAX = 1280;
      let dw = sw, dh = sh;
      if (Math.max(sw, sh) > MAX) { const k = MAX / Math.max(sw, sh); dw = Math.round(sw * k); dh = Math.round(sh * k); }
      const canvas = document.createElement('canvas');
      canvas.width = dw; canvas.height = dh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgRef.current, sx, sy, sw, sh, 0, 0, dw, dh);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      if (blob) await onCrop(blob);
      setMode('view'); setBox(null);
    } catch (err) {
      try { window.__apiToast && window.__apiToast(t('lightbox.crop_failed'), { kind: 'danger' }); } catch (_) {}
    } finally { setBusy(false); }
  }, [box, onCrop, imgDims]);

  // 删除：ConfirmDialog 确认 → await onDelete()。失败 toast 报错并留在弹窗(busy 复位),
  // 成功由调用方(聊天接线)close —— 缩略图走 SSE image/deleted / 404 onError 两条既有路径移除。
  const confirmDelete = useCallback(async () => {
    if (!onDelete) return;
    setDelBusy(true);
    try {
      await onDelete();
      setConfirmDel(false);
    } catch (_) {
      try { window.__apiToast && window.__apiToast(t('lightbox.delete_failed'), { kind: 'danger' }); } catch (_) {}
    } finally {
      setDelBusy(false);
    }
  }, [onDelete, t]);

  if (!open) return null;

  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const node = (
    <div className="ilb" role="dialog" aria-modal="true" aria-label={t('common.image_preview')}
      onClick={(e) => {
        if (mode !== 'view') return;
        // React portal 的事件沿 **React 树**冒泡:删除确认弹窗(ConfirmDialog)虽再
        // portal 到 body,DOM 上不在 .ilb 里,点击仍会冒到这里——不拦掉就把大图预览
        // 一起关了(点弹窗外部本意只是取消确认)。
        if (e.target instanceof Element && e.target.closest('.pl-modal-backdrop')) return;
        onClose && onClose();
      }}>
      <div className="ilb__stage" onClick={(e) => e.stopPropagation()}>
        <div className="ilb__imgwrap">
          <img ref={imgRef} src={src} alt={alt} className="ilb__img" draggable="false" />
          {mode === 'crop' && box && (
            <div className="ilb-crop" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              onPointerDown={onPointerDown('move')}>
              {HANDLES.map((hd) => (
                <span key={hd} className={`ilb-crop__h ilb-crop__h--${hd}`} data-h={hd}
                  onPointerDown={onPointerDown(hd)} />
              ))}
            </div>
          )}
        </div>

        <div className="ilb__bar">
          {mode === 'view' ? (
            <>
              {onCrop && <button className="ilb__btn" onClick={enterCrop}>✂ {t('lightbox.crop')}</button>}
              {downloadUrl && <button className="ilb__btn" onClick={() => window.open(downloadUrl, '_blank', 'noopener')}>⬇ {t('lightbox.download')}</button>}
              {onDelete && <button className="ilb__btn" onClick={() => setConfirmDel(true)}>🗑 {t('lightbox.delete')}</button>}
              <button className="ilb__btn ilb__btn--ghost" onClick={() => onClose && onClose()}>{t('common.close')}</button>
            </>
          ) : (
            <>
              <span className="ilb__hint">{cropHint || t('lightbox.crop_hint')}</span>
              <button className="ilb__btn ilb__btn--ghost" disabled={busy} onClick={() => { setMode('view'); setBox(null); }}>{t('common.cancel')}</button>
              <button className="ilb__btn" disabled={busy} onClick={applyCrop}>{busy ? t('lightbox.applying') : t('lightbox.apply_crop')}</button>
            </>
          )}
        </div>
      </div>
      {/* 关闭按钮:用 SVG 图标而不是文本 ×。文本 × 的落位取决于字体度量 + 行盒(叠加 button 的
          UA 默认 padding),在 40px 圆里会明显偏高 —— 用户上报「大叉不在圆心」。SVG 在 24×24
          viewBox 内几何居中,与 Modal 的关闭按钮同一做法。 */}
      <button className="ilb__close" aria-label={t('common.close')} onClick={() => onClose && onClose()}>
        <Icon name="close" size={17} />
      </button>
      {/* 删除确认:danger + portal 到 body——lightbox 自身已 portal,弹窗再 portal 保证
          叠在 overlay 之上(与 tavern/game 同款用法)。 */}
      <ConfirmDialog
        open={confirmDel}
        danger
        portal
        title={t('lightbox.delete_confirm_title')}
        body={t('lightbox.delete_confirm_body')}
        confirmLabel={t('common.delete')}
        busy={delBusy}
        onClose={() => !delBusy && setConfirmDel(false)}
        onConfirm={confirmDelete}
      />
    </div>
  );
  return createPortal(node, document.body);
}
