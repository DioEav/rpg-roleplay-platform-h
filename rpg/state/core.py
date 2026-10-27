"""state/core.py — GameState class + module constants (DEFAULT_STATE, SAVE_FILE, etc.)"""
# ruff: noqa: F401
from __future__ import annotations

import copy
import hashlib
import json
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from core.clock import now_iso
from core.logging import get_logger
from state._mixins import ApplyOpsMixin, PendingMixin, RulesGameplayMixin

log = get_logger(__name__)
from state.extractors import (
    _extract_explicit_time_updates,
    _extract_location_override,
    _extract_player_time_directives,
    _extract_set_assignments,
    _extract_set_directive,
    _extract_set_time_targets,
    _extract_time_matches,
)
from state.json_ops import _extract_json_state_ops, strip_json_state_ops
from state.labels import _risk_label, _validation_label
from state.parsers import (
    _clean_item,
    _parse_assignment,
    _parse_question,
    _split_items,
    _split_label,
    _split_relation,
)
from state.path_ops import (
    _HARD_FORBIDDEN_PATHS,
    _HARD_FORBIDDEN_PREFIXES,
    _MODULE_MANAGED_PATHS,
    _RULES_MANAGED_PATHS,
    _RULES_MANAGED_PREFIXES,
    _clean_path,
    _get_path,
    _module_scene_active,
    _set_path,
    _write_path_allowed,
    _write_path_hard_forbidden,
    _write_path_kind,
    _write_path_module_managed,
    _write_path_rules_managed,
)
from state.permissions import _normalize_permission_mode, _permission_label
from state.time_ops import (
    _clean_time_value,
    _format_pending_timeline,
    _gm_is_asking_for_time_confirm,
    _looks_like_time_value,
    _phase_for_time,
)

# ── helpers imported from sub-modules ──────────────────────────────────────
from state.utils import _deep_update, _hit_score, _latest_assistant_text, _player_action_text
from timeline_state import (
    clean_time_value,
    detect_time_directives,
    is_time_key,
    looks_like_time_value,
)

BASE = Path(__file__).parent.parent  # state/core.py 比原 state.py 深一层,SAVE_FILE 必须回到 rpg/saves/
SAVE_FILE = BASE / "saves" / "game_state.json"
CURRENT_SCHEMA_VERSION = 6

# task 138: 剥离 markdown 角色卡里的"秘密 / 隐藏 / 内心 / 元知识 / 真实身份 / 来历"段。
# user_card 详细字段(personality/appearance/background)由玩家自定义,经常把秘密段
# 直接写在里面(## 秘密 / ## 隐藏 / ## 元知识 …)。short_summary 注入到 GM prompt
# 之前必须 strip 这些段,GM 物理上看不到字面秘密;workspace 入档时同样调用一次,
# 把这些段抽取到 player_private.secrets,原字段只保留 NPC 可观察部分。
# 通用 markdown 段头(## 任意 / ### 任意 都匹配),后跟可能空格 + 段名 + 行尾;
# 段内容到下一个同级或更高级标题、或文本末尾结束(re.DOTALL + 多行)。
_SECRET_SECTION_RE = re.compile(
    r"(?ms)^##+\s*(秘密|隐藏|内心|元知识|真实身份|来历|背景秘密|未公开)\s*$.*?(?=^##+\s|\Z)"
)

# task 45: 句子级元知识关键词 — 含这些词的整句从 GM 视野的角色卡字段里剥除,
# 移到 player_private.secrets。覆盖玩家在 background/personality 散文段里
# 直接写"穿越者 / 2024 年 / 原著剧情"这类元知识(没用 ## 秘密 markdown 包装)。
# 包括穿越/重生/转生/重活/记忆穿越;具体年份(20xx)+"年中国/学生/某中学";
# 提到"原著/原书/原作"+"剧情/情节/未来";常见网络穿越术语。
_META_KEYWORDS_RE = re.compile(
    r"穿越者?|"
    r"重生(回|至|到|成)|"
    r"转生|"
    # task 45 ext: "原著/原书/原作" 单独出现也是元知识(GM 不该知道这是"小说")
    r"原著|原书|原作|"
    r"(知道|记得|预知)(剧情|未来|历史|结局|走向)|"
    r"(20[0-9][0-9])\s*年.{0,12}(中国|大学|高中|学生|某|普通|地球|现代)|"
    r"(21\s*世纪|22\s*世纪)|"
    r"(穿越前|穿越以前|穿越之前|来到这|来这之前)|"
    r"(老乡|同乡)(穿越|意识|默契|关系)|"
    r"前世|今生.{0,10}穿越"
)


def _strip_meta_knowledge_sentences(text: str) -> tuple[str, list[str]]:
    """从散文里逐句扫描,含元知识关键词的整句移除并返回。

    返回 (clean_text, removed_sentences)。中文分句按 。!?;\n 切分。
    被移除的句子由调用方写入 player_private.secrets,GM 物理上看不到。
    """
    if not text or not isinstance(text, str):
        return ("", [])
    # 按 。!?;\n 分句,保留分隔符以便重组
    parts = re.split(r"([。!?;；\n])", text)
    kept: list[str] = []
    removed: list[str] = []
    buf = ""
    for piece in parts:
        if piece in "。!?;；\n":
            sentence = buf + piece
            if _META_KEYWORDS_RE.search(sentence):
                removed.append(sentence.strip())
            else:
                kept.append(sentence)
            buf = ""
        else:
            buf += piece
    if buf:
        if _META_KEYWORDS_RE.search(buf):
            removed.append(buf.strip())
        else:
            kept.append(buf)
    cleaned = "".join(kept)
    # 压缩多余空行
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned, [r for r in removed if r]


def _strip_secret_sections(text: str) -> str:
    """从 markdown 文本里剥离常见秘密段(## 秘密 / ## 隐藏 / ## 元知识 等)
    + task 45 句子级元知识关键词,返回 NPC 可见的剩余部分。
    空 / 非字符串输入返回空串。"""
    if not text or not isinstance(text, str):
        return ""
    no_sections = _SECRET_SECTION_RE.sub("", text).strip()
    cleaned, _removed = _strip_meta_knowledge_sentences(no_sections)
    return cleaned


def _extract_secret_sections(text: str) -> list[str]:
    """从 markdown 文本里抽出常见秘密段(## 秘密 / ## 隐藏 / ## 元知识 等)原文
    + task 45 句子级元知识(含穿越/原著等关键词),用于 workspace 入档时
    把秘密段 + 元知识句迁移到 player_private.secrets。
    返回每段/每句的列表。空 / 非字符串输入返回空列表。"""
    if not text or not isinstance(text, str):
        return []
    sections = [m.group(0).strip() for m in _SECRET_SECTION_RE.finditer(text) if m.group(0).strip()]
    no_sections = _SECRET_SECTION_RE.sub("", text)
    _cleaned, meta_sentences = _strip_meta_knowledge_sentences(no_sections)
    return sections + meta_sentences

# 剧情开始时的初始状态
DEFAULT_STATE = {
    "schema_version": CURRENT_SCHEMA_VERSION,
    # 规则集元信息。RulesEngine 据此选择规则集（dnd5e 为内部命名，对外文案统一使用
    # "5E compatible / 五版规则兼容"）。不引入官方 D&D 品牌内容。
    "ruleset": {
        "id": "dnd5e",
        "mode": "5e_compatible",
        "public_label": "5E compatible / 五版规则兼容"
    },
    # 5E 角色卡。空骨架——只在 rules_bridge.start_module 加载模组时由
    # make_default_character 填入具体 5E 数值。小说 / freeform 存档不应预填 5E
    # 默认值（hp=9/ac=13/属性等），否则前端 5E 面板会在非模组剧本里误显示一套
    # 用不上的角色卡。HP/AC/conditions 等硬数值受 State Gate 保护，仍只能由
    # RulesEngine 写。
    "player_character": {
        "name": "",
        "level": 0,
        "class_name": "",
        "species": "",
        "background": "",
        "abilities": {},
        "proficiency_bonus": 0,
        "skills": {},
        "saves": {},
        "max_hp": 0,
        "hp": 0,
        "ac": 0,
        "inventory": [],
        "conditions": [],
        "features": [],
        "weapons": {}
    },
    # 当前场景（房间）。模组开启后由 RulesEngine/模组加载器填入。
    "scene": {
        "module_id": "",
        "location_id": "",
        "visited_rooms": [],
        "exits": [],
        "visible_clues": [],
        "flags": {}
    },
    # 战斗遭遇状态。所有 hp/initiative 修改必须经 RulesEngine。
    "encounter": {
        "active": False,
        "round": 0,
        "turn_index": 0,
        "initiative_order": [],
        "combatants": [],
        "encounter_id": "",
        "log": []
    },
    # 最近骰子日志（最多保留 50 条）。append-only by RulesEngine。
    "dice_log": [],
    # 当前在场轻量实体索引(NPC / 敌人 / 临时角色)。NOT 完整角色卡 —
    # 完整角色卡是长期资产,在 user_cards db 表里;active_entities 是运行时索引,
    # 当 GM 在场景里遇到 / 引入角色,先进这里;真正重要才手动 promote 成 user_card
    # (只在平台『角色卡』页操作,游戏内不创建)。
    # 来源 (source 字段):
    #   "room_data"       — module 当前房间 npcs/enemies (自动同步)
    #   "encounter"       — RulesEngine 启动的合法遭遇里 combatants
    #   "gm_provisional"  — GM 正文提及的新角色 (待玩家确认 / 规则验证)
    # 字段:
    #   id, name, kind ("npc"|"enemy"|"ally"|"unknown"),
    #   role, disposition ("friendly"|"hostile"|"neutral"|"unknown"),
    #   source, first_seen_turn, last_seen_turn, location, status,
    #   confidence (0..1), card_id?, stat_block_id?
    "active_entities": [],
    # 通用 RPG 底座：DEFAULT_STATE 不再写入任何具体剧本（如《我蕾穆丽娜不爱你》的柏林开场）
    # 的人名/地名/事件。剧本/模组 opening 由 workspace._apply_script_opening、
    # rules_bridge.start_module、context_providers/module_adventure 等加载器填入。
    # 默认仅保留结构骨架与中性默认值。
    "player": {
        "name": "",
        "role": "",          # 玩家选择的角色定位
        "background": "",    # 玩家自定义背景
        "current_location": ""
    },
    # task 138：玩家私密状态机（Player Private State）。
    # 这层 namespace **永远不进 GM system prompt 字面注入** —— short_summary() 会显式
    # 排除整个 player_private.*,strip player.background/personality/appearance 里的
    # "## 秘密 / ## 隐藏 / ## 内心 / ## 元知识" 段。GM 物理上看不到秘密字面;只有玩家
    # 用 /reveal <text> 主动揭示时,该秘密本回合作为 ephemeral context 注入。
    # 字段说明:
    #   secrets        : 玩家声明的秘密原文(角色卡 secrets 字段 + 角色卡 ## 秘密 段 + /set 追加)
    #   flags          : 秘密 flag(GM 收束时可查 True/False,但不读字面 —— 当前 MVP 不引入 tool)
    #   hidden_traits  : 隐藏特质 / 元身份描述(穿越者 / 读过原著 / 真名等 meta 标签)
    #   story_intent   : 玩家剧情期望(从 worldline.user_variables.story_intent 迁移至此)
    "player_private": {
        "secrets": [],
        "flags": {},
        "hidden_traits": [],
        "story_intent": "",
    },
    "world": {
        "time": "",
        "timeline": {
            "anchor_state": "locked",
            "current_label": "",
            "current_phase": "",
            "anchor_source": "initial",
            "anchor_turn": 0,
            "pending_jump": None,
            "last_transition": None,
        },
        "known_events": []
    },
    "relationships": {},    # {角色名: "信任/警惕/未知"...}
    # 关系写入元数据（本次记忆修复新增）: {角色名: {updated_turn, previous, source}}。
    # 兼容期不改 relationships 的字符串值，避免所有读取方（short_summary/面板/规则）
    # 一起改；元数据先供后续实体召回、审计和「关系变化时间线」使用。
    "relationship_meta": {},
    "history": [],           # 完整对话 [{"role":"user","content":...}, ...]
    "permissions": {
        "mode": "full_access",  # default / auto_review / full_access
        "pending_writes": [],
        "pending_questions": [],
        "audit_log": []
    },
    "worldline": {
        "user_variables": {},
        # task 53: 玩家分支偏离原书的章节。一旦玩家做了影响主线的动作(杀死主角/
        # 改了关键事件/进入原书没写过的场景),GM 不该再用原书 divergence_chapter
        # 之后的 chunks/entities 作为"确定信息"。retrieval 会用 min(timeline.chapter_max,
        # divergence_chapter) 作为实际可见上限。
        # 默认 None = 没偏离,原书全部可查。可通过 /set worldline.divergence_chapter=N 设置。
        "divergence_chapter": None,
        "constraints": [
            "用户变量优先级高于世界线推演。",
            "世界线推演必须先满足玩家设定，再外推局势。",
            "若推演与用户变量冲突，必须报告冲突，不得写回为事实。"
        ],
        "last_projection": None,
        "pending_projection": None,
        "last_validation": {
            "status": "none",
            "message": "",
            "turn": 0
        },
        "custom_ui": {}
    },
    # 本存档记忆设置覆盖（本次记忆修复）: 只存用户显式改过的 MemorySettings 字段；
    # 未设字段继续跟随用户全局设置。由 /api/memory/settings 写入，Provider/maintenance
    # 经 get_effective_memory_settings 读取。
    "memory_settings": {},
    "memory": {
        "mode": "normal",    # concise / normal / deep
        "main_quest": "",
        # 通用 RPG 底座：current_objective 默认空，由剧本/模组 opening 写入。
        "current_objective": "",
        "resources": [],
        "abilities": [],
        "facts": [],
        # 归档事实索引（本次记忆修复新增）: _maybe_auto_archive 把超龄 facts 从 facts
        # 桶移出时，先把原文追加到这里。facts 桶保持精简（注入只看最近 N 条），
        # archived_facts 作为「远期事实存档」供 KB/episodic 召回；不参与 MemoryProvider
        # 的常规注入。上限 _ARCHIVED_FACTS_MAX，防止 state 无界增长。
        "archived_facts": [],
        # 玩家显式删除的事实文本（本次记忆修复）：KB 冷归档不应把已删除事实
        # 重新召回。只记录文本，不保留 item；上限防长局无界增长。
        "facts_deleted": [],
        # 删除文本的 sha1[:16]（小体积、可长期保留）：即使文本 tombstone 被裁，
        # 冷查询也能按 hash 排除已删除事实。与退役事件双保险。
        "facts_deleted_hashes": [],
        # 记忆生命周期计数（本次记忆修复）：只增不减，供 Debug/运维观测。
        # 不参与注入；KB 作为 memory 子树变量持久化。
        "stats": {
            "archived_total": 0,
            "superseded_total": 0,
            "cold_queries": 0,
        },
        # 篇章级 arc rollup（本次记忆修复 Phase 3）: 每 5 个 closed phase 一条确定性
        # 汇总（读 save_phase_digests，不额外调 LLM），由 MemoryAssembler 注入。
        # arc_refresh_turn 是节流戳（每 10 回合最多刷新一次）。
        "arc_summaries": [],
        "arc_refresh_turn": -1,
        "pinned": [],
        "notes": [],
        # 真摘要压缩:归档扫描把超龄 facts 压缩成的「第X-Y轮：…」条目(系统生成,只读,
        # 不接受 /api/memory/add|remove|update;随 MemoryProvider 注入「概要：」行)。
        "summaries": [],
        # 真摘要压缩第二步的待精修任务:归档扫描写入(原始全文+轮次范围+保底下标),
        # GM 回复后的收尾 worker(chat_pipeline.memory_summary)调 LLM 精修后清空。
        "summary_pending": {},
        # task 74：结构化记忆 dual-write 槽位。MemoryItem schema:
        # {id, kind, text, source, turn, time_label?, characters?, status, ts}
        # 其中 kind ∈ {canon_fact, runtime_fact, hypothesis, user_constraint}。
        # 旧 facts/notes/pinned/resources/abilities 数组继续工作（向后兼容），
        # 新 items 数组是 task 75/76/77/78 的结构化基础。
        "items": [],
        "last_retrieval": "",
        # 面板观测:本轮「长期记忆」层实际注入原文(含截断后真实进 prompt 的行),
        # MemoryProvider.collect 每轮覆写。与 last_retrieval(小说检索层文本)无关。
        "last_memory_injection": "",
        "last_context": {},
        "last_context_agent": {},
        "last_structured_updates": []
    },
    "turn": 0,
    "is_new": True,
    "created_at": "",
    # A1: 会话级模型覆盖。仅当游戏内 ModelPicker 切换时写入（不动全局 catalog）。
    # 结构：{"model_id": "...", "api_id": "..."} 或 {} 表示未设置。
    # GM 取模型时优先这里，fallback 到全局 catalog selected。
    "session_model": {}
}

MAX_HISTORY_TURNS = 6  # 保留最近6轮（12条消息）

# world.known_events 硬上限（本次记忆修复统一）: 工具写入路径原本已 cap 100，
# 但 JSON ops/史官 append 路径没有 —— 同样的事件走不同通道，长局会无界增长。
# 注入只看最近 15 条，保留最近 100 条足够；超出部分由 _append_known_events_capped
# / apply_ops / maintenance 统一裁掉。
KNOWN_EVENTS_MAX = 100

# memory.items 软上限（本次记忆修复）：旧实现 `items[-500:]` 直接砍最旧，长局里
# 被砍掉的可能是仍 active 的 notes/abilities item，而 legacy 桶还保留着文本 →
# 两套表示漂移。现在上限只裁“非 active”历史（archived/superseded/rejected），
# active 条目永远保留；active 本身超过上限时允许继续增长，优先保证记忆正确。
MEMORY_ITEMS_MAX = 500
# characters 回填/别名归并的节流窗口（本次记忆修复）。旧实现对每个缺 characters
# 的 item 每回合重扫；关系名没变时结果不会变，纯浪费。20 回合重扫一次足够让
# 新写入 relationships 的角色在合理时间内被旧事实识别。
CHARACTER_RESCAN_TURNS = 20

# ── 事实 supersede（本次记忆修复）──────────────────────────────────────────
# 保守自动取代：同一批 characters（实体标注非空）+ 文本高度重叠才认为「新事实
# 取代旧事实」。阈值刻意高（包含关系或 2-gram Jaccard ≥0.68），宁漏勿误。
_SUPERSEDE_MIN_NORM_CHARS = 8
_SUPERSEDE_JACCARD = 0.68
_SUPERSEDE_PUNCT_RE = re.compile(r"[\s，。；：、！？,.!?;:\"'“”‘’（）()【】\[\]《》<>·…—\-]+")


def normalize_fact_text(text: str) -> str:
    """事实比较用的归一化：去空白/标点，只留文字数字。"""
    return _SUPERSEDE_PUNCT_RE.sub("", str(text or ""))


def fact_text_similarity(a: str, b: str) -> float:
    """两条事实的保守相似度（0-1）。长度 < 8 或完全不同返回 0。"""
    a, b = normalize_fact_text(a), normalize_fact_text(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if len(a) < _SUPERSEDE_MIN_NORM_CHARS or len(b) < _SUPERSEDE_MIN_NORM_CHARS:
        return 0.0
    if a in b or b in a:
        return 1.0
    ga = {a[i:i + 2] for i in range(len(a) - 1)}
    gb = {b[i:i + 2] for i in range(len(b) - 1)}
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


# 本次修复：旧版柏林剧本的建议规则从硬编码迁到 script_overrides 后，仓库里没有
# 对应 JSON、测试/本地无 DB 时柏林存档只剩 5 条通用建议（“柏林势力图/特殊小队”
# 等既有能力静默消失）。这里保留一份最小内置 fallback；数据库/文件里存在同名
# script_key 时以外部 overrides 为准（merge 时外部覆盖内置）。
_BUILTIN_SCRIPT_OVERRIDES: dict[str, dict] = {
    "berlin_default": {
        "script_key": "berlin_default",
        "novel_signature_tokens": [
            "柏林", "扎府", "哈布斯堡", "图卢兹", "薇瑟", "蕾穆丽娜",
            "斯雷因", "扎兹巴鲁姆", "蛇信",
        ],
        # 当前剧情位置仍含这些 token 才允许出现柏林专属建议。
        "setting_lock_tokens": ["柏林", "扎府", "哈布斯堡"],
        "setting_locked_text_tokens": ["柏林", "扎府", "哈布斯堡"],
        "rules": [
            {
                "score": 120,
                "text": "要求一份柏林当前势力图和行动时限。",
                "needles": ["柏林", "图卢兹", "蛇信", "薇瑟"],
            },
            {
                "score": 115,
                "text": "召集特殊小队，建立柏林城内侦察与撤离预案。",
                "needles": ["特殊小队", "扎兹巴鲁姆"],
            },
            {
                "score": 105,
                "text": "摸清基地核心机密库的守卫与进入路线。",
                "needles": ["核心机密库", "基地"],
            },
        ],
    },
}


@lru_cache(maxsize=1)
def _load_script_overrides() -> dict:
    """从 DB script_overrides 表加载所有剧本 overrides,按 script_key 索引。

    DB 不可用时 fallback 到 modules/_script_overrides/*.json（本地开发兜底）；
    最后合并内置 legacy fallback（外部同名 key 优先）。
    """
    out: dict[str, dict] = {}
    try:
        from platform_app.knowledge.script_overrides import load_all_overrides_by_key
        out = dict(load_all_overrides_by_key() or {})
    except Exception:
        out = {}
    # fallback: 读 JSON 文件（本地开发 / DB 不可用时兜底）
    overrides_dir = BASE / "modules" / "_script_overrides"
    if overrides_dir.is_dir():
        for f in sorted(overrides_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                key = data.get("script_key")
                if key:
                    out[key] = data
            except Exception:
                continue
    # 外部 overrides 先匹配（更具体的剧本优先），内置 legacy fallback 只补缺。
    merged = dict(out)
    for _k, _v in _BUILTIN_SCRIPT_OVERRIDES.items():
        merged.setdefault(_k, dict(_v))
    return merged


def _detect_active_script_key(context: str) -> str | None:
    """根据 context 中出现的 signature tokens 推测当前剧本 key。返回 None 表示未识别 (用通用 fallback)。"""
    for key, ov in _load_script_overrides().items():
        tokens = ov.get("novel_signature_tokens") or []
        if tokens and any(t in context for t in tokens):
            return key
    return None


class GameState(ApplyOpsMixin, RulesGameplayMixin, PendingMixin):
    def __init__(self, data: dict):
        self.data = self._migrate(data)

    # ── 读档 / 新档 ────────────────────────────────────────────────
    @classmethod
    def load_or_new(cls) -> GameState:
        SAVE_FILE.parent.mkdir(parents=True, exist_ok=True)
        if SAVE_FILE.exists():
            try:
                with open(SAVE_FILE, encoding="utf-8") as f:
                    data = json.load(f)
                data = cls._migrate(data)
                log.info(f"[读档] {data['player']['name']} · 第{data['turn']}回合 · {data['world']['time']}")
                return cls(data)
            except Exception as e:
                log.warning(f"[读档失败：{e}，开始新游戏]")
        return cls.new()

    @classmethod
    def new(cls) -> GameState:
        data = copy.deepcopy(DEFAULT_STATE)
        data["created_at"] = now_iso()
        return cls(data)

    @staticmethod
    def _migrate(data: dict) -> dict:
        source = data or {}
        source_world = source.get("world", {}) if isinstance(source, dict) else {}
        source_timeline = source_world.get("timeline", {}) if isinstance(source_world, dict) else {}
        migrated = copy.deepcopy(DEFAULT_STATE)
        _deep_update(migrated, source)
        migrated["schema_version"] = CURRENT_SCHEMA_VERSION
        migrated.setdefault("history", [])
        migrated.setdefault("relationships", {})
        permissions = migrated.setdefault("permissions", {})
        permissions.setdefault("mode", "full_access")
        permissions.setdefault("pending_writes", [])
        permissions.setdefault("pending_questions", [])
        permissions.setdefault("audit_log", [])
        worldline = migrated.setdefault("worldline", {})
        worldline.setdefault("user_variables", {})
        worldline.setdefault("constraints", list(DEFAULT_STATE["worldline"]["constraints"]))
        worldline.setdefault("last_projection", None)
        worldline.setdefault("pending_projection", None)
        worldline.setdefault("last_validation", {"status": "none", "message": "", "turn": 0})
        worldline.setdefault("custom_ui", {})
        timeline = migrated.setdefault("world", {}).setdefault("timeline", {})
        if not source_timeline or not source_timeline.get("current_label"):
            timeline["current_label"] = migrated["world"].get("time", "")
            timeline["anchor_source"] = "migrated"
        timeline.setdefault("anchor_state", "locked")
        # 通用 RPG 底座：旧存档默认 phase 不再硬编码《我蕾穆丽娜不爱你》的『柏林暗流篇』。
        # 真实剧本/模组 opening 会在 _apply_script_opening 写入对应阶段；遗留 Berlin 存档
        # 已经把『柏林暗流篇』写在自己的 state_snapshot 里，不依赖 setdefault。
        timeline.setdefault("current_phase", "")
        timeline.setdefault("anchor_turn", migrated.get("turn", 0))
        timeline.setdefault("pending_jump", None)
        timeline.setdefault("last_transition", None)
        # schema v5：5E-compatible 规则相关字段补全。旧存档没有 ruleset / player_character /
        # scene / encounter / dice_log 时，补上 DEFAULT_STATE 的默认值；保持已有字段不变。
        for rules_key in ("ruleset", "player_character", "scene", "encounter", "dice_log"):
            if rules_key not in migrated:
                migrated[rules_key] = copy.deepcopy(DEFAULT_STATE[rules_key])
        # schema v6 (task 138): player_private namespace 默认。旧存档没有时补默认空 struct,
        # 已有字段不变;并尝试从 player.secrets / worldline.user_variables.story_intent
        # 迁移过来(后者 *仅* 在 player_private.story_intent 仍空时,避免覆盖玩家本回合
        # 已经在新结构里写过的 intent)。
        pp = migrated.setdefault("player_private", copy.deepcopy(DEFAULT_STATE["player_private"]))
        if not isinstance(pp.get("secrets"), list):
            pp["secrets"] = []
        if not isinstance(pp.get("flags"), dict):
            pp["flags"] = {}
        if not isinstance(pp.get("hidden_traits"), list):
            pp["hidden_traits"] = []
        if not isinstance(pp.get("story_intent"), str):
            pp["story_intent"] = ""
        # 迁移 1: player.secrets(老 task 137 字段)→ player_private.secrets
        # 老存档 player.secrets 是字符串(整段角色卡 ## 秘密 节)。这里转 list[str]
        # 单条目;若已经在 player_private.secrets 里出现则跳过。
        _old_secrets = (migrated.get("player") or {}).get("secrets") or ""
        if isinstance(_old_secrets, str) and _old_secrets.strip():
            if _old_secrets.strip() not in pp["secrets"]:
                pp["secrets"].append(_old_secrets.strip())
        elif isinstance(_old_secrets, list):
            for _s in _old_secrets:
                _t = str(_s or "").strip()
                if _t and _t not in pp["secrets"]:
                    pp["secrets"].append(_t)
        # 迁移 2: worldline.user_variables.story_intent → player_private.story_intent
        # 只迁不删 user_variables(留 backward compat,避免别处 dual-read 失败)。
        _wl_vars = (migrated.get("worldline") or {}).get("user_variables") or {}
        _wl_intent = _wl_vars.get("story_intent")
        if not pp["story_intent"]:
            if isinstance(_wl_intent, dict):
                _v = str(_wl_intent.get("value") or "").strip()
                if _v:
                    pp["story_intent"] = _v
            elif isinstance(_wl_intent, str) and _wl_intent.strip():
                pp["story_intent"] = _wl_intent.strip()
        # 兼容旧存档：如果 player_character.hp 为空但 max_hp 有值，回填 hp=max_hp。
        pc = migrated.get("player_character") or {}
        if pc and pc.get("max_hp") and not pc.get("hp"):
            pc["hp"] = pc["max_hp"]
        # task 74：旧存档没有 memory.items，补一个空数组（不回填旧 facts，让 task 78
        # 在确定迁移策略后做。这里只是让新写入能落地）。
        memory_block = migrated.setdefault("memory", {})
        memory_block.setdefault("items", [])
        # task 83（codex §7.1 phase B）：MemoryItem 旧数据 backfill 迁移。
        # task 74 只做 dual-write，新写入同时落 legacy facts/notes/pinned/abilities/
        # resources 和 items；旧存档里 memory.items 还是空。这里补一次迁移：
        # 当 items 为空且任一 legacy bucket 有内容，就把 legacy 数组转成 MemoryItem
        # 注入 items（kind=runtime_fact, source=legacy_migration_v1, turn=0——
        # 旧数据无 turn 可考，用 0 标记"档前"）。
        # 保留 legacy 字段不动：codex 哲学是 6 月观察期 dual-read 兼容，迁移阶段
        # 不删旧字段，等 phase C 才决定是否移除。
        # _migrate 是 staticmethod，调不到 self.add_memory_item，所以内联生成 item。
        if not memory_block.get("items"):
            import secrets as _secrets
            legacy_buckets = ("facts", "notes", "pinned", "abilities", "resources")
            has_legacy = any(memory_block.get(b) for b in legacy_buckets)
            if has_legacy:
                backfilled: list[dict] = []
                now_ts = now_iso()
                for bucket in legacy_buckets:
                    legacy_arr = memory_block.get(bucket) or []
                    if not isinstance(legacy_arr, list):
                        continue
                    for raw in legacy_arr:
                        text = _clean_item(raw if isinstance(raw, str) else str(raw))
                        if not text:
                            continue
                        backfilled.append({
                            "id": f"mem_{_secrets.token_urlsafe(6)}",
                            "kind": "runtime_fact",
                            "text": text,
                            "source": "legacy_migration_v1",
                            "turn": 0,
                            "ts": now_ts,
                            "status": "active",
                            "legacy_bucket": bucket,
                        })
                if backfilled:
                    memory_block["items"] = backfilled
        return migrated

    # ── 存档 ──────────────────────────────────────────────────────
    def save(self, target_path: Path | str | None = None) -> str:
        """写 state 到磁盘。

        多用户安全：在服务器模式下，**绝对不能写全局 SAVE_FILE**——这是并发污染源。
        - 显式 target_path：写到该路径（推荐让调用方传 user-specific runtime_state_path）
        - 否则按部署模式决定：
          - server / 强制鉴权：拒绝写盘，返回空串（数据应该走 DB 持久化）
          - 本地匿名：写 SAVE_FILE（兼容旧逻辑）

        返回实际写入的路径，调用方可用于审计。空串表示没写盘。
        """
        import os as _os
        out_path: Path | None = None
        if target_path:
            out_path = Path(target_path)
        else:
            # 服务器模式：禁止落到全局 SAVE_FILE
            from core.config import is_local_mode as _is_local_mode
            from core.config import require_auth as _require_auth
            is_server = _require_auth() or not _is_local_mode()
            if is_server:
                return ""  # 不写盘；DB 是权威源，runtime_state_path 由 branches.persist_runtime_state 管
            out_path = SAVE_FILE

        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_file = out_path.with_suffix(out_path.suffix + ".tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
        tmp_file.replace(out_path)
        return str(out_path)

    # ── 玩家设置 ──────────────────────────────────────────────────
    def setup_player(self, name: str, role: str, background: str):
        self.data["player"]["name"] = name
        self.data["player"]["role"] = role
        self.data["player"]["background"] = background
        self.data["is_new"] = False
        # harness:不再按 role/background 字符串嗅探注入写死设定(穿越者读原著 / 魔力∞ 能力)。
        # 出身框架由 state.player.player_origin(4 档)驱动,GM master._dynamic_context 按档注入;
        # 角色能力/背景一律来自角色卡 + 身份卡,这里不硬编码任何特定剧本角色。

    # ── 记录对话 ──────────────────────────────────────────────────
    def record_turn(self, player_input: str, gm_response: str):
        # 不把空 assistant 回复记进历史:provider(moonshot/kimi 等)会对空 assistant 消息 400,
        # 一旦记入,之后每轮重放都炸(history_messages 也会再过滤一道兜底)。空回复=本轮无产出,
        # 玩家输入由前端恢复草稿,不该污染历史。带 tool_ops/reasoning 的工具轮不算空,照常记。
        _has_aux = bool(self.data.get("_turn_tool_ops") or self.data.get("_turn_reasoning"))
        if not str(gm_response or "").strip() and not _has_aux:
            self.data.pop("_turn_tool_ops", None)
            self.data.pop("_turn_reasoning", None)
            return
        self.data["history"].append({"role": "user",      "content": player_input})
        _asst = {"role": "assistant", "content": gm_response}
        # 工具流 + 思考流:本轮 pipeline 累积在 _turn_tool_ops / _turn_reasoning 临时键,这里落到
        # assistant 历史消息(随 state_snapshot 持久化)→ 重开/刷新聊天后工具调用 + 思考流仍可见。
        try:
            _ops = self.data.pop("_turn_tool_ops", None)
            if _ops:
                _clean = [{k: v for k, v in o.items() if k != "_pending"}
                          for o in _ops if isinstance(o, dict)]
                if _clean:
                    _asst["tool_ops"] = _clean
            _rsn = self.data.pop("_turn_reasoning", None)
            if _rsn:
                _txt = "".join(x for x in _rsn if isinstance(x, str)).strip()
                if _txt:
                    _asst["reasoning"] = _txt
        except Exception:
            pass
        self.data["history"].append(_asst)
        self.data["turn"] += 1
        # task 138: ephemeral reveal 是本回合一次性注入,GM 已经吃过 prompt,
        # 现在清掉避免下一轮自动重注。secrets 仍留在 player_private.secrets 历史里。
        try:
            _flags = self.data.setdefault("player_private", {}).setdefault("flags", {})
            if _flags.get("revealed_this_turn"):
                _flags["revealed_this_turn"] = ""
        except Exception:
            pass

    # ── 给 GM 用的历史消息列表 ────────────────────────────────────
    def history_messages(self, limit_turns: int = MAX_HISTORY_TURNS,
                          *, save_id: int | None = None,
                          include_digest: bool = True) -> list[dict]:
        """返回喂给 GM backend 的历史 messages。

        默认行为:
          取最近 limit_turns 轮原文 + 已 closed phase digests 作为"前情提要"
          顶到最前面。**Claude Code /compact 风格**:旧对话压缩成摘要,
          新对话原文,context window 不爆。

        save_id 来源 (优先级):
          1. 显式参数(老 caller / 测试可控制)
          2. self.data["_active_save_id"] (chat_pipeline 入口写入)
          3. None → 退化到只返最近 limit_turns 轮原文

        include_digest=False:
          只返最近 limit_turns 轮**原文**,不带前情提要。给「判断此刻在哪、
          谁在场」的消费方用 —— 前情提要是**最旧**的已压缩阶段且顶在最前面,
          任何按「最近对话」语义使用它、或对返回值做**头部**截断的调用方,
          拿到的都是开局剧情而非当前场景(子代理把第 116 章的档判成开局
          激光通道即此因)。
        """
        max_msgs = limit_turns * 2
        # 丢弃 content 为空/纯空白的历史消息:某些 provider(moonshot/kimi 等)对**空 assistant
        # 消息**直接 400「the message ... role 'assistant' must not be empty」→ 整轮失败,且历史
        # 一旦混入空 assistant(上一轮空回复/失败被记进 history),之后每轮重放都炸。这里在喂给
        # backend 前过滤,兼修已被污染的存档(非破坏性,只过滤不改库)。
        recent = [m for m in self.data["history"][-max_msgs:]
                  if isinstance(m, dict) and str(m.get("content") or "").strip()]
        if not include_digest:
            return recent
        if save_id is None:
            save_id = self.data.get("_active_save_id")
        if save_id is None:
            return recent
        # 拉该 save 的全部 phase(不只 closed)—— 需要全集才能算出「层」那条路占了哪几个。
        # v1.82.0:在此之前这里注入的是**所有** closed phase,无条数上限也无字符上限,而
        # runtime_phase_digests 层又把最近 4 个 phase 渲染了一遍 → 同一段历史一个请求里出现
        # 两次,且这条路随存档变长无限膨胀。归属划分与上限现在收敛在 state.phase_digest_policy。
        try:
            from platform_app.db import connect as _connect
            from state.phase_digest_policy import (
                DIGEST_PREFIX_MAX_CHARS,
                DIGEST_SUMMARY_MAX_CHARS,
                layer_owned_phase_indexes,
                select_prefix_phases,
            )
            with _connect() as db:
                digests = db.execute(
                    """
                    select phase_index, phase_label, turn_start, turn_end,
                           summary, key_events, key_npcs, key_locations,
                           key_decisions, status
                    from save_phase_digests
                    where save_id = %s
                    order by phase_index asc
                    """,
                    (int(save_id),),
                ).fetchall()
            if not digests:
                return recent
            digests = [dict(d) for d in digests]
            # 如果最近 K 轮已经覆盖了所有 phase,不重复注入 (避免老 phase 重复)
            min_recent_turn = self.data.get("turn", 0) - limit_turns
            _owned = layer_owned_phase_indexes(
                [int(d.get("phase_index") or 0) for d in digests])
            relevant_digests = select_prefix_phases(
                digests, layer_owned=_owned, max_recent_turn=min_recent_turn)
            if not relevant_digests:
                return recent
            # 组装前情提要 message
            digest_lines = ["【前情提要 · 已压缩历史阶段】"]
            for d in relevant_digests:
                events = d["key_events"] or []
                npcs = d["key_npcs"] or []
                locs = d["key_locations"] or []
                decisions = d["key_decisions"] or []
                ev_str = "; ".join(str(x) for x in events[:3]) if events else "(无)"
                npc_str = ", ".join(str(x) for x in npcs[:5]) if npcs else "(无)"
                digest_lines.append(
                    f"\n## Phase {d['phase_index']}: {d['phase_label']} "
                    f"(turn {d['turn_start']}-{d['turn_end']})\n"
                    f"{(d['summary'] or '')[:DIGEST_SUMMARY_MAX_CHARS]}\n"
                    f"关键事件: {ev_str}\n"
                    f"出场人物: {npc_str}\n"
                    f"主要地点: {', '.join(str(x) for x in locs[:3]) if locs else '(无)'}\n"
                    f"关键决策: {'; '.join(str(x) for x in decisions[:3]) if decisions else '(无)'}"
                )
            digest_text = "\n".join(digest_lines)
            # 总字符上限:比逐条上限更硬的那道闸(phase 条数已封顶,但 key_events/npcs
            # 是变长的)。超了从**最早**的 phase 砍起 —— 前情提要是时间正序,越靠后越接近
            # 当前场景,砍头保尾。
            if len(digest_text) > DIGEST_PREFIX_MAX_CHARS:
                digest_text = ("【前情提要 · 已压缩历史阶段(更早的部分已省略,"
                               "可经「相关往事」层按需召回)】\n"
                               + digest_text[-(DIGEST_PREFIX_MAX_CHARS):])
            digest_msg = {"role": "user", "content": digest_text}
            # 给一个 assistant ack 让结构合法 (避免连续两个 user role)
            ack_msg = {"role": "assistant", "content": "[已收到前情提要,继续在此基础上叙事]"}
            return [digest_msg, ack_msg, *recent]
        except Exception:
            # 任何失败回退到原行为,保证 chat 主路径不挂
            return recent

    def chat_history(self) -> list[dict]:
        return list(self.data["history"])

    # ── 状态简报（注入 system prompt）────────────────────────────
    def short_summary(self, *, include_memory: bool = True,
                      include_worldline: bool = True) -> str:
        """当前状态简报。

        prompt 专用裁剪（本次记忆修复）:
          · include_memory=False —— MemoryProvider 已是 facts/pinned/notes/abilities/
            resources/summaries/主线目标的唯一注入源，状态层不再重复列一遍。
          · include_worldline=False —— WorldlineProvider 已注入用户变量/约束/位置/权限
            行为，状态层不再重复。
        默认 True 保持 UI / /api/state / 既有测试的行为不变；只有 context_engine 的
        state 层与 GM 动态上下文在确认对应 provider 存在时才传 False。
        """
        p = self.data["player"]
        w = self.data["world"]
        m = self.data["memory"]
        permissions = self.data.get("permissions", {})
        worldline = self.data.get("worldline", {})
        rel_lines = []
        # 只注入最近 N 条关系:relationships dict 无上限,长局 GM 给大量路人/已离场 NPC 登记
        # 关系后会全量注入吃 token(同 known_events、memory 各 bucket 都已截断,唯独这里漏了)。
        # 取最近登记的 20 条(dict 按插入序,末尾=较新引入的角色);<20 关系是常态极少触发。
        for char, status in list(self.data["relationships"].items())[-20:]:
            rel_lines.append(f"  · {char}：{status}")
        rel_text = "\n".join(rel_lines) if rel_lines else "  （尚未与任何人建立明确关系）"

        # 只注入最近 N 条已知事件:与下方 memory 各 bucket(abilities[:6]/facts[:10]/notes[:8])
        # 的注入截断一致。原来全量注入,而 known_events 写入无上限 + GM prompt 鼓励记流水账,
        # 长局后这块线性增长吃光 token。取最近 15 条(时间上最相关)。
        known = "\n".join(f"  · {e}" for e in w["known_events"][-15:])
        memory_lines = []
        if include_memory:
            if m["main_quest"]:
                memory_lines.append(f"主线：{m['main_quest']}")
            if m["current_objective"]:
                memory_lines.append(f"当前目标：{m['current_objective']}")
            # 能力取尾：旧实现 [:6] 取头，能力超过 6 条后状态层永远显示最早的能力，
            # 与 MemoryProvider[-depth:] / 其他桶的取尾方向不一致。
            memory_lines.extend(f"能力：{x}" for x in m["abilities"][-6:])
            # 各桶写入端是尾部 append(add_memory / apply_ops list 分支),窗口必须取**尾**
            # (最近 N 条),与上方 relationships[-20:]/下方 known_events[-15:] 同向。
            # 旧实现取头([:N])→ 桶一旦超过窗口,新增能力/资源/固定记忆/笔记永久不可见
            # (群反馈同族:「面板一直是很早以前的」)。
            memory_lines.extend(f"资源：{x}" for x in m["resources"][-6:])
            memory_lines.extend(f"固定记忆：{x}" for x in m["pinned"][-6:])
            if m["mode"] == "deep":
                memory_lines.extend(f"事实：{x}" for x in m["facts"][-10:])
                memory_lines.extend(f"笔记：{x}" for x in m["notes"][-8:])
            elif m["mode"] == "normal":
                memory_lines.extend(f"事实：{x}" for x in m["facts"][-5:])
                memory_lines.extend(f"笔记：{x}" for x in m["notes"][-3:])
        memory_text = ("\n".join(f"  · {line}" for line in memory_lines)
                       or "  （暂无长期记忆）") if include_memory else ""
        # task 138: user_variables 里的 story_intent 是 player_private 范畴,不再注入 GM prompt。
        # 旧存档迁移函数已把 story_intent 复制到 player_private.story_intent,这里只是把字面
        # 从 system prompt 里抹掉(player_private namespace 整个不进 prompt)。
        variable_text = ""
        if include_worldline:
            variables = worldline.get("user_variables", {})
            _public_vars = [
                (name, info) for name, info in variables.items()
                if name != "story_intent"
            ]
            # 窗口取「最近设定的 12 条」:dict 键序过 jsonb 落库后不保(键按长度/字节重排),
            # 直接取头 [:12] = 任意子集。变量自带 turn,按它升序后取尾恢复真实时序。
            def _var_turn(kv):
                info = kv[1]
                if isinstance(info, dict):
                    try:
                        return int(info.get("turn") or 0)
                    except (TypeError, ValueError):
                        return 0
                return 0
            _public_vars.sort(key=_var_turn)
            if _public_vars:
                variable_text = "\n".join(
                    f"  · {name}={info.get('value', '')}"
                    if isinstance(info, dict) else f"  · {name}={info}"
                    for name, info in _public_vars[-12:]
                )
            else:
                variable_text = "  （暂无用户变量）"
        # task 138: 玩家段只注入 NPC 可观察字段。规则:
        #   1. 不注入 player_private.* 整个 namespace(secrets / hidden_traits / flags / story_intent)
        #   2. 不注入 player.secrets(老 task 137 残留;迁移函数会清空但保险起见这里再过一遍)
        #   3. background / personality / appearance 注入前用 _strip_secret_sections 剥离
        #      ## 秘密 / ## 隐藏 / ## 内心 / ## 元知识 / ## 真实身份 / ## 来历 / ## 背景秘密 / ## 未公开 段
        #   4. 玩家档案保留 NPC 可观察字段:name / role / 外貌(strip) / 当前位置 / identity_role_desc
        #      性格/语气/背景也是 NPC 可推断但秘密段必须 strip。
        _card_detail_lines = []
        _appearance = _strip_secret_sections(p.get("appearance") or "")
        _personality = _strip_secret_sections(p.get("personality") or "")
        if _appearance:
            _card_detail_lines.append(f"外貌：{_appearance}")
        if _personality:
            _card_detail_lines.append(f"性格/详细设定：{_personality}")
        if p.get("speech_style"):
            _card_detail_lines.append(f"语气/说话方式：{p['speech_style']}")
        # 注意: p.get("secrets") 显式 *不* 注入 — 即使老存档仍有该字段,
        # GM 也物理上看不到。秘密属于 state.player_private.*(永不进 system prompt)。
        if p.get("aliases"):
            _card_detail_lines.append(f"别名：{p['aliases']}")
        if p.get("identity_role_desc"):
            _card_detail_lines.append(f"入场定位：{p['identity_role_desc']}")
        _card_detail = ("\n" + "\n".join(_card_detail_lines)) if _card_detail_lines else ""
        # task 138: story_intent 改从 player_private.story_intent 读取(dual-read 旧存档兼容)。
        # 但 story_intent 也不应注入到 system prompt — 这是玩家剧情期望,属于 player_private 范畴,
        # GM 看不到字面意图,只能通过场景反应自然推进。如果玩家想让 GM 知道,用 /reveal。
        # 这里保留向后兼容: 旧存档没改完前,user_variables.story_intent 仍可能有值,但**不再注入**。
        # 阶段 5 /reveal 会用 player_private.flags["revealed_this_turn"] 做 ephemeral 注入。
        _revealed = self.data.get("player_private", {}).get("flags", {}).get("revealed_this_turn") or ""
        _revealed_block = f"\n\n【玩家本轮揭示】\n{_revealed}" if _revealed else ""
        # background 字段同样 strip 秘密段
        _background = _strip_secret_sections(p.get("background") or "")
        # prompt 专用裁剪:MemoryProvider / WorldlineProvider 已接管对应内容时，
        # 这里不再重复渲染。默认 True 时保持 UI / /api/state 原输出不变。
        _memory_block = f"\n\n【长期记忆】\n{memory_text}" if include_memory else ""
        _worldline_block = (
            f"\n\n【权限与世界线】\n"
            f"  · LLM写入权限：{_permission_label(permissions.get('mode', 'full_access'))}\n"
            f"  · 用户变量：\n{variable_text}"
        ) if include_worldline else ""
        return f"""【玩家档案】
姓名：{p['name']}
定位：{p['role']}
背景：{_background}{_card_detail}
当前位置：{p['current_location']}

【当前时间线】{w['time']}
【时间线锚定】
  · 状态：{w.get('timeline', {}).get('anchor_state', 'locked')}
  · 阶段：{w.get('timeline', {}).get('current_phase', '未知')}
  · 待确认跳跃：{_format_pending_timeline(w.get('timeline', {}).get('pending_jump'))}

【已知事件】
{known}

【关系状态】
{rel_text}{_memory_block}{_worldline_block}

【当前回合】第 {self.data['turn']} 回合{_revealed_block}"""

    def status_payload(self) -> dict:
        p = self.data["player"]
        w = self.data["world"]
        m = self.data["memory"]
        # ContentPack manifest 解析（小说 / 模组 / freeform）。让前端按 manifest.kind
        # 选择性渲染 5E 规则面板，避免在小说存档里显示模组 UI。
        try:
            from context_providers import resolve_content_pack
            content_pack = resolve_content_pack(self)
        except Exception:
            content_pack = {"kind": "freeform", "context_providers": [], "ruleset": "none"}
        rules_block = {
            "ruleset": copy.deepcopy(self.data.get("ruleset") or {}),
            "player_character": copy.deepcopy(self.data.get("player_character") or {}),
            "scene": copy.deepcopy(self.data.get("scene") or {}),
            "encounter": copy.deepcopy(self.data.get("encounter") or {}),
            "dice_log": list(self.data.get("dice_log") or [])[-30:],
            # 三层人物系统:轻量在场实体索引 (NPC / 敌人 / 临时角色)。
            # 前端 PanelCharacters 读这个,不再依赖 GM 写 relationships。
            "active_entities": list(self.data.get("active_entities") or []),
            "content_pack": {
                "id": content_pack.get("id"),
                "kind": content_pack.get("kind"),
                "ruleset": content_pack.get("ruleset"),
                "context_providers": list(content_pack.get("context_providers") or []),
                "retrieval_policy": dict(content_pack.get("retrieval_policy") or {}),
                "gm_policy": dict(content_pack.get("gm_policy") or {}),
                "title": content_pack.get("title"),
            },
        }
        return {**rules_block, **{
            "player": dict(p),
            "world": dict(w),
            "relationships": dict(self.data["relationships"]),
            # 关系变化元数据（本次记忆修复）: 前端 PanelCharacters 显示 updated_turn/previous。
            "relationship_meta": copy.deepcopy(self.data.get("relationship_meta") or {}),
            # NPC 议程 v0:前端人物面板展示用;无议程 = 空 dict。
            "npc_agendas": copy.deepcopy(self.data.get("npc_agendas") or {}),
            "permissions": copy.deepcopy(self.data.get("permissions", {})),
            "worldline": copy.deepcopy(self.data.get("worldline", {})),
            "memory": copy.deepcopy(m),
            # 本存档 MemorySettings override（本次记忆修复）: 前端 PanelMemory 据此回显
            # 「本存档设置」；空 dict = 全部跟随用户全局。
            "memory_settings": copy.deepcopy(self.data.get("memory_settings") or {}),
            "turn": self.data["turn"],
            "schema_version": self.data.get("schema_version", CURRENT_SCHEMA_VERSION),
            "is_new": self.data["is_new"],
            "created_at": self.data["created_at"],
            "summary": self.short_summary(),
            "history": self.chat_history(),
            "suggestions": self.suggestions(),
            # A1: 存档级模型覆盖，前端 ModelPicker 据此显示当前选中状态
            "session_model": dict(self.data.get("session_model") or {}),
            # 2026-10: 存档级思考档位覆盖(对话框里的「本对话」作用域),前端 Effort 控件回显。
            "session_reasoning": dict(self.data.get("session_reasoning") or {}),
            # 酒馆模式:把 state.data["tavern"]（AI 角色卡快照 + persona 绑定 + system_prompt 等）
            # 透到 /api/state 顶层,供 Tavern 前端读角色名/角色卡视图。普通 game 存档无此 key → 空 dict,
            # 前端按 falsy 兜底,对 Game Console 零影响。
            "tavern": copy.deepcopy(self.data.get("tavern") or {}),
        }}

    def suggestions(self) -> list[str]:
        latest = _latest_assistant_text(self.data["history"])
        player = self.data["player"]
        world = self.data["world"]
        memory = self.data["memory"]
        context = "\n".join([
            latest,
            player.get("current_location", ""),
            world.get("time", ""),
            memory.get("main_quest", ""),
            memory.get("current_objective", ""),
            "\n".join(world.get("known_events", [])),
            "\n".join(memory.get("resources", [])),
            "\n".join(memory.get("abilities", [])),
            "\n".join(memory.get("facts", [])),
        ])

        # 识别当前剧本 key (None 表示未识别 → 用通用 fallback)
        active_script_key = _detect_active_script_key(context)
        active_overrides = _load_script_overrides().get(active_script_key, {}) if active_script_key else {}

        # task 86：剧情位置一致性检查。
        # 历史 memory.facts / pinned / known_events 可能积累了之前柏林剧情的事实
        # （比如"扎兹巴鲁姆"、"特殊小队"），跨剧情跳跃到月球/火星后这些 needle 仍
        # 会命中,但建议内容含"柏林城内/柏林战役"等当前位置已不再适用的地理词,
        # 让玩家困惑。这里检查**当前剧情位置**是否仍在 setting lock 范围内,决定是否允许含
        # 锁定地理词的建议出现。当前位置以 player.current_location / world.time /
        # timeline.current_phase / timeline.current_label 为准（这些是"此时此刻"，
        # 不受过往记忆污染）。
        _setting_blob = " ".join([
            str(player.get("current_location") or ""),
            str(world.get("time") or ""),
            str((world.get("timeline") or {}).get("current_phase") or ""),
            str((world.get("timeline") or {}).get("current_label") or ""),
        ])
        _setting_lock_tokens = active_overrides.get("setting_lock_tokens") or []
        _setting_is_active = any(tok in _setting_blob for tok in _setting_lock_tokens) if _setting_lock_tokens else True
        _setting_locked_text_tokens = tuple(active_overrides.get("setting_locked_text_tokens") or ())

        candidates: list[tuple[int, str]] = []

        def add(score: int, text: str, *needles: str):
            if needles and not any(n in context for n in needles):
                return
            # setting lock: 含锁定 token 的文本只在当前剧情匹配 setting 时允许
            if not _setting_is_active and _setting_locked_text_tokens and any(
                tok in text for tok in _setting_locked_text_tokens
            ):
                return
            candidates.append((score + _hit_score(context, needles), _player_action_text(text)))

        # 从 overrides 加载剧本专属规则 (替代原 11 条硬编码)
        for rule in active_overrides.get("rules") or []:
            add(rule["score"], rule["text"], *rule.get("needles", []))

        if latest and re.search(r"[？?]\s*$", latest):
            add(125, "直接回应当前抉择，并要求列出风险与代价。")

        # 通用 fallback 跨剧本都安全；剧本专属 fallback 从 overrides 加载
        fallback_generic = [
            "观察当前场景的可见人物、出口和风险点。",
            "整理当下已知情报，标出最危险变量。",
            "确认下一步目标、可用资源和不可触碰底线。",
            "先和关键人物单独谈话，判断真实立场。",
            "回顾当前剧本开场设定，校准核心动机。",
        ]
        fallback_novel = active_overrides.get("default_novel_fallbacks") or []
        fallback = fallback_generic + fallback_novel
        for index, text in enumerate(fallback):
            add(20 - index, text)

        suggestions: list[str] = []
        seen: set[str] = set()
        for _, text in sorted(candidates, reverse=True):
            key = re.sub(r"\W+", "", text)
            if key not in seen:
                suggestions.append(text)
                seen.add(key)
            if len(suggestions) >= 5:
                break
        return suggestions

    # ── 长期记忆与结构化更新 ──────────────────────────────────────
    # set_memory_mode 已删除(v1.77.0)。记忆模式选择器是装饰性的:全仓没有任何一处据
    # memory.mode 改变行为,真正的旋钮是 MemorySettings(recall_depth / token_budget /
    # 三个分桶开关,「设置 → 记忆」里有完整 UI)。原实现的白名单还漏了 UI 提供的 "off",
    # 且非法值**静默丢弃** → 用户点「关闭」自动弹回普通(群反馈)。
    # data["memory"]["mode"] 字段保留不删:存量存档/快照往返兼容,留着无害(已无消费方)。

    def _memory_characters_for(self, text: str) -> list[str]:
        """从文本中确定性识别已知角色名（本次记忆修复，不调用额外 LLM）。

        数据源：relationships 的键、active_entities 的 name/id、玩家名。
        facts/notes/abilities/resources 写入时把这个结果塞进 MemoryItem.characters，
        让 query_memory 的 characters 过滤和后续「按实体召回」真正可用。

        只做子串命中，宁漏勿误：名字至少 2 字；长名优先；最多 8 个；排除
        unknown/_player 这类哨兵值。它不是 NER，不指望识别正文里首次出现的新名字；
        新名字先由 GM/史官写入 relationships/active_entities，下一轮才会被识别。
        """
        t = str(text or "")
        if not t:
            return []
        names: set[str] = set()
        for name in (self.data.get("relationships") or {}):
            n = str(name or "").strip()
            if len(n) >= 2:
                names.add(n)
        for ent in (self.data.get("active_entities") or []):
            if isinstance(ent, dict):
                n = str(ent.get("name") or ent.get("id") or "").strip()
                if len(n) >= 2:
                    names.add(n)
        pn = str((self.data.get("player") or {}).get("name") or "").strip()
        if len(pn) >= 2:
            names.add(pn)
        names.discard("unknown")
        names.discard("未知")
        names.discard("_player")
        # 本次记忆修复：写入前做一次 canon 别名归并（云芝 → 云韵）。这样同一角色的
        # 化名/主名写入的 facts 共享 characters，自动 supersede 和按实体召回不会漏。
        # 注意要保留「原文名 → 主名」映射：match 用原文名（正文里可能写的是化名），
        # 存进 item.characters 的用主名（后续过滤/取代用统一身份）。
        _save_id = self.data.get("_active_save_id")
        if _save_id:
            try:
                from kb.alias import canonical_name_for_save
                canonical_map = {
                    n: (canonical_name_for_save(_save_id, n) or n) for n in names
                }
            except Exception:
                canonical_map = {n: n for n in names}
        else:
            canonical_map = {n: n for n in names}
        hits = sorted(
            {canonical for original, canonical in canonical_map.items() if original in t},
            key=len, reverse=True,
        )
        return hits[:8]

    def _memory_context_meta(self) -> dict[str, str | None]:
        """当前地点/场景/篇章（本次记忆修复）。

        写入事实/笔记时随 item 一起落库，让 MemoryAssembler 在玩家说“我回到这里
        看看”这类没有明确人名的查询里，也能按当前场景/地点召回旧记忆。
        旧档没有这些字段时全部返回 None，召回仍走文本 gram/实体兜底。
        """
        try:
            data = self.data or {}
            player = data.get("player") or {}
            scene = data.get("scene") or {}
            timeline = (data.get("world") or {}).get("timeline") or {}
            location = str(player.get("current_location") or "").strip()
            if not location:
                location = str(scene.get("location_id") or "").strip()
            scene_id = str(scene.get("location_id") or scene.get("module_id") or "").strip()
            phase = str(timeline.get("current_phase") or "").strip()
            return {
                "location": location or None,
                "scene_id": scene_id or None,
                "phase_label": phase or None,
            }
        except Exception:
            return {"location": None, "scene_id": None, "phase_label": None}

    def _log_fact_supersede(self, old_text: str, new_text: str, *, source: str,
                            auto: bool, score: float | None = None) -> None:
        """事实取代进 audit_log（自动/显式共用，便于面板与排障）。"""
        try:
            audit = self.data.setdefault("permissions", {}).setdefault("audit_log", [])
            audit.append({
                "ts": now_iso(),
                "kind": "memory_superseded_auto" if auto else "memory_superseded",
                "source": str(source or "gm"),
                "path": "memory.facts",
                "old": str(old_text)[:160],
                "new": str(new_text)[:160],
                "score": round(float(score), 3) if score is not None else None,
                "turn": int(self.data.get("turn") or 0),
            })
            if len(audit) > 200:
                self.data["permissions"]["audit_log"] = audit[-200:]
        except Exception:
            pass

    def _auto_supersede_fact(self, text: str, characters: list[str], origin: str) -> str:
        """GM/史官写入新事实时，保守地把同实体的高度重叠旧事实标 superseded。

        只在以下条件全部成立时动手（本次记忆修复，宁漏勿误）：
          · 来源是 GM/史官（玩家手写 facts 不自动取代）
          · 新旧事实共享至少一个 characters（没有实体标注就不判断）
          · 文本包含关系，或 2-gram Jaccard ≥0.68
        返回被取代的旧文本（没有则空串）。旧 item 保留为 superseded 供审计，
        旧文本从 legacy facts 桶移除，不再注入/召回。
        """
        try:
            from state.memory_budget import is_gated_origin
            if not is_gated_origin(origin):
                return ""
            chars = {str(c) for c in (characters or []) if str(c).strip()}
            if not chars:
                return ""
            items = (self.data.get("memory") or {}).get("items") or []
            best: dict | None = None
            best_score = 0.0
            # 本次记忆修复：扫描全部 items，而不是只看最近 120 条。长局里旧矛盾
            # 事实可能已经被后续大量无关 item 挤出窗口，只看 120 条会漏取代。
            # items 本身有 500 软上限，O(n) 对每回合几十条事实写入可接受。
            for it in reversed(items):
                if not isinstance(it, dict):
                    continue
                if it.get("legacy_bucket") != "facts":
                    continue
                if (it.get("status") or "active") != "active" or it.get("archived"):
                    continue
                old_text = str(it.get("text") or "").strip()
                if not old_text or old_text == text:
                    continue
                old_chars = {str(c) for c in (it.get("characters") or [])}
                if not (chars & old_chars):
                    continue
                score = fact_text_similarity(text, old_text)
                if score > best_score:
                    best, best_score = it, score
            if best is None or best_score < _SUPERSEDE_JACCARD:
                return ""
            old_text = str(best.get("text") or "").strip()
            best["status"] = "superseded"
            best["superseded_at_turn"] = int(self.data.get("turn") or 0)
            best["superseded_by"] = text
            facts = self.data.setdefault("memory", {}).setdefault("facts", [])
            if isinstance(facts, list):
                self.data["memory"]["facts"] = [t for t in facts if t != old_text]
            self._log_fact_supersede(old_text, text, source=origin, auto=True, score=best_score)
            self._bump_memory_stat("superseded_total")
            return old_text
        except Exception:
            return ""

    def _find_active_fact_item(self, item_id: str | None = None,
                               old_text: str | None = None) -> dict | None:
        """找一条可被 supersede 的 active fact item（本次记忆修复）。

        优先 id；其次 old_text 精确匹配；最后做归一化（去空白/标点）唯一匹配 ——
        GM 从 prompt 复制旧事实时常带标点差异，精确匹配会失败。归一化匹配只在
        唯一命中时返回，避免把两条相似事实里的另一条误标 superseded。
        """
        items = (self.data.get("memory") or {}).get("items") or []
        if item_id:
            target = next(
                (i for i in items if isinstance(i, dict) and i.get("id") == item_id),
                None,
            )
            if target is not None:
                if target.get("legacy_bucket") not in (None, "facts"):
                    return None
                return target
        if not old_text:
            return None
        want = str(old_text).strip()
        active = [
            i for i in items
            if isinstance(i, dict)
            and i.get("legacy_bucket") in (None, "facts")
            and (i.get("status") or "active") == "active"
            and not i.get("archived")
        ]
        exact = [i for i in active if str(i.get("text") or "").strip() == want]
        if exact:
            return exact[0]
        want_norm = normalize_fact_text(want)
        if not want_norm:
            return None
        normalized = [
            i for i in active if normalize_fact_text(str(i.get("text") or "")) == want_norm
        ]
        return normalized[0] if len(normalized) == 1 else None

    def supersede_memory_item(self, *, item_id: str | None = None,
                              old_text: str | None = None,
                              new_text: str | None = None,
                              source: str = "gm") -> bool:
        """显式取代一条 facts 记忆（本次记忆修复）。

        优先按 item id 找；否则按 old_text 精确/归一化匹配 active facts item。旧 item
        标 superseded（保留历史/审计），旧文本从 facts 桶移除。new_text 非空且尚不存在
        时顺手写入新事实（避免调用方还要再写一条 append op）。

        本次加固：
          · id 找不到时继续用 old_text 兜底（GM/史官可能只给其中一个）；
          · old_text 标点/空白差异走归一化唯一匹配；
          · 写入 new_text 时 skip_auto_supersede=True，避免显式取代又连锁触发
            第二条自动取代（一条 op 只应该影响它点名的那条旧事实）。
        """
        try:
            mem = self.data.setdefault("memory", {})
            target = self._find_active_fact_item(item_id=item_id, old_text=old_text)
            if target is not None:
                old_text = str(target.get("text") or "").strip()
                target["status"] = "superseded"
                target["superseded_at_turn"] = int(self.data.get("turn") or 0)
                target["superseded_by"] = str(new_text or "").strip()
                target["supersede_reason"] = "explicit"
            removed = False
            if old_text:
                facts = mem.setdefault("facts", [])
                if isinstance(facts, list) and old_text in facts:
                    mem["facts"] = [t for t in facts if t != old_text]
                    removed = True
            if target is None and not removed:
                return False
            self._log_fact_supersede(old_text or "", new_text or "",
                                     source=source, auto=False)
            self._bump_memory_stat("superseded_total")
            if new_text:
                self.add_memory("facts", new_text, origin=source,
                                skip_auto_supersede=True)
            self._touch_memory()
            return True
        except Exception:
            return False

    def find_restore_conflicts(self, target_text: str, *,
                               target_chars: list[str] | None = None,
                               superseded_by: str | None = None,
                               limit: int = 5) -> list[dict]:
        """恢复历史事实前，找出会被它顶掉的当前 active 事实（本次记忆修复）。

        两种冲突来源：
          · 直接取代链：旧 item 的 `superseded_by` 指向的新版本仍 active；
          · 同实体且文本高度相似（characters 有交集 + similarity ≥0.68）。
        只做检测，不改 state；返回 [{id,text,turn,reason}]，直接取代版本排最前。
        """
        target_text = _clean_item(str(target_text or ""))
        if not target_text:
            return []
        chars = {str(c) for c in (target_chars or []) if str(c).strip()}
        if not chars:
            chars = set(self._memory_characters_for(target_text))
        direct_text = _clean_item(str(superseded_by or ""))
        out: list[dict] = []
        for it in (self.data.get("memory") or {}).get("items") or []:
            if not isinstance(it, dict):
                continue
            if it.get("legacy_bucket") not in (None, "facts"):
                continue
            # hypothesis/canon_fact/user_constraint 不走这条“事实恢复冲突”逻辑，
            # 避免恢复事实时把一条推测或硬约束标成 superseded。
            if it.get("kind") != "runtime_fact":
                continue
            if (it.get("status") or "active") != "active" or it.get("archived"):
                continue
            text = _clean_item(str(it.get("text") or ""))
            if not text or text == target_text:
                continue
            reason = ""
            if direct_text and text == direct_text:
                reason = "direct_replacement"
            else:
                it_chars = {str(c) for c in (it.get("characters") or [])}
                if chars and (chars & it_chars) and fact_text_similarity(target_text, text) >= _SUPERSEDE_JACCARD:
                    reason = "similar"
            if not reason:
                continue
            out.append({
                "id": it.get("id"),
                "text": text,
                "turn": it.get("turn"),
                "reason": reason,
            })
        out.sort(key=lambda x: (0 if x.get("reason") == "direct_replacement" else 1,
                                -int(x.get("turn") or 0)))
        return out[:max(1, int(limit))]

    def restore_memory_item_ex(self, *, item_id: str | None = None,
                               bucket: str | None = None,
                               text: str | None = None,
                               source: str = "ui_restore",
                               supersede_conflicts: bool = False) -> tuple[bool, dict]:
        """恢复历史事实的增强版：返回 (是否完成, 结果/待确认信息)。

        与旧 `restore_memory_item` 的差别（本次记忆修复）：如果恢复后会和当前
        active 事实矛盾（直接取代版本或同实体高相似），先返回 needs_confirmation，
        UI 确认后再以 supersede_conflicts=True 调一次，把冲突版本标 superseded，
        避免“恢复旧版 → 两个矛盾版本同时 active”。
        """
        try:
            mem = self.data.setdefault("memory", {})
            items = mem.get("items")
            if not isinstance(items, list):
                items = []
                mem["items"] = items
            buckets = {"facts", "notes", "pinned", "abilities", "resources"}
            target = None
            if item_id:
                target = next(
                    (i for i in items if isinstance(i, dict) and i.get("id") == item_id),
                    None,
                )
            elif bucket and text:
                target = next((
                    i for i in items
                    if isinstance(i, dict)
                    and i.get("legacy_bucket") == bucket
                    and _clean_item(str(i.get("text", ""))) == _clean_item(str(text))
                ), None)

            target_text = ""
            b = ""
            if target is not None:
                b = str(target.get("legacy_bucket") or "")
                if b not in buckets or target.get("kind") != "runtime_fact":
                    return False, {"error": "该条目不是可恢复的事实类记忆"}
                target_text = _clean_item(str(target.get("text") or ""))
            else:
                b = str(bucket or "").strip()
                target_text = _clean_item(str(text or ""))
                if b not in buckets or not target_text:
                    return False, {"error": "未找到可恢复的记忆"}

            conflicts = (
                self.find_restore_conflicts(
                    target_text,
                    target_chars=(target.get("characters") if target is not None else None),
                    superseded_by=(target.get("superseded_by") if target is not None else None),
                ) if b == "facts" else []
            )
            if conflicts and not supersede_conflicts:
                return False, {
                    "needs_confirmation": True,
                    "target": target_text,
                    "conflicts": conflicts,
                }

            superseded_conflicts = 0
            if conflicts:
                facts = mem.setdefault("facts", [])
                conflict_texts = {_clean_item(str(c.get("text") or "")) for c in conflicts}
                turn = int(self.data.get("turn", 0) or 0)
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    if _clean_item(str(it.get("text") or "")) not in conflict_texts:
                        continue
                    if (it.get("status") or "active") != "active" or it.get("archived"):
                        continue
                    it["status"] = "superseded"
                    it["superseded_at_turn"] = turn
                    it["superseded_by"] = target_text
                    it["supersede_reason"] = "restore_conflict"
                    it["supersede_source"] = str(source or "ui_restore")
                    superseded_conflicts += 1
                if isinstance(facts, list):
                    mem["facts"] = [t for t in facts if _clean_item(str(t)) not in conflict_texts]

            if target is not None:
                target["status"] = "active"
                target["archived"] = False
                target["turn"] = int(self.data.get("turn", 0) or 0)
                target["source"] = str(source or "ui_restore")
                target.pop("superseded_at_turn", None)
                target.pop("superseded_by", None)
                target.pop("supersede_reason", None)
                target.pop("supersede_source", None)
                target.pop("orphaned_at_turn", None)
                target.pop("orphan_reason", None)
                bucket_list = mem.setdefault(b, [])
                if isinstance(bucket_list, list) and target_text and target_text not in bucket_list:
                    bucket_list.append(target_text)
            else:
                bucket_list = mem.setdefault(b, [])
                if not isinstance(bucket_list, list):
                    bucket_list = []
                    mem[b] = bucket_list
                if target_text not in bucket_list:
                    bucket_list.append(target_text)
                self.add_memory_item(
                    text=target_text,
                    kind="runtime_fact",
                    source=str(source or "ui_restore"),
                    characters=self._memory_characters_for(target_text) or None,
                    legacy_bucket=b,
                )
            if b == "facts" and target_text:
                arch = mem.get("archived_facts")
                if isinstance(arch, list):
                    mem["archived_facts"] = [t for t in arch if _clean_item(str(t)) != target_text]
                deleted = mem.get("facts_deleted")
                if isinstance(deleted, list):
                    mem["facts_deleted"] = [t for t in deleted if _clean_item(str(t)) != target_text]
                hashes = mem.get("facts_deleted_hashes")
                if isinstance(hashes, list) and hashes:
                    h = hashlib.sha1(target_text.encode("utf-8")).hexdigest()[:16]
                    mem["facts_deleted_hashes"] = [x for x in hashes if x != h]
            if superseded_conflicts:
                try:
                    audit = self.data.setdefault("permissions", {}).setdefault("audit_log", [])
                    audit.append({
                        "ts": now_iso(),
                        "kind": "memory_restore_superseded_conflicts",
                        "source": str(source or "ui_restore"),
                        "restored": target_text,
                        "superseded": superseded_conflicts,
                        "turn": int(self.data.get("turn", 0) or 0),
                    })
                    if len(audit) > 200:
                        self.data["permissions"]["audit_log"] = audit[-200:]
                except Exception:
                    pass
            self._touch_memory()
            return True, {
                "restored": target_text,
                "superseded_conflicts": superseded_conflicts,
            }
        except Exception as exc:  # noqa: BLE001 —— 回给 UI，不破回合
            return False, {"error": str(exc)}

    def restore_memory_item(self, *, item_id: str | None = None,
                            bucket: str | None = None,
                            text: str | None = None,
                            source: str = "ui_restore") -> bool:
        """兼容旧调用方：不处理冲突确认，只返回是否恢复成功。

        UI/API 应优先用 restore_memory_item_ex，以便在冲突时二次确认。
        """
        ok, _ = self.restore_memory_item_ex(
            item_id=item_id, bucket=bucket, text=text, source=source)
        return ok

    def add_memory(self, bucket: str, text: str, *, origin: str = "",
                   skip_auto_supersede: bool = False) -> bool:
        """兼容门面:只回「写没写进去」。要区分「重复」和「被闸拦」用 add_memory_ex。"""
        return self.add_memory_ex(
            bucket, text, origin=origin,
            skip_auto_supersede=skip_auto_supersede,
        )[0]

    def add_memory_ex(self, bucket: str, text: str, *, origin: str = "",
                      skip_auto_supersede: bool = False) -> tuple[bool, str]:
        """返回 (是否写入, 原因)。原因为空=写入成功;否则是给调用方/GM 看的拒绝理由。

        origin 走 dispatcher 恒等注入的 `_origin`(用户意图分流的既有约定):玩家自己的
        写入不受洪泛闸,GM/史官的受。
        """
        text = _clean_item(text)
        if not text:
            return False, "文本为空"
        # acceptance 验收元信息不进任何玩家记忆桶。此处是**单点根闸**:dispatcher 的
        # add_memory_fact/pin_memory 等 5 工具、apply_ops 的关系标签回退分支、以及一切
        # 未来调用方都经这里;apply_ops 列表闸/known_event 工具闸是各自入口的前置纵深。
        from state.json_ops import is_acceptance_meta
        if is_acceptance_meta(text):
            return False, "验收元信息不进玩家记忆桶"
        bucket = bucket if bucket in {"resources", "abilities", "facts", "pinned", "notes"} else "notes"
        items = self.data["memory"].setdefault(bucket, [])
        # 精确去重排在洪泛闸**前面**:重复写入本来就什么都不改,拿「超额」当理由回它会
        # 误导 GM(它会以为自己在刷屏,其实只是重写了一条已有的)。
        if text in items:
            return False, "已含此条(去重)"
        # 洪泛闸(群反馈:一门功法逐窍拆写刷了二十多条能力)。放在这里是因为这里是所有
        # 写入路径的共同终点;拒绝会原样退回给 GM,绝不静默丢玩家可见资产。
        from state.memory_budget import check_append
        blocked = check_append(self.data, bucket, text, origin)
        if blocked:
            self._log_memory_flood_block(bucket, text, blocked, origin)
            return False, blocked
        # 本次记忆修复:写入时顺手做确定性实体/时间标注（不调 LLM）。characters 让
        # query_memory 的实体过滤和「按实体召回」可用；time_label 记录写入时的世界
        # 时间，方便后续按时间窗口召回。识别不出实体时留空，不影响原文本注入。
        _chars = self._memory_characters_for(text)
        _time_label = str((self.data.get("world") or {}).get("time") or "").strip() or None
        _ctx = self._memory_context_meta()
        # 重新添加一条曾删除的事实：清掉删除 tombstone，否则它虽然回到 facts 桶，
        # 冷归档查询仍会因 tombstone 被永久排除。
        if bucket == "facts":
            _deleted = self.data.setdefault("memory", {}).get("facts_deleted")
            if isinstance(_deleted, list) and text in _deleted:
                self.data["memory"]["facts_deleted"] = [t for t in _deleted if t != text]
            _hashes = self.data["memory"].get("facts_deleted_hashes")
            if isinstance(_hashes, list) and _hashes:
                _h = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
                if _h in _hashes:
                    self.data["memory"]["facts_deleted_hashes"] = [
                        h for h in _hashes if h != _h
                    ]
        # 保守自动 supersede 只对 GM/史官写入的 facts 生效（玩家手写 facts 不自动取代）。
        # 它可能重建 memory.facts 列表，所以必须在 append 前调用并重新取一次桶引用。
        # skip_auto_supersede：显式 supersede 的 new_text 已经由那条 op 表达过意图，
        # 不能再让它连锁取代另一条相似事实。
        if bucket == "facts" and not skip_auto_supersede:
            self._auto_supersede_fact(text, _chars, origin)
            items = self.data["memory"].setdefault(bucket, [])
        items.append(text)
        # task 74：dual-write 到结构化 memory.items（旧调用方完全无感知）
        # bucket → kind 映射：当前所有旧 bucket 都标 runtime_fact（本局事实）。
        # 后续 task 76/77/78 会按更细粒度区分 canon_fact / hypothesis 等。
        self.add_memory_item(
            text=text,
            kind="runtime_fact",
            source="legacy_add_memory",
            legacy_bucket=bucket,
            characters=_chars or None,
            time_label=_time_label,
            location=_ctx.get("location"),
            scene_id=_ctx.get("scene_id"),
            phase_label=_ctx.get("phase_label"),
        )
        return True, ""

    def _log_memory_flood_block(self, bucket: str, text: str, reason: str, origin: str) -> None:
        """洪泛闸拦下的写入进 audit_log —— 与 parse_error / hard_forbidden 同一条落法,
        context_engine.write_results 下轮会把它讲给 GM 听,让它自己合并而不是反复重试。"""
        try:
            audit = self.data.setdefault("permissions", {}).setdefault("audit_log", [])
            audit.append({
                "ts": now_iso(),
                "kind": "memory_flood_blocked",
                "source": origin or "gm",
                "path": f"memory.{bucket}",
                "value": str(text)[:120],
                "hint": reason,
                "turn": int(self.data.get("turn") or 0),
            })
            if len(audit) > 200:
                self.data["permissions"]["audit_log"] = audit[-200:]
        except Exception:
            pass

    # task 74：结构化记忆写入入口。callers (extractor / curator / GM JSON op /
    # 玩家手动 add) 可以直接用这个，带上 kind + source + meta，避免被 bucket
    # 字符串语义局限。返回新建条目的 id（用于后续引用/supersede）。
    def add_memory_item(
        self,
        text: str,
        *,
        kind: str = "runtime_fact",
        source: str = "gm",
        time_label: str | None = None,
        characters: list[str] | None = None,
        location: str | None = None,
        scene_id: str | None = None,
        phase_label: str | None = None,
        status: str = "active",
        supersedes: list[str] | None = None,
        legacy_bucket: str | None = None,
    ) -> str:
        text = _clean_item(text)
        if not text:
            return ""
        # 已知 kind 白名单（task 74 起步只支持 4 种核心，task 76 可扩展）
        valid_kinds = {"canon_fact", "runtime_fact", "hypothesis", "user_constraint"}
        if kind not in valid_kinds:
            kind = "runtime_fact"
        import secrets as _secrets
        item = {
            "id": f"mem_{_secrets.token_urlsafe(6)}",
            "kind": kind,
            "text": text,
            "source": source,
            "turn": int(self.data.get("turn", 0)),
            "ts": now_iso(),
            "status": status,
        }
        if time_label:
            item["time_label"] = time_label
        if characters:
            item["characters"] = list(characters)
        # 本次记忆修复：写入时记录地点/场景/篇章，供 MemoryAssembler 做场景召回。
        # 旧数据没有这些字段，召回仍按文本 gram/实体兜底，不影响兼容。
        if location:
            item["location"] = str(location).strip()
        if scene_id:
            item["scene_id"] = str(scene_id).strip()
        if phase_label:
            item["phase_label"] = str(phase_label).strip()
        if supersedes:
            item["supersedes"] = list(supersedes)
        if legacy_bucket:
            item["legacy_bucket"] = legacy_bucket
        items = self.data.setdefault("memory", {}).setdefault("items", [])
        items.append(item)
        self._prune_memory_items(items)
        self._touch_memory()
        return item["id"]  # type: ignore[return-value]

    def _touch_memory(self) -> None:
        """记忆版本号 +1（本次记忆修复）：用于 active recall 索引缓存失效。

        任何会改变 items 的 active/archived/status/text/characters/location 的写路径
        都必须调用；漏调最坏结果是索引候选偏旧，MemoryAssembler 仍会复核状态。
        """
        try:
            mem = self.data.setdefault("memory", {})
            mem["_rev"] = int(mem.get("_rev", 0) or 0) + 1
        except Exception:
            pass

    def _bump_memory_stat(self, key: str, n: int = 1) -> None:
        """记忆生命周期计数 +n（本次记忆修复，仅观测，不参与逻辑）。"""
        try:
            stats = self.data.setdefault("memory", {}).setdefault("stats", {})
            stats[key] = int(stats.get(key, 0) or 0) + int(n)
        except Exception:
            pass

    @staticmethod
    def _prune_memory_items(items: list) -> None:
        """items 软上限：只裁非 active 历史，绝不因为数量上限丢掉当前生效的记忆。

        旧实现 `items[-500:]` 不看 status/archived，直接砍最旧。长局中最早被砍的
        往往是 notes/abilities 的 active item，但 legacy 桶仍保留文本 → MemoryProvider
        还能注入，query_memory/归档扫描却看不到，形成静默漂移。这里：
          · active 且未归档的条目全部保留（它们是当前事实/手写记忆/持久状态）；
          · 剩余名额按“从新到旧”保留 archived/superseded/rejected 历史；
          · active 本身超过上限时不强裁，宁可 state 大一点，也不丢正确性。
        """
        if not isinstance(items, list) or len(items) <= MEMORY_ITEMS_MAX:
            return
        active_flags = [
            isinstance(it, dict)
            and (it.get("status") or "active") == "active"
            and not it.get("archived")
            for it in items
        ]
        active_count = sum(1 for f in active_flags if f)
        history_slots = max(0, MEMORY_ITEMS_MAX - active_count)
        keep: set[int] = set()
        # active 全部保留；非 active 从尾部（较新）往前保留 history_slots 条。
        for i, is_active in enumerate(active_flags):
            if is_active:
                keep.add(i)
        for i in range(len(items) - 1, -1, -1):
            if history_slots <= 0:
                break
            if not active_flags[i]:
                keep.add(i)
                history_slots -= 1
        items[:] = [it for i, it in enumerate(items) if i in keep]

    def reconcile_memory_items(self) -> dict[str, int]:
        """对账 legacy 记忆桶与结构化 memory.items（本次记忆修复）。

        背景：历史上有三条路径会造成漂移：
          1. 旧 `set/overwrite memory.<bucket>` 直接 `_set_path`，items 没同步；
          2. task 74 之前写入的桶条目没有 item；
          3. 旧 items 上限直接砍最旧，可能砍掉仍 active 的 item。
        漂移后果：legacy 桶里有、items 里没有 → 查询召回/归档扫描看不到；
        items 里有、legacy 桶里没有 → 已被覆盖/删除的事实还能被召回（僵尸记忆）。

        对账策略（用户拍板：legacy 桶是“当前生效集合”的权威）：
          · legacy 文本缺少 active item → 补建 item（turn=0 / source=reconcile_v1，
            不伪造时间，避免被自动归档立刻清走）；
          · active item 的文本已不在 legacy 桶 → 标 `orphaned`（保留历史，不硬删），
            让它立即退出召回/归档/query_memory；
          · 顺带清洗 legacy 桶的空值、验收元信息和重复文本。
        幂等；返回计数供 maintenance/日志观测。
        """
        out = {"backfilled": 0, "orphaned": 0, "deduped": 0}
        changed = False
        try:
            from state.json_ops import is_acceptance_meta

            mem = self.data.setdefault("memory", {})
            items = mem.get("items")
            if not isinstance(items, list):
                items = []
                mem["items"] = items
            buckets = ("facts", "notes", "pinned", "abilities", "resources")
            turn = int(self.data.get("turn", 0) or 0)
            _save_id = self.data.get("_active_save_id")

            # 1) 清洗 legacy 桶：去空/验收元信息/重复，保持原顺序。
            cleaned_buckets: dict[str, list[str]] = {}
            for bucket in buckets:
                raw_list = mem.get(bucket)
                if not isinstance(raw_list, list):
                    continue
                cleaned: list[str] = []
                seen: set[str] = set()
                for raw in raw_list:
                    text = _clean_item(raw if isinstance(raw, str) else str(raw))
                    if not text or is_acceptance_meta(text) or text in seen:
                        out["deduped"] += 1
                        continue
                    seen.add(text)
                    cleaned.append(text)
                cleaned_buckets[bucket] = cleaned
                if cleaned != raw_list:
                    mem[bucket] = cleaned
                    changed = True

            # 2) active item 按 bucket+text 建索引。
            active_keys: set[tuple[str, str]] = set()
            duplicate_items: list[dict] = []
            for it in items:
                if not isinstance(it, dict):
                    continue
                if (it.get("status") or "active") != "active" or it.get("archived"):
                    continue
                # 本次记忆修复：给旧 item 回填 characters / 做别名归一，但按 20 回合
                # 节流。旧实现每回合对每个缺 characters 的 item 重扫，关系名没变时
                # 结果完全相同；长局里这是固定浪费。
                _last_scan = int(it.get("characters_scanned_turn") or -1)
                if _last_scan < 0 or turn - _last_scan >= CHARACTER_RESCAN_TURNS:
                    _existing = [str(c) for c in (it.get("characters") or []) if str(c).strip()]
                    _chars = _existing or self._memory_characters_for(str(it.get("text") or ""))
                    if _chars and _save_id:
                        try:
                            from kb.alias import canonical_name_for_save
                            _canon: list[str] = []
                            for c in _chars:
                                cc = canonical_name_for_save(_save_id, c) or c
                                if cc not in _canon:
                                    _canon.append(cc)
                            _chars = _canon
                        except Exception:
                            pass
                    if _chars and it.get("characters") != _chars:
                        it["characters"] = _chars
                        changed = True
                    it["characters_scanned_turn"] = turn
                b = str(it.get("legacy_bucket") or "")
                t = _clean_item(str(it.get("text", "")))
                if b in buckets and t:
                    key = (b, t)
                    if key in active_keys:
                        # legacy 桶对文本去重，同一 (bucket,text) 最多应有一个 active item。
                        # 历史漂移留下的重复 active item 会让“active 数量 != 桶长度”，
                        # 也会让 query_memory/召回重复；保留第一条，其余标 orphaned。
                        duplicate_items.append(it)
                        changed = True
                    else:
                        active_keys.add(key)
            for it in duplicate_items:
                it["status"] = "orphaned"
                it["orphaned_at_turn"] = turn
                it["orphan_reason"] = "duplicate_active_item"
                out["orphaned"] += 1

            # 3) legacy 有、items 没有 → 补建 item（不进入自动 supersede/洪泛闸，
            #    这是历史修复而非新写入，直接 add_memory_item）。
            for bucket, texts in cleaned_buckets.items():
                for text in texts:
                    if (bucket, text) in active_keys:
                        continue
                    self.add_memory_item(
                        text=text,
                        kind="runtime_fact",
                        source="reconcile_v1",
                        time_label=None,  # 旧数据没有可信时间，不伪造
                        characters=self._memory_characters_for(text) or None,
                        legacy_bucket=bucket,
                    )
                    active_keys.add((bucket, text))
                    out["backfilled"] += 1
                    changed = True
                    # 旧归档索引里如果还留着同文，必须去掉：否则 KB 会同时写
                    # fact 和 afact，episodic 召回可能把同一条事实返回两次。
                    if bucket == "facts":
                        arch = mem.get("archived_facts")
                        if isinstance(arch, list):
                            mem["archived_facts"] = [
                                t for t in arch if _clean_item(str(t)) != text
                            ]
                        deleted = mem.get("facts_deleted")
                        if isinstance(deleted, list):
                            mem["facts_deleted"] = [
                                t for t in deleted if _clean_item(str(t)) != text
                            ]
                        hashes = mem.get("facts_deleted_hashes")
                        if isinstance(hashes, list) and hashes:
                            h = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]
                            mem["facts_deleted_hashes"] = [
                                x for x in hashes if x != h
                            ]

            # 4) items 有、legacy 没有 → orphaned（保留历史，立即退出召回）。
            legacy_texts = {b: set(t) for b, t in cleaned_buckets.items()}
            for it in items:
                if not isinstance(it, dict):
                    continue
                if (it.get("status") or "active") != "active" or it.get("archived"):
                    continue
                b = str(it.get("legacy_bucket") or "")
                if b not in buckets:
                    continue
                t = _clean_item(str(it.get("text", "")))
                if t and t not in legacy_texts.get(b, set()):
                    it["status"] = "orphaned"
                    it["orphaned_at_turn"] = turn
                    it["orphan_reason"] = "legacy_bucket_missing"
                    out["orphaned"] += 1
                    changed = True
        except Exception:
            return out
        if changed:
            self._touch_memory()
        return out

    def remove_memory(self, bucket: str, index: int):
        items = self.data["memory"].get(bucket, [])
        if not (0 <= index < len(items)):
            return
        raw = items[index]
        removed_text = _clean_item(raw if isinstance(raw, str) else str(raw))
        items.pop(index)
        # 假删除根因修复：add_memory 对 legacy bucket 做了 dual-write 到结构化
        # memory.items（legacy_bucket=bucket），而 context_engine 注入 GM 上下文
        # 只读 memory.items（layers._fact_groups_layer，且只取 status==active）。
        # 若删除仅 pop legacy bucket、不清 items，被删条目仍以 status=active 留在
        # items → 下回合注入 GM 上下文 → GM 复述 → 经 apply_ops 又写回 bucket，
        # 表现为「玩家删了笔记、点推进剧情又自动加回来」（且依赖 GM 是否复述而时
        # 有时无）。
        #
        # 本次记忆修复：删除改为「按剩余出现次数」对齐 items。旧实现只删首个匹配
        # item，遇到 legacy 桶重复文本或历史漂移（items 里同文 active 条目多于桶内
        # 出现次数）时会留下仍 active 的 item，查询召回/归档还能把它捡回来。
        if not removed_text:
            return
        structured = self.data.get("memory", {}).get("items")
        if not isinstance(structured, list):
            return
        matched = [
            i for i, it in enumerate(structured)
            if isinstance(it, dict)
            and it.get("legacy_bucket") == bucket
            and (it.get("status") or "active") == "active"
            and _clean_item(str(it.get("text", ""))) == removed_text
        ]
        # 桶里还剩 N 条同文，就保留 N 个 active item；多出来的都是漂移/重复，删掉。
        remaining = sum(1 for t in items if _clean_item(str(t)) == removed_text)
        # 本次记忆修复：如果这条事实被彻底删除，记 tombstone，KB 冷归档/查询
        # 不应再把它召回。只记文本，不保留 item 元数据。
        if bucket == "facts" and remaining == 0 and removed_text:
            mem = self.data.setdefault("memory", {})
            deleted = mem.setdefault("facts_deleted", [])
            if isinstance(deleted, list) and removed_text not in deleted:
                deleted.append(removed_text)
                if len(deleted) > 1000:
                    del deleted[:-1000]
            hashes = mem.setdefault("facts_deleted_hashes", [])
            if isinstance(hashes, list):
                h = hashlib.sha1(removed_text.encode("utf-8")).hexdigest()[:16]
                if h not in hashes:
                    hashes.append(h)
                    # hash 很小，保留更多，覆盖文本 tombstone 被裁后的远期删除。
                    if len(hashes) > 5000:
                        del hashes[:-5000]
        to_remove = max(0, len(matched) - remaining)
        while to_remove > 0 and matched:
            structured.pop(matched[0])
            to_remove -= 1
            # pop 后下标会前移：重新计算剩余匹配，避免跳项/越界。
            matched = [
                j for j, it in enumerate(structured)
                if isinstance(it, dict)
                and it.get("legacy_bucket") == bucket
                and (it.get("status") or "active") == "active"
                and _clean_item(str(it.get("text", ""))) == removed_text
            ]
        self._touch_memory()

    def replace_memory_bucket(self, bucket: str, values, *, source: str = "gm:json") -> tuple[bool, str]:
        """完整重写一个记忆桶，并同步结构化 items（本次记忆修复）。

        背景：`set/overwrite memory.facts` 之前直接 `_set_path` 替换 legacy 列表，
        完全绕过 add_memory 的 dual-write。被移出列表的旧条目仍以 active 留在
        memory.items 里 → 查询召回、归档扫描、query_memory 还能把它们捡回来，
        形成「已经删掉/覆盖掉的事实又出现在上下文」的僵尸记忆。

        语义（用户拍板）：被移除的旧条目**保留历史但标记 superseded**，不硬删；
        新列表里的文本若没有对应 active item，则补建 item。这样 legacy 桶与 items
        在“当前生效集合”上严格一致，同时保留可追溯的旧版本。

        返回 (是否成功, 给调用方/GM 看的说明)。任何异常都返回失败，不半写。
        """
        try:
            bucket = str(bucket or "").strip()
            if bucket not in {"resources", "abilities", "facts", "pinned", "notes"}:
                return False, f"不支持的记忆桶：{bucket}"
            from state.json_ops import is_acceptance_meta

            # 1) 清洗新列表：去空、去验收元信息、保序去重。与 add_memory 的入口闸同口径。
            cleaned: list[str] = []
            seen: set[str] = set()
            for raw in (values if isinstance(values, (list, tuple)) else []):
                text = _clean_item(raw if isinstance(raw, str) else str(raw))
                if not text or is_acceptance_meta(text) or text in seen:
                    continue
                seen.add(text)
                cleaned.append(text)

            mem = self.data.setdefault("memory", {})
            # 新列表里重新出现的事实不再算“已删除”，清掉 tombstone。
            if bucket == "facts":
                _deleted = mem.get("facts_deleted")
                if isinstance(_deleted, list):
                    mem["facts_deleted"] = [t for t in _deleted if _clean_item(str(t)) not in seen]
                _hashes = mem.get("facts_deleted_hashes")
                if isinstance(_hashes, list) and _hashes:
                    _cleared = {
                        hashlib.sha1(t.encode("utf-8")).hexdigest()[:16] for t in cleaned
                    }
                    mem["facts_deleted_hashes"] = [h for h in _hashes if h not in _cleared]
            structured = mem.get("items")
            if not isinstance(structured, list):
                structured = []
                mem["items"] = structured

            # 2) 收集该桶当前 active item（按文本索引；同文可能有多条，一起处理）。
            active_by_text: dict[str, list[dict]] = {}
            for it in structured:
                if not isinstance(it, dict):
                    continue
                if it.get("legacy_bucket") != bucket:
                    continue
                if (it.get("status") or "active") != "active" or it.get("archived"):
                    continue
                active_by_text.setdefault(_clean_item(str(it.get("text", ""))), []).append(it)

            turn = int(self.data.get("turn", 0) or 0)

            # 3) 新列表里没有的 active item → 标记 superseded。按 active item 而不是
            #    仅按 old_list 判断：如果历史漂移导致 item 在、legacy 桶不在，它们同样
            #    不能继续 active（否则 set 之后仍会被查询召回）。旧列表文本差集只用于
            #    兼容“只有 legacy、没有 item”的旧档，下面统一由 item 索引兜底。
            removed_items = 0
            for text, its in active_by_text.items():
                if text in seen:
                    continue
                for it in its:
                    it["status"] = "superseded"
                    it["superseded_at_turn"] = turn
                    it["superseded_by"] = ""
                    it["supersede_reason"] = "bucket_replace"
                    it["supersede_source"] = str(source or "gm:json")
                    removed_items += 1

            # 4) 新列表里没有 active item 的文本 → 补建 item（archived 同文则直接复活，
            #    superseded 同文则新建，保留旧版本的 supersede 链）。
            created = 0
            _ctx = self._memory_context_meta()
            for text in cleaned:
                if active_by_text.get(text):
                    continue
                revived = next((
                    it for it in structured
                    if isinstance(it, dict)
                    and it.get("legacy_bucket") == bucket
                    and _clean_item(str(it.get("text", ""))) == text
                    and it.get("archived")
                ), None)
                if revived is not None:
                    revived["archived"] = False
                    revived["status"] = "active"
                    revived["turn"] = turn
                    revived["source"] = str(source or "gm:json")
                    # 复活时补上当前场景元数据（旧归档 item 可能没有）。
                    for key in ("location", "scene_id", "phase_label"):
                        if not revived.get(key) and _ctx.get(key):
                            revived[key] = _ctx[key]
                    created += 1
                    if bucket == "facts":
                        _arch = mem.get("archived_facts")
                        if isinstance(_arch, list):
                            mem["archived_facts"] = [t for t in _arch if _clean_item(str(t)) != text]
                    continue
                self.add_memory_item(
                    text=text,
                    kind="runtime_fact",
                    source=str(source or "gm:json"),
                    time_label=str((self.data.get("world") or {}).get("time") or "").strip() or None,
                    characters=self._memory_characters_for(text) or None,
                    location=_ctx.get("location"),
                    scene_id=_ctx.get("scene_id"),
                    phase_label=_ctx.get("phase_label"),
                    legacy_bucket=bucket,
                )
                created += 1

            # 5) 最后才替换 legacy 列表：即使上面某一步异常，也不会出现“桶已改、items 没改”。
            mem[bucket] = cleaned

            if removed_items or created:
                try:
                    audit = self.data.setdefault("permissions", {}).setdefault("audit_log", [])
                    audit.append({
                        "ts": now_iso(),
                        "kind": "memory_bucket_replaced",
                        "source": str(source or "gm:json"),
                        "path": f"memory.{bucket}",
                        "kept": len(cleaned),
                        "removed": removed_items,
                        "created": created,
                        "turn": turn,
                    })
                    if len(audit) > 200:
                        self.data["permissions"]["audit_log"] = audit[-200:]
                except Exception:
                    pass
            self._touch_memory()
            return True, (
                f"已重写 memory.{bucket}（保留 {len(cleaned)} 条，"
                f"取代 {removed_items} 条，新建 {created} 条）"
            )
        except Exception as exc:  # noqa: BLE001 —— 写入口失败要回给调用方，不破回合
            return False, f"重写记忆桶失败：{exc}"

    def edit_memory(self, bucket: str, index: int, new_text: str) -> bool:
        """就地改一条玩家记忆:同步 legacy bucket + 结构化 memory.items 里匹配的 active 条目。
        与 remove_memory 同理 —— 只改 bucket 不改 items 会导致 GM 上下文(只读 items)仍读旧文本。

        本次记忆修复：如果旧文本只有 legacy 桶、没有对应 item（历史漂移或旧 set 路径），
        编辑后补建 item，避免这条被编辑过的记忆永远进不了查询召回/归档扫描。
        """
        new_text = _clean_item(new_text)
        if not new_text:
            return False
        items = self.data.get("memory", {}).get(bucket, [])
        if not (0 <= index < len(items)) or not isinstance(items[index], str):
            return False
        old_text = _clean_item(items[index])
        items[index] = new_text
        structured = self.data.get("memory", {}).get("items")
        if not isinstance(structured, list):
            structured = []
            self.data.setdefault("memory", {})["items"] = structured
        if not old_text:
            return True
        for it in structured:
            if (
                isinstance(it, dict)
                and it.get("legacy_bucket") == bucket
                and (it.get("status") or "active") == "active"
                and _clean_item(str(it.get("text", ""))) == old_text
            ):
                it["text"] = new_text
                it["source"] = "ui_edit"
                self._touch_memory()
                return True
        # 没有对应 item：补建一条 active item（turn 用当前回合，便于后续归档/召回）。
        _ctx = self._memory_context_meta()
        self.add_memory_item(
            text=new_text,
            kind="runtime_fact",
            source="ui_edit",
            time_label=str((self.data.get("world") or {}).get("time") or "").strip() or None,
            characters=self._memory_characters_for(new_text) or None,
            location=_ctx.get("location"),
            scene_id=_ctx.get("scene_id"),
            phase_label=_ctx.get("phase_label"),
            legacy_bucket=bucket,
        )
        return True

    # task 75：hypothesis 独立 namespace。codex §1 强调"推测不能混进事实"——
    # 这里给 hypothesis 提供专门的写/查/确认/拒绝 API，让 context_engine
    # 渲染层能明显区分"推测"和"事实"。
    def add_hypothesis(
        self,
        text: str,
        *,
        source: str = "gm",
        time_label: str | None = None,
        characters: list[str] | None = None,
    ) -> str:
        """添加一条推测/计划/草稿。返回 item id 供后续 confirm/reject 引用。"""
        # 本次记忆修复:调用方没给 characters/time_label 时做确定性补全，和 facts
        # 一样让实体/时间过滤可用（推测确认后也会带着这些元数据进 facts）。
        _chars = characters or self._memory_characters_for(text)
        _time = time_label or (str((self.data.get("world") or {}).get("time") or "").strip() or None)
        _ctx = self._memory_context_meta()
        return self.add_memory_item(
            text=text,
            kind="hypothesis",
            source=source,
            time_label=_time,
            characters=_chars or None,
            location=_ctx.get("location"),
            scene_id=_ctx.get("scene_id"),
            phase_label=_ctx.get("phase_label"),
        )

    def list_active_hypotheses(self) -> list[dict]:
        """列出当前 active 的推测（按 turn 倒序，最多 20 条）。"""
        items = self.data.get("memory", {}).get("items", []) or []
        out = [
            i for i in items
            if i.get("kind") == "hypothesis" and i.get("status") == "active"
        ]
        out.sort(key=lambda x: x.get("turn", 0), reverse=True)
        return out[:20]

    def confirm_hypothesis(self, item_id: str, *, source: str = "user") -> bool:
        """把推测升级成 runtime_fact。原 hypothesis status='superseded'，
        新建一条 kind=runtime_fact 引用它的 id（supersedes 链）。"""
        items = self.data.get("memory", {}).get("items", []) or []
        target = next((i for i in items if i.get("id") == item_id), None)
        if not target or target.get("kind") != "hypothesis":
            return False
        if target.get("status") != "active":
            return False
        target["status"] = "superseded"
        _text = str(target.get("text", "") or "").strip()
        # 双写 legacy facts: MemoryProvider 注入、面板事实列表、remove_memory 同步都以
        # legacy bucket 为准。旧实现只写 items，确认后的推测在 fact_groups 12 条窗口之外
        # 或归档之后就从 GM 上下文彻底消失（只剩摘要里一句），这是「推测确认了但 GM 仍不认」的根因。
        _ctx = self._memory_context_meta()
        self.add_memory_item(
            text=_text,
            kind="runtime_fact",
            source=source,
            time_label=target.get("time_label") or (
                str((self.data.get("world") or {}).get("time") or "").strip() or None),
            characters=target.get("characters") or self._memory_characters_for(_text) or None,
            location=target.get("location") or _ctx.get("location"),
            scene_id=target.get("scene_id") or _ctx.get("scene_id"),
            phase_label=target.get("phase_label") or _ctx.get("phase_label"),
            supersedes=[item_id],
            legacy_bucket="facts",
        )
        if _text:
            _facts = self.data.setdefault("memory", {}).setdefault("facts", [])
            if _text not in _facts:
                _facts.append(_text)
        return True

    def reject_hypothesis(self, item_id: str) -> bool:
        """把推测标记为 rejected，不再出现在 active 列表。"""
        items = self.data.get("memory", {}).get("items", []) or []
        target = next((i for i in items if i.get("id") == item_id), None)
        if not target or target.get("kind") != "hypothesis":
            return False
        target["status"] = "rejected"
        self._touch_memory()
        return True

    def set_permission_mode(self, mode: str):
        mode = _normalize_permission_mode(mode)
        self.data.setdefault("permissions", {})["mode"] = mode

    def set_user_variable(self, key: str, value: str, source: str = "user") -> bool:
        key = _clean_item(key)
        value = _clean_item(value)
        if not key or not value:
            return False
        # acceptance 元信息不进用户变量(变量面板可见 + 每回合硬约束注入 GM)
        from state.json_ops import is_acceptance_meta
        if is_acceptance_meta(value):
            return False
        variables = self.data.setdefault("worldline", {}).setdefault("user_variables", {})
        old = variables.get(key, {})
        variables[key] = {
            "value": value,
            "source": source,
            "locked": True,
            "turn": self.data.get("turn", 0),
            "updated_at": now_iso(),
        }
        return old.get("value") != value

    def apply_set_directive(self, text: str) -> list[str]:
        directive = _extract_set_directive(text)
        if not directive:
            return []

        updates: list[str] = []
        set_key = f"set_{self.data.get('turn', 0) + 1}_{len(self.data.setdefault('worldline', {}).setdefault('user_variables', {})) + 1}"
        if self.set_user_variable(set_key, directive, source="user:/set"):
            updates.append(f"强制设定：{directive}")
        if self.add_memory("pinned", f"玩家强制设定：{directive}"):
            updates.append("固定记忆：玩家强制设定")

        # task 28：调整应用顺序——时间/位置等自动派生的更新先做，
        # 显式 path=value 最后兜底覆盖。
        # 原顺序是先 _extract_set_assignments → 写 world.timeline.current_phase=X，
        # 然后 _extract_set_time_targets → update_time() → _phase_for_time() 又把
        # current_phase 推回『玩家分支』/『柏林暗流篇』，把用户的显式值冲掉。
        # 用户显式 path=value 是硬约束，必须最后跑、最后赢。
        for target in _extract_set_time_targets(directive):
            if target and target != self.data["world"]["time"]:
                self.update_time(target, source="user_set")
                updates.append(f"时间线强制设定：{target}")

        location = _extract_location_override(directive)
        if location:
            self.update_location(location)
            updates.append(f"位置强制设定：{location}")

        for spec in _extract_set_assignments(directive):
            result = self.apply_state_write(spec, source="user:/set", force=True, overwrite=True)
            updates.append(result)

        return updates

    def remove_user_variable(self, key: str):
        variables = self.data.setdefault("worldline", {}).setdefault("user_variables", {})
        variables.pop(_clean_item(key), None)

    def set_last_retrieval(self, text: str):
        self.data["memory"]["last_retrieval"] = text or ""

    def set_last_context(self, context: dict):
        self.data["memory"]["last_context"] = context or {}

    def set_last_context_agent(self, agent: dict):
        self.data["memory"]["last_context_agent"] = agent or {}

    def _scan_worldline_validation(self, tags: list[str]) -> dict[str, str]:
        status = "none"
        message = ""
        for item in tags:
            key, value = _split_label(item)
            if "设定冲突" in key:
                return {"status": "conflict", "message": value or item}
            if "设定校验" in key:
                if any(word in value for word in ("通过", "满足", "无冲突", "ok", "OK")):
                    status = "passed"
                else:
                    status = "review"
                message = value
        if self.data.get("worldline", {}).get("user_variables") and any("世界线推演" in tag for tag in tags):
            if status == "none":
                return {"status": "review", "message": "推演缺少【设定校验：通过】"}
        return {"status": status, "message": message}

    def _set_worldline_validation(self, status: str, message: str):
        self.data.setdefault("worldline", {})["last_validation"] = {
            "status": status,
            "message": message,
            "turn": self.data.get("turn", 0),
        }

    def _store_worldline_projection(self, text: str, validated: bool) -> bool:
        projection = {
            "text": _clean_item(text),
            "turn": self.data.get("turn", 0),
            "validated": validated,
            "time": self.data.get("world", {}).get("time", ""),
            "variables": copy.deepcopy(self.data.get("worldline", {}).get("user_variables", {})),
        }
        worldline = self.data.setdefault("worldline", {})
        if validated or not worldline.get("user_variables"):
            worldline["last_projection"] = projection
            worldline["pending_projection"] = None
            return True
        worldline["pending_projection"] = projection
        return False

    # ── 便捷属性 ──────────────────────────────────────────────────
    @property
    def is_new(self) -> bool:
        return self.data["is_new"]

    @property
    def player_name(self) -> str:
        return self.data["player"]["name"]

    def update_location(self, loc: str):
        self.data["player"]["current_location"] = loc

    def update_relationship(self, char: str, status: str, *, source: str = "gm"):
        # acceptance 元信息不进关系状态(人物面板可见;谓词极窄,合法状态文本不可能命中)
        from state.json_ops import is_acceptance_meta
        if not str(char or "").strip():
            return
        if is_acceptance_meta(status):
            return
        prev = self.data["relationships"].get(char)
        self.data["relationships"][char] = status
        # 本次记忆修复:记录关系变化元数据（兼容期不改字符串值，避免所有读取方一起改）。
        # updated_turn/previous/source 供后续「关系变化时间线」「按实体召回」使用；
        # 当前 prompt 仍只读 relationships 字符串，行为不变。
        try:
            meta = self.data.setdefault("relationship_meta", {})
            meta[char] = {
                "updated_turn": int(self.data.get("turn") or 0),
                "previous": prev,
                "source": str(source or "gm"),
            }
        except Exception:
            pass

    def update_time(self, time_desc: str, source: str = "system"):
        time_desc = clean_time_value(time_desc)
        if time_desc:
            self.data["world"]["time"] = time_desc
            timeline = self._timeline()
            old = timeline.get("current_label")
            timeline["current_label"] = time_desc
            # task 36：用户曾用 /set 显式 world.timeline.current_phase=X 时（被记入 user_locked_fields），
            # update_time 不要再用 _phase_for_time(time_desc) 推断覆盖。
            # 这条规则同时覆盖 GM 任何【时间：Y】tag 触发的二次 update_time。
            if not self._is_user_locked("world.timeline.current_phase"):
                timeline["current_phase"] = _phase_for_time(time_desc)
            timeline["anchor_state"] = "locked"
            timeline["anchor_source"] = source
            timeline["anchor_turn"] = self.data["turn"]
            timeline["last_transition"] = {
                "from": old,
                "to": time_desc,
                "source": source,
                "turn": self.data["turn"],
            }
            timeline["pending_jump"] = None
            # task 86：guard 独立标志。GM 在响应中可能调 update_time(source="gm")
            # 把 last_transition.source 改为 "gm"，让 detect_time_jump_violations
            # 错过本回合的 user_set 跳跃检测。这里只在 source=="user_set" 时记录
            # 跳跃回合号，**不**让后续非 user_set 的 update_time 清掉它——
            # 这样 guard 可以可靠判断"本回合是否发生过用户硬跳跃"。
            if source == "user_set":
                timeline["user_set_jump_turn"] = self.data["turn"]

    # ── task 36：用户显式写入字段保护注册表 ─────────────────────────
    def _user_locked_fields(self) -> list[str]:
        wl = self.data.setdefault("worldline", {})
        locked = wl.setdefault("user_locked_fields", [])
        if not isinstance(locked, list):
            wl["user_locked_fields"] = []
            locked = wl["user_locked_fields"]
        return locked

    def _is_user_locked(self, path: str) -> bool:
        try:
            return str(path) in self._user_locked_fields()
        except Exception:
            return False

    def mark_user_locked(self, path: str) -> None:
        """记录某个 state path 是用户显式写入的，后续自动派生（如 _phase_for_time）
        不得覆盖。/set / apply_state_write 在 source=user* 或 force=True 时调。"""
        path = str(path or "").strip()
        if not path:
            return
        locked = self._user_locked_fields()
        if path not in locked:
            locked.append(path)

    # ── A1: 会话级模型覆盖 ───────────────────────────────────────
    def set_session_model(self, model_id: str, api_id: str) -> None:
        """写入当前存档的 session_model（游戏内 ModelPicker 专用）。不影响全局 catalog。"""
        self.data["session_model"] = {"model_id": str(model_id), "api_id": str(api_id)}

    def clear_session_model(self) -> None:
        """清除当前存档的 session_model，回退到全局 catalog 默认。"""
        self.data["session_model"] = {}

    def get_session_model(self) -> tuple[str, str] | None:
        """返回 (model_id, api_id) 若存在 session_model，否则 None。"""
        sm = self.data.get("session_model") or {}
        if sm.get("model_id") and sm.get("api_id"):
            return (str(sm["model_id"]), str(sm["api_id"]))
        return None

    # ── 会话级思考档位覆盖 ───────────────────────────────────────
    def set_session_reasoning(self, api_id: str, model_id: str, level: str) -> None:
        """写入当前存档的主 GM 思考档位；只影响本对话,不改其他存档。

        带 api_id/model_id 是为了在用户切模型后自动失效 —— 旧档位属于旧模型,
        不能拿去套新模型的 spec(不同模型支持的档位不同)。
        """
        self.data["session_reasoning"] = {
            "api_id": str(api_id),
            "model_id": str(model_id),
            "level": str(level),
        }

    def clear_session_reasoning(self) -> None:
        self.data["session_reasoning"] = {}

    def get_session_reasoning(self) -> dict[str, str] | None:
        """返回当前存档的思考档位覆盖,没有则 None。"""
        sr = self.data.get("session_reasoning") or {}
        if sr.get("api_id") and sr.get("model_id") and sr.get("level"):
            return {
                "api_id": str(sr["api_id"]),
                "model_id": str(sr["model_id"]),
                "level": str(sr["level"]),
            }
        return None

    def request_time_jump(self, target: str, raw: str):
        target = clean_time_value(target)
        if not target:
            return
        timeline = self._timeline()
        timeline["anchor_state"] = "pending_confirmation"
        timeline["pending_jump"] = {
            "from": self.data["world"].get("time", ""),
            "to": target,
            "raw": raw,
            "turn": self.data["turn"],
            "status": "awaiting_gm_confirmation",
        }

    def confirm_time_jump(self, target: str | None = None):
        timeline = self._timeline()
        pending = timeline.get("pending_jump") or {}
        self.update_time(target or pending.get("to") or self.data["world"].get("time", ""), source="gm_confirmed")

    def reject_time_jump(self, reason: str):
        timeline = self._timeline()
        pending = timeline.get("pending_jump")
        timeline["last_transition"] = {
            "from": pending.get("from") if pending else self.data["world"].get("time", ""),
            "to": pending.get("to") if pending else "",
            "source": "gm_rejected",
            "reason": reason,
            "turn": self.data["turn"],
        }
        timeline["anchor_state"] = "locked"
        timeline["pending_jump"] = None

    def _timeline(self) -> dict:
        world = self.data.setdefault("world", {})
        timeline = world.setdefault("timeline", {})
        timeline.setdefault("anchor_state", "locked")
        timeline.setdefault("current_label", world.get("time", ""))
        # 通用 RPG 底座：不再硬编码《我蕾穆丽娜不爱你》的『柏林暗流篇』；阶段由
        # 剧本/模组 opening、/set、time_directive 等显式来源写入。
        timeline.setdefault("current_phase", "")
        timeline.setdefault("anchor_source", "legacy")
        timeline.setdefault("anchor_turn", self.data.get("turn", 0))
        timeline.setdefault("pending_jump", None)
        timeline.setdefault("last_transition", None)
        return timeline


