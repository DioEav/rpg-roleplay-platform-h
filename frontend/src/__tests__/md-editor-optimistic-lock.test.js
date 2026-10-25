/**
 * md-editor-optimistic-lock.test.js — 非章节实体乐观锁的前端契约。
 *
 * 编辑器保存时把「打开标签时拿到的版本」回传,服务端 409 时按 kind 取 server_* 快照。
 * 这里锁住三件事:
 *   · 世界书/锚点/canon 发 base_updated_at;角色卡发 base_row_version;
 *   · 保存成功返回新基线(updatedAt / version),供下一次保存推进;
 *   · conflictServer/serverBase 能按实体类型取到统一形状的冲突快照。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toMd, fromMd } from '../lib/md-serialize.js';
import {
  loadNodeContentMeta,
  saveNodeContent,
  conflictServer,
  serverBase,
} from '../components/md-editor/node-io.js';

afterEach(() => {
  delete window.api;
});

const WB_ROW = {
  id: 2, title: '铁人团', content: '旧正文', priority: 50, enabled: true,
  token_budget: 600, insertion_position: 'worldbook', sticky_turns: 0,
  cooldown_turns: 0, probability: 100, first_revealed_chapter: 0,
  keys: [], regex_keys: [], character_filter: [], scene_filter: [],
  updated_at: '2026-10-25T01:02:03.456789+00:00',
};

describe('saveNodeContent 乐观锁基线', () => {
  it('章节:同时发送 base_updated_at 与 base_chapter_id(普通保存/逐块取舍共用)', async () => {
    const row = {
      id: 11, chapter_index: 1, title: '开篇', volume_title: '', word_count: 3,
      content: '旧正文', updated_at: '2026-10-25T01:00:00.123456+00:00',
    };
    const updateChapter = vi.fn(async () => ({
      ok: true, chapter: { ...row, content: '新正文', updated_at: '2026-10-25T02:00:00+00:00' },
    }));
    window.api = { scripts: { updateChapter } };

    const original = toMd('chapter', row);
    const edited = toMd('chapter', { ...row, content: '新正文' });
    const res = await saveNodeContent(
      'chapter', 1, 1, edited, original, row.updated_at, null, row.id,
    );

    const body = updateChapter.mock.calls[0][2];
    expect(body.content).toBe('新正文');
    expect(body.base_updated_at).toBe(row.updated_at);
    expect(body.base_chapter_id).toBe(row.id);
    expect(res).toEqual({ updatedAt: '2026-10-25T02:00:00+00:00', version: null });
  });

  it('世界书:带 base_updated_at,返回服务端新 updated_at', async () => {
    const worldbookUpdate = vi.fn(async () => ({
      ok: true,
      entry: { ...WB_ROW, content: '新正文', updated_at: '2026-10-25T02:00:00+00:00' },
    }));
    window.api = { scripts: { worldbookUpdate } };

    const original = toMd('worldbook', WB_ROW);
    const edited = toMd('worldbook', { ...WB_ROW, content: '新正文' });
    const res = await saveNodeContent('worldbook', 1, 2, edited, original, WB_ROW.updated_at);

    expect(worldbookUpdate).toHaveBeenCalledTimes(1);
    const body = worldbookUpdate.mock.calls[0][2];
    expect(body.content).toBe('新正文');
    expect(body.base_updated_at).toBe(WB_ROW.updated_at);
    expect(res).toEqual({ updatedAt: '2026-10-25T02:00:00+00:00', version: null });
  });

  it('锚点:带 base_updated_at;不带基线时保持旧覆盖语义(不发该字段)', async () => {
    const anchorUpdate = vi.fn(async () => ({
      ok: true, anchor: { id: 8, updated_at: '2026-10-25T03:00:00+00:00' },
    }));
    window.api = { scripts: { anchorUpdate } };
    const row = {
      id: 8, story_phase: '第一幕', story_time_label: '开端', chapter_min: 1,
      chapter_max: 2, chapter_count: 2, sample_summary: '旧', keywords: [],
      confidence: 1, sample_title: '',
    };
    const original = toMd('anchor', row);
    const edited = toMd('anchor', { ...row, sample_summary: '新' });

    await saveNodeContent('anchor', 1, 8, edited, original, '2026-10-25T01:00:00+00:00');
    expect(anchorUpdate.mock.calls[0][2].base_updated_at).toBe('2026-10-25T01:00:00+00:00');
    // 锚点正文列名是 sample_summary(md schema 原样回发);后端两者都收。
    expect(anchorUpdate.mock.calls[0][2].sample_summary).toBe('新');

    await saveNodeContent('anchor', 1, 8, edited, original, null);
    expect('base_updated_at' in anchorUpdate.mock.calls[1][2]).toBe(false);
  });

  it('canon:PUT 体不再包含 logical_key(稳定标识只读),仍带 base_updated_at', async () => {
    const canonUpsert = vi.fn(async () => ({
      ok: true, entity: { logical_key: 'k', updated_at: '2026-10-25T04:00:00+00:00' },
    }));
    window.api = { scripts: { canonUpsert } };
    const row = {
      id: 9, logical_key: 'k', type: 'concept', entity_subtype: '', parent_logical_key: '',
      name: '设定', full_name: '', identity: '', summary: '旧', aliases: [],
      first_revealed_chapter: 0, public_knowledge: false, importance: 0, attrs: {},
    };
    const original = toMd('canon', row);
    const edited = toMd('canon', { ...row, summary: '新' });

    await saveNodeContent('canon', 1, 'k', edited, original, '2026-10-25T01:00:00+00:00');

    const body = canonUpsert.mock.calls[0][1];
    // logical_key 只作为路由 path id 带上(值仍是打开时的 id),不作为可写字段参与 diff;
    // fromMd 的 patch 里已经没有它,避免“可编辑但后端忽略”。
    expect(body.logical_key).toBe('k');
    expect('logical_key' in fromMd('canon', edited)).toBe(false);
    expect(body.base_updated_at).toBe('2026-10-25T01:00:00+00:00');
  });

  it('canon:修改 logical_key 直接报错,不发请求(不再假装保存成功)', async () => {
    const canonUpsert = vi.fn();
    window.api = { scripts: { canonUpsert } };
    const row = {
      id: 9, logical_key: 'k', type: 'concept', entity_subtype: '', parent_logical_key: '',
      name: '设定', full_name: '', identity: '', summary: '旧', aliases: [],
      first_revealed_chapter: 0, public_knowledge: false, importance: 0, attrs: {},
    };
    const original = toMd('canon', row);
    const renamed = toMd('canon', { ...row, logical_key: 'k2' });
    await expect(
      saveNodeContent('canon', 1, 'k', renamed, original, null),
    ).rejects.toThrow(/logical_key/);
    expect(canonUpsert).not.toHaveBeenCalled();
  });

  it('角色卡:发 base_row_version,返回新 row_version', async () => {
    const card = {
      id: 3, card_type: 'npc', source: 'platform', slug: '', avatar_path: '',
      name: '甲', full_name: '', aliases: [], identity: '', background: '旧', appearance: '',
      personality: '', speech_style: '', current_status: '', secrets: '', tags: [],
      sample_dialogue: [], first_revealed_chapter: 0, importance: 1, token_budget: 450,
      priority: 100, enabled: true, row_version: 5,
      updated_at: '2026-10-25T01:02:03+00:00',
    };
    const scriptGet = vi.fn(async () => ({ ok: true, card }));
    const scriptUpsert = vi.fn(async () => ({
      ok: true, card: { ...card, background: '新', row_version: 6, updated_at: '2026-10-25T05:00:00+00:00' },
    }));
    window.api = { cards: { scriptGet, scriptUpsert } };

    const original = toMd('card', card);
    const edited = toMd('card', { ...card, background: '新' });
    const res = await saveNodeContent('card', 1, 3, edited, original, card.updated_at, 5);

    const body = scriptUpsert.mock.calls[0][1];
    expect(body.base_row_version).toBe(5);
    expect(body.background).toBe('新');
    expect(res).toEqual({ updatedAt: '2026-10-25T05:00:00+00:00', version: 6 });
  });

  it('loadNodeContentMeta:角色卡返回 row_version 作为版本基线', async () => {
    const card = { id: 3, card_type: 'npc', name: '甲', background: '正文', row_version: 7, updated_at: 't' };
    window.api = { cards: { scriptGet: vi.fn(async () => ({ ok: true, card })) } };
    const meta = await loadNodeContentMeta('card', 1, 3);
    expect(meta.version).toBe(7);
    expect(meta.updatedAt).toBe('t');
  });
});

describe('409 冲突快照解析', () => {
  it('按 kind 取 server_* 并生成新基线', () => {
    const wb = { id: 2, content: 'server', updated_at: '2026-10-25T06:00:00+00:00' };
    const err = { status: 409, payload: { conflict: true, server_entry: wb } };
    expect(conflictServer(err, 'worldbook')).toBe(wb);
    expect(serverBase('worldbook', wb)).toEqual({
      updatedAt: '2026-10-25T06:00:00+00:00', version: null,
    });

    const card = { id: 3, row_version: 9, updated_at: 't' };
    expect(conflictServer({ payload: { server_card: card } }, 'card')).toBe(card);
    expect(serverBase('card', card)).toEqual({ updatedAt: 't', version: 9 });
  });

  it('兼容章节 server_chapter;无快照时返回 null(调用方降级为标记冲突)', () => {
    const ch = { id: 7, chapter_index: 1, content: 'x', updated_at: 't' };
    expect(conflictServer({ payload: { server_chapter: ch } }, 'chapter')).toBe(ch);
    // 章节快照额外带稳定 id,供旧标签在合并/强制保存时补身份基线。
    expect(serverBase('chapter', ch)).toEqual({ updatedAt: 't', version: null, chapterId: 7 });
    expect(conflictServer({ payload: { conflict: true } }, 'canon')).toBeNull();
    expect(serverBase('canon', null)).toEqual({ updatedAt: null, version: null });
  });
});
