from __future__ import annotations

import hashlib
import re
from typing import Any

from core.text import slugify

# 游标解析单一真相源 = db.cursor_id;保留 _cursor_int 名做薄别名,本模块的
# 兄弟调用方(memory/worldbook/context_runs/character_cards)按名 import 零改动。
from platform_app.db import cursor_id as _cursor_int  # noqa: F401  (兄弟模块按名 re-export)


def _clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def _require_script(db, user_id: int, script_id: int) -> dict[str, Any]:
    """READ-ONLY 校验:union owned + subscribed。

    公开剧本订阅者可读 worldbook / character_cards / chapter_facts 等。
    **编辑类调用方必须用 _require_script_owner 而不是这个**(订阅者只读)。

    SQL 收敛到 perms.script_readable(唯一来源);保留 ValueError 契约 + 原文案 +
    返回整行 + 本模块历史的 (db, user_id, script_id) 参数顺序。
    """
    from platform_app.perms import script_readable
    row = script_readable(db, script_id, user_id)
    if not row:
        raise ValueError("无权访问该剧本")
    return row


def _require_script_owner(db, user_id: int, script_id: int) -> dict[str, Any]:
    """WRITE 校验:仅 owner_id 匹配,订阅者拒绝。

    所有改 character_cards / worldbook / canon / overrides / 章节内容 的入口必须用这个。
    订阅者要改剧本须先 fork(走 /api/scripts/public/{id}/fork 物理复制成自己的副本)。

    SQL 收敛到 perms.script_owned(唯一来源);保留 ValueError 契约 + 原文案 +
    返回整行 + 本模块历史的 (db, user_id, script_id) 参数顺序。
    """
    from platform_app.perms import script_owned
    row = script_owned(db, script_id, user_id)
    if not row:
        raise ValueError("仅原作者可编辑该剧本。订阅剧本只读;如需改动请先「另存为可编辑副本」(fork)。")
    return row


def _slugify(text: str) -> str:
    return slugify(text, fallback="book")


def _keys_for(title: str, content: str) -> list[str]:
    values = {title}
    values.update(re.findall(r"[一-鿿A-Za-z0-9]{2,12}", f"{title} {content or ''}")[:8])
    return [item for item in values if item][:10]


def _auto_extract_keys(title: str, content: str, max_keys: int = 20) -> list[str]:
    """task 80: 通用命名实体/关键词提取 — 不依赖任何特定书的词表。

    简单启发式:
    - 提取所有 markdown **加粗** 内容
    - 提取所有 3-8 个汉字 (或 2-4 个英文词) 的"专名样本": 出现 >=2 次,
      非常见动词/形容词,看起来像专名 (大写首字母 / 中间无标点)
    - 加上 title 本身作为 key
    """
    keys: list[str] = []
    if title:
        keys.append(title)
    # 加粗词
    for m in re.findall(r"\*\*([^*\n]{2,12})\*\*", content):
        if m and m not in keys:
            keys.append(m)
    # 中文专名: 连续 2-6 个汉字, 出现 >=2 次
    from collections import Counter
    cn_terms = re.findall(r"[一-鿿]{2,6}", content)
    counter = Counter(cn_terms)
    # 过滤一些极常见的非专名 (通用,任何书都适用)
    stop_words = {"的", "了", "和", "是", "在", "就是", "我们", "他们", "这个", "那个",
                  "什么", "怎么", "可以", "因为", "所以", "但是", "不过", "如果", "已经",
                  "应该", "需要", "可能", "或者", "甚至", "于是", "其中"}
    for term, freq in counter.most_common(60):
        if freq < 2 or term in stop_words:
            continue
        if len(term) >= 2 and term not in keys:
            keys.append(term)
        if len(keys) >= max_keys:
            break
    # 英文专名 (大写开头, 长度 >=3, 出现 >=2)
    en_terms = re.findall(r"\b[A-Z][A-Za-z]{2,}\b", content)
    en_counter = Counter(en_terms)
    for term, freq in en_counter.most_common(20):
        if freq < 2:
            continue
        if term not in keys:
            keys.append(term)
        if len(keys) >= max_keys:
            break
    return keys[:max_keys]


def _wb(title: str, keys: list[str], priority: int, content: str) -> dict[str, Any]:
    return {
        "title": title,
        "keys": keys,
        "regex_keys": [],
        "priority": priority,
        "token_budget": 600,
        "insertion_position": "worldbook",
        "sticky_turns": 0,
        "cooldown_turns": 0,
        "probability": 100.0,
        "character_filter": [],
        "scene_filter": [],
        "content": content or "",
    }


def _chunk_text(text: str) -> list[str]:
    import re as _re

    from platform_app.knowledge._constants import CHUNK_CHARS, CHUNK_OVERLAP
    text = _re.sub(r"\n{3,}", "\n\n", text or "").strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(len(text), start + CHUNK_CHARS)
        if end < len(text):
            window = text[start:end]
            split_at = max(window.rfind("\n\n"), window.rfind("。"), window.rfind("！"), window.rfind("？"))
            if split_at > CHUNK_CHARS // 2:
                end = start + split_at + 1
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return chunks


# ── v2 场景化切片(2026-11)────────────────────────────────────────────────
# 背景:旧 _chunk_text 固定 1400 字 + 160 重叠,但嵌入只取前 1200 字、提示词只取
# 块头 360 字 —— 三个窗口不一致:块尾 200 字不参与向量;命中句在 360 之后时,
# 向量命中了、GM 却看不到证据。v2 目标:
#   · 先按场景/句界切,块 800-1200 字(最大 1200),完整进入嵌入上限;
#   · 不再用字符重叠(按句切已经不会断句,重叠只会重复注入);
#   · 每块写 context_header/scene_index/char_start/char_end/chunk_key,
#     供检索注入章节头、查询感知片段和后续增量重切使用。
CHUNK_VERSION = "v2-scene"
_CHUNK_V2_TARGET_MIN = 800
_CHUNK_V2_TARGET_MAX = 1200

# 显式场景分隔:整行的 ***/---/___/###/◇◇/※※/◆◆/===/———。
_SCENE_SEP_RE = re.compile(
    r"^[ \t]*(?:\*{3,}|-{3,}|_{3,}|#{3,}|◇{2,}|※{2,}|◆{2,}|={3,}|—{3,})[ \t]*$",
    re.M,
)
# 2 个以上连续空行 = 场景分隔(单个空行只当段落分隔,避免把普通分段切碎)。
_SCENE_BLANK_RE = re.compile(r"\n[ \t]*\n[ \t]*\n+")
# 时间/地点/视角切换句:只在段首、且上一段以句末标点结束时才切,宁少勿错。
_SCENE_CUE_RE = re.compile(
    r"^(?:"
    r"(?:三|两|数|半|一|几)\s*(?:天|日|年|个月|月|时辰|刻钟|小时)\s*(?:后|之后|以后)"
    r"|(?:翌日|次日|第二天|第三天|隔天|与此同时|同一时间|另一边|画面一转|镜头一转|转场)"
    r"|(?:清晨|黎明|早晨|上午|正午|午后|黄昏|傍晚|入夜|深夜|半夜|夜色|天亮)"
    r"|(?:回到|来到|抵达|走进|踏入|离开)\s*[^，。！？\n]{2,12}"
    r")"
)
_SENT_ENDERS = set("。！？!?…")
_CLOSERS = set("”’」』）)")
# 章标题已带章节前缀(中文数字/阿拉伯数字/Chapter N)→ 不再重复拼「第N章」。
# 之前只认 `第{chapter_index}章`,像「第一章 雪夜」会变成「第1章 第一章 雪夜」。
_CHAPTER_PREFIX_RE = re.compile(
    r"^\s*(?:第\s*[零〇一二三四五六七八九十百千万两0-9]+\s*[章回节卷部话集篇]"
    r"|chapter\s*\d+)",
    re.I,
)


def _normalize_chunk_text(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def _iter_paragraph_spans(text: str) -> list[tuple[int, int]]:
    """按空行分段,返回 (start, end) 偏移;单空行即段落边界。"""
    spans: list[tuple[int, int]] = []
    start: int | None = None
    pos = 0
    for line in text.splitlines(keepends=True):
        if line.strip():
            if start is None:
                start = pos
        else:
            if start is not None:
                spans.append((start, pos))
                start = None
        pos += len(line)
    if start is not None:
        spans.append((start, pos))
    return spans


def _scene_cut_positions(text: str) -> list[int]:
    cuts: set[int] = set()
    for m in _SCENE_SEP_RE.finditer(text):
        cuts.add(m.start())
        cuts.add(m.end())
    for m in _SCENE_BLANK_RE.finditer(text):
        cuts.add(m.start())
        cuts.add(m.end())
    paras = _iter_paragraph_spans(text)
    for idx in range(1, len(paras)):
        ps, pe = paras[idx]
        para = text[ps:pe].lstrip()
        if not para or para[0] in "“\"「『":
            continue  # 引号开头 = 对话延续,不切
        if not _SCENE_CUE_RE.match(para):
            continue
        prev = text[paras[idx - 1][0]:paras[idx - 1][1]].rstrip()
        if not prev or prev[-1] not in "。！？!?…”’」』":
            continue
        last_cut = max((c for c in cuts if c <= ps), default=0)
        if ps - last_cut < 300:
            continue  # 当前场景太短,先不切,避免碎场景
        cuts.add(ps)
    return sorted(c for c in cuts if 0 < c < len(text))


def _split_scene_spans(text: str) -> list[tuple[int, int]]:
    cuts = [0, *_scene_cut_positions(text), len(text)]
    spans: list[tuple[int, int]] = []
    for a, b in zip(cuts, cuts[1:], strict=False):
        raw = text[a:b]
        lead = len(raw) - len(raw.lstrip())
        trail = len(raw) - len(raw.rstrip())
        s, e = a + lead, b - trail
        content = text[s:e].strip()
        if not content:
            continue
        # 显式分隔符本身(***/---/◇◇)不是正文,跳过;否则会被当成一个 3 字块。
        if _SCENE_SEP_RE.fullmatch(content):
            continue
        spans.append((s, e))
    # 不合并短场景:显式分隔符(***/空行/时间切换)本身就是语义边界,合并会把
    # 分隔符重新包进正文、并抹掉场景归属。短场景(如 100 字段落)保持独立块,
    # 后续由父子检索在提示词侧合并,而不是在切片层破坏边界。
    # 全篇只有分隔符/空白时 spans 为空 → 返回空,不再把分隔符本身兜底成正文块。
    return spans


def _split_sentences_with_offsets(text: str) -> list[tuple[int, int]]:
    """句界切分(保留句末标点与右引号),返回绝对偏移。"""
    spans: list[tuple[int, int]] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in _SENT_ENDERS:
            j = i + 1
            while j < n and text[j] in _SENT_ENDERS:
                j += 1
            while j < n and text[j] in _CLOSERS:
                j += 1
            if text[start:j].strip():
                spans.append((start, j))
            start = j
            i = j
            continue
        if ch == "\n":
            if i > start and text[start:i].strip():
                spans.append((start, i))
            start = i + 1
        i += 1
    if start < n and text[start:].strip():
        spans.append((start, n))
    return spans or [(0, n)]


def _split_long_span(text: str, s: int, e: int, max_chars: int) -> list[tuple[int, int]]:
    """单句超过 max_chars 时在逗号/分号/冒号处再切,保证块不超上限。"""
    if e - s <= max_chars:
        return [(s, e)]
    out: list[tuple[int, int]] = []
    cur = s
    while e - cur > max_chars:
        window = text[cur:cur + max_chars]
        cut = max(
            window.rfind("，"), window.rfind("、"), window.rfind("；"),
            window.rfind(";"), window.rfind("："),
        )
        if cut < max_chars // 2:
            cut = max_chars - 1
        out.append((cur, cur + cut + 1))
        cur = cur + cut + 1
    if cur < e:
        out.append((cur, e))
    return out


def _split_scene_chunks(text: str, scene_start: int, scene_end: int) -> list[tuple[int, int]]:
    """场景内按句累积到 800-1200 字;不跨场景、不做字符重叠。"""
    units: list[tuple[int, int]] = []
    for s, e in _split_sentences_with_offsets(text[scene_start:scene_end]):
        units.extend(_split_long_span(text, scene_start + s, scene_start + e,
                                      _CHUNK_V2_TARGET_MAX))
    chunks: list[tuple[int, int]] = []
    cur_s: int | None = None
    cur_e: int | None = None
    for s, e in units:
        if cur_s is None:
            cur_s, cur_e = s, e
            continue
        if (e - cur_s) <= _CHUNK_V2_TARGET_MAX:
            cur_e = e
        else:
            # 下一句会超上限:先收当前块(即使不足 target_min,也绝不超 target_max,
            # 否则会再次出现"块 1400、嵌入只取 1250"的尾部丢失)。
            chunks.append((cur_s, cur_e))
            cur_s, cur_e = s, e
    if cur_s is not None:
        chunks.append((cur_s, cur_e))
    # 尾块过短则并入上一块(必须在 target_max 内,保证整块可完整嵌入)。
    if len(chunks) >= 2 and (chunks[-1][1] - chunks[-1][0]) < _CHUNK_V2_TARGET_MIN:
        a, _ = chunks[-2]
        _, d = chunks[-1]
        if d - a <= _CHUNK_V2_TARGET_MAX:
            chunks[-2:] = [(a, d)]
    return chunks


def _chapter_header(chapter_index: int, title: str) -> str:
    t = (title or "").strip()
    if t and _CHAPTER_PREFIX_RE.match(t):
        return t
    prefix = f"第{chapter_index}章"
    return f"{prefix} {t}".strip()


def _chunk_chapter(
    text: str,
    *,
    script_id: int = 0,
    chapter_id: int = 0,
    chapter_index: int = 0,
    title: str = "",
) -> list[dict[str, Any]]:
    """v2 章节切片:场景优先、句界切分、800-1200 字、带上下文头与偏移。

    返回 [{"content": str, "metadata": {...}}, ...]。
    content 仍是原文(不含 header);header 只进 metadata/嵌入/提示词,不污染正文。
    """
    norm = _normalize_chunk_text(text)
    if not norm:
        return []
    header = _chapter_header(chapter_index, title)
    out: list[dict[str, Any]] = []
    for scene_idx, (ss, se) in enumerate(_split_scene_spans(norm)):
        for cs, ce in _split_scene_chunks(norm, ss, se):
            raw = norm[cs:ce]
            content = raw.strip()
            if not content:
                continue
            lead = len(raw) - len(raw.lstrip())
            trail = len(raw) - len(raw.rstrip())
            s2, e2 = cs + lead, ce - trail
            out.append({
                "content": content,
                "metadata": {
                    "context_header": header,
                    "chapter_title": (title or "").strip(),
                    "chapter_index": int(chapter_index),
                    "scene_index": scene_idx,
                    "char_start": s2,
                    "char_end": e2,
                    "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest()[:16],
                    "chunk_key": f"s{script_id}:ch{chapter_id}:sc{scene_idx}:{s2}-{e2}",
                    "chunking_version": CHUNK_VERSION,
                },
            })
    return out


def _pick_snippet(content: str, tokens: list[str], *, max_chars: int = 520) -> str:
    """查询感知片段:以命中句为中心取完整句窗口,而不是永远截块头。

    纯规则/正则,不调 LLM。没有查询词命中、也没有对话句加分时退回块头 max_chars。
    """
    text = content or ""
    if not text.strip():
        return ""
    if len(text) <= max_chars:
        return text.strip()
    spans = _split_sentences_with_offsets(text)
    if not spans:
        return text[:max_chars].strip()
    q = [t for t in (tokens or []) if t]
    scores: list[float] = []
    for s, e in spans:
        sent = text[s:e]
        score = float(sum(1 for t in q if t in sent))
        if "“" in sent or '"' in sent or "「" in sent:
            score += 0.5  # 对话句通常含人物语气/关键信息
        scores.append(score)
    best = max(range(len(spans)), key=lambda i: (scores[i], -i))
    if scores[best] <= 0:
        return text[:max_chars].strip()
    lo = hi = best
    cur_len = spans[hi][1] - spans[lo][0]
    while True:
        left_len = spans[lo][0] - spans[lo - 1][0] if lo > 0 else 10 ** 9
        right_len = spans[hi + 1][1] - spans[hi][1] if hi + 1 < len(spans) else 10 ** 9
        # 分别判断两侧能否完整放入:不能因为“左侧得分高”就扩一个放不下的长句,
        # 否则 cur_len 超限后退回块头硬截,反而切断句子边界。
        left_fit = lo > 0 and left_len != 10 ** 9 and cur_len + left_len <= max_chars
        right_fit = hi + 1 < len(spans) and right_len != 10 ** 9 and cur_len + right_len <= max_chars
        if not left_fit and not right_fit:
            break
        if left_fit and right_fit:
            if scores[lo - 1] > scores[hi + 1]:
                lo -= 1
            elif scores[hi + 1] > scores[lo - 1]:
                hi += 1
            elif left_len <= right_len:
                lo -= 1
            else:
                hi += 1
        elif left_fit:
            lo -= 1
        else:
            hi += 1
        cur_len = spans[hi][1] - spans[lo][0]
    if cur_len > max_chars:
        return text[spans[best][0]:spans[best][0] + max_chars].strip()
    return text[spans[lo][0]:spans[hi][1]].strip()


def _query_tokens(query: str) -> list[str]:
    text = re.sub(r"[^一-鿿A-Za-z0-9_]", " ", query or "")
    tokens = {part for part in text.split() if len(part) >= 2}
    compact = re.sub(r"\s+", "", text)
    for index in range(max(0, len(compact) - 1)):
        bg = compact[index:index + 2]
        if re.fullmatch(r"[一-鿿]{2}", bg):
            tokens.add(bg)
    return sorted(tokens, key=len, reverse=True)[:16]


def _retrieved_chunks_payload(text: str) -> list[dict[str, Any]]:
    blocks = [block.strip() for block in (text or "").split("\n\n") if block.strip()]
    return [{"preview": block[:240], "chars": len(block)} for block in blocks[:12]]


def _worldbook_seed_entries(world: dict[str, Any]) -> list[dict[str, Any]]:
    """task 80: 通用底座 — 支持两种 world 形态:
    1) 新格式 (script_id scoped): {"entries": [{title, content}, ...]} — 直接落库,
       keys 由 _auto_extract_keys 通用提取(命名实体/高频专名)。
    2) 老格式 (柏林书 indexes/world.json): {setting, current_situation, key_factions,
       key_concepts, current_berlin} — 保留兼容路径,但不再硬编码 keys。
    """
    entries: list[dict[str, Any]] = []
    # 路径 1: 新格式 (worldbook_entries 已经存在的剧本)
    if isinstance(world.get("entries"), list):
        for i, ent in enumerate(world["entries"]):
            title = (ent.get("title") or "").strip() or f"设定条目 {i+1}"
            content = (ent.get("content") or "").strip()
            if not content:
                continue
            # 通用 keys: title 拆词 + content 抽专名
            keys = _auto_extract_keys(title, content)
            entries.append(_wb(title, keys, 90, content))
        return entries
    # 路径 2: 老格式 兼容 (柏林 indexes/world.json)
    if world.get("setting"):
        entries.append(_wb("世界基础设定", _auto_extract_keys("世界基础设定", world["setting"]),
                           100, world["setting"]))
    if world.get("current_situation"):
        entries.append(_wb("当前局势", _auto_extract_keys("当前局势", world["current_situation"]),
                           96, world["current_situation"]))
    for title, content in (world.get("key_factions") or {}).items():
        entries.append(_wb(title, _keys_for(title, content), 82, content))
    for title, content in (world.get("key_concepts") or {}).items():
        entries.append(_wb(title, _keys_for(title, content), 78, content))
    return entries
