import React from 'react';
import { useTranslation } from 'react-i18next';
import CSContainer from '@cloudscape-design/components/container';
import CSHeader from '@cloudscape-design/components/header';
import CSColumnLayout from '@cloudscape-design/components/column-layout';
import CSFormField from '@cloudscape-design/components/form-field';
import CSSelect from '@cloudscape-design/components/select';
import CSInput from '@cloudscape-design/components/input';
import CSAlert from '@cloudscape-design/components/alert';
import CSButton from '@cloudscape-design/components/button';
import { credApiIdSet } from './catalog-helpers.js';
import { plGoto } from '../router.js';
import { lsGetJSON, lsSetJSON, lsRemove } from '../lib/storage.js';

/* ── 共享数据快照:single-flight + 内存/localStorage stale-while-revalidate ─────
   背景:模块模型页挂 16 个 picker,过去每个各自拉 profile + models + credentials
   ≈ 49 请求/次进入(其中 17 个是重型的 /api/me/profile,内含 token_usage 聚合),
   且前后端零缓存 → 每次进页白屏等待、已保存选择迟迟不上屏。
   现在:N 个实例共用一次拉取(single-flight),成功结果存内存 + localStorage;
   重新挂载先画快照(即时上屏),再按 TTL 决定是否后台校真。
   只缓存目录元数据 / 哪些供应商配过 key 的布尔 / 模块→模型偏好 —— 不含任何密钥
   (credentials.list 本身只回元数据,见 user_credentials.list_credentials)。 */
const _PICKER_TTL_MS = 5 * 60 * 1000;
const _SNAPSHOT_KEY = 'agent_picker_snapshot_v1';
let _shared = null;    // { ts, models, creds, prefs } — 最近一次成功结果(内存)
let _inflight = null;  // 进行中的共享拉取(single-flight)

function _snapshotFresh(s) {
  // 只有「完整」快照(目录+凭据都成功)才允许充当新鲜数据 —— 残缺快照(models 腿失败)
  // 若被当作新鲜,会让选择器拿着空目录空转 5 分钟还显示误导文案。
  return !!s && s.models != null && s.creds != null && (Date.now() - s.ts) < _PICKER_TTL_MS;
}
function _readLocalSnapshot() {
  try {
    const s = lsGetJSON(_SNAPSHOT_KEY);
    return (s && s.ts && s.models != null && s.creds != null) ? s : null;  // 坏档当没有
  } catch (_) { return null; }
}

/** 用户显式改了偏好之后,把结果**写穿**快照(内存 + localStorage 镜像),并把内存快照标记为
 *  不新鲜(ts=0,`_snapshotFresh` 据此判否)。
 *  为什么必须写穿:快照只在 _fetchShared 成功时写入,persist() 不改它 —— 于是"刚选完 → 5 分钟内
 *  重开"会解析出**改前**的旧值;本次把 init 回声恢复成两条路径都发之后,那个旧值还会被交给父组件
 *  (ScriptDetail 的 audit-cards 用 body 覆盖后端偏好 → 直接提交错模型)。
 *  ts=0 则保证下次挂载仍会做一次校真(目录/凭据/服务端偏好也可能在此期间变了)——两端都要:
 *  既让"画出来的第一帧"是对的,又不把校真关掉。 */
function _patchSnapshotPrefs(patch) {
  const apply = (snap) => {
    if (!snap) return;
    snap.prefs = { ...(snap.prefs || {}), ...patch };
  };
  try {
    if (_shared) { apply(_shared); _shared.ts = 0; }
    const ls = _readLocalSnapshot();
    if (ls) { apply(ls); lsSetJSON(_SNAPSHOT_KEY, ls); }
  } catch (_) { /* 快照只是缓存,写失败不影响落库本身 */ }
}

async function _fetchShared() {
  // 逐项 catch:某一项失败不拖垮其它两项(与旧的每项 .catch(() => ({})) 等价);
  // 只有目录和凭据【双双】失败才算失败 → 上层进错误态(可重试),而不是假扮"没配 key"。
  const [profile, models, creds] = await Promise.all([
    window.api.account.profile().catch(() => null),
    window.api.models.list().catch(() => null),
    window.api.credentials.list().catch(() => null),
  ]);
  if (!models && !creds) throw new Error('model catalog & credentials unavailable');
  const snap = { ts: Date.now(), models, creds, prefs: (profile && profile.preferences) || {} };
  // 只有【完整】结果(目录+凭据都成功)才允许进内存/LocaStorage 快照 —— 残缺结果一旦被
  // _snapshotFresh 当成新鲜,选择器会拿着空目录空转整个 TTL 还显示误导文案。部分结果
  // 仍然返回给调用方上屏(有多少画多少),但下一次挂载会重新拉取。
  if (models && creds) {
    _shared = snap;
    try { lsSetJSON(_SNAPSHOT_KEY, snap); } catch (_) {}
  }
  return snap;
}

function _getShared() {
  if (_inflight) return _inflight;
  _inflight = _fetchShared().finally(() => { _inflight = null; });
  return _inflight;
}

/** 凭据增删后清快照(rpg-credentials-updated 监听器调用);下个挂载/重拉会重新取数。 */
export function invalidatePickerSnapshot() {
  _shared = null;
  try { lsRemove(_SNAPSHOT_KEY); } catch (_) {}
}

/** 测试专用:连 _inflight 一起清,避免「永不 resolve」桩把 single-flight 泄漏进下一个用例。 */
export function _resetPickerStoreForTests() {
  _shared = null;
  _inflight = null;
  try { lsRemove(_SNAPSHOT_KEY); } catch (_) {}
}

/** 供本组件以外的调用方(如 module-models-section)复用同一份 preferences,不再各拉一次重型 profile。 */
export async function getSharedPickerPrefs() {
  if (_shared && _snapshotFresh(_shared)) return _shared.prefs;
  try { return (await _getShared()).prefs; }
  catch (_) { return (_shared && _shared.prefs) || {}; }
}

// ── variant="popover" 紧凑浮层样式(只注一次;复用与旧 ModelPopover 同源的视觉 token) ──
const AMP_POP_STYLE_ID = 'amp-pop-styles-v1';
if (typeof document !== 'undefined' && !document.getElementById(AMP_POP_STYLE_ID)) {
  const css = `
.amp-pop{display:flex;flex-direction:column;min-width:280px;max-width:420px;
  background:var(--panel,#211f1d);border:1px solid var(--line,#36322d);
  border-radius:var(--r-3,8px);overflow:hidden;color:var(--text,#ebe7df);
  font-family:var(--font-sans,system-ui);font-size:13px;box-shadow:var(--shadow-3,0 8px 28px rgba(0,0,0,.4));
  transform-origin:top right;animation:m-pop-menu var(--m-fast,100ms) var(--m-out,cubic-bezier(0.16,1,0.3,1)) forwards;}
.amp-pop-head{padding:8px 10px;border-bottom:1px solid var(--line-soft,#2a2724);background:var(--bg-deep,#131211);}
.amp-pop-search{width:100%;box-sizing:border-box;padding:5px 10px;background:rgba(255,255,255,0.04);
  border:1px solid var(--line-soft,#2a2724);border-radius:6px;color:var(--text,#ebe7df);font-size:12.5px;outline:none;font-family:inherit;}
.amp-pop-search::placeholder{color:var(--muted-2,#6b655e);}
.amp-pop-list{list-style:none;margin:0;padding:4px;max-height:min(60vh,420px);overflow-y:auto;}
.amp-pop-list::-webkit-scrollbar{width:5px;}
.amp-pop-list::-webkit-scrollbar-thumb{background:var(--line,#36322d);border-radius:3px;}
.amp-pop-empty{padding:16px 10px;text-align:center;color:var(--muted,#968f85);font-size:12.5px;}
.amp-pop-item{width:100%;text-align:left;display:flex;flex-direction:column;gap:2px;
  padding:7px 10px;border:1px solid transparent;border-radius:6px;background:transparent;
  color:inherit;cursor:pointer;font-family:inherit;transition:background .1s,border-color .1s;}
.amp-pop-item:hover:not(:disabled){background:var(--panel-2,#282623);}
.amp-pop-item.active{background:var(--info-soft,rgba(122,166,194,.12));border-color:rgba(122,166,194,.45);}
.amp-pop-item:disabled{cursor:not-allowed;}
.amp-pop-item-top{display:flex;align-items:center;gap:6px;}
.amp-pop-item-top strong{font-size:13px;}
.amp-pop-dot{display:inline-block;width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.amp-pop-api{margin-left:auto;font-size:11px;color:var(--muted-2,#6b655e);font-family:var(--font-mono,monospace);}
.amp-pop-err{font-size:10.5px;color:var(--danger,#c8675d);}
.amp-pop-meta{font-size:11.5px;color:var(--muted,#968f85);}
`;
  const el = document.createElement('style');
  el.id = AMP_POP_STYLE_ID;
  el.textContent = css;
  document.head.appendChild(el);
}

/* AgentModelPicker — 全站唯一的「某 agent / 模块用哪个模型」选择器。
   Provider + Model 两个 CSSelect,默认写入 user_preferences:
     <prefPrefix>.api_id / <prefPrefix>.model_real_name
   后端各 agent 的 resolve_api_and_model 读同名 key。
   导入剧本(extractor)/ 导入角色卡 AI 整理(card_import)/ 设置页「模块分配」/
   游戏内模型切换 等全部共用此组件 —— UI 与持久化完全一致,不再各写一套。

   ── 落库形态(persistShape) ──────────────────────────────────────────────
     "flat"(默认)  : 写 <prefPrefix>.api_id + <prefPrefix>.model_real_name 双 key
     "dict"        : 写 dictKey = { api_id, model } 单 key 对象(sub_agent / console)
     "models_select": 调 POST /api/models/select(per-user gm scope,可带 saveId),
                      不写 preferences —— 游戏内 GM 模型切换用

   ── 继承(allowInherit) ──────────────────────────────────────────────────
     allowInherit=true 时下拉首项为 inheritLabel(默认「跟随主 GM」),选中=清空偏好
     (flat 写 null/null;dict 写 null),后端解析时回退主 GM / 系统默认。

   ── 紧凑浮层(variant="popover") ──────────────────────────────────────────
     纯 CSS 浮层(无 Cloudscape 依赖),按 provider 分组、可搜索、可显示
     health badge(showHealth)/价格(showPricing),替代旧 game-composer ModelPopover。

   props:
     prefPrefix       : 偏好命名空间(如 "extractor" / "card_import" / "gm")
     header           : 容器标题(variant="container" 时)
     description      : 标题下描述
     defaultModel     : 用户未配时的默认候选 model_real_name；不传则取后端 selected.real_name
     preferProvider   : 用户已配 key 时优先选的 provider(如 "deepseek")
     configHash       : 「去配 key」跳转的 hash(默认 settings-models)
     variant          : "container"(带 CSContainer 外框) | "bare"(只渲染内容) | "popover"(紧凑浮层)
     onChange?        : (api_id, model) => void  选择变化时回调(可选)
     capabilityFilter?: string  只展示 capabilities 含此值的模型(如 "image_gen" / "embedding")
     persistShape?    : "flat"(默认) | "dict" | "models_select"
     dictKey?         : persistShape="dict" 时写入的单 key(如 "sub_agent_model_override")
     allowInherit?    : 是否提供「跟随主 GM」(清空偏好)首项,默认 false
     inheritLabel?    : 继承项文案,默认「跟随主 GM」
     saveId?          : persistShape="models_select" 时传入 → 存档级切换(不动全局)
     showHealth?      : variant="popover" 时展示 health badge(默认 false)
     showPricing?     : variant="popover" 时展示价格/ctx 行(默认 false)
     restrictPlatformVertex?: embedder 专用 — 非 admin/vip 不显示平台 vertex embedding 兜底
                              (传入 embedder/status 判定结果布尔:true=允许平台兜底) */
export default function AgentModelPicker({
  prefPrefix,
  header = null,
  description = '',
  defaultModel = null,      // 不再硬编码；null 时从后端 selected 取默认值
  preferProvider = null,
  configHash = 'settings-models',
  variant = 'container',
  onChange = null,
  persistOnMount = false,   // 无偏好时把解析出的默认(provider+model)一次性写入,保证"所见即所用"
  fallbackPrefix = null,    // 本功能(prefPrefix)无偏好时,继承哪个偏好命名空间作默认(如 'gm'=用户默认模型);默认不继承
  capabilityFilter = null,  // 可选：只展示 capabilities 含此字符串的模型(如 "image_gen")
  persistShape = 'flat',    // "flat" | "dict" | "models_select"
  dictKey = null,           // persistShape="dict" 时的单 key
  allowInherit = false,     // 提供「跟随主 GM」(清空偏好)首项
  inheritLabel = null,
  saveId = null,            // persistShape="models_select" 存档级切换
  showHealth = false,       // variant="popover" health badge
  showPricing = false,      // variant="popover" 价格/ctx 行
  platformVertexAllowed = false,  // embedder:是否允许平台 vertex embedding 兜底(admin/vip)
}) {
  const { t } = useTranslation();
  const effectiveHeader = header ?? t('agent_picker.default_header');
  const effectiveInheritLabel = inheritLabel ?? t('agent_picker.inherit_label');
  const { useState, useEffect } = React;
  const [apis, setApis] = useState([]);
  const [credApiIds, setCredApiIds] = useState(new Set());
  const [apiId, setApiId] = useState('');
  const [model, setModel] = useState('');
  const [inherit, setInherit] = useState(false);     // 当前是否「跟随主 GM」(无偏好态)
  const [saving, setSaving] = useState(false);
  const [customSel, setCustomSel] = useState(false);  // 用户在下拉里显式选了「自定义…」
  const [reloadTick, setReloadTick] = useState(0);    // 凭据变更后强制重拉(issue #22)
  const [popOpen, setPopOpen] = useState(false);      // variant="popover" 浮层开关
  const [popQuery, setPopQuery] = useState('');       // popover 搜索词
  const [loaded, setLoaded] = useState(false);        // 模型/凭据首拉是否完成(区分「加载中」与「真的没模型」)
  const [loadError, setLoadError] = useState(false);  // 目录+凭据【双双】拉取失败 → 错误态+重试(不再假扮"没配 key")
  const [syncing, setSyncing] = useState(false);      // stale 快照已上屏、后台校真进行中 → 提示"列表可能马上更新"
  const popRef = useState(() => React.createRef())[0];
  const popTriggerRef = useState(() => React.createRef())[0];
  // 上次回声过的 "api|model":同一值不重复回声(内存快照→校真两趟常解析出同一个值)。
  const lastEchoRef = useState(() => ({ current: '' }))[0];
  // 用户显式动过选择器的**代次**(选模型 / 切换继承 → +1)。
  // 用途:丢弃「在这一代之前发出的」校真响应 —— 冷加载时 /api/me/profile 这类重接口可能几秒才回,
  // 期间用户点了模型,那份带着改前旧值的结果回来会把用户的选择改回去("选完自己变回去")。
  // 用计数器而不是布尔:换/删 API Key 会触发 reloadTick 重拉(那是一次**新的**请求,应当被应用),
  // 布尔标记会把它一起挡掉 —— 计数器的比较只丢弃"发出早于用户操作"的那一份。
  const userTouchEpochRef = useState(() => ({ current: 0 }))[0];

  // 换/删 API Key 后(api-client 广播 rpg-credentials-updated)重拉 API/模型/凭据列表,
  // 让下拉里能选的 provider/模型与当前 key 同步。
  useEffect(() => {
    const bump = () => { invalidatePickerSnapshot(); setReloadTick((x) => x + 1); };
    window.addEventListener('rpg-credentials-updated', bump);
    return () => window.removeEventListener('rpg-credentials-updated', bump);
  }, []);

  // 数据应用:把一份 {models, creds, prefs} 推导成选中态。推导逻辑与旧版逐行一致(机械搬家)。
  // authoritative=false(stale 快照先画)时:不做 persistOnMount 写回 —— 临时值绝不落库
  // (游戏内浮层据 source 判断不关闭/不刷新);但**回声照发**,见下方 onChange 处。
  const applyData = (modelsData, credsData, prefsData, { authoritative = true } = {}) => {
    {
        const list = modelsData?.models?.apis || (Array.isArray(modelsData?.apis) ? modelsData.apis : []) || [];
        setApis(Array.isArray(list) ? list : []);
        // AgentPlatform 是 Vertex 的 SA 凭证 — UI 里归一成 vertex_ai（与后端 canonical 一致）
        // 局部 ids 供下方 eligible()/Array.from(ids) 用 —— 此前直接引用未声明的 `ids` 会抛
        // ReferenceError,被本块外层 catch 静默吞掉,导致挂载时 setApiId/setModel/onChange(init)
        // 整段不执行(无偏好场景下选择器空着、回显失败)。必须用已构建的 Set。
        const ids = credApiIdSet(credsData);
        setCredApiIds(ids);
        // 后端 selected 是全局默认模型（由 /api/models 返回）；
        // defaultModel prop 若未传（null），就从 selected 取。
        const backendSelected = modelsData?.selected;
        const resolvedDefaultModel = defaultModel
          || (backendSelected && (backendSelected.real_name || backendSelected.model_id))
          || '';
        const p = prefsData || {};
        // ── dict-shape(sub_agent / console)读取:dictKey = { api_id, model } ──
        let prefApi, prefModel;
        if (persistShape === 'dict' && dictKey) {
          const dv = p[dictKey];
          if (dv && typeof dv === 'object' && (dv.api_id || dv.model)) {
            prefApi = dv.api_id; prefModel = dv.model;
          }
        } else if (persistShape === 'models_select') {
          // 游戏内 GM 模型切换:当前生效模型来自后端 selected(per-user gm 偏好),
          // 不读 prefPrefix 双 key(那是别的命名空间)。
          prefApi = backendSelected && backendSelected.api_id;
          prefModel = backendSelected && (backendSelected.real_name || backendSelected.model_id);
        } else {
          prefApi = p[`${prefPrefix}.api_id`];
          prefModel = p[`${prefPrefix}.model_real_name`];
        }
        // allowInherit:本功能完全无偏好 → 当前态为「跟随主 GM」(inherit)。
        const noPref = !(prefApi || prefModel);
        setInherit(allowInherit && noPref);
        // fallbackPrefix(如 'gm')= 用户设置的默认模型。本功能(prefPrefix)无偏好时,优先继承它,
        // 而不是落到便宜档/写死默认 —— 满足"默认是用户设置的默认模型"。
        const fbApi = fallbackPrefix ? p[`${fallbackPrefix}.api_id`] : '';
        const fbModel = fallbackPrefix ? p[`${fallbackPrefix}.model_real_name`] : '';
        // Provider:本功能偏好 > 继承的默认 provider(若已配 key) > 后端 selected provider(若已配 key)
        //   > 偏好的 provider(若已配 key) > 用户首个已配 provider
        const selectedApiId = backendSelected && (backendSelected.api_id || '');
        // embedder(admin/vip)平台兜底:vertex_ai 即使不在 ids(没配用户 SA),也算可选 provider。
        const platVertexOk = allowInherit === false && capabilityFilter === 'embedding'
          && platformVertexAllowed;
        const eligible = (aid) => !!aid && (ids.has(aid)
          || (platVertexOk && aid === 'vertex_ai'
              && list.some((x) => (x.api_id || x.id) === 'vertex_ai'
                  && (x.models || x.entries || []).some((m) => (m.capabilities || m.caps || []).includes('embedding')))));
        // prefApi 也必须过 eligible 闸:删掉某 provider 的 key 后,若偏好仍指向它,
        // 不该继续把选中态钉在一个「已无 key、模型列表为空」的 provider 上,而要自动
        // 降级到用户当前真有 key 的 provider(issue #22:删 key 后选择器空列表)。
        const chosenApi = (prefApi && eligible(prefApi) ? prefApi : null)
          || (fbApi && eligible(fbApi) ? fbApi : null)
          || (selectedApiId && eligible(selectedApiId) ? selectedApiId : null)
          || (preferProvider && eligible(preferProvider) ? preferProvider : null)
          || Array.from(ids)[0]
          || (platVertexOk ? 'vertex_ai' : null)
          // 兜底:用户一个 key 都没配时仍回显偏好/preferProvider,避免完全空白(不算回归)。
          || prefApi
          || preferProvider || '';
        // Model 必须属于 chosenApi(否则会出现 Anthropic + gemini 这种错配):
        //   本功能偏好 model > 继承的默认 model(若在该 provider 下) > resolvedDefaultModel
        //   > 该 provider 首个 capabilityFilter 过滤后的模型
        const apiObj = list.find((x) => (x.api_id || x.id) === chosenApi);
        let chosenModels = (apiObj?.models || apiObj?.entries || []);
        // capabilityFilter='embedding' 时保留 embedding 模型；否则剔除 embedding-only(避免聊天选择器混进 RAG 模型)。
        if (capabilityFilter !== 'embedding') {
          chosenModels = chosenModels.filter((m) => !((m.capabilities || m.caps || []).length === 1 && (m.capabilities || m.caps || [])[0] === 'embedding'));
        }
        // capabilityFilter 过滤（仅影响"默认首选"查找，不影响最终兜底）
        const capFilteredModels = capabilityFilter
          ? chosenModels.filter((m) => (m.capabilities || m.caps || []).includes(capabilityFilter))
          : chosenModels;
        const fbModelValid = fbModel && capFilteredModels.some((m) => (m.real_name || m.id) === fbModel);
        const hasDefault = capFilteredModels.some((m) => (m.real_name || m.id) === resolvedDefaultModel);
        // 该 provider 下偏向便宜档(haiku/flash/mini/lite/small/nano),适合整理这种工具任务,
        // 避免默认落到旗舰(如 Opus)烧额度。
        const cheapRe = /haiku|flash|mini|lite|small|nano/i;
        const cheap = capFilteredModels.find((m) => cheapRe.test(m.real_name || m.id || '') || cheapRe.test(m.display_name || ''));
        const firstModel = capFilteredModels[0] ? (capFilteredModels[0].real_name || capFilteredModels[0].id) : '';
        const chosenModel = prefModel
          || (fbModelValid ? fbModel : null)
          || (hasDefault ? resolvedDefaultModel : null)
          || (cheap ? (cheap.real_name || cheap.id) : null)
          || firstModel
          || resolvedDefaultModel;
        setApiId(chosenApi);
        setModel(chosenModel);
        // 把解析出的当前 provider+model 告知父组件(父拿它提交),与展示完全一致,不依赖 persistOnMount。
        // source='init':这是「解析出的当前模型回声」,不是用户真的换了模型 ——
        // 游戏内浮层据此【不关闭/不刷新】(否则一打开就被这条回声关掉,见 game-composer / MobileGame)。
        // ⚠️ 快照路径(authoritative=false)也必须回声:新鲜内存快照会 early return、校真那趟永不执行
        // (见下方挂载 effect 第 ② 步),不回声就会出现「选择器自己把模型画上屏、父组件拿到的却是空值」
        // —— 生图弹窗据此报「请先选择模型」,必须重选一次才成功(2026-09 回归)。
        // 同一个值只回一次声(内存快照→校真两趟值相同时不重复 setState)。
        const echoKey = `${chosenApi}|${chosenModel}`;
        if (chosenApi && chosenModel && lastEchoRef.current !== echoKey) {
          lastEchoRef.current = echoKey;
          onChange && onChange(chosenApi, chosenModel, 'init');
        }
        // 无偏好时把解析出的一致默认写回(仅当 provider+model 都有效),避免"显示一套、后端用另一套"。
        // persistOnMount 只对 flat shape 有意义(dict/models_select/allowInherit 不在挂载时强写)。
        // stale 快照先画(authoritative=false)时不写回 —— 临时值绝不落库。
        if (authoritative && persistOnMount && persistShape === 'flat' && !allowInherit
            && chosenApi && chosenModel && !(prefApi && prefModel)) {
          window.api.account.preferences({
            [`${prefPrefix}.api_id`]: chosenApi,
            [`${prefPrefix}.model_real_name`]: chosenModel,
          }).catch(() => { /* 静默 */ });
        }
      }
  };

  // 挂载/重拉三步:① 先画缓存(内存或 localStorage)→ 已保存选择即时上屏,不等网络;
  // ② 内存快照还新鲜 → 0 请求直达(本会话内切页面即此路径);③ 过期/没有 → 拉新
  // (single-flight,同页 N 实例共享一次)。失败且没有任何缓存可画 → 错误态+重试,
  // 不再像旧版那样把异常吞成「尚未配置任何 API key」的永久空状态。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = _shared || _readLocalSnapshot();
      if (cached) {
        setLoadError(false);
        // 先画快照并置 loaded —— 表单立即用 stale 数据上屏(这就是"即时上屏"),
        // 后台校真完成后 applyData(authoritative) 平滑更新到最新。
        setLoaded(true);
        setSyncing(true);   // stale 在屏 → 挂"同步中"提示,校真结束(成败皆)摘除
        applyData(cached.models, cached.creds, cached.prefs, { authoritative: false });
      }
      if (_shared && _snapshotFresh(_shared)) {
        if (!cancelled) { setLoaded(true); setLoadError(false); setSyncing(false); }
        return;
      }
      // 记下"这一份请求是第几代发出的":回来时若用户已经动过(代次变了),就丢弃它。
      const touchedAtStart = userTouchEpochRef.current;
      try {
        const s = await _getShared();
        if (cancelled) return;
        setSyncing(false);
        if (!s.models) {
          // 目录这一腿失败(凭据可能成功):诚实地进错误态+重试,而不是拿着空目录
          // 显示「没有可显示的模型」—— 那会把"加载不完整"伪装成"供应商没模型"。
          setLoadError(true);
          return;
        }
        setLoadError(false);
        // 发出这份请求之后用户动过选择器 → 它的值可能已经过时,不能覆盖用户的选择,连回声也不发。
        // 只摘掉"同步中"提示。(换/删 Key 触发的重拉是在用户操作**之后**发出的,代次相同 → 照常应用。)
        if (userTouchEpochRef.current !== touchedAtStart) return;
        applyData(s.models, s.creds, s.prefs, { authoritative: true });
      } catch (_) {
        // 有 stale 快照在屏就不吓用户(后台刷新失败,保留旧画面);从零失败才亮错误态
        if (!cancelled) { if (!cached) setLoadError(true); setSyncing(false); }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefPrefix, dictKey, persistShape, saveId, reloadTick]);

  // 该 (aid, m) 当前是否 degraded —— 从 /api/models 响应(apis state,含 _inject_health 注入的
  // api.degraded / model.degraded)里查,不额外发请求。
  const isChannelDegraded = (aid, m) => {
    const a = apiOf(aid);
    if (!a) return false;
    if (a.degraded) return true;
    const mm = (a.models || a.entries || []).find((x) => (x.real_name || x.id) === m);
    return !!(mm && mm.degraded);
  };

  // 统一落库:按 persistShape 走 flat 双 key / dict 单 key 对象 / POST /api/models/select。
  const persist = async (aid, m) => {
    if (!aid || !m) return;
    // 推进代次必须在 await **之前**:在途的那份校真响应回来时不该覆盖用户这次选择。
    userTouchEpochRef.current += 1;
    setSaving(true);
    setInherit(false);
    try {
      if (persistShape === 'dict' && dictKey) {
        await window.api.account.preferences({ [dictKey]: { api_id: aid, model: m } });
      } else if (persistShape === 'models_select') {
        await window.api.models.select({
          api_id: aid, model_id: m,
          ...(saveId != null ? { save_id: saveId } : {}),
        });
      } else {
        await window.api.account.preferences({
          [`${prefPrefix}.api_id`]: aid,
          [`${prefPrefix}.model_real_name`]: m,
        });
      }
      onChange && onChange(aid, m, 'user');   // 用户真的换了模型 → 浮层据此关闭/刷新
      // 新值写穿快照:否则 5 分钟内重开时快照仍解析出**改前**的旧值,而它会被 init 回声交给
      // 父组件(ScriptDetail 这类"body 覆盖后端偏好"的接口会因此提交错模型)。
      _patchSnapshotPrefs(
        persistShape === 'dict' && dictKey
          ? { [dictKey]: { api_id: aid, model: m } }
          : persistShape === 'models_select'
            ? {}   // 这个 shape 没有 pref 键 → 只靠 ts=0 让下次挂载校真取回真值
            : { [`${prefPrefix}.api_id`]: aid, [`${prefPrefix}.model_real_name`]: m },
      );
      // 渠道健康门控:选中的渠道最近多次故障 —— 不阻止选择,只 warn 提示(models_select 路径,
      // 即游戏内 GM 模型切换;其它 persistShape 维持原静默行为,与既有 reject 分支同范围)。
      if (persistShape === 'models_select' && isChannelDegraded(aid, m)) {
        window.__apiToast?.(t('agent_picker.degraded_select_warning'), { kind: 'warn', duration: 4000 });
      }
    } catch (e) {
      // models_select 路径:后端可能前置拒绝(如 vertex_ai 未上传 SA,needs_model_config)
      // 这类错误必须提示用户,不能像其它 persistShape 一样静默吞掉 —— 否则用户以为切换成功,
      // 实际下一轮对话仍用旧模型/直接报错。其余 persistShape 维持原静默行为。
      if (persistShape === 'models_select') {
        window.__apiToast?.(e?.message || t('agent_picker.select_save_failed'), { kind: 'warn', duration: 4000 });
      }
    } finally { setSaving(false); }
  };

  // allowInherit:清空本功能偏好 → 后端解析回退主 GM / 系统默认。
  const persistInherit = async () => {
    userTouchEpochRef.current += 1;   // 同 persist():推进代次要放在 await 之前
    setSaving(true);
    try {
      if (persistShape === 'dict' && dictKey) {
        await window.api.account.preferences({ [dictKey]: null });
      } else {
        await window.api.account.preferences({
          [`${prefPrefix}.api_id`]: null,
          [`${prefPrefix}.model_real_name`]: null,
        });
      }
      setInherit(true);
      setCustomSel(false);
      onChange && onChange(null, null, 'user');
      // 镜像"已清空":否则快照里仍留着旧偏好,下次挂载又会把它画上屏/回声给父组件。
      _patchSnapshotPrefs(
        persistShape === 'dict' && dictKey
          ? { [dictKey]: null }
          : { [`${prefPrefix}.api_id`]: null, [`${prefPrefix}.model_real_name`]: null },
      );
    } catch (_) { /* 静默 */ } finally { setSaving(false); }
  };

  const apiOf = (id) => apis.find((x) => (x.api_id || x.id) === id);
  const modelsOf = (id) => (apiOf(id)?.models || apiOf(id)?.entries || []);
  const isEmbeddingOnly = (m) => {
    const caps = m.capabilities || m.caps || [];
    return caps.length === 1 && caps[0] === 'embedding';
  };
  // embedder 平台兜底:仅 admin/vip(platformVertexAllowed=true)可见平台 vertex embedding。
  // 非 vip/admin 用户没上传自己的 SA 时 vertex_ai 不在 credApiIds → 不会被显示(收紧到位)。
  const platformVertexEmbedding = platformVertexAllowed && capabilityFilter === 'embedding';
  // 单一真相:某 provider 在选择器里是否可见。
  //   = provider 级 curation 开(a.enabled !== false,即用户/admin 没在「模型管理」隐藏它)
  //     且(用户配了该 provider 凭据 OR 平台 vertex embedding 兜底)。
  // 游戏内 popover 与设置/聊天 bare 的 providerOptions 共用此判定,避免两套门控不一致 ——
  // 历史 bug:popover 看 a.enabled、下拉只看 cred,导致用户禁用的 provider(如 openrouter 336 模型)
  // 在聊天/游戏选择器里仍冒出「完整模型列表」。
  // 已知没有 embedding 接口的 chat-only provider:选嵌入器时排除(即便用户配了聊天凭据)——
  // 否则用户能把 deepseek 选成嵌入器 → 每批 404、导入 RAG 坏掉(后端 embedding.provider_lacks_embedding 兜底)。
  const NO_EMBEDDING_PROVIDERS = new Set(['deepseek', 'anthropic', 'moonshot']);
  const _providerVisible = (a) => {
    const aid = a && (a.api_id || a.id);
    if (!aid) return false;
    if (a.enabled === false) return false;          // 用户/admin 在模型管理隐藏了该 provider
    if (capabilityFilter === 'embedding' && NO_EMBEDDING_PROVIDERS.has(String(aid).toLowerCase())) return false;
    if (credApiIds.has(aid)) return true;           // 用户配了凭据
    if (platformVertexEmbedding && aid === 'vertex_ai'
        && (a.models || a.entries || []).some((m) => (m.capabilities || m.caps || []).includes('embedding'))) return true;
    return false;
  };
  // 渠道健康门控(韧性战役):degraded provider 不置灰不禁选(用户可能就是要试),
  // 只在下拉/浮层加警示后缀 —— 与既有 showHealth(popover 专属、置灰 err 项)是两条独立逻辑。
  const degradedLabel = (label, degraded) => degraded ? `${label} ${t('agent_picker.degraded_suffix')}` : label;
  const providerOptions = React.useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const a of apis) {
      const id = a.api_id || a.id;
      if (!id || seen.has(id)) continue;
      if (!_providerVisible(a)) continue;            // 尊重 a.enabled curation + 凭据
      seen.add(id);
      out.push({ value: id, label: degradedLabel(a.display_name || a.name || id, !!a.degraded) });
    }
    // 自定义 OpenAI-compatible API 可能只有用户凭证,不在全局模型目录里。
    for (const id of credApiIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ value: id, label: id });
    }
    return out;
  }, [apis, credApiIds, platformVertexEmbedding]);
  // 过滤后的模型条目(共用于下拉 + popover)。
  const filteredModels = modelsOf(apiId).filter((m) => {
    const caps = m.capabilities || m.caps || [];
    // capabilityFilter='embedding' 时只看 embedding;其它(含无 filter)排除 embedding-only(避免聊天选择器混进 RAG)。
    if (capabilityFilter === 'embedding') return caps.includes('embedding');
    if (isEmbeddingOnly(m)) return false;
    if (capabilityFilter) return caps.includes(capabilityFilter);
    return true;
  });
  const modelOptions = filteredModels.map((m) => ({
    value: m.real_name || m.id,
    label: `${degradedLabel(m.display_name || m.real_name || m.id, !!m.degraded)}${m.enabled === false ? ` ${t('agent_picker.model_disabled_suffix')}` : ''}`,
    disabled: m.enabled === false,
  }));

  // 「自定义」态:用户显式选了自定义,或当前 model 不在该 provider 的目录里(如手填的旧偏好)。
  const CUSTOM_MODEL = '__custom_model__';
  const INHERIT = '__inherit__';
  const knownModelVals = new Set(modelOptions.map((o) => o.value));
  const isCustomModel = !inherit && customSel || (!inherit && modelOptions.length > 0 && !!model && !knownModelVals.has(model));
  // 是否展示「未配 key」告警:加载【完成】且无任何凭据 且 没有平台 vertex 兜底可用。
  // loaded 前置是本次修复的核心:旧版从首帧起就把"加载中"渲染成"没配 key"(闪错误)。
  const showNoKeyAlert = loaded && !loadError && credApiIds.size === 0
    && !(platformVertexEmbedding && providerOptions.length > 0);

  const noProviders = providerOptions.length === 0;
  // Model 下拉项:首项可选「跟随主 GM」(allowInherit),末项「自定义…」。
  const modelSelectOptions = [
    ...(allowInherit ? [{ value: INHERIT, label: effectiveInheritLabel }] : []),
    ...modelOptions,
    { value: CUSTOM_MODEL, label: t('agent_picker.custom_model_option') },
  ];
  const modelSelectSelected = inherit
    ? { value: INHERIT, label: effectiveInheritLabel }
    : isCustomModel
      ? { value: CUSTOM_MODEL, label: t('agent_picker.custom_model_short') }
      : (() => {
          const m = modelsOf(apiId).find((x) => (x.real_name || x.id) === model);
          return m ? { value: model, label: degradedLabel(m.display_name || m.real_name || m.id, !!m.degraded) }
            : (model ? { value: model, label: model } : null);
        })();

  const readyForm = (
    <>
      {showNoKeyAlert && (
        <CSAlert type="warning" header={t('agent_picker.no_key_alert_header')} action={
          <CSButton iconName="settings" onClick={() => { plGoto(configHash); }}>{t('agent_picker.go_config_key')}</CSButton>
        }>
          {t('agent_picker.no_key_alert_body')}
        </CSAlert>
      )}
      <CSColumnLayout columns={2}>
        <CSFormField label={t('agent_picker.provider_label')}>
          <CSSelect
            selectedOption={inherit ? null : (() => {
              const a = apiOf(apiId);
              return a ? { value: apiId, label: degradedLabel(a.display_name || a.name || apiId, !!a.degraded) }
                : (apiId ? { value: apiId, label: `${apiId} ${t('agent_picker.provider_no_key_suffix')}` } : null);
            })()}
            options={providerOptions}
            placeholder={noProviders ? t('agent_picker.provider_placeholder_no_key') : (inherit ? effectiveInheritLabel : t('agent_picker.provider_placeholder'))}
            onChange={({ detail }) => {
              const aid = detail.selectedOption.value;
              setApiId(aid);
              setInherit(false);
              const m0 = filteredModelsOf(aid).find((m) => m.enabled !== false);
              const mid = m0 ? (m0.real_name || m0.id) : '';
              setCustomSel(false);  // 换 provider 重置「自定义」态
              // 切到「无可用模型」的 provider 时,绝不回写旧 provider 的 model
              // (否则会把 {新api_id, 旧model_real_name} 错配写进 preferences → 后端解析失败)。
              if (mid) { setModel(mid); persist(aid, mid); }
              else { setModel(''); }
            }}
            disabled={saving || noProviders}
            empty={t('agent_picker.provider_empty')}
          />
        </CSFormField>
        <CSFormField label={t('agent_picker.model_label')} description={t('agent_picker.model_field_description')}>
          <div style={{ display: 'grid', gap: 8 }}>
            {(modelOptions.length > 0 || allowInherit) && (
              <CSSelect
                selectedOption={modelSelectSelected}
                options={modelSelectOptions}
                placeholder={t('agent_picker.model_placeholder')}
                onChange={({ detail }) => {
                  const mid = detail.selectedOption.value;
                  if (mid === INHERIT) { persistInherit(); }
                  else if (mid === CUSTOM_MODEL) { setCustomSel(true); setInherit(false); }
                  else { setCustomSel(false); setInherit(false); setModel(mid); persist(apiId, mid); }
                }}
                disabled={saving || (!apiId && !allowInherit)}
              />
            )}
            {(isCustomModel || (modelOptions.length === 0 && !allowInherit)) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                <CSInput
                  value={model}
                  placeholder={t('agent_picker.model_name_placeholder')}
                  onChange={({ detail }) => setModel(detail.value)}
                  onBlur={() => { const m = (model || '').trim(); if (apiId && m) persist(apiId, m); }}
                  disabled={saving || !apiId}
                />
                <CSButton
                  loading={saving}
                  disabled={saving || !apiId || !(model || '').trim()}
                  onClick={() => persist(apiId, (model || '').trim())}
                >
                  {t('common.save')}
                </CSButton>
              </div>
            )}
          </div>
        </CSFormField>
      </CSColumnLayout>
      {syncing && (
        <div className="muted-2" style={{ fontSize: 11, padding: '2px 0' }}>{t('agent_picker.syncing_hint')}</div>
      )}
    </>
  );

  // 三态渲染:① 加载失败 → 错误条 + 重试(不再假扮"没配 key"的永久死路);
  // ② 加载中 → 一行轻量占位,表单整体不渲染(杜绝"禁用下拉"的假象);
  // ③ 就绪 → 告警 + 表单(readyForm,内部与旧版逐行一致)。
  const body = (
    <>
      {loadError && (
        <CSAlert
          type="error"
          header={t('agent_picker.load_failed')}
          action={(
            <CSButton iconName="refresh" onClick={() => { setLoadError(false); setReloadTick((x) => x + 1); }}>
              {t('agent_picker.retry')}
            </CSButton>
          )}
        />
      )}
      {!loaded && !loadError && (
        <div className="muted-2" style={{ fontSize: 12, padding: '2px 0' }}>{t('agent_picker.loading')}</div>
      )}
      {loaded && !loadError && readyForm}
    </>
  );

  if (variant === 'popover') return renderPopover();
  if (variant === 'bare') return body;
  return (
    <CSContainer header={<CSHeader variant="h2" description={description}>{effectiveHeader}</CSHeader>}>
      {body}
    </CSContainer>
  );

  // ── variant="popover":游戏内紧凑浮层(替代旧 game-composer ModelPopover) ──────
  function filteredModelsOf(aid) {
    return modelsOf(aid).filter((m) => {
      const caps = m.capabilities || m.caps || [];
      if (capabilityFilter === 'embedding') return caps.includes('embedding');
      if (isEmbeddingOnly(m)) return false;
      if (capabilityFilter) return caps.includes(capabilityFilter);
      return true;
    });
  }

  function renderPopover() {
    // 扁平化所有【可见 provider】(尊重 a.enabled curation + 凭据)下的可选模型(+ health / pricing)。
    // 与 providerOptions 共用 _providerVisible,两处门控一致。
    const flat = [];
    for (const a of apis) {
      const aid = a.api_id || a.id;
      if (!_providerVisible(a)) continue;
      for (const m of filteredModelsOf(aid)) {
        if (m.enabled === false) continue;
        const pricing = m.pricing || {};
        flat.push({
          api_id: aid,
          api_label: a.display_name || a.name || aid,
          real_name: m.real_name || m.id,
          label: m.display_name || m.real_name || m.id,
          desc: (m.capabilities || m.caps || []).slice(0, 3).join(' · '),
          health: m.health || 'untested',
          health_error: m.health_error || '',
          health_latency_ms: m.health_latency_ms,
          // 渠道健康门控:与 health(主动探测结果,枚举含未触发的 "degraded" 值)是独立信号——
          // 这里是被动失败计数触发的渠道级降权,命名 channel_degraded 避免与 health==='degraded' 混淆。
          channel_degraded: !!(m.degraded || a.degraded),
          price_in: pricing.input != null ? pricing.input : null,
          price_out: pricing.output != null ? pricing.output : null,
          ctx: pricing.context != null ? pricing.context : null,
        });
      }
    }
    const order = { ok: 0, untested: 1, degraded: 2, err: 3 };
    flat.sort((a, b) => (order[a.health] ?? 4) - (order[b.health] ?? 4));
    const q = popQuery.trim().toLowerCase();
    const filtered = q ? flat.filter((m) =>
      `${m.label} ${m.real_name} ${m.api_label} ${m.api_id}`.toLowerCase().includes(q)) : flat;
    const selKey = (apiId && model) ? `${apiId}::${model}` : '';
    // K/M 缩写走 window.__fmt.compact(语义统一 #30);本组件 falsy → null(非 "—"),故保留该分支。
    const fmtCtx = (n) => !n ? null
      : ((window.__fmt && window.__fmt.compact) ? window.__fmt.compact(n)
        : (n >= 1000000 ? `${Math.round(n / 1000000)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)));
    const fmtPrice = (m) => (m.price_in != null && m.price_out != null)
      ? (m.price_in === 0 && m.price_out === 0 ? t('agent_picker.price_free') : `$${m.price_in.toFixed(2)} / $${m.price_out.toFixed(2)} per M`) : null;

    return (
      <div ref={popRef} className="amp-pop">
        <div className="amp-pop-head">
          <input
            className="amp-pop-search"
            type="text"
            value={popQuery}
            placeholder={t('agent_picker.popover_search_placeholder')}
            onChange={(e) => setPopQuery(e.target.value)}
            autoFocus
          />
        </div>
        <ul className="amp-pop-list">
          {filtered.length === 0 && (
            <li className="amp-pop-empty">{
              loadError ? t('agent_picker.load_failed')
                : !loaded ? t('agent_picker.popover_loading')
                : q ? t('agent_picker.popover_no_match', { query: popQuery })
                : credApiIds.size === 0 ? t('agent_picker.popover_no_models')
                : t('agent_picker.popover_no_models_for_provider')
            }</li>
          )}
          {filtered.map((m) => {
            const key = `${m.api_id}::${m.real_name}`;
            const active = key === selKey;
            const unavailable = showHealth && m.health === 'err';
            const dotColor = m.health === 'ok' ? 'var(--ok,#3fa66a)'
              : m.health === 'degraded' ? '#e89b3a'
              : m.health === 'err' ? 'var(--danger,#c8675d)'
              : 'var(--muted,#968f85)';
            const price = showPricing ? fmtPrice(m) : null;
            const ctx = showPricing ? fmtCtx(m.ctx) : null;
            return (
              <li key={key}>
                <button
                  className={'amp-pop-item' + (active ? ' active' : '')}
                  disabled={saving || unavailable}
                  style={unavailable ? { opacity: 0.45 } : undefined}
                  onClick={() => { if (!saving && !unavailable) { setApiId(m.api_id); setModel(m.real_name); persist(m.api_id, m.real_name); } }}
                  title={unavailable ? `unreachable: ${(m.health_error || '').slice(0, 120)}` : m.real_name}
                >
                  <div className="amp-pop-item-top">
                    {showHealth && <span className="amp-pop-dot" style={{ background: dotColor }} />}
                    <strong>{m.label}</strong>
                    <span className="amp-pop-api">{m.api_label}</span>
                    {unavailable && <span className="amp-pop-err">unreachable</span>}
                  </div>
                  {(m.desc || price || ctx || m.channel_degraded) && (
                    <span className="amp-pop-meta">
                      {m.desc || null}
                      {price && <span style={{ marginLeft: m.desc ? 6 : 0, opacity: 0.85 }}>{price}</span>}
                      {ctx && <span style={{ marginLeft: (m.desc || price) ? 6 : 0, opacity: 0.7 }}>ctx {ctx}</span>}
                      {/* 渠道健康门控:degraded 不置灰不禁选,只加警示后缀(用户可能就是要试)。 */}
                      {m.channel_degraded && (
                        <span className="amp-pop-err" style={{ marginLeft: (m.desc || price || ctx) ? 6 : 0 }}>
                          {t('agent_picker.degraded_suffix')}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {syncing && (
            <li className="amp-pop-empty" style={{ padding: '4px 10px', fontSize: 11.5 }}>
              {t('agent_picker.syncing_hint')}
            </li>
          )}
        </ul>
      </div>
    );
  }
}
