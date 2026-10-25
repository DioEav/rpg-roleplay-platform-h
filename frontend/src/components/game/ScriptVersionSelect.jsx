/* Game Console 顶栏 script 版本历史下拉(ScriptVersionSelect)。
   只读查看器:GET /api/scripts/{id}/commits?limit=10 拉最近 10 个 commit。
   后端 POST /api/scripts/{id}/checkout/{commit_id} 仍是返回 501 的 stub,所以这里
   不再渲染可点击的「切换」假交互(旧版非 HEAD 全 disabled、HEAD 点了也无操作)。 */
import React from 'react';
import { useTranslation } from 'react-i18next';

// ---- Script Version Select — 顶栏 script 版本历史 dropdown(只读) ----
function ScriptVersionSelect({ scriptId, headCommitId }) {
  const { t } = useTranslation();
  const [commits, setCommits] = React.useState([]);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!scriptId) return;
    (async () => {
      try {
        const r = await window.api.scripts.commits(scriptId, { limit: 10 });
        const list = Array.isArray(r) ? r : (r?.items || r?.commits || []);
        setCommits(list);
      } catch (_) {}
    })();
  }, [scriptId]);

  if (!scriptId || commits.length === 0) return null;

  const headShort = headCommitId ? String(headCommitId).slice(0, 8) : '—';

  return (
    <div style={{ position: 'relative', display: 'inline-block', marginLeft: 8 }}>
      <button
        className="btn ghost"
        style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 4 }}
        onClick={() => setOpen(v => !v)}
        title={t('game.console.version.switch_tip')}
      >
        <span>HEAD · {headShort}</span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 1499 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 1500, marginTop: 4,
            background: 'var(--panel, #1a1d22)', border: '1px solid var(--line-soft)',
            borderRadius: 6, minWidth: 280, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            overflow: 'hidden',
          }}>
            <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--muted)', borderBottom: '1px solid var(--line-soft)' }}>
              {t('game.console.version.header', { count: commits.length })}
            </div>
            {commits.map((c) => {
              // 后端 commit id 是 bigint(number),不能直接 .slice;统一转字符串比较/截断。
              const isCurrent = headCommitId != null && String(c.id) === String(headCommitId);
              return (
                // 只读行:不再是 button(避免「看起来能切换」);保留当前 HEAD 高亮。
                <div
                  key={c.id}
                  className="gc-version-row"
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    width: '100%', padding: '6px 10px', gap: 8, boxSizing: 'border-box',
                    background: isCurrent ? 'var(--accent-soft, rgba(212,164,94,0.12))' : 'transparent',
                    fontWeight: isCurrent ? 600 : 400, borderBottom: '1px solid var(--line-soft)',
                    opacity: isCurrent ? 1 : 0.6,
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: isCurrent ? 'var(--accent)' : 'inherit' }}>
                    {String(c.id || '').slice(0, 8)}
                  </span>
                  <span style={{ flex: 1, textAlign: 'left', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.message || c.kind || '—'}
                  </span>
                  {isCurrent && (
                    <span style={{ fontSize: 10, color: 'var(--ok)', flexShrink: 0 }}>HEAD</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export { ScriptVersionSelect };
