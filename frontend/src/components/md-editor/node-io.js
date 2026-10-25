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
    const r = await A.scripts.worldbook(sid);
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
          story_phase: a.story_phase || ph.phase_label || '',
          // 乐观锁基线:timeline 接口随锚点下发 updated_at,保存时回传比对。
          updated_at: a.updated_at || null,
        };
      }
    }
    return { id };
  }
  if (kind === 'canon') {
    if (A.scripts.canonGet) { const r = await A.scripts.canonGet(sid, id); return r?.entity ?? r ?? {}; }
    // 兜底:列表里找
    if (A.scripts.canonList) {
      const r = await A.scripts.canonList(sid);
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
// 返回 { updatedAt, version } 作为下一次保存的新基线;无实际改动返回 null。
async function saveNodeContent(kind, sid, id, content, original, baseUpdatedAt, baseVersion) {
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
  const diff = diffPatch(orig, cur);
  if (Object.keys(diff).length === 0) return null;   // 无实际改动

  if (kind === 'chapter') {
    // base_updated_at=乐观锁:服务端已被他方(AI 工具/另一标签)改过时 409+服务端版本,
    // 调用方转三方合并。返回新 updated_at 供刷新基线。
    const body = baseUpdatedAt ? { ...diff, base_updated_at: baseUpdatedAt } : diff;
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
function serverBase(kind, server) {
  if (!server) return { updatedAt: null, version: null };
  return {
    updatedAt: server.updated_at || null,
    version: kind === 'card' && server.row_version != null ? server.row_version : null,
  };
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
