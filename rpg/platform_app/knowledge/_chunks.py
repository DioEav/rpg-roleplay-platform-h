from __future__ import annotations

import hashlib
from typing import Any

from psycopg.types.json import Jsonb

from chapter_fact_indexer import _extract_fact

# 确定性摘要版本:与 facts_refine 的 llm-v2 区分;未来规则摘录算法变化时 bump。
DETERMINISTIC_SUMMARY_VERSION = "det-v2"


def _chapter_content_hash(content: str) -> str:
    """章节正文变更指纹。

    必须与 SQL 里的 `substr(md5(coalesce(sc.content,'')),1,16)` 完全一致:
    facts_refine 的增量候选在 SQL 侧直接比较这个 hash,避免把整本正文读进 Python。
    MD5 只用于变更检测,不做安全校验。
    """
    return hashlib.md5(
        (content or "").encode("utf-8"), usedforsecurity=False,
    ).hexdigest()[:16]


def _upsert_document(db, book: dict[str, Any], script: dict[str, Any], chapter: dict[str, Any]) -> dict[str, Any]:
    return db.execute(
        """
        insert into documents(book_id, script_id, chapter_id, source_kind, source_ref, title, content, metadata)
        values (%s, %s, %s, 'chapter', %s, %s, %s, %s)
        on conflict(book_id, source_kind, source_ref) do update set
          chapter_id = excluded.chapter_id,
          title = excluded.title,
          content = excluded.content,
          metadata = excluded.metadata,
          row_version = documents.row_version + 1,
          updated_at = now()
        returning *
        """,
        (
            book["id"],
            script["id"],
            chapter["id"],
            str(chapter["chapter_index"]),
            chapter["title"],
            chapter["content"],
            Jsonb({
                "chapter_index": chapter["chapter_index"],
                "volume_title": chapter.get("volume_title") or "",
                "source_marker": chapter.get("source_marker") or "",
            }),
        ),
    ).fetchone()


def _insert_chunk(db, book: dict[str, Any], script: dict[str, Any], chapter: dict[str, Any],
                  document: dict[str, Any], chunk_index: int, content: str,
                  metadata: dict[str, Any] | None = None) -> None:
    """写入一个 chunk。metadata 由 v2 切片器提供(context_header/scene_index/偏移等),
    与 content_hash 合并后落 document_chunks.metadata;content 仍是原文。"""
    meta: dict[str, Any] = {
        "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest()[:16],
    }
    if metadata:
        meta.update(metadata)
    db.execute(
        """
        insert into document_chunks(
          document_id, book_id, script_id, chapter_id, chapter_index,
          chunk_index, content, token_count, metadata
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            document["id"],
            book["id"],
            script["id"],
            chapter["id"],
            chapter["chapter_index"],
            chunk_index,
            content,
            max(1, len(content) // 2),
            Jsonb(meta),
        ),
    )


def _upsert_chapter_fact(db, book: dict[str, Any], script: dict[str, Any], chapter: dict[str, Any], document: dict[str, Any], fact: dict[str, Any]) -> None:
    """UPSERT 确定性章节事实。

    关键:**章节内容没变时保留 LLM 精炼结果**。旧实现无条件覆盖 summary/metadata,
    一次零 LLM 重建就把 facts_refine 花过的钱全部冲回原文残句;同时 in_world_time
    又不在 update 列里,留下“旧精炼时间 + 新规则摘要 + 来源=规则”的不一致状态。

    现在的冲突处理:
      · 旧行 source=llm_refined 且 chapter_content_hash 相同(或老数据没有 hash,
        legacy 精炼成果按“默认可信”处理)→ 保留 summary/in_world_time/confidence,
        只刷新结构化字段,并把 hash/版本合并进 metadata;
      · hash 不同 → 该章内容变了,退回确定性摘要,清空 in_world_time,来源改回规则;
      · 其它情况 → 正常覆盖。
    """
    content_hash = _chapter_content_hash(chapter.get("content") or "")
    meta = {
        "source": "deterministic_import",
        "summary_kind": "extractive",
        "summary_version": DETERMINISTIC_SUMMARY_VERSION,
        "chapter_content_hash": content_hash,
    }
    # 老库(本次改动前)的精炼行没有 hash:旧 apply_refined 不 bump updated_at,
    # 时间戳不可靠。这里按“legacy 精炼成果默认可信”处理 —— 保留 summary 并补 hash;
    # 若用户确实改过该章,可在 facts_refine 里勾“强制全部重做”。宁可让老数据少一次
    # 自动重精炼,也不要在升级后一次零 LLM 重建把它们全部冲掉。
    keep_refined = (
        "chapter_facts.metadata->>'source' = 'llm_refined' and ("
        "chapter_facts.metadata->>'chapter_content_hash' = excluded.metadata->>'chapter_content_hash'"
        " or coalesce(chapter_facts.metadata->>'chapter_content_hash','') = '')"
    )
    sql = f"""
        insert into chapter_facts(
          book_id, script_id, document_id, chapter_id, chapter, title, viewpoint,
          summary, story_phase, story_time_label, scene_count, token_estimate,
          characters, locations, factions, concepts, items, relationships, events,
          confidence, metadata
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        on conflict(script_id, chapter) do update set
          document_id = excluded.document_id,
          chapter_id = excluded.chapter_id,
          title = excluded.title,
          viewpoint = excluded.viewpoint,
          summary = case when {keep_refined} then chapter_facts.summary else excluded.summary end,
          story_phase = excluded.story_phase,
          story_time_label = case when {keep_refined}
            then chapter_facts.story_time_label else excluded.story_time_label end,
          in_world_time = case when {keep_refined}
            then chapter_facts.in_world_time else null end,
          scene_count = excluded.scene_count,
          token_estimate = excluded.token_estimate,
          characters = excluded.characters,
          locations = excluded.locations,
          factions = excluded.factions,
          concepts = excluded.concepts,
          items = excluded.items,
          relationships = excluded.relationships,
          events = excluded.events,
          confidence = case when {keep_refined}
            then chapter_facts.confidence else excluded.confidence end,
          metadata = case when {keep_refined}
            then chapter_facts.metadata || jsonb_build_object(
              'chapter_content_hash', excluded.metadata->>'chapter_content_hash',
              'deterministic_version', excluded.metadata->>'summary_version')
            else excluded.metadata end,
          row_version = chapter_facts.row_version + 1,
          updated_at = now()
        """
    db.execute(
        sql,
        (
            book["id"],
            script["id"],
            document["id"],
            chapter["id"],
            fact["chapter"],
            fact["title"],
            fact["viewpoint"],
            fact["summary"],
            fact["story_phase"],
            fact["story_time_label"],
            fact["scene_count"],
            fact["token_estimate"],
            Jsonb(fact["characters"]),
            Jsonb(fact["locations"]),
            Jsonb(fact["factions"]),
            Jsonb(fact["concepts"]),
            Jsonb(fact["items"]),
            Jsonb(fact["relationships"]),
            Jsonb(fact["events"]),
            fact["confidence"],
            Jsonb(meta),
        ),
    )


def _fact_from_chapter(
    chapter: dict[str, Any],
    summaries: dict[str, Any],
    known_names: dict[str, str],
    known_locations: list[str],
    known_concepts: list[str],
) -> dict[str, Any]:
    return _extract_fact(
        {
            "chapter": int(chapter["chapter_index"]),
            "title": chapter["title"],
            "volume": 0,
            "path": f"script:{chapter['script_id']}/chapter:{chapter['chapter_index']}",
            "text": chapter["content"],
        },
        summaries,
        known_names,
        known_locations,
        known_concepts,
    )
