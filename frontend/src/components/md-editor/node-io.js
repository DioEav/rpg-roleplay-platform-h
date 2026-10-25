// node-io.js — 节点内容读写(加载 → toMd;保存 → diff-only fromMd,含 front-matter 冻结闸)(机械搬出,逐字节不变)。
import i18n from '../../i18n';
import { api } from './helpers.js';
import { toMd, fromMd, splitFrontMatter } from '../../lib/md-serialize.js';

// ── 节点内容 加载:GET 行 → md-serialize.toMd ─────────────────────────────
async function loadNodeContentMeta(kind, sid, id) {
  const row = await loadRow(kind, sid, id);
  // 版本基线(乐观锁):
  //   · 章节/世界书/锚点/canon 用 updated_at(时间戳);
  //   · 角色卡用 row_version(整数,后端每次写 +1,比时间戳更稳)。
  // 打开标签时存进 tab,保存时回传;服务端已被 AI/另一标签改过 → 409,走三方合并。
  // 拿不到版本(老后端/字段缺失)时为 null,保存端不传基线 = 保持原来的覆盖语义。
  return {
    content: toMd(kind, row),
    updatedAt: (row && row.updated_at) || null,
    version: kind === 'card' && row && row.row_version != null ? row.row_version : null,
    // 章节稳定身份(script_chapters.id)。chapter_index 会因删除/拆分/合并/重切整本
    // 重排,只有 id 能判断「这个 index 还是不是打开时那一章」。保存时随
    // base_chapter_id 回传,服务端不一致直接 409 structure_changed,禁止跨章合并。
    stableId: kind === 'chapter' && row && row.id != null ? row.id : null,
  };
}
async function loadNodeContent(kind, sid, id) {
  return (await loadNodeContentMeta(kind, sid, id)).content;
}

async function loadRow(kind, sid, id) {
  const A = api();
  if (kind === 'chapter') {
    const r = await A.scripts.chapterDetail(sid, id);
    return r?.chapter ?? r ?? {};
  }
  if (kind === 'card') {
    const r = await A.cards.scriptGet(sid, id);
    return r?.card ?? r ?? {};
  }
  if (kind === 'worldbook') {
    // 编辑器要能管理全量条目:后端默认 limit=50,不传 fetch_all 时第 51 条之后
    // 在树里点不到、@引用也搜不到。fetch_all 是后端专门为编辑器加的无分页路径。
    const r = await A.scripts.worldbook(sid, { fetch_all: 1 });
    const arr = r?.entries || r?.items || (Array.isArray(r) ? r : []);
    return arr.find((x) => String(x.id) === String(id)) || {};
  }
  if (kind === 'anchor') {
    // timeline 端点按 phase 聚合,锚点字段是子集(无 keywords/sample_title);
    // diff-based 保存只发改动字段,故未加载字段不会被覆盖(见 saveNodeContent)。
    const r = await A.scripts.timeline(sid);
    for (const ph of (r?.phases || [])) for (const a of (ph.anchors || [])) {
      if (String(a.anchor_id || a.id) === String(id)) {
        return {
          ...a, id: a.anchor_id || a.id,
          // timeline 端点现在随锚点返回原始 story_phase(含空串)。旧实现拿桶名
          // 「未分阶段」兜底,导致冲突快照(DB 的 '')与本地 MD('未分阶段')出现假差异,
          // 「保留自己」还会把这个展示用桶名写进库。
          story_phase: a.story_phase !== undefined ? a.story_phase : (ph.phase_label || ''),
          // 乐观锁基线:timeline 接口随锚点下发 updated_at,保存时回传比对。
          updated_at: a.updated_at || null,
        };
      }
    }
    return { id };
  }
  if (kind === 'canon') {
    if (A.scripts.canonGet) { const r = await A.scripts.canonGet(sid, id); return r?.entity ?? r ?? {}; }
    // 兜底:列表里找(canonListAll 翻页拉全量;只有旧 client 时才退回默认 200 条)。
    const list = A.scripts.canonListAll || A.scripts.canonList;
    if (list) {
      const r = await list(sid);
      const arr = r?.entities || r?.items || [];
      return arr.find((e) => String(e.logical_key) === String(id)) || { logical_key: id };
    }
    return { logical_key: id };
  }
  return {};
}

// ── 节点内容 保存:fromMd(当前) vs fromMd(原始) 求 diff,只发改动字段 ──────────
// baseUpdatedAt / baseVersion 是打开标签时拿到的乐观锁基线:
//   · 时间戳实体(chapter/worldbook/anchor/canon)用 baseUpdatedAt(updated_at);
//   · 角色卡用 baseVersion(row_version,后端每次写 +1)。
// baseChapterId 仅章节:打开时拿到的稳定 script_chapters.id,服务端用它校验
// chapter_index 是否仍指向同一章(外部重排/多标签时防止跨章覆盖)。
// 返回 { updatedAt, version } 作为下一次保存的新基线;无实际改动返回 null。
async function saveNodeContent(kind, sid, id, content, original, baseUpdatedAt, baseVersion, baseChapterId) {
  const A = api();
  // front-matter 结构冻结(权威闸):顶层字段集合不可增删改名,只能改值。编辑层 frontMatterGuard 已挡掉
  // 改键名/破围栏的交互;此处兜底拦「新增/删除顶层字段」(加项目)—— 否则 fromMd 会静默丢弃非 schema 键,
  // 用户加了字段保存后凭空消失,体验更差。差异化报错让用户知道哪个字段越界。
  if (original != null) {
    try {
      const ka = Object.keys(splitFrontMatter(original).fm || {}).sort();
      const kb = Object.keys(splitFrontMatter(content).fm || {}).sort();
      if (ka.join('') !== kb.join('')) {
        const added = kb.filter((k) => !ka.includes(k));
        const removed = ka.filter((k) => !kb.includes(k));
        const parts = [];
        if (added.length) parts.push(i18n.t('md_editor.errors.fm_added', { fields: added.join(', ') }));
        if (removed.length) parts.push(i18n.t('md_editor.errors.fm_removed', { fields: removed.join(', ') }));
        throw new Error(i18n.t('md_editor.errors.fm_frozen', { parts: parts.join(';') }));
      }
    } catch (e) {
      if (e instanceof Error && /front-matter/.test(e.message)) throw e;
      /* YAML 解析失败等:交给下面 fromMd 抛更具体的错 */
    }
  }
  const cur = fromMd(kind, content);
  const orig = original != null ? fromMd(kind, original) : {};
  // canon.logical_key 是稳定标识,后端更新接口不接受改名;readonly 会让它从 patch
  // 里剔除,但若用户在前 front-matter 里改了值,不报错就会“保存成功→刷新回退”。
  // 这里显式拦截,给出可行动的错误,而不是静默丢弃。
  if (kind === 'canon' && original != null) {
    try {
      const a = (splitFrontMatter(original).fm || {}).logical_key;
      const b = (splitFrontMatter(content).fm || {}).logical_key;
      if (String(a ?? '') !== String(b ?? '')) {
        throw new Error(i18n.t('md_editor.errors.canon_key_readonly', {
          defaultValue: 'logical_key 是 canon 实体的稳定标识,不能在编辑器中修改。请恢复原值后再保存。',
        }));
      }
    } catch (e) {
      if (e instanceof Error && /logical_key/.test(e.message)) throw e;
      /* YAML 解析失败等交给下面 fromMd 报更具体的错 */
    }
  }
  const diff = diffPatch(orig, cur);
  if (Object.keys(diff).length === 0) return null;   // 无实际改动

  if (kind === 'chapter') {
    // base_updated_at=乐观锁:服务端已被他方(AI 工具/另一标签)改过时 409+服务端版本,
    // 调用方转三方合并。base_chapter_id=身份锁:index 已指向另一章时 409 structure_changed,
    // 调用方必须拒绝合并/force-save。返回新 updated_at 供刷新基线。
    const body = { ...diff };
    if (baseUpdatedAt) body.base_updated_at = baseUpdatedAt;
    if (baseChapterId != null) body.base_chapter_id = baseChapterId;
    const r = await A.scripts.updateChapter(sid, id, body);
    const ch = (r && r.chapter) || {};
    return { updatedAt: ch.updated_at || null, version: null };
  }
  if (kind === 'card') {
    // 后端 upsert_character_card 是「全量覆盖」(缺字段→清空,含 SCHEMA 不覆盖的 avatar/metadata/
    // token_budget/priority 等)。只发 diff 会抹掉这些 → 重新拉全卡、叠加本次编辑的可写字段、整卡回写。
    const full = await A.cards.scriptGet(sid, id);
    const base = (full && full.card) ? full.card : (full || {});
    const body = { ...base, id, ...cur };
    // 基线只用「打开标签时」的 row_version:若期间 AI/另一标签改过卡,服务端应 409 让用户合并,
    // 不能拿刚刚这次 GET 的新版本把窗口抹掉。baseVersion 缺失(旧标签/旧后端)= 不传,保持覆盖语义。
    if (baseVersion != null) body.base_row_version = baseVersion;
    const r = await A.cards.scriptUpsert(sid, body);
    const card = (r && r.card) || {};
    return { updatedAt: card.updated_at || null, version: card.row_version != null ? card.row_version : null };
  }
  if (kind === 'worldbook') {
    // 非章节实体此前是无条件覆盖写;现在带 base_updated_at 后,服务端把版本条件放进
    // UPDATE WHERE,不一致回 409 + server_entry(见 worldbook.py)。
    const body = baseUpdatedAt ? { ...diff, base_updated_at: baseUpdatedAt } : diff;
    const r = await A.scripts.worldbookUpdate(sid, id, body);
    return { updatedAt: (r && r.entry && r.entry.updated_at) || null, version: null };
  }
  if (kind === 'anchor') {
    if (!A.scripts.anchorUpdate) throw new Error(i18n.t('md_editor.errors.anchor_write_not_ready'));
    const body = baseUpdatedAt ? { ...diff, base_updated_at: baseUpdatedAt } : diff;
    const r = await A.scripts.anchorUpdate(sid, id, body);
    return { updatedAt: (r && r.anchor && r.anchor.updated_at) || null, version: null };
  }
  if (kind === 'canon') {
    if (!A.scripts.canonUpsert) throw new Error(i18n.t('md_editor.errors.canon_write_not_ready'));
    // canonUpsert 见到 logical_key 会走 PUT;base_updated_at 由端点与服务端 updated_at 比对。
    const body = baseUpdatedAt
      ? { logical_key: id, ...diff, base_updated_at: baseUpdatedAt }
      : { logical_key: id, ...diff };
    const r = await A.scripts.canonUpsert(sid, body);
    return { updatedAt: (r && r.entity && r.entity.updated_at) || null, version: null };
  }
  throw new Error(i18n.t('md_editor.errors.unknown_kind', { kind }));
}

// 乐观锁 409 的服务端快照按实体类型放在不同 key(与章节 server_chapter 同构)。
// 统一在这里取,调用方只传 kind,避免每处再写一遍 return 分支。
const CONFLICT_SERVER_KEY = {
  chapter: 'server_chapter',
  worldbook: 'server_entry',
  anchor: 'server_anchor',
  canon: 'server_entity',
  card: 'server_card',
};

function conflictServer(err, kind) {
  const p = (err && err.payload) || {};
  return p[CONFLICT_SERVER_KEY[kind]] || p.server || null;
}

// 服务端快照 → 新基线。时间戳实体取 updated_at;角色卡取 row_version。
// 章节额外带 chapterId(稳定 id):旧标签(打开时还没有 chapterId)在冲突合并/强制保存时
// 用它补上身份基线,避免合并期间 index 再次变化时写错章。非章节实体不返回该键,
// 保持原有基线形状,调用方用 `??` 取值即可兼容。
function serverBase(kind, server) {
  if (!server) return { updatedAt: null, version: null };
  const base = {
    updatedAt: server.updated_at || null,
    version: kind === 'card' && server.row_version != null ? server.row_version : null,
  };
  if (kind === 'chapter') {
    base.chapterId = server.id != null ? server.id : null;
  }
  return base;
}

// 浅 diff:返回 cur 中与 orig 不同(深比较值)的键。
function diffPatch(orig, cur) {
  const out = {};
  for (const k of Object.keys(cur)) {
    if (!deepEq(orig[k], cur[k])) out[k] = cur[k];
  }
  return out;
}
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEq(a[k], b[k]));
  }
  return false;
}

export { loadNodeContentMeta, saveNodeContent, conflictServer, serverBase };
