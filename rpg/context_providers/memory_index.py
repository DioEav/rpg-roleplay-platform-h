"""context_providers.memory_index — active 记忆召回轻量索引（本次记忆修复）。

为什么需要：
  MemoryAssembler 每回合做一次「查询召回」时原本全量扫描 memory.items；长局
  active facts/notes 上千条时是固定 O(n × query_grams) 开销。这里为 active
  facts/notes 建一个按 2/3-gram、characters、location/scene 的倒排索引，按
  memory._rev 缓存：只有记忆写入/状态变化时才重建。

设计约束：
  · 只索引 active、未归档的 facts/notes；superseded/archived 不参与召回；
  · 索引是「候选集」，不是最终排序；命中后仍走 MemoryAssembler 的 gram/实体/
    地点打分，保证行为与全量扫描一致；
  · 任何索引构建失败都返回 None，调用方回退全量扫描，绝不阻断回合；
  · rev 由 GameState._touch_memory() 维护；漏 bump 的最坏结果是候选集偏旧，
    调用方仍会重新校验 item 的 status/archived，不会把已归档内容注入。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")


def _text_grams(text: str) -> set[str]:
    grams: set[str] = set()
    # 与 MemoryItem 文本上限（2000 字）对齐，避免长事实后半段查询词漏索引。
    for run in _CJK_RUN.findall(str(text or "")[:2000]):
        for n in (2, 3):
            for i in range(len(run) - n + 1):
                grams.add(run[i:i + n])
    return grams


def _norm_key(value: Any) -> str:
    return str(value or "").strip().lower()


@dataclass
class MemoryIndex:
    rev: int = 0
    item_count: int = 0
    by_gram: dict[str, set[int]] = field(default_factory=dict)
    by_character: dict[str, set[int]] = field(default_factory=dict)
    by_location: dict[str, set[int]] = field(default_factory=dict)
    by_scene: dict[str, set[int]] = field(default_factory=dict)

    def candidates(self, grams: set[str], entities: list[str],
                   scene_keys: set[str]) -> set[int]:
        """返回候选 item 下标集合；没有任何查询条件时返回空集。"""
        out: set[int] = set()
        for g in grams or ():
            out |= self.by_gram.get(g, set())
        for ent in entities or ():
            out |= self.by_character.get(_norm_key(ent), set())
        for key in scene_keys or ():
            k = _norm_key(key)
            out |= self.by_location.get(k, set())
            out |= self.by_scene.get(k, set())
        return out


def build_memory_index(mem: dict, *, rev: int = 0) -> MemoryIndex:
    items = (mem.get("items") or []) if isinstance(mem, dict) else []
    idx = MemoryIndex(rev=int(rev or 0), item_count=len(items))
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        bucket = str(it.get("legacy_bucket") or "")
        if bucket not in ("facts", "notes"):
            continue
        if (it.get("status") or "active") != "active" or it.get("archived"):
            continue
        text = str(it.get("text") or "")
        for gram in _text_grams(text):
            idx.by_gram.setdefault(gram, set()).add(i)
        for c in (it.get("characters") or []):
            key = _norm_key(c)
            if key:
                idx.by_character.setdefault(key, set()).add(i)
        for key, table in (
            (_norm_key(it.get("location")), idx.by_location),
            (_norm_key(it.get("scene_id")), idx.by_scene),
        ):
            if key:
                table.setdefault(key, set()).add(i)
    return idx


def get_memory_index(state: Any, mem: dict) -> MemoryIndex | None:
    """按 memory._rev 取缓存索引；构建失败返回 None（调用方回退全量扫描）。"""
    try:
        rev = int((mem or {}).get("_rev", 0) or 0)
        items = (mem or {}).get("items") or []
        count = len(items) if isinstance(items, list) else 0
        cache = getattr(state, "_memory_index_cache", None)
        if (isinstance(cache, tuple) and len(cache) == 3
                and cache[0] == rev and cache[1] == count
                and isinstance(cache[2], MemoryIndex)):
            return cache[2]
        idx = build_memory_index(mem, rev=rev)
        try:
            state._memory_index_cache = (rev, count, idx)
        except Exception:
            pass
        return idx
    except Exception:
        return None
