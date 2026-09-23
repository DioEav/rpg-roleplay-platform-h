import React from 'react';
import { useTranslation } from 'react-i18next';

/* ReferenceImagePicker — 生图参考图选择器（i2i）。

   props:
     refs    : string[]        已选参考图的站内 URL（受控）
     onChange: (next)=>void    增删后回传完整列表
     max     : number          上限（默认 4 —— **唯一可调常量**，改这一处全站生效；
                               后端各适配器按模型名各自再截：doubao seedream-4 ≤10、
                               gpt-image ≤16、gemini ≤6、chat 模态 ≤4）

   两个来源:
     ① 本地上传 → window.api.images.refUpload(file) → {ok,url}（POST /api/images/ref-upload）
        · 后端做魔数白名单 + 8MB 上限；这里**前置**同规格拦截给即时行内报错
     ② 从图库选 → api.library.list() 懒加载（首次展开才拉），.ms-lib__cell 多选确认

   已选缩略图复用 .ms-lib__cell 样式 + 逐张 × 删除；满 max 禁选并提示。
   i18n 命名空间 components.reference_image.*（两个宿主复用同一份）。 */
export const REF_MAX_DEFAULT = 4;

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 8 * 1024 * 1024; // 与后端 _REF_MAX_BYTES 同规格（前端只为即时报错，后端仍是准）

// 图库过滤口径(见 toggleLib 内注释):已知图片 kind,或 url 以图片扩展名结尾
const IMAGE_KIND_RE = /^(ai_image|card_image|avatar|cover)$/;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)(\?|#|$)/i;

export default function ReferenceImagePicker({ refs = [], onChange, max = REF_MAX_DEFAULT }) {
  const { useState, useRef, useCallback } = React;
  const { t } = useTranslation();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);      // 上传中（禁按钮，防重复提交）
  const [libOpen, setLibOpen] = useState(false);
  const [libItems, setLibItems] = useState(null); // null=未拉（照 MediaStudio 懒加载模式）
  const [libSel, setLibSel] = useState([]);       // 图库里已勾选、待确认的 url
  const fileRef = useRef(null);

  const api = (typeof window !== 'undefined' && window.api) || {};
  const full = refs.length >= max;

  const emit = useCallback((next) => {
    setErr('');
    onChange && onChange(next);
  }, [onChange]);

  // ── 来源① 本地上传 ──
  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';   // 清掉 value，否则连选两次同一文件不触发 change
    if (!files.length) return;

    if (refs.length + files.length > max) {
      setErr(t('components.reference_image.error.over_limit', { max }));
      return;
    }
    for (const f of files) {
      if (!ACCEPT.includes(f.type)) {
        setErr(t('components.reference_image.error.bad_type', { name: f.name }));
        return;
      }
      if (f.size > MAX_BYTES) {
        setErr(t('components.reference_image.error.too_large', { name: f.name }));
        return;
      }
    }

    setBusy(true);
    setErr('');
    try {
      const added = [];
      for (const f of files) {
        const r = await (api.images && api.images.refUpload
          ? api.images.refUpload(f)
          : Promise.reject(new Error('refUpload unavailable')));
        if (r && r.ok && r.url) added.push(r.url);
        else throw new Error((r && r.error) || t('components.reference_image.error.upload_failed'));
      }
      emit([...refs, ...added]);
    } catch (e2) {
      setErr(t('components.reference_image.error.upload_failed', { msg: (e2 && e2.message) || '' }));
    } finally {
      setBusy(false);
    }
  }

  // ── 来源② 图库多选（懒加载：首次展开才拉一次） ──
  function toggleLib() {
    const next = !libOpen;
    setLibOpen(next);
    setLibSel([]);
    if (next && libItems === null && api.library && api.library.list) {
      api.library.list().then((r) => {
        const items = (r && r.items) || [];
        // 过滤口径:**kind 白名单 或 url 是图片扩展名**。
        // 只认 kind 会漏 —— register_asset 的调用点众多,FileLibrary 对未知 kind 是兜底展示
        // (label 直接用原始 kind),picker 若按白名单硬滤,就会出现「文件库有图、这里却空」
        // (用户上报)。url 扩展名兜底后,文件库里看得到的图片这里一定看得到。
        setLibItems(items.filter((a) => a && a.url
          && (IMAGE_KIND_RE.test(a.kind || '') || IMAGE_EXT_RE.test(a.url))));
      }).catch(() => setLibItems([]));
    }
  }

  function toggleLibSel(url) {
    setLibSel((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));
  }

  function confirmLib() {
    const room = max - refs.length;
    const over = libSel.length > room;
    const picked = libSel.slice(0, room);
    // 先 emit 再设错误:emit 会清 err(见下),顺序反了超限提示会立刻被自己清掉,用户永远看不到
    if (picked.length) emit([...refs, ...picked]);
    if (over) setErr(t('components.reference_image.error.over_limit', { max }));
    setLibSel([]);
    setLibOpen(false);
  }

  function removeAt(url) {
    emit(refs.filter((u) => u !== url));
  }

  return (
    <div className="rif" role="group" aria-label={t('components.reference_image.label')}>
      <div className="rif__row">
        <button
          type="button"
          className="rif__btn"
          disabled={busy || full}
          onClick={() => fileRef.current && fileRef.current.click()}
        >
          {busy ? t('components.reference_image.uploading') : t('components.reference_image.upload_btn')}
        </button>
        <button
          type="button"
          className={`rif__btn${libOpen ? ' is-active' : ''}`}
          disabled={full}
          onClick={toggleLib}
        >
          {t('components.reference_image.library_btn')}
        </button>
        <span className="rif__count">{refs.length} / {max}</span>
      </div>
      <div className="rif__hint">{t('components.reference_image.hint')}</div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={handleFiles}
      />

      {refs.length > 0 && (
        <div className="ms-lib rif__sel">
          {refs.map((u) => (
            <div key={u} className="ms-lib__cell is-sel rif__cell">
              <img src={u} alt="" loading="lazy" />
              <button
                type="button"
                className="rif__rm"
                aria-label={t('components.reference_image.remove')}
                title={t('components.reference_image.remove')}
                onClick={() => removeAt(u)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {full && <div className="rif__full">{t('components.reference_image.full_hint', { max })}</div>}
      {err && <div className="rif__err">{err}</div>}

      {libOpen && (
        <div className="rif__lib">
          {libItems === null
            ? <div className="rif__libempty">{t('components.reference_image.loading')}</div>
            : libItems.length === 0
              ? <div className="rif__libempty">{t('components.reference_image.lib_empty')}</div>
              : (
                <div className="ms-lib">
                  {libItems.map((a) => (
                    <div
                      key={a.id}
                      className={`ms-lib__cell${libSel.includes(a.url) ? ' is-sel' : ''}`}
                      onClick={() => toggleLibSel(a.url)}
                      title={a.source}
                    >
                      <img src={a.url} alt="" loading="lazy" />
                    </div>
                  ))}
                </div>
              )}
          <div className="rif__row rif__row--end">
            <button type="button" className="rif__btn" onClick={() => { setLibOpen(false); setLibSel([]); }}>
              {t('components.reference_image.cancel')}
            </button>
            <button
              type="button"
              className="rif__btn rif__btn--primary"
              disabled={!libSel.length}
              onClick={confirmLib}
            >
              {t('components.reference_image.confirm', { n: libSel.length })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
