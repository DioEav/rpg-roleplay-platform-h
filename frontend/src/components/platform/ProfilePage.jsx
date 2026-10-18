// 工作台首页 ProfilePage —— 「首映式」改版:主页直接展示在线剧本库 / 在线角色卡库内容。
// 布局 = 问候区(继续游玩入口) + 精选剧本 Hero 轮播 + 热门剧本排 + 人气角色卡排。
// 原「最近游玩」表格与新用户引导(提示文案/酒馆输入框)均已移出主页。
// 豁免说明:移动端 MobileHome.jsx 是刻意平行实现(CLAUDE.md 同面横扫规则),本次改版只覆盖桌面主页。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL } from 'react';
import { useTranslation } from 'react-i18next';
import { plNavigate } from '../../router.js';
import { Icon } from '../../game-icons.jsx';
import AvatarImg from '../AvatarImg.jsx';
import { usePlatformData, useReactiveUser } from './shared.jsx';

/* 封面/头像缺图时的渐变补位色板:按 id 稳定取模选色,同一内容每次渲染同色。 */
const HOME_FB_COUNT = 5;
function homeFbClass(id) {
  const s = String(id == null ? '?' : id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) % HOME_FB_COUNT;
  return `pl-home-fb-${h + 1}`;
}

/* ---------------------------- PROFILE -------------------------- */
function ProfilePage() {
  const { t } = useTranslation();
  const platform = usePlatformData();  // task 45：响应式 platform，登录后真实数据自动注入
  const { scripts = [], saves = [] } = platform;
  const user = useReactiveUser();  // task 13: 保存资料后即时同步显示名/简介
  const realScripts = Array.isArray(scripts) ? scripts : [];
  // 首页「继续游玩」只针对游戏存档;酒馆对话从 #tavern 页(或下方空态输入框)进入。
  const realSaves = (Array.isArray(saves) ? saves : [])
    .filter(s => (s?.save_kind || s?._raw?.save_kind || 'game') !== 'tavern');
  const lastSave = realSaves[0] || null;
  const lastScript = lastSave ? realScripts.find(sc => sc && sc.id === lastSave.script_id) : null;
  const lastLabel = lastSave
    ? (lastScript?.title
        ? `《${lastScript.title}》${lastSave.title || ''}`
        : (lastSave.title || t('platform.profile.last_save', '上次存档')))
    : null;

  const hour = (() => { try { return new Date().getHours(); } catch (_) { return 12; } })();
  const greeting = hour < 5 ? t('platform.profile.greeting_late', '夜深了') : hour < 11 ? t('platform.profile.greeting_morning', '早上好') : hour < 14 ? t('platform.profile.greeting_noon', '中午好') : hour < 18 ? t('platform.profile.greeting_afternoon', '下午好') : t('platform.profile.greeting_evening', '晚上好');

  // ── 在线库内容(按热度取数,主页改版核心数据源)。
  //    null=加载中(骨架屏);false=加载失败(整块隐藏,不阻塞主页);[]=公开库为空(引导卡)。 ──
  const [homeScripts, setHomeScripts] = useStatePL(null);
  const [homeCards, setHomeCards] = useStatePL(null);
  const [featIdx, setFeatIdx] = useStatePL(0);
  const [cloningScriptId, setCloningScriptId] = useStatePL(null);
  const [importedScriptIds, setImportedScriptIds] = useStatePL({}); // 本会话内已导入的剧本
  const [importingCardIds, setImportingCardIds] = useStatePL({});
  const [importedCardIds, setImportedCardIds] = useStatePL({}); // 本会话内已导入的角色卡
  // 左栏双视图:scripts(默认)=精选 Hero + 热门剧本;cards=人气角色卡大网格
  const [homeView, setHomeView] = useStatePL('scripts');

  useEffectPL(() => {
    let alive = true;
    window.api.scripts.publicList({ order: 'hot', limit: 12 })
      .then((r) => { if (alive) setHomeScripts(Array.isArray(r?.items) ? r.items : []); })
      .catch(() => { if (alive) setHomeScripts(false); });
    window.api.cards.publicList({ order: 'hot', limit: 12 })
      .then((r) => { if (alive) setHomeCards(Array.isArray(r?.items) ? r.items : []); })
      .catch(() => { if (alive) setHomeCards(false); });
    return () => { alive = false; };
  }, []);

  // 导入公开剧本(O(1) subscribe),交互与 ScriptsLibraryView 保持一致
  const onCloneScript = async (s) => {
    setCloningScriptId(s.id);
    try {
      const r = await window.api.scripts.cloneFromPublic(s.id);
      if (r && r.ok === false) throw new Error(r.error || t('scripts.toast.import_fail'));
      setImportedScriptIds((m) => ({ ...m, [s.id]: true }));
      if (r?.already_imported) {
        // 之前已导入过:不谎报「导入成功」,也不重复累加热度。
        window.toast?.(t('scripts.public.already_imported', '该剧本已在你的剧本库中'), { kind: 'info', detail: s.title, duration: 2600 });
      } else {
        window.toast?.(t('scripts.public.clone_ok'), { kind: 'ok', detail: `${s.title} · script #${r?.script_id ?? '?'}`, duration: 3000 });
        setHomeScripts((arr) => Array.isArray(arr)
          ? arr.map((x) => x.id === s.id ? { ...x, clone_count: (x.clone_count || 0) + 1 } : x)
          : arr);
      }
      try { window.dispatchEvent(new CustomEvent('rpg-scripts-updated')); } catch (_) {}
    } catch (e) {
      window.__apiToast?.(t('scripts.toast.import_fail'), { kind: 'danger', detail: e?.message || String(e) });
    } finally {
      setCloningScriptId(null);
    }
  };

  // 导入公开角色卡(完整复制),交互与 OnlineCardsView 保持一致
  const onCloneCard = async (c) => {
    setImportingCardIds((p) => ({ ...p, [c.id]: true }));
    try {
      const r = await window.api.cards.cloneFromPublic(c.id);
      setImportedCardIds((m) => ({ ...m, [c.id]: true }));
      if (r?.already_imported) {
        // 与剧本导入一致:已导入过只提示,不重复报成功、不重复累加热度。
        window.__apiToast?.(t('cards.page.online.already_imported', '这张角色卡已在你的卡库中'), { kind: 'info', detail: c.name, duration: 2600 });
      } else {
        window.__apiToast?.(t('cards.page.online.import_ok'), { kind: 'ok', duration: 2200, detail: t('cards.page.online.import_ok_detail', { name: c.name }) });
        setHomeCards((arr) => Array.isArray(arr)
          ? arr.map((x) => x.id === c.id ? { ...x, clone_count: (x.clone_count || 0) + 1 } : x)
          : arr);
      }
    } catch (e) {
      window.__apiToast?.(t('cards.page.online.import_fail'), { kind: 'danger', detail: e?.payload?.error || e?.message });
    } finally {
      setImportingCardIds((p) => ({ ...p, [c.id]: false }));
    }
  };

  // 精选 Hero:hot 序里优先取有封面的前 3 本;无任何公开剧本时不渲染。
  // featIdx 做钳制:公开库刷新后条目可能变少,避免下标越界/圆点失去选中态。
  const pubScripts = Array.isArray(homeScripts) ? homeScripts : [];
  const featured = pubScripts.length
    ? [...pubScripts].sort((a, b) => (b.cover_image_url ? 1 : 0) - (a.cover_image_url ? 1 : 0)).slice(0, 3)
    : [];
  const featShown = featured.length ? Math.min(featIdx, featured.length - 1) : 0;
  const feat = featured.length ? featured[featShown] : null;
  const featOwned = !!(feat && (feat.mine || feat.imported || importedScriptIds[feat.id]));

  // 角色卡视图的「人气之选」:hot 序里优先取有立绘的第一张
  const cardsList = Array.isArray(homeCards) ? homeCards : [];
  const cardsFeat = cardsList.length
    ? [...cardsList].sort((a, b) => (b.avatar_path ? 1 : 0) - (a.avatar_path ? 1 : 0))[0]
    : null;
  const cardsFeatOwned = !!(cardsFeat && (cardsFeat.mine || cardsFeat.imported || importedCardIds[cardsFeat.id]));
  const cardsFeatDesc = cardsFeat
    ? (cardsFeat.personality || cardsFeat.background || cardsFeat.appearance || cardsFeat.identity || '').slice(0, 90)
    : '';

  return (
    <div className="pl-home">
      {/* 左栏 rail:剧本 / 角色卡 双视图切换(面板式,图标+文字标签;悬停浮起,按压缩放,选中 accent) */}
      <aside className="pl-home-rail" aria-label={t('platform.home.rail_label', '内容分区')}>
        <button type="button" className={`pl-home-rail-btn${homeView === 'scripts' ? ' on' : ''}`}
          aria-label={t('platform.home.rail_scripts', '剧本')}
          aria-pressed={homeView === 'scripts'}
          onClick={() => setHomeView('scripts')}>
          <Icon name="book" size={22} />
          <span className="pl-home-rail-label">{t('platform.home.rail_scripts', '剧本')}</span>
        </button>
        <button type="button" className={`pl-home-rail-btn${homeView === 'cards' ? ' on' : ''}`}
          aria-label={t('platform.home.rail_cards', '角色卡')}
          aria-pressed={homeView === 'cards'}
          onClick={() => setHomeView('cards')}>
          <Icon name="cards" size={22} />
          <span className="pl-home-rail-label">{t('platform.home.rail_cards', '角色卡')}</span>
        </button>
      </aside>

      <div className="pl-home-main">
      {/* 问候区 + 继续游玩入口 */}
      <div className="pl-home-hello">
        <div>
          <div className="pl-home-eyebrow">{greeting}，{user.display_name || t('platform.profile.traveler', '旅行者')}</div>
          <h1 className="pl-home-title">{t('platform.profile.hero_tagline', '继续你的故事，或开启新的旅程')}</h1>
        </div>
        {lastSave && (
          <div className="pl-home-hello-actions">
            <span className="pl-home-last-chip">
              <Icon name="clock" size={13} />
              {t('platform.home.last_played', '上次玩到')} <b>{lastLabel}</b>
            </span>
            <button className="btn primary" onClick={() => window.__openContinue?.(lastSave)}>
              <Icon name="play" size={13} /> {t('platform.home.continue_play', '继续游玩')}
            </button>
          </div>
        )}
      </div>

      {/* ── 剧本视图:精选 Hero + 热门剧本 ── */}
      {homeView === 'scripts' ? (
      <div className="pl-home-view" key="view-scripts">
      {/* 精选剧本 Hero(海报式大横幅,取自在线剧本库) */}
      {feat && (
        <div className="pl-home-hero">
          <div
            className={`pl-home-hero-bg${feat.cover_image_url ? '' : ` ${homeFbClass(feat.id)}`}`}
            style={feat.cover_image_url ? { backgroundImage: `url("${feat.cover_image_url}")` } : undefined}
            aria-hidden="true"
          />
          <div className="pl-home-hero-body">
            <div className="pl-home-hero-info">
              <span className="pl-home-gchip">
                <Icon name="sparkle" size={13} />
                {feat.mine ? t('scripts.public.mine_badge', '我的')
                  : (importedScriptIds[feat.id] ? t('scripts.public.imported_badge', '已导入')
                    : t('platform.home.featured_chip', '精选 · 在线剧本库'))}
              </span>
              <h2 className="pl-home-hero-title">《{feat.title}》</h2>
              {feat.description && <p className="pl-home-hero-desc">{feat.description}</p>}
              <div className="pl-home-hero-chips">
                <span className="pl-home-gchip">{t('scripts.public.stat_chapters', { n: feat.chapter_count || 0 })}</span>
                <span className="pl-home-gchip">{t('scripts.public.stat_words', { n: ((feat.word_count || 0) / 10000).toFixed(0) })}</span>
                <span className="pl-home-gchip">{t('scripts.public.stat_clones', { n: feat.clone_count || 0 })}</span>
                <span className="pl-home-gchip">by {feat.author || feat.author_username || t('scripts.public.anon', '匿名')}</span>
              </div>
              <div className="pl-home-hero-btns">
                {featOwned ? (
                  <button className="btn" disabled>
                    <Icon name="check" size={13} />
                    {feat.mine ? t('scripts.public.is_mine', '我的剧本') : t('scripts.public.imported_badge', '已导入')}
                  </button>
                ) : (
                  <button className="btn primary" disabled={!!cloningScriptId} onClick={() => onCloneScript(feat)}>
                    <Icon name="download" size={13} /> {t('scripts.public.import_btn', '导入到我的剧本')}
                  </button>
                )}
                <button className="btn pl-home-btn-dark" onClick={() => plNavigate('scripts-library')}>
                  {t('platform.home.view_detail', '查看详情')}
                </button>
              </div>
            </div>
            <div className="pl-home-hero-side">
              <div className={`pl-home-poster ${homeFbClass(feat.id)}`}>
                <AvatarImg
                  src={feat.cover_image_url || null}
                  name={feat.title}
                  size={150}
                  aspectRatio="3/4"
                  zoomable
                  className={homeFbClass(feat.id)}
                />
              </div>
              {featured.length > 1 && (
                <div className="pl-home-dots">
                  {featured.map((f, i) => (
                    <button key={f.id} type="button" className={i === featShown ? 'on' : ''}
                      aria-label={f.title} aria-pressed={i === featShown}
                      onClick={() => setFeatIdx(i)} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 热门剧本(在线剧本库 · hot 序前 8) */}
      {homeScripts !== false && (
        <section className="pl-home-sec">
          <div className="pl-home-sec-head">
            <h2><Icon name="sparkle" size={16} /> {t('platform.home.hot_scripts', '热门剧本')}</h2>
            <button className="pl-home-more" onClick={() => plNavigate('scripts-library')}>
              {t('platform.home.go_scripts', '进入剧本库')} <Icon name="chevron_right" size={13} />
            </button>
          </div>
          {homeScripts === null ? (
            <div className="pl-home-skel" aria-hidden="true"><i /><i /><i /><i /></div>
          ) : homeScripts.length === 0 ? (
            <div className="pl-home-guide">
              <span>{t('platform.home.empty_scripts', '公开剧本库还是空的。把你的剧本设为公开分享,它就会出现在首页和在线剧本库里。')}</span>
              <button className="btn" onClick={() => plNavigate('scripts')}>{t('platform.home.empty_scripts_btn', '去分享剧本')}</button>
            </div>
          ) : (
            <div className="pl-home-grid">
              {homeScripts.slice(0, 8).map((s) => {
                // imported 来自后端(订阅指针):刷新页面后仍正确显示「已导入」,不可重复导入
                const owned = !!(s.mine || s.imported || importedScriptIds[s.id]);
                return (
                  <article className="pl-home-card" key={s.id}>
                    <div className={`pl-home-cover${s.cover_image_url ? '' : ` ${homeFbClass(s.id)}`}`}>
                      <AvatarImg
                        src={s.cover_image_url || null}
                        name={s.title}
                        className={`pl-home-cover-img ${homeFbClass(s.id)}`}
                      />
                      <span className="pl-home-cov-chip">
                        <Icon name="download" size={11} /> {s.clone_count || 0}
                      </span>
                    </div>
                    <div className="pl-home-card-body">
                      <div className="pl-home-card-title">
                        {s.title}
                        {owned && <span className="pill accent">{s.mine ? t('scripts.public.mine_badge', '我的') : t('scripts.public.imported_badge', '已导入')}</span>}
                      </div>
                      <div className="pl-home-card-meta">
                        {t('scripts.public.stat_chapters', { n: s.chapter_count || 0 })}
                        {' · '}
                        {t('scripts.public.stat_words', { n: ((s.word_count || 0) / 10000).toFixed(0) })}
                      </div>
                      <div className="pl-home-card-foot">
                        <span className="pl-home-by">by {s.author || s.author_username || t('scripts.public.anon', '匿名')}</span>
                        {owned ? (
                          <button className="btn pl-home-btn-mini" disabled><Icon name="check" size={12} /></button>
                        ) : (
                          <button className="btn primary pl-home-btn-mini" disabled={!!cloningScriptId}
                            title={t('scripts.public.import_btn', '导入到我的剧本')}
                            onClick={() => onCloneScript(s)}>
                            <Icon name="download" size={12} /> {t('cards.page.online.btn_import', '导入')}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      </div>
      ) : (

      /* ── 角色卡视图:人气之选 Hero + 人气角色卡大网格 ── */
      <div className="pl-home-view" key="view-cards">
      {/* 人气之选 Hero(与剧本 Hero 同构,取 hot 序第一张有立绘的角色卡) */}
      {cardsFeat && (
        <div className="pl-home-hero">
          <div
            className={`pl-home-hero-bg${cardsFeat.avatar_path ? '' : ` ${homeFbClass(cardsFeat.id)}`}`}
            style={cardsFeat.avatar_path ? { backgroundImage: `url("${cardsFeat.avatar_path}")` } : undefined}
            aria-hidden="true"
          />
          <div className="pl-home-hero-body">
            <div className="pl-home-hero-info">
              <span className="pl-home-gchip">
                <Icon name="cards" size={13} />
                {cardsFeat.mine ? t('scripts.public.mine_badge', '我的')
                  : (importedCardIds[cardsFeat.id] || cardsFeat.imported ? t('scripts.public.imported_badge', '已导入')
                    : t('platform.home.featured_card_chip', '人气之选 · 在线角色卡库'))}
              </span>
              <h2 className="pl-home-hero-title">{cardsFeat.name || t('cards.detail.unnamed', '未命名')}</h2>
              {cardsFeatDesc && <p className="pl-home-hero-desc">{cardsFeatDesc}</p>}
              <div className="pl-home-hero-chips">
                <span className="pl-home-gchip">♥ {t('scripts.public.stat_clones', { n: cardsFeat.clone_count || 0 })}</span>
                {(cardsFeat.tags || []).slice(0, 3).map((tg) => (
                  <span className="pl-home-gchip" key={tg}>{tg}</span>
                ))}
                <span className="pl-home-gchip">by {cardsFeat.owner_name || t('cards.page.online.anon', '匿名')}</span>
              </div>
              <div className="pl-home-hero-btns">
                {cardsFeatOwned ? (
                  <button className="btn" disabled>
                    <Icon name="check" size={13} />
                    {cardsFeat.mine ? t('scripts.public.mine_badge', '我的') : t('scripts.public.imported_badge', '已导入')}
                  </button>
                ) : (
                  <button className="btn primary" disabled={!!importingCardIds[cardsFeat.id]} onClick={() => onCloneCard(cardsFeat)}>
                    <Icon name="download" size={13} /> {t('cards.page.online.btn_import', '导入')}
                  </button>
                )}
                <button className="btn pl-home-btn-dark" onClick={() => plNavigate('cards-online')}>
                  {t('platform.home.view_detail', '查看详情')}
                </button>
              </div>
            </div>
            <div className="pl-home-hero-side">
              <div className={`pl-home-poster ${homeFbClass(cardsFeat.id)}`}>
                <AvatarImg
                  src={cardsFeat.avatar_path || null}
                  name={cardsFeat.name || '?'}
                  size={150}
                  aspectRatio="3/4"
                  zoomable
                  className={`pl-home-cover-img-face ${homeFbClass(cardsFeat.id)}`}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {homeCards !== false && (
        <section className="pl-home-sec">
          <div className="pl-home-sec-head">
            <h2><Icon name="cards" size={16} /> {t('platform.home.hot_cards', '人气角色卡')}</h2>
            <button className="pl-home-more" onClick={() => plNavigate('cards-online')}>
              {t('platform.home.go_cards', '进入角色卡库')} <Icon name="chevron_right" size={13} />
            </button>
          </div>
          {homeCards === null ? (
            <div className="pl-home-skel" aria-hidden="true"><i /><i /><i /><i /></div>
          ) : homeCards.length === 0 ? (
            <div className="pl-home-guide">
              <span>{t('platform.home.empty_cards', '还没有公开的角色卡。在「用户角色卡」里发布一张,这里就会展示给所有旅行者。')}</span>
              <button className="btn" onClick={() => plNavigate('cards')}>{t('platform.home.empty_cards_btn', '去发布角色卡')}</button>
            </div>
          ) : (
            <div className="pl-home-grid">
              {homeCards.slice(0, 12).map((c) => {
                // mine 来自后端(user_id 比对),imported 由后端按克隆来源判定 ——
                // 与剧本卡一致:刷新后仍显示「我的/已导入」,不会重复出现导入按钮。
                const ownCard = !!c.mine || (user?.id != null && c.user_id != null && Number(c.user_id) === Number(user.id));
                const importedCard = !ownCard && !!(c.imported || importedCardIds[c.id]);
                return (
                <article className="pl-home-card" key={c.id}>
                  <div className={`pl-home-cover${c.avatar_path ? '' : ` ${homeFbClass(c.id)}`}`}>
                    <AvatarImg
                      src={c.avatar_path || null}
                      name={c.name || '?'}
                      className={`pl-home-cover-img pl-home-cover-img-face ${homeFbClass(c.id)}`}
                    />
                    <span className="pl-home-cov-chip" title={t('scripts.public.stat_clones', { n: c.clone_count || 0 })}>
                      ♥ {c.clone_count || 0}
                    </span>
                  </div>
                  <div className="pl-home-card-body">
                    <div className="pl-home-card-title">
                      {c.name || t('cards.detail.unnamed', '未命名')}
                      {ownCard && <span className="pill accent">{t('scripts.public.mine_badge', '我的')}</span>}
                      {importedCard && <span className="pill accent">{t('scripts.public.imported_badge', '已导入')}</span>}
                    </div>
                    {c.identity && <div className="pl-home-card-meta pl-home-char-id">{String(c.identity).slice(0, 40)}</div>}
                    {(c.tags || []).length > 0 && (
                      <div className="pl-home-tags">
                        {(c.tags || []).slice(0, 3).map((tg) => <span className="pill" key={tg}>{tg}</span>)}
                      </div>
                    )}
                    <div className="pl-home-card-foot">
                      <span className="pl-home-by">by {c.owner_name || t('cards.page.online.anon', '匿名')}</span>
                      {(ownCard || importedCard) ? (
                        <button className="btn pl-home-btn-mini" disabled><Icon name="check" size={12} /></button>
                      ) : (
                        <button className="btn primary pl-home-btn-mini" disabled={!!importingCardIds[c.id]}
                          onClick={() => onCloneCard(c)}>
                          <Icon name="download" size={12} /> {t('cards.page.online.btn_import', '导入')}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      </div>
      )}
      </div>
    </div>
  );
}

export { ProfilePage };
