/* Game Console 使用须知弹窗(GCWelcomeModal)。
   注意:游戏台当前已移除入口(顶栏按产品要求只保留反馈),本组件仅保留文件,
   不再被 game-console.jsx 挂载;恢复入口时重新接入即可。 */
import React from 'react';
import { useTranslation } from 'react-i18next';

// ---- GCWelcomeModal — 游戏控制台内的使用须知弹窗 ----
// 与 platform-app.jsx 的 WelcomeModal 功能等价，独立实现（不跨 bundle 导入）
function GCWelcomeModal({ open, onClose }) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--panel, #1c1a18)', border: '1px solid var(--line-strong, #4a4540)',
          borderRadius: 12, width: 'min(520px, 96vw)', maxHeight: '88vh', overflowY: 'auto',
          padding: '20px 22px', boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4 }}>{t('game.console.welcome.eyebrow')}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{t('game.console.welcome.title')}</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--muted)', fontSize: 18, lineHeight: 1, padding: 4 }}
            aria-label={t('common.close')}
          >×</button>
        </div>
        {/* 测试期免责 */}
        <div style={{ background: 'rgba(220,80,60,0.10)', border: '1px solid rgba(220,80,60,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e07060', marginBottom: 4 }}>{t('game.console.welcome.disclaimer_title')}</div>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text-quiet, #9a9590)' }}>
            {t('game.console.welcome.disclaimer_body')}
          </div>
        </div>
        {/* 反馈流程 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{t('game.console.welcome.feedback_title')}</div>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text-quiet, #9a9590)' }}>
            {t('game.console.welcome.feedback_body')}
          </div>
        </div>
        {/* API 说明 */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{t('game.console.welcome.byok_title')}</div>
          <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text-quiet, #9a9590)' }}>
            {t('game.console.welcome.byok_body')}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => { onClose(); window.open('/settings-models', '_blank'); }}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line-strong)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}
          >{t('game.console.welcome.configure_key_btn')}</button>
          <button
            onClick={onClose}
            style={{ padding: '6px 14px', borderRadius: 6, border: 0, background: 'var(--accent, #c49b4e)', color: '#1a1610', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >{t('game.console.welcome.got_it_btn')}</button>
        </div>
      </div>
    </div>
  );
}

export { GCWelcomeModal };
