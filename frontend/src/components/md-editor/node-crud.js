// node-crud.js — 文件树实体增删改 + 分组列表拉取(从 pages/md-editor.jsx 机械搬出,逐字节不变)。
import i18n from '../../i18n';
import { api, stripChapterPrefix, canonTypeZh } from './helpers.js';
import { loadNodeContentMeta } from './node-io.js';
import { fromMd } from '../../lib/md-serialize.js';

// canon.logical_key 是后端必填的稳定标识。新建/复制时用名称生成 slug(保留中文),
// 撞已有 key(同名)时再追加短后缀重试。
function canonKeyFromName(name) {
  const slug = String(name || '').trim().replace(/\s+/g, '_').replace(/[^\w\u4e00-\u9fff·.-]/g, '').slice(0, 60);
  return `${slug || 'entity'}_concept`;
}
function uniqueCanonKey(base) {
  return `${String(base || 'entity_concept').slice(0, 60)}_copy_${Date.now().toString(36)}`;
}

// ── 实体 CRUD(树内增删改) ─────────────────────────────────────────────
async function createNode(kind, sid, name) {
  const A = api(); const nm = (name || '').trim();
  if (kind === 'chapter')   { const r = await A.scripts.addChapter(sid, nm); return { id: r.chapter_index, label: `${i18n.t('md_editor.chapter_prefix', { index: r.chapter_index })} ${r.title || ''}`.trim() }; }
  if (kind === 'worldbook') { const _def = i18n.t('md_editor.node_defaults.worldbook'); const r = await A.scripts.worldbookCreate(sid, { title: nm || _def, content: '' }); const e = r?.entry || r; return { id: e.id, label: e.title || nm || _def }; }
  if (kind === 'card')      { const _def = i18n.t('md_editor.node_defaults.card'); const r = await A.scripts.cardUpsert(sid, { name: nm || _def, create_only: true }); const c = r?.card || r; return { id: c.id, label: c.name || nm || _def }; }
  if (kind === 'canon') {
    // 修:POST /canon-entities 必填 logical_key;之前直接 canonUpsert({name,type}) 会 400,
    // 且带 key 的 canonUpsert 会走 PUT(只更新已存在实体),所以新建必须显式用 canonCreate。
    const _def = i18n.t('md_editor.node_defaults.canon');
    const title = nm || _def;
    const body = { logical_key: canonKeyFromName(title), name: title, type: 'concept' };
    let r;
    try { r = await A.scripts.canonCreate(sid, body); }
    catch (e) {
      if (e && e.status === 409) {                      // 同名 key 已存在:换唯一后缀再建
        // 用新对象重试,不原地改 body —— 保证第一次请求的参数仍可被审计/测试观察。
        r = await A.scripts.canonCreate(sid, { ...body, logical_key: uniqueCanonKey(body.logical_key) });
      } else throw e;
    }
    const e = r?.entity || r;
    return { id: e.logical_key, label: `${e.name || title} (${canonTypeZh(e.type || 'concept')})` };
  }
  if (kind === 'anchor')    { const _def = i18n.t('md_editor.node_defaults.anchor'); const r = await A.scripts.anchorCreate(sid, { story_time_label: nm || _def, chapter_min: 1, chapter_max: 1 }); const a = r?.anchor || r; return { id: a.id, label: nm || _def }; }
  throw new Error(i18n.t('md_editor.errors.create_unsupported'));
}
async function renameNode(kind, sid, id, name) {
  const A = api(); const nm = (name || '').trim(); if (!nm) return;
  if (kind === 'chapter')   { await A.scripts.updateChapter(sid, id, { title: nm }); return; }
  if (kind === 'worldbook') { await A.scripts.worldbookUpdate(sid, id, { title: nm }); return; }
  // 修:树里显示的是 story_time_label,不是 story_phase;重命名必须改 label 字段,
  // 否则列表标题不变、只是锚点换了阶段分组。
  if (kind === 'anchor')    { await A.scripts.anchorUpdate(sid, id, { story_time_label: nm }); return; }
  // card/canon 是全覆盖 upsert → 必须 re-fetch 全字段再改名,否则抹掉头像/属性等(历史 data-loss 坑)。
  // 同时带上刚读到的版本作为乐观锁基线:GET 与 POST 之间若有 AI/另一标签写入,服务端 409 拒绝,
  // 而不是把对方的改动覆盖掉。
  if (kind === 'card')      { const cur = await A.scripts.cardGet(sid, id); const c = cur?.card || cur; await A.scripts.cardUpsert(sid, { ...c, id, name: nm, base_row_version: c.row_version }); return; }
  if (kind === 'canon')     { const cur = await A.scripts.canonGet(sid, id); const e = cur?.entity || cur; await A.scripts.canonUpsert(sid, { ...e, logical_key: id, name: nm, base_updated_at: e.updated_at }); return; }
}

// 复制实体:先读源实体的完整 markdown,再 fromMd 取全部可写字段,用新名称创建。
// 旧实现只 createNode(名字+"副本"),世界书内容为空、角色卡只有名字 —— 并不是复制。
async function duplicateNode(kind, sid, id, suffix) {
  const A = api();
  const meta = await loadNodeContentMeta(kind, sid, id);
  const fields = fromMd(kind, meta.content);
  const base = (kind === 'worldbook' ? fields.title
    : kind === 'anchor' ? fields.story_time_label
      : fields.name) || '';
  const title = `${String(base || '').trim()} ${suffix || ''}`.trim();
  if (kind === 'worldbook') {
    const r = await A.scripts.worldbookCreate(sid, { ...fields, title });
    const e = r?.entry || r;
    return { id: e.id, label: e.title || title };
  }
  if (kind === 'card') {
    // create_only:同名时后端 400,而不是走 ON CONFLICT 把已有卡的人设/标签清空。
    const r = await A.scripts.cardUpsert(sid, { ...fields, name: title, create_only: true });
    const c = r?.card || r;
    return { id: c.id, label: c.name || title };
  }
  if (kind === 'canon') {
    const key = uniqueCanonKey(fields.logical_key || canonKeyFromName(title));
    const r = await A.scripts.canonCreate(sid, { ...fields, logical_key: key, name: title });
    const e = r?.entity || r;
    return { id: e.logical_key, label: `${e.name || title} (${canonTypeZh(e.type || 'concept')})` };
  }
  if (kind === 'anchor') {
    // 锚点 markdown 的正文列是 sample_summary,而 POST /anchors 接收的字段叫 summary;
    // 不映射的话复制出来的锚点会丢失正文。
    const { sample_summary: anchorSummary, ...anchorRest } = fields;
    const r = await A.scripts.anchorCreate(sid, { ...anchorRest, summary: anchorSummary || '', story_time_label: title });
    const a = r?.anchor || r;
    return { id: a.id || a.anchor_id, label: title };
  }
  throw new Error(i18n.t('md_editor.errors.create_unsupported'));
}
async function deleteNode(kind, sid, id) {
  const A = api();
  if (kind === 'chapter')   return A.scripts.deleteChapters(sid, [id]);  // 单删=批量删一项(后端统一重排)
  if (kind === 'worldbook') return A.scripts.worldbookDelete(sid, id);
  if (kind === 'card')      return A.scripts.cardDelete(sid, id);
  if (kind === 'anchor')    return A.scripts.anchorDelete(sid, id);
  if (kind === 'canon')     return A.scripts.canonDelete(sid, id);
  throw new Error(i18n.t('md_editor.errors.delete_unsupported'));
}

// 每组的列表拉取 —— 复用 window.api.scripts.* / api.cards.*。
async function fetchGroupList(kind, sid) {
  const A = api();
  if (kind === 'chapter') {
    const r = await A.scripts.chapters(sid, { limit: 5000 });
    const arr = r?.chapters || r?.items || [];
    return arr.map((c) => ({ id: c.chapter_index, title: stripChapterPrefix(c.title || ''), renameValue: stripChapterPrefix(c.title || ''), label: `${i18n.t('md_editor.chapter_prefix', { index: c.chapter_index })} ${stripChapterPrefix(c.title || '')}`.trim(), word_count: c.word_count }));
  }
  if (kind === 'card') {
    const r = await A.cards.scriptList(sid);
    const arr = Array.isArray(r) ? r : (r?.items || []);
    // label 是展示串(Name (Full Name));renameValue 才是可写进 name 的裸值。
    // 旧实现用 label 预填重命名输入框,直接回车会把 "Name (Full Name)" 写进 name。
    return arr.map((c) => ({ id: c.id, label: c.name + (c.full_name && c.full_name !== c.name ? ` (${c.full_name})` : ''), renameValue: c.name }));
  }
  if (kind === 'worldbook') {
    // fetch_all:编辑器要管理全量条目。不传时后端默认只给 50 条(独立世界书面板
    // script-edit-worldbook.jsx 早就用了 fetch_all:1,这里之前漏了)。
    const r = await A.scripts.worldbook(sid, { fetch_all: 1 });
    const arr = r?.entries || r?.items || (Array.isArray(r) ? r : []);
    // meta.priority 给拖拽重排用:旧实现没带,onDrop 里 `it.meta?.priority` 恒 undefined,
    // 每次拖拽都会把所有条目 PUT 一遍(还只重排过滤后的子集)。
    return arr.map((w) => ({ id: w.id, label: w.title || i18n.t('md_editor.tree.entry_fallback', { id: w.id }), renameValue: w.title || '', meta: { priority: w.priority } }));
  }
  if (kind === 'anchor') {
    const r = await A.scripts.timeline(sid);
    const phases = r?.phases || [];
    const out = [];
    for (const ph of phases) for (const a of (ph.anchors || [])) {
      // label 带章节范围 "开端 (1-5)";renameValue 只取故事时间标签本身。
      out.push({
        id: a.anchor_id || a.id,
        label: `${a.story_time_label || ph.phase_label || ''} (${a.chapter_min}-${a.chapter_max})`,
        renameValue: a.story_time_label || '',
      });
    }
    return out;
  }
  if (kind === 'canon') {
    // canon 列表默认只返回 200 条;编辑器必须翻页拉全量,否则后面的实体在树/快速打开里
    // 根本不可见。canonListAll 是 api-client 新增的全量包装(分页累积)。
    const list = A.scripts.canonListAll || A.scripts.canonList;
    if (list) {
      const r = await list(sid);
      const arr = r?.entities || r?.items || [];
      return arr.map((e) => ({ id: e.logical_key, label: `${e.name} (${canonTypeZh(e.type)})`, renameValue: e.name }));
    }
    try {
      const r = await A.scripts.graph(sid);
      const arr = r?.entities || [];
      return arr.map((e) => ({ id: e.logical_key, label: `${e.name} (${canonTypeZh(e.type)})`, renameValue: e.name }));
    } catch (_) { return []; }
  }
  return [];
}

export { createNode, duplicateNode, renameNode, deleteNode, fetchGroupList };
