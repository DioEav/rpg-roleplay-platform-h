"""schemas.memory — 记忆管理路由请求模型 + MemorySettings 配置 schema。"""
from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, Field

from schemas._common import _BaseRequest


class MemoryModeRequest(_BaseRequest):
    mode: str | None = "normal"


class MemoryAddRequest(_BaseRequest):
    bucket: Annotated[str, Field(max_length=128)] | None = "notes"
    text: Annotated[str, Field(max_length=2000)] | None = ""


class MemoryRemoveRequest(_BaseRequest):
    bucket: str | None = "notes"
    index: int | None = None


class MemoryUpdateRequest(_BaseRequest):
    bucket: str | None = "notes"
    index: int | None = None
    text: Annotated[str, Field(max_length=2000)] | None = ""


class MemoryRestoreRequest(_BaseRequest):
    """恢复归档/取代条目（本次记忆修复）：id 或 bucket+text 二选一。

    supersede_conflicts=True 表示用户已确认：恢复旧事实时把当前相似/替代版本
    标记 superseded，避免两个矛盾版本同时 active。
    """
    id: str | None = None
    bucket: str | None = None
    text: Annotated[str, Field(max_length=2000)] | None = None
    supersede_conflicts: bool = False


class MemorySettingsOverrideRequest(_BaseRequest):
    """本存档记忆设置覆盖（本次记忆修复）。

    settings: 只提交要改的字段；unset: 要恢复“跟随全局”的字段名；reset=True 清空全部。
    unset 与 settings 可同时出现（先删后写），方便 UI 做逐字段恢复。
    """
    settings: dict[str, Any] | None = None
    unset: list[str] | None = None
    reset: bool = False


class MemorySettings(BaseModel):
    """用户级记忆系统配置。

    实际存储于 user_preferences.preferences（扁平 key 前缀 memory.*），
    前端 MemorySection（桌面/移动）经 /api/me/preference 写入各 key；
    后端消费方经 platform_app.settings.get_memory_settings(user_id) 读取
    （该函数对旧 settings 表仅作历史数据兜底）。
    """

    token_budget: int = Field(
        default=1600,
        ge=200,
        le=5000,
        description=(
            "每轮注入记忆 token 上限（字符数 // 2 估算）。"
            "本次记忆修复起默认 800→1600：旧默认装不下 2-3 条 600 字归档摘要，"
            "facts/notes 会被摘要挤掉。"
        ),
    )
    token_estimate_factor: float = Field(
        default=1.0,
        ge=0.5,
        le=3.0,
        description=(
            "token 估算系数（本次记忆修复）：最终估算 = len(text)//2 × factor。"
            "默认 1.0 保留旧行为；中文 token 密度高的模型（约 1 字≈1 token）"
            "可调到 1.5–2.0，避免候选扩大后实际 prompt 超出 token_budget。"
        ),
    )
    auto_archive_after_turns: int = Field(
        default=50,
        ge=10,
        le=200,
        description="N 轮后自动归档旧记忆（不删除，仅不注入上下文）",
    )
    facts_soft_limit: int = Field(
        default=80,
        ge=20,
        le=500,
        description=(
            "active facts 软上限（本次记忆修复）：超过时在归档扫描回合触发压力归档，"
            "先压重要性最低的、同分再压最旧，直到回到上限。高密度长局用它防止最近"
            "候选窗口与归档阈值之间出现记忆断层。"
        ),
    )
    pinned_max: int = Field(
        default=20,
        ge=5,
        le=100,
        description=(
            "固定记忆桶（pinned）条目上限；同时是每轮注入的候选上限。"
            "注入仍受 token_budget 截断，但不再被 recall_depth 二次砍到 5 条。"
        ),
    )
    bucket_pinned_enabled: bool = Field(
        default=True,
        description="是否在上下文中注入 pinned 桶",
    )
    bucket_world_enabled: bool = Field(
        default=True,
        description="是否在上下文中注入 world memory（main_quest / objective / facts）",
    )
    bucket_character_enabled: bool = Field(
        default=True,
        description="是否在上下文中注入 character memory（abilities / resources）",
    )
    recall_depth: int = Field(
        default=8,
        ge=1,
        le=20,
        description=(
            "记忆桶的候选窗口基准：至少看最近 N 条，实际注入条数由 token_budget 裁剪"
            "（facts/摘要会按倍数扩大候选，notes/abilities/resources 有更高的候选下限）。"
            "pinned 不看这个值，按 pinned_max 全量候选。"
        ),
    )
    summary_window: int = Field(
        default=10,
        ge=1,
        le=50,
        description=(
            "机械摘要的批量窗口：每 N 回合或 buffer 满 20 条时 flush 一次。"
            "归档检查本身每回合都会做（年龄/压力），不受此值控制；"
            "已归档但尚未成摘要的原文会暂以「概要：」行注入，避免空窗。"
        ),
    )
    summary_llm_enabled: bool = Field(
        default=True,
        description="归档时用 LLM 把旧事实精修成连贯摘要（收尾异步，失败/关闭回落机械压缩）",
    )
