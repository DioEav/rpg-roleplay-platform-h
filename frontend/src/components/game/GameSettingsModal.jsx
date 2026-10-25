/* Game Console 游戏内设置弹窗(GameSettingsModal + _read* 读取器)——
   纯机械从 game-app.jsx 搬出,DOM/视觉/行为零变化。 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useState as useStateA, useEffect as useEffectA } from 'react';
import { Icon } from '../../game-icons.jsx';
import Modal from '../Modal.jsx';
import { lsGet, lsSet } from '../../lib/storage.js';

// ----------------------------- IN-GAME SETTINGS --------------------------
// task 89 → task 135: 用真实可用的设置面板替换 placeholder。
// 现范围: 密度预设 / 叙事字体 / token 用量显隐 / 保留未响应轮 / AI 改写建议 / 剧情引导强度 / 全局设置链接。
// 已隐藏(2026-10-15): 自动存档(rpg.autosave 死键,后端无条件每回合存档)、写入权限只读展示
// (纯回显,切换入口在顶栏 chip / 移动端 sheet)——两行均以注释保留,恢复前先接线。
// 所有改动均为纯前端 localStorage — 不需要后端(引导强度/AI 改写建议除外,走真实 API)。
function _readDensity() {
  return lsGet("rpg.density") || "default";
}
function _readNarrativeFont() {
  return lsGet("rpg.narrativeFont") || "serif";
}
// 自动存档开关已隐藏(2026-10-15):rpg.autosave 是死键 —— 全库(前端/移动端/后端)零运行时消费者,
// 后端 autosave 是每存档每回合无感提交(migrations v24),不受任何客户端开关控制。与全局偏好页
// pref-sections.jsx 同款处理:诚实优于装饰。恢复 = 先接线再解注释。
// function _readAutosave() {
//   return lsGet("rpg.autosave") !== "off";
// }
// #11: token 用量显示开关 — 默认关闭(=== "on")
function _readShowUsage() {
  return lsGet("rpg.showTokenUsage") === "on";
}
// A#2:未响应/失败时保留本轮对话(可重试),不回退玩家气泡 — 默认关闭(=== "on")
function _readKeepFailedTurn() {
  return lsGet("gc.keepFailedTurn") === "on";
}

// permission prop 暂不解构:写入权限只读展示行已隐藏,恢复时连同 PERM_OPT 一起解注释。
function GameSettingsModal({ open, onClose, saveTitle, saveId }) {
  const { t } = useTranslation();
  const [density, setDensityState] = useStateA(_readDensity);
  const [narrativeFont, setNarrativeFontState] = useStateA(_readNarrativeFont);
  // const [autosave, setAutosaveState] = useStateA(_readAutosave); // 自动存档死键,开关已隐藏(见 _readAutosave 注)
  const [showUsage, setShowUsageState] = useStateA(_readShowUsage);
  const [keepFailedTurn, setKeepFailedTurnState] = useStateA(_readKeepFailedTurn);
  // null = 尚未从后端拉到本档真实值;加载期不高亮任何档,避免先闪默认「软引导」再跳真值(被误读成"自己回跳")
  const [steerStrength, setSteerStrength] = useStateA(null);
  // acceptance 改写建议开关(用户级 user_preferences['acceptance_ab.enabled'],默认开)。行者无疆诉求:可手动关。
  const [abEnabled, setAbEnabled] = useStateA(true);
  // 两个后端保存项各加一个 in-flight 闸:防止快速连点导致「旧请求失败回滚覆盖新请求结果」。
  const [abBusy, setAbBusy] = useStateA(false);
  const [steerBusy, setSteerBusy] = useStateA(false);

  // sync density state with external RPG_setDensity calls
  useEffectA(() => {
    const onDensityChange = (e) => setDensityState(e.detail || "default");
    window.addEventListener("rpg-density-change", onDensityChange);
    return () => window.removeEventListener("rpg-density-change", onDensityChange);
  }, []);

  // 打开时拉一次存档设置,取 steering_strength 当前值
  useEffectA(() => {
    if (!open || saveId == null) return;
    const base = (window.__API_BASE || '');
    fetch(`${base}/api/saves/${saveId}/settings`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      // 成功就落定真值(缺字段才回退默认),失败保持 null 不假装默认 → 不会误显回跳
      .then(d => { if (d?.ok && d.settings) setSteerStrength(d.settings.steering_strength || "guided"); })
      .catch(() => {});
  }, [open, saveId]);

  // 打开时拉用户偏好,取 acceptance 改写建议开关(默认开)
  useEffectA(() => {
    if (!open) return;
    const base = (window.__API_BASE || '');
    fetch(`${base}/api/me/profile`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const v = d && d.preferences && d.preferences['acceptance_ab.enabled'];
        setAbEnabled(!(String(v).toLowerCase() === 'false' || v === false));
      })
      .catch(() => {});
  }, [open]);

  const handleAbEnabled = (v) => {
    if (abBusy) return;
    const prev = abEnabled;
    setAbEnabled(v);
    setAbBusy(true);
    const base = (window.__API_BASE || '');
    fetch(`${base}/api/me/preference`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'acceptance_ab.enabled': v }),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || j.detail || `HTTP ${r.status}`);
    }).catch((e) => {
      // 乐观更新失败必须回滚,否则用户以为已关掉,后端仍在生成 A/B 候选。
      setAbEnabled((cur) => (cur === v ? prev : cur));
      window.__apiToast?.(t('game.app.settings.save_failed'), { kind: 'danger', detail: e?.message });
    }).finally(() => setAbBusy(false));
  };

  const handleDensity = (d) => {
    setDensityState(d);
    if (typeof window.RPG_setDensity === "function") window.RPG_setDensity(d);
  };

  const handleNarrativeFont = (f) => {
    setNarrativeFontState(f);
    lsSet("rpg.narrativeFont", f);
    const fontMap = {
      serif: "var(--font-serif)",
      sans: "var(--font-sans)",
      mono: "var(--font-mono)",
    };
    document.documentElement.style.setProperty("--narrative-font", fontMap[f] || fontMap.serif);
    window.dispatchEvent(new CustomEvent("rpg-narrative-font-change", { detail: f }));
  };

  // const handleAutosave = ... // 自动存档死键,开关已隐藏(见 _readAutosave 注)

  const handleShowUsage = (v) => {
    setShowUsageState(v);
    lsSet("rpg.showTokenUsage", v ? "on" : "off");
    // App(game-console)监听此事件即时显隐 footer,无需刷新
    window.dispatchEvent(new CustomEvent("rpg-show-usage-change", { detail: v }));
  };

  const handleKeepFailedTurn = (v) => {
    setKeepFailedTurnState(v);
    // 纯前端:game-console 的 restoreFailedDraft 在失败时即时读 localStorage,无需事件/刷新
    lsSet("gc.keepFailedTurn", v ? "on" : "off");
  };

  const handleSteerStrength = (v) => {
    if (steerBusy) return;
    if (saveId == null) return;
    const prev = steerStrength;
    setSteerStrength(v);
    setSteerBusy(true);
    const base = (window.__API_BASE || '');
    fetch(`${base}/api/saves/${saveId}/settings`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: { steering_strength: v } }),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      // apply_settings 可能 HTTP 200 但把字段放进 rejected(锁死/非法值)。
      const rejected = j && j.rejected && j.rejected.steering_strength;
      if (!r.ok || j.ok === false || rejected) throw new Error(rejected || j.error || j.detail || `HTTP ${r.status}`);
    }).catch((e) => {
      // 失败回滚 + 提示;否则引导强度看起来已切换,实际仍按旧档跑。
      setSteerStrength((cur) => (cur === v ? prev : cur));
      window.__apiToast?.(t('game.app.settings.save_failed'), { kind: 'danger', detail: e?.message });
    }).finally(() => setSteerBusy(false));
  };

  if (!open) return null;

  // PERM_OPT/currentPerm:写入权限只读展示已隐藏(2026-10-15),恢复展示时一并解注释。
  // const PERM_OPT = (typeof window.PERMISSION_OPTIONS !== "undefined" && window.PERMISSION_OPTIONS) || [
  //   { id: "read_only",   label: t('game.app.settings.perm_read_only'), icon: "eye" },
  //   { id: "default",     label: t('game.app.settings.perm_default'),   icon: "lock" },
  //   { id: "review",      label: t('game.app.settings.perm_review'),    icon: "shield" },
  //   { id: "full_access", label: t('game.app.settings.perm_full'),      icon: "unlock" },
  // ];
  // const currentPerm = PERM_OPT.find(p => p.id === permission) || PERM_OPT[1];

  const DENSITY_OPTS = [
    { id: "compact",  label: t('game.app.settings.density_compact') },
    { id: "default",  label: t('game.app.settings.density_default') },
    { id: "spacious", label: t('game.app.settings.density_spacious') },
  ];
  const FONT_OPTS = [
    { id: "serif", label: t('game.app.settings.font_serif') },
    { id: "sans",  label: t('game.app.settings.font_sans') },
    { id: "mono",  label: t('game.app.settings.font_mono') },
  ];
  const STEER_OPTS = [
    { id: "rail",    label: t('game.app.settings.steer_rail') },
    { id: "guided",  label: t('game.app.settings.steer_guided') },
    { id: "free",    label: t('game.app.settings.steer_free') },
  ];

  const rowStyle = {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "10px 0", borderBottom: "1px solid var(--line-soft)",
    gap: 16,
  };
  const labelStyle = { fontSize: 13, color: "var(--text)", flex: 1 };
  const sublabelStyle = { fontSize: 11.5, color: "var(--muted)", marginTop: 2 };

  const node = (
    <Modal
      open
      eyebrow={t('game.app.settings.eyebrow')}
      title={saveTitle || t('game.app.settings.title')}
      width={480}
      onClose={onClose}
      footer={<>
        <span className="muted-2" style={{fontSize: 11.5}}>
          <Icon name="info" size={11} /> {t('game.app.settings.instant_hint')}
        </span>
        <div style={{display: "flex", gap: 8}}>
          <a className="btn ghost" href="/settings"
             target="_blank" rel="noopener noreferrer"
             style={{textDecoration: "none"}}>
            <Icon name="settings" size={12} /> {t('game.app.settings.global_settings')}
          </a>
          <button className="btn primary" onClick={onClose}>
            <Icon name="check" size={12} /> {t('game.app.settings.done')}
          </button>
        </div>
      </>}
    >
      <div className="pl-modal-form" style={{paddingTop: 4}}>

          {/* ── 信息密度 ── */}
          <div style={rowStyle}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.density_label')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.density_desc')}</div>
            </div>
            <div className="seg" style={{flexShrink: 0}}>
              {DENSITY_OPTS.map(d => (
                <button key={d.id} className={density === d.id ? "active" : ""}
                        onClick={() => handleDensity(d.id)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── 叙事字体 ── */}
          <div style={rowStyle}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.font_label')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.font_desc')}</div>
            </div>
            <div className="seg" style={{flexShrink: 0}}>
              {FONT_OPTS.map(f => (
                <button key={f.id} className={narrativeFont === f.id ? "active" : ""}
                        onClick={() => handleNarrativeFont(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── 自动存档:已隐藏(2026-10-15)—— rpg.autosave 死键,后端每回合无条件自动存档,
               开关不接线(见文件头 _readAutosave 注)。恢复 = 接线后解注释。
          <div style={rowStyle}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.autosave_label')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.autosave_desc')}</div>
            </div>
            <label style={{display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexShrink: 0}}>
              <input type="checkbox" checked={autosave}
                     onChange={(e) => handleAutosave(e.target.checked)}
                     style={{width: 15, height: 15, cursor: "pointer"}} />
              <span style={{fontSize: 12.5, color: "var(--text-quiet)"}}>{autosave ? t('game.app.settings.on') : t('game.app.settings.off')}</span>
            </label>
          </div>
          */}

          {/* ── 显示 token 用量 ── */}
          <div style={rowStyle}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.show_usage_label')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.show_usage_desc')}</div>
            </div>
            <label style={{display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexShrink: 0}}>
              <input type="checkbox" checked={showUsage}
                     onChange={(e) => handleShowUsage(e.target.checked)}
                     style={{width: 15, height: 15, cursor: "pointer"}} />
              <span style={{fontSize: 12.5, color: "var(--text-quiet)"}}>{showUsage ? t('game.app.settings.on') : t('game.app.settings.off')}</span>
            </label>
          </div>

          {/* ── 保留未响应轮(可重试) ── */}
          <div style={rowStyle}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.keep_failed_label')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.keep_failed_desc')}</div>
            </div>
            <label style={{display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexShrink: 0}}>
              <input type="checkbox" checked={keepFailedTurn}
                     onChange={(e) => handleKeepFailedTurn(e.target.checked)}
                     style={{width: 15, height: 15, cursor: "pointer"}} />
              <span style={{fontSize: 12.5, color: "var(--text-quiet)"}}>{keepFailedTurn ? t('game.app.settings.on') : t('game.app.settings.off')}</span>
            </label>
          </div>

          {/* ── AI 改写建议(acceptance A/B) ── */}
          <div style={rowStyle}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.ab_label', 'AI 改写建议')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.ab_desc', 'AI 偶尔漏掉本回合该体现的剧情点时,并排给你一个改写版本供选择(最多每 5 回合一次)。关掉则始终只用首稿。')}</div>
            </div>
            <label style={{display: "flex", alignItems: "center", gap: 8, cursor: "pointer", flexShrink: 0}}>
              <input type="checkbox" checked={abEnabled} disabled={abBusy}
                     onChange={(e) => handleAbEnabled(e.target.checked)}
                     style={{width: 15, height: 15, cursor: abBusy ? "progress" : "pointer"}} />
              <span style={{fontSize: 12.5, color: "var(--text-quiet)"}}>{abEnabled ? t('game.app.settings.on') : t('game.app.settings.off')}</span>
            </label>
          </div>

          {/* ── 剧情引导强度 ── */}
          {saveId != null && (
            <div style={rowStyle}>
              <div style={labelStyle}>
                <div>{t('game.app.settings.steering_label')}</div>
                <div style={sublabelStyle}>{t('game.app.settings.steering_desc')}</div>
              </div>
              <div className="seg" style={{flexShrink: 0}}>
                {STEER_OPTS.map(s => (
                  <button key={s.id} className={steerStrength === s.id ? "active" : ""}
                          disabled={steerBusy}
                          onClick={() => handleSteerStrength(s.id)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── 写入权限(只读展示):已隐藏(2026-10-15)—— 仅回显 permissions.mode,弹框内
               不可操作;移动端 sheet 与桌面顶栏 chip 才是真切换入口。要回显时解注释即可。
          <div style={{...rowStyle, borderBottom: "none"}}>
            <div style={labelStyle}>
              <div>{t('game.app.settings.perm_label')}</div>
              <div style={sublabelStyle}>{t('game.app.settings.perm_desc')}</div>
            </div>
            <div className="pill" style={{flexShrink: 0, gap: 6}}>
              <Icon name={currentPerm.icon} size={11} />
              {currentPerm.label}
            </div>
          </div>
          */}

      </div>
    </Modal>
  );
  return createPortal(node, document.body);
}

export { GameSettingsModal };
