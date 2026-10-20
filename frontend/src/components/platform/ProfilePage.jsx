// 工作台首页 ProfilePage —— 「首映式」改版:主页直接展示在线剧本库 / 在线角色卡库内容。
// 布局 = 问候区(继续游玩入口) + 精选剧本 Hero 轮播 + 热门剧本排 + 人气角色卡排。
// 原「最近游玩」表格与新用户引导(提示文案/酒馆输入框)均已移出主页。
// 豁免说明:移动端 MobileHome.jsx 是刻意平行实现(CLAUDE.md 同面横扫规则),本次改版只覆盖桌面主页。
import React from 'react';
import { useState as useStatePL, useEffect as useEffectPL, useRef as useRefPL } from 'react';
import { useTranslation } from 'react-i18next';
import { plNavigate } from '../../router.js';
import { Icon } from '../../game-icons.jsx';
import AvatarImg from '../AvatarImg.jsx';
import { parseImportedDesc } from '../../lib/script-desc.js';
import { usePlatformData, useReactiveUser } from './shared.jsx';

/* 自动生成的导入描述(「导入剧本 · N章(· 切分模式 · 置信 X)」)按界面语言本地化展示;
   用户自写的 description 原样透传。 */
function homeImportDesc(desc, t) {
  const imp = parseImportedDesc(desc);
  return imp ? t('scripts.public.imported_desc', { n: imp.n, defaultValue: `导入剧本 · ${imp.n}章` }) : desc;
}

/* 封面/头像缺图时的渐变补位色板:按 id 稳定取模选色,同一内容每次渲染同色。 */
const HOME_FB_COUNT = 5;
function homeFbClass(id) {
  const s = String(id == null ? '?' : id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i)) % HOME_FB_COUNT;
  return `pl-home-fb-${h + 1}`;
}

/* 精选轮播:每日 12 点换一批 —— 以「日期+上午/下午」为种子做确定性伪随机抽取 5 个,
   同半天内所有人、所有刷新看到的都是同一批;每 6s 自动轮到下一个,
   悬停精选框暂停,系统「减少动态效果」时不自动轮播(圆点仍可手动切换)。 */
const FEATURED_COUNT = 5;
const FEATURED_ROTATE_MS = 6000;

/* 左栏 rail 的内容分区注册表:数据驱动渲染,新增分区(如「酒馆」「成就」)只需加一条
   { view, icon, labelKey } 并在下方补对应 homeView 分支,按钮渲染/选中态/无障碍全自动。
   样式尺寸统一由 .pl-home-rail* 控制(platform.css),不需要为新条目写 CSS。 */
const RAIL_SECTIONS = [
  { view: 'scripts', icon: 'book',  labelKey: 'platform.home.rail_scripts' },
  { view: 'cards',   icon: 'cards', labelKey: 'platform.home.rail_cards' },
];

function featuredPeriodKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${d.getHours() < 12 ? 'am' : 'pm'}`;
}

function seededShuffle(items, seed) {
  let h = 2166136261; // FNV-1a 散列字符串 → 种子
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
  const [cloningScriptId, setCloningScriptId] = useStatePL(null);
  const [importedScriptIds, setImportedScriptIds] = useStatePL({}); // 本会话内已导入的剧本
  const [importingCardIds, setImportingCardIds] = useStatePL({});
  const [importedCardIds, setImportedCardIds] = useStatePL({}); // 本会话内已导入的角色卡
  // 左栏双视图:scripts(默认)=精选 Hero + 热门剧本;cards=人气角色卡大网格
  const [homeView, setHomeView] = useStatePL('scripts');
  // 精选轮播游标(剧本/角色卡各一个);悬停时暂停自动轮播
  const [featIdx, setFeatIdx] = useStatePL(0);
  const [cardsFeatIdx, setCardsFeatIdx] = useStatePL(0);
  // 切换方向:next=新内容从右滑入(右箭头/自动轮播),prev=从左滑入(左箭头) —— 驱动方向性动效
  const [featDir, setFeatDir] = useStatePL('next');
  const [cardsFeatDir, setCardsFeatDir] = useStatePL('next');
  const [, setFeaturedPeriod] = useStatePL(featuredPeriodKey()); // 跨 12 点时强制重渲染
  const featPauseRef = useRefPL(false);
  const featPeriodRef = useRefPL(featuredPeriodKey());

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

  // 精选 Hero:以「今日半日」为种子从公开库确定性抽取 5 个(12 点刷新,一整天/半天内不变);
  // featShown 做钳制:公开库刷新后条目可能变少,避免下标越界/圆点失去选中态。
  const period = featuredPeriodKey();
  const pubScripts = Array.isArray(homeScripts) ? homeScripts : [];
  const featured = pubScripts.length ? seededShuffle(pubScripts, 'home-scripts:' + period).slice(0, FEATURED_COUNT) : [];
  const featShown = featured.length ? Math.min(featIdx, featured.length - 1) : 0;
  const feat = featured.length ? featured[featShown] : null;
  const featOwned = !!(feat && (feat.mine || feat.imported || importedScriptIds[feat.id]));

  // 角色卡视图的「人气之选」:同一批种子抽 5 张轮播
  const cardsList = Array.isArray(homeCards) ? homeCards : [];
  const featuredCards = cardsList.length ? seededShuffle(cardsList, 'home-cards:' + period).slice(0, FEATURED_COUNT) : [];
  const cardsFeatShown = featuredCards.length ? Math.min(cardsFeatIdx, featuredCards.length - 1) : 0;
  const cardsFeat = featuredCards.length ? featuredCards[cardsFeatShown] : null;
  const cardsFeatOwned = !!(cardsFeat && (cardsFeat.mine || cardsFeat.imported || importedCardIds[cardsFeat.id]));

  // 圆点/箭头统一的切换入口:旧精选平移退场(leaving 层)、新精选从对应方向平移入场;
  // 自动轮播固定视为 next。idxRef 镜像游标,供 interval/退场快照取「当前展示项」。
  const featIdxRef = useRefPL(0);
  const cardsFeatIdxRef = useRefPL(0);
  const [featLeaving, setFeatLeaving] = useStatePL(null);  // {item, owned, dir} 动画结束即卸载
  const [cardsLeaving, setCardsLeaving] = useStatePL(null);
  const motionOK = () => !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const goFeat = (dir, i) => {
    if (i === featIdxRef.current) return;
    if (motionOK() && featured[featIdxRef.current]) {
      setFeatLeaving({ item: featured[featIdxRef.current], owned: featOwned, dir });
    }
    setFeatDir(dir);
    featIdxRef.current = i;
    setFeatIdx(i);
  };
  const goCardsFeat = (dir, i) => {
    if (i === cardsFeatIdxRef.current) return;
    if (motionOK() && featuredCards[cardsFeatIdxRef.current]) {
      setCardsLeaving({ item: featuredCards[cardsFeatIdxRef.current], owned: cardsFeatOwned, dir });
    }
    setCardsFeatDir(dir);
    cardsFeatIdxRef.current = i;
    setCardsFeatIdx(i);
  };
  const goNextFeat = () => goFeat('next', (featIdxRef.current + 1) % Math.max(featured.length, 1));
  const goPrevFeat = () => goFeat('prev', (featIdxRef.current - 1 + featured.length) % Math.max(featured.length, 1));
  const goNextCards = () => goCardsFeat('next', (cardsFeatIdxRef.current + 1) % Math.max(featuredCards.length, 1));
  const goPrevCards = () => goCardsFeat('prev', (cardsFeatIdxRef.current - 1 + featuredCards.length) % Math.max(featuredCards.length, 1));
  // 数据刷新后条目变少时 featShown 会被钳制,同步镜像游标,避免 interval 取到越界旧值
  if (featIdxRef.current !== featShown) featIdxRef.current = featShown;
  if (cardsFeatIdxRef.current !== cardsFeatShown) cardsFeatIdxRef.current = cardsFeatShown;

  // 精选滑层渲染(剧本):模糊背景 + 信息体 + 立绘海报;leaving 层复用同一渲染(不可交互)
  const renderScriptsSlide = (item, owned) => (
    <>
      <div
        className={`pl-home-hero-bg${item.cover_image_url ? '' : ` ${homeFbClass(item.id)}`}`}
        style={item.cover_image_url ? { backgroundImage: `url("${item.cover_image_url}")` } : undefined}
        aria-hidden="true"
      />
      <div className="pl-home-hero-body">
        <div className="pl-home-hero-info">
          <span className="pl-home-gchip">
            <Icon name="sparkle" size={13} />
            {t('platform.home.featured_chip', '精选 · 在线剧本库')}
          </span>
          <h2 className="pl-home-hero-title">《{item.title}》</h2>
          {item.description && <p className="pl-home-hero-desc">{homeImportDesc(item.description, t)}</p>}
          <div className="pl-home-hero-chips">
            <span className="pl-home-gchip">{t('scripts.public.stat_chapters', { n: item.chapter_count || 0 })}</span>
            <span className="pl-home-gchip">{t('scripts.public.stat_words', { n: ((item.word_count || 0) / 10000).toFixed(0) })}</span>
            <span className="pl-home-gchip">{t('scripts.public.stat_clones', { n: item.clone_count || 0 })}</span>
            <span className="pl-home-gchip">by {item.author || item.author_username || t('scripts.public.anon', '匿名')}</span>
          </div>
          <div className="pl-home-hero-btns">
            {owned ? (
              <button className="btn" disabled>
                <Icon name="check" size={13} />
                {item.mine ? t('scripts.public.is_mine', '我的剧本') : t('scripts.public.imported_badge', '已导入')}
              </button>
            ) : (
              <button className="btn primary" disabled={!!cloningScriptId} onClick={() => onCloneScript(item)}>
                <Icon name="download" size={13} /> {t('scripts.public.import_btn', '导入到我的剧本')}
              </button>
            )}
            <button className="btn pl-home-btn-dark" onClick={() => plNavigate('scripts-library')}>
              {t('platform.home.view_detail', '查看详情')}
            </button>
          </div>
        </div>
        <div className="pl-home-hero-side">
          <div className={`pl-home-poster ${homeFbClass(item.id)}`}>
            <AvatarImg
              src={item.cover_image_url || null}
              name={item.title}
              size={150}
              aspectRatio="3/4"
              zoomable
              className={homeFbClass(item.id)}
            />
          </div>
        </div>
      </div>
    </>
  );

  // 精选滑层渲染(角色卡):结构同剧本滑层
  const renderCardsSlide = (item, owned) => (
    <>
      <div
        className={`pl-home-hero-bg${item.avatar_path ? '' : ` ${homeFbClass(item.id)}`}`}
        style={item.avatar_path ? { backgroundImage: `url("${item.avatar_path}")` } : undefined}
        aria-hidden="true"
      />
      <div className="pl-home-hero-body">
        <div className="pl-home-hero-info">
          <span className="pl-home-gchip">
            <Icon name="cards" size={13} />
            {t('platform.home.featured_card_chip', '人气之选 · 在线角色卡库')}
          </span>
          <h2 className="pl-home-hero-title">{item.name || t('cards.detail.unnamed', '未命名')}</h2>
          {(item.personality || item.background || item.appearance || item.identity) &&
            <p className="pl-home-hero-desc">{(item.personality || item.background || item.appearance || item.identity).slice(0, 90)}</p>}
          <div className="pl-home-hero-chips">
            <span className="pl-home-gchip">♥ {t('scripts.public.stat_clones', { n: item.clone_count || 0 })}</span>
            {(item.tags || []).slice(0, 3).map((tg) => (
              <span className="pl-home-gchip" key={tg}>{tg}</span>
            ))}
            <span className="pl-home-gchip">by {item.owner_name || t('cards.page.online.anon', '匿名')}</span>
          </div>
          <div className="pl-home-hero-btns">
            {owned ? (
              <button className="btn" disabled>
                <Icon name="check" size={13} />
                {item.mine ? t('scripts.public.mine_badge', '我的') : t('scripts.public.imported_badge', '已导入')}
              </button>
            ) : (
              <button className="btn primary" disabled={!!importingCardIds[item.id]} onClick={() => onCloneCard(item)}>
                <Icon name="download" size={13} /> {t('cards.page.online.btn_import', '导入')}
              </button>
            )}
            <button className="btn pl-home-btn-dark" onClick={() => plNavigate('cards-online')}>
              {t('platform.home.view_detail', '查看详情')}
            </button>
          </div>
        </div>
        <div className="pl-home-hero-side">
          <div className={`pl-home-poster ${homeFbClass(item.id)}`}>
            <AvatarImg
              src={item.avatar_path || null}
              name={item.name || '?'}
              size={150}
              aspectRatio="3/4"
              zoomable
              className={`pl-home-cover-img-face ${homeFbClass(item.id)}`}
            />
          </div>
        </div>
      </div>
    </>
  );

  // 自动轮播:每 6s 平移换下一个(next 方向);悬停精选框暂停;跨 12 点重置并按新一批精选重算
  useEffectPL(() => {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => {
      const pk = featuredPeriodKey();
      if (pk !== featPeriodRef.current) {
        featPeriodRef.current = pk;
        goFeat('next', 0);
        goCardsFeat('next', 0);
        setFeaturedPeriod(pk);
        return;
      }
      if (featPauseRef.current) return;
      goNextFeat();
      goNextCards();
    }, FEATURED_ROTATE_MS);
    return () => clearInterval(timer);
  }, [featured.length, featuredCards.length]);

  return (
    <div className="pl-home">
      {/* 左栏 rail:内容分区切换(面板式,图标+文字标签;悬停浮起,按压缩放,选中 accent)。
          条目来自 RAIL_SECTIONS 注册表,新增分区零 JSX 改动。 */}
      <aside className="pl-home-rail" aria-label={t('platform.home.rail_label', '内容分区')}>
        {RAIL_SECTIONS.map((sec) => (
          <button type="button" key={sec.view}
            className={`pl-home-rail-btn${homeView === sec.view ? ' on' : ''}`}
            aria-label={t(sec.labelKey)}
            aria-pressed={homeView === sec.view}
            onClick={() => setHomeView(sec.view)}>
            <Icon name={sec.icon} size={27} />
            <span className="pl-home-rail-label">{t(sec.labelKey)}</span>
          </button>
        ))}
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
      {/* 精选剧本 Hero(海报式大横幅,取自在线剧本库;箭头/圆点/自动轮播均为左右平移切换) */}
      {feat && (
        <div className="pl-home-hero"
          onMouseEnter={() => { featPauseRef.current = true; }}
          onMouseLeave={() => { featPauseRef.current = false; }}>
          <button type="button" className="pl-home-hero-arrow pl-home-hero-arrow-l"
            aria-label={t('platform.home.prev_featured', '上一个')} onClick={goPrevFeat}>
            <Icon name="chevron_left" size={18} />
          </button>
          <button type="button" className="pl-home-hero-arrow pl-home-hero-arrow-r"
            aria-label={t('platform.home.next_featured', '下一个')} onClick={goNextFeat}>
            <Icon name="chevron_right" size={18} />
          </button>
          {/* 平移退场的旧内容层(动画结束即卸载) */}
          {featLeaving && (
            <div className={`pl-home-hero-slide leaving dir-${featLeaving.dir}`} aria-hidden="true"
              onAnimationEnd={() => setFeatLeaving(null)}>
              {renderScriptsSlide(featLeaving.item, featLeaving.owned)}
            </div>
          )}
          {/* 当前内容层(featDir 决定从左/右平移入场) */}
          <div className={`pl-home-hero-slide dir-${featDir}`} key={`feat-${featShown}`}>
            {renderScriptsSlide(feat, featOwned)}
          </div>
          {featured.length > 1 && (
            <div className="pl-home-dots">
              {featured.map((f, i) => (
                <button key={f.id} type="button" className={i === featShown ? 'on' : ''}
                  aria-label={f.title} aria-pressed={i === featShown}
                  onClick={() => goFeat(i > featShown ? 'next' : 'prev', i)} />
              ))}
            </div>
          )}
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
      {/* 人气之选 Hero(与剧本 Hero 同构,每日随机 5 张轮播;箭头/圆点/自动轮播均为左右平移切换) */}
      {cardsFeat && (
        <div className="pl-home-hero"
          onMouseEnter={() => { featPauseRef.current = true; }}
          onMouseLeave={() => { featPauseRef.current = false; }}>
          <button type="button" className="pl-home-hero-arrow pl-home-hero-arrow-l"
            aria-label={t('platform.home.prev_featured', '上一个')} onClick={goPrevCards}>
            <Icon name="chevron_left" size={18} />
          </button>
          <button type="button" className="pl-home-hero-arrow pl-home-hero-arrow-r"
            aria-label={t('platform.home.next_featured', '下一个')} onClick={goNextCards}>
            <Icon name="chevron_right" size={18} />
          </button>
          {/* 平移退场的旧内容层(动画结束即卸载) */}
          {cardsLeaving && (
            <div className={`pl-home-hero-slide leaving dir-${cardsLeaving.dir}`} aria-hidden="true"
              onAnimationEnd={() => setCardsLeaving(null)}>
              {renderCardsSlide(cardsLeaving.item, cardsLeaving.owned)}
            </div>
          )}
          {/* 当前内容层(cardsFeatDir 决定从左/右平移入场) */}
          <div className={`pl-home-hero-slide dir-${cardsFeatDir}`} key={`cards-feat-${cardsFeatShown}`}>
            {renderCardsSlide(cardsFeat, cardsFeatOwned)}
          </div>
          {featuredCards.length > 1 && (
            <div className="pl-home-dots">
              {featuredCards.map((f, i) => (
                <button key={f.id} type="button" className={i === cardsFeatShown ? 'on' : ''}
                  aria-label={f.name || t('cards.detail.unnamed', '未命名')} aria-pressed={i === cardsFeatShown}
                  onClick={() => goCardsFeat(i > cardsFeatShown ? 'next' : 'prev', i)} />
              ))}
            </div>
          )}
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

export { ProfilePage, homeFbClass };
