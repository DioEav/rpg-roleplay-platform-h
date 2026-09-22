/* Game Console 聊天区外壳(ChatArea)—— 纯机械从 game-app.jsx 搬出,DOM/视觉/行为零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useState as useStateA, useRef as useRefA, useMemo as useMemoA } from 'react';
import { Icon } from '../../game-icons.jsx';
import { useStickToBottom } from '../../hooks/useStickToBottom.js';
import { ToolCallBlock } from '../ToolCallBlock.jsx';
import { NarrativeBlock, PlayerBlock, useSaveImages } from './GameChatMessages.jsx';
import { chatImageAnchor } from './chat-image-anchor.js';
import { ThinkingPill } from './GameLeftRail.jsx';

function ChatArea({ history, runState, runStyle, narrativeFont, narrativeSize, hasError, errorMessage, saveId, onRetry, onShowSse, memory }) {
  const { t } = useTranslation();
  const ref = useRefA(null);
  // task 21：实战存档 history 可能有 100+ 条；一次性渲染整个数组 + 每次 setGame
  // 都重渲全部 NarrativeBlock 会拖死主线程（用户报 Playwright 简单 DOM 访问也 45s 不返回）。
  // 默认只渲染最近 80 条；用户可点 "显示更早" 一次性扩 80 条。完整历史走顶栏「历史回顾」抽屉。
  const HISTORY_WINDOW = 80;
  const [extra, setExtra] = useStateA(0);
  const totalLen = Array.isArray(history) ? history.length : 0;
  const visibleStart = Math.max(0, totalLen - HISTORY_WINDOW - extra);
  const hiddenCount = visibleStart;
  const visible = totalLen > 0 ? history.slice(visibleStart) : [];

  // PR#65: 组装「长记忆」复制文本(save 级,非每条消息级)。取 SearchModal 同一数据面:
  // memory.main_quest / current_objective / pinned[],空则为 "" → MsgActions 的 hasMemory
  // 为 false,复制行为与旧版完全一致(不弹选项)。
  const memoryText = useMemoA(() => {
    const mem = memory || {};
    const parts = [];
    if (mem.main_quest) parts.push(t('game.app.search.main_quest') + ": " + mem.main_quest);
    if (mem.current_objective) parts.push(t('game.app.search.current_objective') + ": " + mem.current_objective);
    const pinned = (Array.isArray(mem.pinned) ? mem.pinned : []).filter(Boolean);
    if (pinned.length) parts.push(t('game.app.search.group_memory') + ":\n" + pinned.map((p) => "- " + p).join("\n"));
    return parts.join("\n\n");
  }, [memory, t]);

  // 内嵌聊天图片:最后一条助手消息的绝对索引(实时图归属 + __last 兜底)
  let lastAsstIdx = -1;
  for (let _i = totalLen - 1; _i >= 0; _i--) { if (history[_i] && history[_i].role === "assistant") { lastAsstIdx = _i; break; } }
  const lastKeyRef = useRefA(null);
  lastKeyRef.current = lastAsstIdx >= 0 ? String(lastAsstIdx) : null;
  // 同步发布给生图弹窗(提交时读,生成的图据此写 message_index,见 chat-image-anchor.js)。
  chatImageAnchor.lastAsstKey = lastKeyRef.current;
  const imagesByKey = useSaveImages(saveId, lastKeyRef);

  // task 133: Claude 风格自动滚动 — 用户上滚后停止跟随 + 回到底部按钮。
  // 收口到 useStickToBottom(逐字等价):首屏门控用 visible.length(窗口化渲染),
  // 「末条=玩家」判定读完整 history,deps 逐字保留 [visible.length, running, rawSteps?.length]。
  const _last = history && history[history.length - 1];
  const { showJump: showJumpBtn, jumpToBottom } = useStickToBottom(ref, {
    deps: [visible.length, runState.running, runState.rawSteps?.length],
    lastIsUser: !!(_last && _last.role === "user"),
    hasContent: visible.length > 0,
    mode: "instant",
    withButton: true,
  });

  return (
    <div
      ref={ref}
      className="gc-chat"
      style={{
        "--narrative-font": narrativeFont === "serif" ? "var(--font-serif)" : "var(--font-sans)",
        "--narrative-size": narrativeSize + "px"
      }}>

      <div className="gc-chat-inner">
        {hiddenCount > 0 && (
          <div className="muted-2" style={{textAlign: "center", padding: "8px 0", fontSize: 12}}>
            {t('game.app.chat.hidden_count', { count: hiddenCount })} ·{" "}
            <button className="link" onClick={() => setExtra(x => x + HISTORY_WINDOW)}>
              {t('game.app.chat.load_more', { count: Math.min(HISTORY_WINDOW, hiddenCount) })}
            </button>
            {" · "}
            <span className="muted">{t('game.app.chat.full_history_hint')}</span>
          </div>
        )}
        {visible.map((m, i) => {
          const idx = visibleStart + i;
          // task 38：把 history 索引和当前 saveId 传给消息块，再透给 MsgActions
          // 之前 idx/saveId/commitId 全是 undefined → /api/branches/continue 收到 {label} 后端崩。
          const commitId = m && (m.commit_id || m.node_id);
          return m.role === "assistant" ?
          <NarrativeBlock key={`gm-${idx}`} text={m.content} ts={m.ts}
            msgIndex={idx} saveId={saveId} commitId={commitId}
            thinking={m._thinking}
            images={imagesByKey[String(idx)] || (idx === lastAsstIdx ? imagesByKey['__last'] : undefined)}
            streaming={!m.streaming_done && idx === totalLen - 1 && runState.running}
            toolOps={m._toolOps || m.tool_ops || []}
            renderTool={(ops) => <ToolCallBlock ops={ops} />}
            memoryText={memoryText} /> :
          <PlayerBlock key={`pl-${idx}`} text={m.content} ts={m.ts} attachments={m.attachments}
            msgIndex={idx} saveId={saveId} commitId={commitId} memoryText={memoryText} />;
        })}

        {/* 思考指示器统一(2026-06-23):此前等待首 token 时,这里的 gc-waiting-gm 三点气泡
            与下方 ThinkingPill 圆环【同时出现】= 一个回合内两种"正在思考"UI 并存,跨回合反复
            出现(用户反馈"思考ui有两种循环出现")。ThinkingPill 自身已覆盖整段运行(running 全程,
            含等待首 token 阶段:整理上下文 → 生成正文 → 落库),且带阶段进度/百分比/计时/"已完成"
            收尾,信息更全。故移除冗余的 gc-waiting-gm 三点气泡,全程只用 ThinkingPill 这一种指示器。 */}

        {/* task 92:高层思考状态(整理上下文→生成正文→落库 + 百分比 + 计时 + "已完成 · X.Xs"),
            是回合全程唯一的"正在思考"指示器。完整 raw phase trace 折叠在内,需要时展开。 */}
        <ThinkingPill runState={runState} runStyle={runStyle} />

        {hasError &&
        <div className="gc-error">
            <Icon name="warn" size={14} style={{ color: "var(--danger)" }} />
            <div>
              <strong>{t('game.app.chat.gen_failed')}</strong>
              <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
                {/* task 31：以前这里硬编码"请求中断：上游 504"，把空消息/字段契约错全都误报成网络超时。
                    现在显示后端 error.message 的真实文本（hasError 为字符串时是错误正文，为 true 时回退）。 */}
                {(typeof hasError === "string" && hasError) || errorMessage || t('game.app.chat.request_aborted')}
              </p>
              <div className="gc-error-actions">
                <button className="btn" onClick={onRetry} disabled={!onRetry}>{t('game.app.chat.retry')}</button>
                <button className="btn ghost" onClick={onShowSse} disabled={!onShowSse}>{t('game.app.chat.view_sse')}</button>
              </div>
            </div>
          </div>
        }
        {/* 图片已内嵌进对应助手消息气泡(useSaveImages + ChatImageGroup),不再底部独立 strip */}
        {/* task 133: Claude 风格"回到底部"按钮 — 用户上滚时显示。**必须 sticky 在滚动容器内**
            (而非 absolute):absolute 在 overflow 滚动容器里会随内容滚走、且祖先无 position:relative
            时锚到页面最右(群反馈酒馆/游戏同症)。sticky + justify-self:end → 钉在阅读列右下、
            不随滚动飘。bottom:16 贴 composer 上方。 */}
        {showJumpBtn && (
          <button
            onClick={jumpToBottom}
            className="btn"
            style={{
              position: "sticky", bottom: 16, justifySelf: "end",
              marginLeft: "auto", width: "fit-content",
              background: "var(--panel)", border: "1px solid var(--line)",
              borderRadius: 999, padding: "6px 14px", fontSize: 12.5,
              boxShadow: "var(--shadow-3, 0 6px 18px -6px rgba(0,0,0,0.5))",
              zIndex: 5, cursor: "pointer",
            }}
            data-tip={t('game.app.chat.jump_latest_tip')}>
            <Icon name="chevron_down" size={12} /> {t('game.app.chat.jump_latest')}
          </button>
        )}
      </div>
    </div>);

}

export { ChatArea };
