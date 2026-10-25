/**
 * node-crud-duplicate.test.jsx — 文件树「新建 / 复制 / 重命名」的契约回归。
 *
 * 覆盖本轮修复的三个真实 bug：
 *   · canon 新建必须带 logical_key（旧代码只发 name/type → 400）；
 *   · 锚点重命名必须改 story_time_label（旧代码改 story_phase，列表标题不变）；
 *   · 「复制」必须复制正文/字段，而不是建一个空壳。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createNode, duplicateNode, renameNode } from '../components/md-editor/node-crud.js';

afterEach(() => {
  delete window.api;
});

describe('node-crud canon 新建', () => {
  it('带自动生成的 logical_key 调 canonCreate；409 时换唯一 key 重试', async () => {
    const canonCreate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }))
      .mockResolvedValueOnce({ ok: true, entity: { logical_key: '新设定_concept_copy_x', name: '新设定', type: 'concept' } });
    window.api = { scripts: { canonCreate } };

    const created = await createNode('canon', 1, '新设定');

    expect(canonCreate).toHaveBeenCalledTimes(2);
    const first = canonCreate.mock.calls[0][1];
    expect(first.logical_key).toBeTruthy();
    expect(first.name).toBe('新设定');
    expect(first.type).toBe('concept');
    const second = canonCreate.mock.calls[1][1];
    expect(second.logical_key).not.toBe(first.logical_key);   // 撞 key 后换新 key
    expect(created.id).toBe('新设定_concept_copy_x');
  });
});

describe('node-crud 锚点重命名', () => {
  it('更新 story_time_label，而不是 story_phase', async () => {
    const anchorUpdate = vi.fn(async () => ({ ok: true }));
    window.api = { scripts: { anchorUpdate } };

    await renameNode('anchor', 1, 9, '开端');

    expect(anchorUpdate).toHaveBeenCalledWith(1, 9, { story_time_label: '开端' });
    expect(anchorUpdate).not.toHaveBeenCalledWith(1, 9, { story_phase: '开端' });
  });
});

describe('node-crud 复制实体', () => {
  it('世界书复制带上正文与可写字段，标题加「副本」', async () => {
    const worldbookCreate = vi.fn(async (sid, body) => ({ ok: true, entry: { id: 6, title: body.title } }));
    window.api = {
      scripts: {
        worldbook: vi.fn(async () => ({
          entries: [{ id: 5, title: '力量体系', content: '正文内容', priority: 3, keys: ['magic'], enabled: true }],
        })),
        worldbookCreate,
      },
    };

    const created = await duplicateNode('worldbook', 1, 5, '副本');

    expect(worldbookCreate).toHaveBeenCalledTimes(1);
    const body = worldbookCreate.mock.calls[0][1];
    expect(body.title).toBe('力量体系 副本');
    expect(body.content).toBe('正文内容');
    expect(body.keys).toEqual(['magic']);
    expect(created.id).toBe(6);
  });

  it('锚点复制把 sample_summary 映射到 summary，避免正文丢失', async () => {
    const anchorCreate = vi.fn(async (sid, body) => ({ ok: true, anchor: { id: 8, story_time_label: body.story_time_label } }));
    window.api = {
      scripts: {
        timeline: vi.fn(async () => ({
          phases: [{
            phase_label: '开端',
            anchors: [{ id: 7, story_phase: '开端', story_time_label: '序章', chapter_min: 1, chapter_max: 2, sample_summary: '摘要正文' }],
          }],
        })),
        anchorCreate,
      },
    };

    await duplicateNode('anchor', 1, 7, '副本');

    const body = anchorCreate.mock.calls[0][1];
    expect(body.story_time_label).toBe('序章 副本');
    expect(body.summary).toBe('摘要正文');
    expect(body.sample_summary).toBeUndefined();
  });

  it('canon 复制用新 logical_key 走 canonCreate，并复制正文', async () => {
    const canonCreate = vi.fn(async (sid, body) => ({ ok: true, entity: { logical_key: body.logical_key, name: body.name, type: body.type } }));
    window.api = {
      scripts: {
        canonGet: vi.fn(async () => ({
          entity: { id: 1, logical_key: 'old_key', name: '旧名', type: 'character', summary: '摘要', background: '背景正文' },
        })),
        canonCreate,
      },
    };

    await duplicateNode('canon', 1, 'old_key', '副本');

    const body = canonCreate.mock.calls[0][1];
    expect(body.logical_key).not.toBe('old_key');
    expect(body.name).toBe('旧名 副本');
    expect(body.background).toBe('背景正文');
  });
});
