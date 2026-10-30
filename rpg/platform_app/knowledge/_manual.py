"""platform_app.knowledge._manual — 手编字段（manual_fields）的单一真源。

背景（2026-10）：
  旧实现只有行级 `source='editor'`：
    · canon 修改任一字段 → 整行标 editor → 全量重抽整行跳过；
    · worldbook / anchors 的 update 路径甚至没打标 → 手改 LLM 内容会被重建覆盖；
    · cards 完全没有标记 → 只能"已有非空字段一律保护"，把 LLM 旧产出也冻结了。
  现在统一为**字段级**：写入端把实际改动的字段记进 `manual_fields`（JSON 数组），
  重建端只保护这些字段，其余字段允许 LLM/派生逻辑刷新。

兼容规则（用户确认）：
  · 有 `manual_fields` → 按字段保护；
  · 只有 `source='editor'`、没有 `manual_fields`（旧数据）→ 整行保护（保守兜底）；
  · 两者都没有 → 视为系统/LLM 产出，可刷新。

`sources` 约定：
  · canon: attrs.manual_fields / attrs.source
  · worldbook: metadata.manual_fields / metadata.source
  · cards: metadata.manual_fields / metadata.source
  · anchors: 表列 source（只有行级，字段级后续再做）
"""
from __future__ import annotations

# ── 字段清单（写入端/重建端共用）────────────────────────────────────────────
# cards：只保护"人设内容"字段。章节/重要度/预算/启停等剧本侧字段由各自的
# least/greatest/单独开关保护，不纳入 manual_fields，避免一次编辑把整卡冻结。
CARD_MANUAL_FIELDS: tuple[str, ...] = (
    "full_name", "aliases", "identity", "background", "appearance",
    "personality", "speech_style", "current_status", "secrets",
    "sample_dialogue", "tags",
)

# canon：编辑器工具可以设置的列。注意 attrs/metadata 也作为整体字段保护
# （用户直接改 attrs 时，不希望在重建时被合并掉）。
CANON_MANUAL_FIELDS: tuple[str, ...] = (
    "name", "aliases", "type", "summary", "attrs",
    "first_revealed_chapter", "public_knowledge", "importance", "metadata",
    "full_name", "identity", "background", "entity_subtype", "parent_logical_key",
)

# worldbook：编辑器工具可以设置的列。
# 注意不包含 enabled / probability / metadata：这些是"显示/开关"类设置，
# 不是内容手编；把它们算进手编会让用户只是停用条目就亮「手编」标签。
WORLDBOOK_MANUAL_FIELDS: tuple[str, ...] = (
    "title", "content", "keys", "regex_keys", "character_filter",
    "scene_filter", "priority", "insertion_position", "tags",
)


def manual_fields_from_meta(meta: dict | None) -> set[str]:
    """从 metadata/attrs 里读 manual_fields；旧 editor 行返回"全字段"兜底。

    legacy_editor=True 表示：source='editor' 但从来没有 manual_fields（升级前的老数据）。
    调用方应把它当作"整行保护"，而不是"没有手编"。
    """
    if not isinstance(meta, dict):
        # JSONB 历史脏数据可能是 list/string/null；不能假设一定是 object。
        return set()
    raw = meta.get("manual_fields")
    if isinstance(raw, list):
        return {str(x) for x in raw if isinstance(x, str) or isinstance(x, (int, float))}
    if str(meta.get("source") or "") == "editor":
        return set()  # 由调用方用 legacy 判断；这里不猜具体字段
    return set()


def is_legacy_editor(meta: dict | None) -> bool:
    """source='editor' 但没有 manual_fields：升级前的老手编数据 → 整行保护。"""
    if not isinstance(meta, dict):
        return False
    return str(meta.get("source") or "") == "editor" and not isinstance(
        meta.get("manual_fields"), list
    )


def protected_card_fields(meta: dict | None) -> set[str]:
    """cards 重建时真正需要保护的人设字段集合。"""
    meta = meta or {}
    if is_legacy_editor(meta):
        return set(CARD_MANUAL_FIELDS)
    return manual_fields_from_meta(meta) & set(CARD_MANUAL_FIELDS)


def protected_canon_fields(meta: dict | None) -> set[str]:
    """canon 全量重抽时要跳过的字段集合。"""
    meta = meta or {}
    if is_legacy_editor(meta):
        return set(CANON_MANUAL_FIELDS)
    return manual_fields_from_meta(meta) & set(CANON_MANUAL_FIELDS)


# ── 强制覆盖：只清“本次实际写到”的字段 ─────────────────────────────────────
# 用户确认的语义（2026-10）：
#   · 强制覆盖只清除本次真的被写入的行/字段标记；
#   · 本次没写到的行继续保留标记；
#   · 要精确解锁单个字段，仍用前端标签的逐字段解锁。
# 各写入路径 UPDATE 的列不同，不能共用一份“全清”清单：
#   · canon 全量重抽：见 resolve._canon_overwritten_fields（随抽取值动态判断）；
#   · cards 零 LLM 回填 / LLM 抽取：只清本次传了非空值的文本/列表字段；
#   · worldbook canon 骨架：content/keys/priority/insertion_position；
#   · worldbook LLM 路径：content/keys/priority（不写 insertion_position）；
#   · worldbook 充实：只写 content。
WORLDBOOK_REBUILD_WRITTEN_FIELDS: tuple[str, ...] = (
    "content", "keys", "priority", "insertion_position",
)
WORLDBOOK_LLM_WRITTEN_FIELDS: tuple[str, ...] = ("content", "keys", "priority")
WORLDBOOK_ENRICH_WRITTEN_FIELDS: tuple[str, ...] = ("content",)


def clear_overwritten_manual_fields(
    meta: dict | None,
    overwritten: set[str] | list[str] | tuple[str, ...],
    *,
    universe: tuple[str, ...],
    default_source: str | None = None,
) -> dict:
    """强制覆盖后，只移除“本次确实写到的字段”手编标记。

    与 unlock_manual_fields 的区别：
      · unlock 是用户主动精确解锁，不传 universe；
      · 本函数用于重建 force：旧数据只有 source='editor' 没有 manual_fields 时，
        按 universe 视为“全字段手编”兜底，减去本次覆盖字段后转成显式 manual_fields。
        这样没被本次写到的字段（例如只重建 content 时的 tags/title）不会丢保护，
        也不会因为留下 source='editor' 又退化成整行保护。
      · 没有任何手编标记且非 legacy 的行原样返回 —— 不制造标记，也不改 source。

    剩余字段 → source='editor'（字段级保护仍生效）；
    全部清空 → 删除 manual_fields，source 设为 default_source（None = 删除）。
    """
    out = dict(meta) if isinstance(meta, dict) else {}
    legacy = is_legacy_editor(out)
    current = set(universe) if legacy else manual_fields_from_meta(out)
    if not current and not legacy:
        return out
    current -= {str(x) for x in overwritten}
    if current:
        out["manual_fields"] = sorted(current)
        out["source"] = "editor"
    else:
        out.pop("manual_fields", None)
        if default_source is None:
            out.pop("source", None)
        else:
            out["source"] = default_source
    return out


def clear_canon_force_marks(db, script_id: int, logical_key: str,
                            old_attrs: dict | None, overwritten: set[str]) -> None:
    """canon 强制重抽后，清掉 old_attrs 里本次实际覆盖字段的 manual 标记。"""
    if not isinstance(old_attrs, dict):
        return
    new_attrs = clear_overwritten_manual_fields(
        old_attrs, overwritten, universe=CANON_MANUAL_FIELDS,
        default_source="extracted",
    )
    if new_attrs == old_attrs:
        return
    from psycopg.types.json import Jsonb
    db.execute(
        "update kb_canon_entities set attrs=%s "
        "where script_id=%s and logical_key=%s",
        (Jsonb(new_attrs), int(script_id), str(logical_key)),
    )


def clear_character_card_force_marks(db, script_id: int, name: str,
                                     old_meta: dict | None, overwritten: set[str]) -> None:
    """cards 强制重建后，清掉本次实际写入字段的 manual 标记（其余字段保留）。"""
    if not isinstance(old_meta, dict):
        return
    # 全部清空时：老 source 是 editor（手编来源）→ 删除；否则保留原有来源
    # （例如 indexes/characters.json），避免“强制重建”顺手丢掉来源信息。
    _old_source = str(old_meta.get("source") or "")
    new_meta = clear_overwritten_manual_fields(
        old_meta, overwritten, universe=CARD_MANUAL_FIELDS,
        default_source=None if _old_source in ("", "editor") else _old_source,
    )
    if new_meta == old_meta:
        return
    from psycopg.types.json import Jsonb
    db.execute(
        "update character_cards set metadata=%s "
        "where script_id=%s and name=%s and card_type='npc'",
        (Jsonb(new_meta), int(script_id), str(name)),
    )


def clear_worldbook_force_marks(db, script_id: int, titles: list[str], *,
                                written_fields: tuple[str, ...],
                                default_source: str) -> None:
    """worldbook 强制重建后，按本次真正写入的列清标记，未写字段（tags/title/…）保留。"""
    from psycopg.types.json import Jsonb
    for title in dict.fromkeys(str(t) for t in titles if t):
        row = db.execute(
            "select metadata from worldbook_entries "
            "where script_id=%s and title=%s",
            (int(script_id), title),
        ).fetchone()
        old_meta = (row or {}).get("metadata") if isinstance(row, dict) else None
        if not isinstance(old_meta, dict):
            continue
        new_meta = clear_overwritten_manual_fields(
            old_meta, written_fields, universe=WORLDBOOK_MANUAL_FIELDS,
            default_source=default_source,
        )
        if new_meta == old_meta:
            continue
        db.execute(
            "update worldbook_entries set metadata=%s "
            "where script_id=%s and title=%s",
            (Jsonb(new_meta), int(script_id), title),
        )


def unlock_manual_fields(
    meta: dict | None,
    fields: list[str] | None,
    *,
    default_source: str = "extracted",
) -> dict:
    """从 metadata/attrs 里解锁手编字段，返回新的 metadata 字典。

    · fields=None 或 [] → 解锁全部（整行取消手编）；
    · fields=[...] → 只移除这些字段；
    · 解锁后仍有手编字段 → 保留 source='editor' + manual_fields；
    · 解锁后没有手编字段 → 删除 manual_fields，并把 source 改为 default_source
      （cards 用 'platform'；canon/worldbook 用 'extracted'；anchors 走行级 source）。

    纯函数，供四个 unlock API 共用；不碰数据库。
    """
    out = dict(meta) if isinstance(meta, dict) else {}
    current = set(manual_fields_from_meta(out)) if not is_legacy_editor(out) else set()
    if is_legacy_editor(out):
        # 旧数据没有字段清单：任何解锁请求都视为"整行取消"。
        current = set()
    elif fields:
        current -= {str(x) for x in fields}
    else:
        current = set()
    if current:
        out["manual_fields"] = sorted(current)
        out["source"] = "editor"
    else:
        out.pop("manual_fields", None)
        out["source"] = default_source
    return out


# ── 世界书充实（content 重写）的 SQL 守卫 ────────────────────────────────────
# 默认跳过：
#   · 旧 editor 行（source='editor' 且无 manual_fields）→ 整行保护；
#   · content 被手编（metadata.manual_fields 包含 content）→ 只保护正文。
# 其它字段手编不影响 content 充实（例如只改了 title/priority）。
# include_editor=True 时由调用方自行绕过本片段。
WORLDBOOK_CONTENT_GUARD_SQL = (
    " and not (coalesce(metadata->>'source','') = 'editor' "
    "and metadata->'manual_fields' is null)"
    " and not (coalesce(metadata->'manual_fields','[]'::jsonb) ? 'content')"
)
