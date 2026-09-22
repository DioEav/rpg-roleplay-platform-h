/* 剧本封面 CoverFrame(从 ScriptDetail.jsx 二次拆出,纯机械搬家零行为变化)。 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import ImageLightbox from '../ImageLightbox.jsx';

// 剧本封面:宽高比自适应海报(模糊填充 + contain),竖/方/横封面都完整显示;悬停更换 + 点击放大。
function CoverFrame({ src, title, isOwner, onEdit }) {
  const { t } = useTranslation();
  const [aspect, setAspect] = React.useState(null);
  const [light, setLight] = React.useState(false);
  React.useEffect(() => { setAspect(null); }, [src]);
  React.useEffect(() => {
    if (!light) return;
    const h = (e) => { if (e.key === 'Escape') setLight(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [light]);
  const onLoad = (e) => {
    const w = e.target && e.target.naturalWidth, h = e.target && e.target.naturalHeight;
    if (w && h) { const r = Math.max(0.62, Math.min(1.78, w / h)); setAspect(`${r.toFixed(4)} / 1`); }
  };
  return (
    <div className="mh-hero" style={{ ...(aspect ? { aspectRatio: aspect } : { aspectRatio: '16 / 9' }), cursor: 'zoom-in' }} onClick={() => setLight(true)}>
      <img src={src} className="mh-hero__fill" alt="" aria-hidden="true" loading="lazy" />
      <img src={src} className="mh-hero__img" alt={title} loading="lazy" onLoad={onLoad} />
      <div className="mh-hero__scrim" />
      <div className="mh-hero__meta"><div className="mh-hero__name" style={{ fontSize: 20 }}>{title}</div></div>
      {isOwner && (
        <div className="mh-hero__actions">
          <span className="mh-chip" onClick={(e) => { e.stopPropagation(); onEdit && onEdit(); }}>{t('scripts.page.change_cover')}</span>
        </div>
      )}
      {/* 全屏预览走 portal 化的 ImageLightbox:此前手写的 .mlb-backdrop 是内联 position:fixed,
          会被祖先的 animation(… forwards)/sticky 造出的包含块困住(黑幕只盖局部、图跑到视口外)。 */}
      {light && (
        <ImageLightbox open src={src} alt={title} onClose={() => setLight(false)} />
      )}
    </div>
  );
}

export { CoverFrame };
