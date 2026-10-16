/**
 * HelpDrawer.jsx — 软件内帮助系统
 *
 * 暴露:
 *   <HelpDrawerRoot />        —— 挂到 platform-app 根节点一次即可
 *   window.__openHelp(slug)   —— 任意代码打开对应帮助页
 *
 * 内容来源:开源文档站 docs.stellatrix.icu 的**嵌入视图** /embed/<slug>,以 iframe
 * 在本抽屉(同控件)内打开,不跳新页。单一文档源 = 文档站,前端**不再打包 markdown**
 * —— 文档逐页更新即生效,无需重新发版前端。文档站离线/不可达时给「在新标签打开」入口。
 *
 * 抽屉内换页:嵌入页点内部文档链接 → 在 iframe 内跳 /embed/<otherslug> 并 postMessage
 * 通知本抽屉(help-nav 换 slug / help-ready 同步标题)。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import CSModal from '@cloudscape-design/components/modal';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Spinner from '@cloudscape-design/components/spinner';
import { DOCS_ORIGIN } from '../lib/brand.js';

const embedUrl = (slug) => `${DOCS_ORIGIN}/embed/${encodeURIComponent(slug)}/`;

// ── HelpDrawer ──────────────────────────────────────────────────────────────
export function HelpDrawer({ open, slug, onClose }) {
  const { t } = useTranslation();
  const [curSlug, setCurSlug] = React.useState(slug);
  const [title, setTitle] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  // 新的 __openHelp(prop slug 变化)→ 重置状态
  React.useEffect(() => {
    if (!open) return;
    setCurSlug(slug); setTitle(''); setLoaded(false); setFailed(false);
  }, [slug, open]);

  // 监听文档站 postMessage:help-ready(标题)/ help-nav(站内换页)
  React.useEffect(() => {
    function onMsg(e) {
      if (e.origin !== DOCS_ORIGIN) return; // 仅信任文档站来源
      const d = e.data || {};
      if (d.type === 'help-ready') { setLoaded(true); setFailed(false); if (d.title) setTitle(d.title); }
      else if (d.type === 'help-nav' && d.slug) { setCurSlug(d.slug); setTitle(''); setLoaded(false); setFailed(false); }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 加载超时兜底:8s 内 iframe 既没 onLoad 也没 help-ready → 判失败(按设计只连文档站,
  // 不打包离线副本),给「在新标签打开」入口。
  React.useEffect(() => {
    if (!open || !curSlug || loaded) return;
    const id = setTimeout(() => setFailed((f) => (loaded ? f : true)), 8000);
    return () => clearTimeout(id);
  }, [open, curSlug, loaded]);

  const src = curSlug ? embedUrl(curSlug) : '';

  return (
    <CSModal
      visible={open}
      onDismiss={onClose}
      size="large"
      header={
        <Box variant="h2">
          <span style={{ fontSize: '0.8em', color: 'var(--muted)', marginRight: 8 }}>
            {t('help_drawer.help')}
          </span>
          {title || (curSlug ? '…' : '')}
        </Box>
      }
      footer={
        <Box float="right">
          {src ? (
            <Button variant="link" iconName="external" href={src} target="_blank"
              ariaLabel={t('help_drawer.open_external', { defaultValue: '在新标签打开' })}>
              {t('help_drawer.open_external', { defaultValue: '在新标签打开' })}
            </Button>
          ) : null}
          <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
        </Box>
      }
    >
      {curSlug ? (
        <div style={{ position: 'relative', minHeight: '70vh' }}>
          <iframe
            key={src}
            src={src}
            title={title || 'help'}
            onLoad={() => setLoaded(true)}
            referrerPolicy="no-referrer"
            style={{ width: '100%', height: '70vh', border: 'none', background: 'transparent', display: 'block' }}
          />
          {!loaded && !failed ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <Spinner size="large" />
            </div>
          ) : null}
          {failed ? (
            <div style={{ position: 'absolute', insetInline: 0, top: 0, display: 'flex', justifyContent: 'center' }}>
              <Box color="text-body-secondary" padding="s">
                {t('help_drawer.load_failed', { defaultValue: '文档加载失败(需联网访问文档站)。' })}{' '}
                <a href={src} target="_blank" rel="noopener noreferrer">
                  {t('help_drawer.open_external', { defaultValue: '在新标签打开' })}
                </a>
              </Box>
            </div>
          ) : null}
        </div>
      ) : (
        <Box color="text-body-secondary">{t('help_drawer.no_slug')}</Box>
      )}
    </CSModal>
  );
}

// ── HelpDrawerRoot —— 挂载一次,监听 window.__openHelp ─────────────────────
const OPEN_EVENT = 'help:open';

export function HelpDrawerRoot() {
  const [state, setState] = React.useState({ open: false, slug: '' });

  React.useEffect(() => {
    window.__openHelp = (slug) => {
      window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { slug } }));
    };
    const handler = (e) => setState({ open: true, slug: e.detail?.slug ?? '' });
    window.addEventListener(OPEN_EVENT, handler);
    return () => {
      window.removeEventListener(OPEN_EVENT, handler);
      delete window.__openHelp;
    };
  }, []);

  const handleClose = React.useCallback(() => setState((s) => ({ ...s, open: false })), []);

  return (
    <HelpDrawer
      open={state.open}
      slug={state.slug}
      onClose={handleClose}
    />
  );
}

export default HelpDrawerRoot;
