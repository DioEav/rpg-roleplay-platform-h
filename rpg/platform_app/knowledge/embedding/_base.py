"""platform_app.knowledge.embedding._base — 共享常量 + 低层 helper(叶子层)。

拆包前这些常量/谓词都住在单文件 embedding.py 顶部;拆包后集中到叶子层,供各 provider
子模块(_vertex / _gemini / _cohere)与公共层 __init__ 共用,并借此打破循环依赖
(__init__ → provider 子模块 → _base 单向)。纯机械搬家,行为零变化。

注:env 驱动、且被「reload 后需重读」的 DEFAULT_EMBED_API_ID 留在 __init__(测试会 patch
EMBED_API_ID env 后 reload 包);其余 env 常量对测试稳定,放这里。
"""
from __future__ import annotations

import logging
import os

# 拆包前 embedding.py 的 __name__ 即 platform_app.knowledge.embedding;拆包后各子模块统一用
# 显式包名 logger,保持日志 logger 身份与拆包前完全一致(测试按该 logger 名断言日志)。
log = logging.getLogger("platform_app.knowledge.embedding")

# 系统默认 embedding 配置(env 可覆盖,用户 BYOK 优先于 env)
DEFAULT_EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-embedding-004")

# 已知【没有 embedding 接口】的 chat-only provider:选成嵌入器必然 404/失败(记忆 project_rag_embedder:
# Anthropic/DeepSeek 无 embedding)。用户曾把 deepseek 选成嵌入器(embed.api_id=deepseek + 默认模型
# text-embedding-004 = Google 模型)→ 每批 404、重试 5 次(~2.5 分钟)才放弃、导入的小说 RAG 坏掉。
# 各层校验都漏了(picker 只按模型名 heuristic、preflight 只查有无该 provider 凭据),这里做后端权威闸。
_NO_EMBEDDING_PROVIDERS = frozenset({"deepseek", "anthropic", "moonshot"})


def provider_lacks_embedding(api_id: str, base_url: str = "") -> bool:
    """该 provider 是否没有 embedding 接口(选成嵌入器必然失败)。按 api_id + base_url host 双判。"""
    a = (api_id or "").strip().lower()
    if any(k in a for k in _NO_EMBEDDING_PROVIDERS):
        return True
    h = (base_url or "").strip().lower()
    return any(k in h for k in ("deepseek.com", "api.anthropic.com", "moonshot"))
# 向量维度:默认 768(text-embedding-004 / 平台栈)。自部署用别的 provider 时设 EMBED_DIM
# (须与 migrations 建表维度一致,首次部署前设)。仅用于返回维度校验,不强制截断。
EMBED_DIM = int(os.environ.get("EMBED_DIM", "768") or "768")
# Vertex text-embedding-004 限制:**单请求总 token ≤ 20000**(不是 250 项)。
# 中文 chunk 平均 ~200 token,100 项已经超过 20K → 400 INVALID_ARGUMENT。
# 减到 30 项 × ~600 char ≈ 9000 tokens,留足 50% buffer 处理长 chunk。
BATCH_SIZE = 30
# 单批 embedding 连续失败上限:provider 永久故障(坏 key/配额耗尽/模型下线)时
# _embed_batch 始终返 None,原 while True 会 30s 一次无限重试 → daemon 线程永 spin、
# _EMBED_QUEUE_RUNNING flag 永 True(该 script 再不能重 embed)。超限即 raise,由
# _embed_chunks_loop 的 try/finally 优雅收尾(清 flag + 线程退出);chunks 留 null 待重试。
_MAX_EMBED_BATCH_RETRIES = 5
# 每个 chunk 文本上限(char),配合 batch_size 控制总 token。
# Vertex 中文 ~1 char/0.5 token,2400 char ≈ 1200 token;30 × 1200 = 36000 仍超。
# 改成 1200 char/chunk ≈ 600 token;30 × 600 = 18000 安全。
# 2026-11 v2 切片:块最大 1200 字 + context_header(~20 字),1200 会截掉 header/尾部;
# 提到 1250(≈625 token ×30 ≈ 18750,仍低于 Vertex 20k 上限),保证整块完整入向量。
PER_CHUNK_CHAR_LIMIT = 1250
# 嵌入请求超时按「本批条数」自适应:本地/自部署慢模型每条 embedding 可能 2-3s(群反馈 abci
# 实测 2.5s/条),一批 30/64 条就要 75-160s,**原硬编码 60s 必超时** → 模型返 200 但平台已放弃 →
# 向量索引永远卡在 0(实测现象:模型日志收到几条请求后「半天才增加一条」)。按条数 × 每条预算
# (取 8s,覆盖到 CPU 慢模型)放大,下限 60s 不变(单条 query 仍快速失败,GM 召回热路径不受拖)。
_EMBED_SECS_PER_TEXT = 8.0


def _embed_req_timeout(n_texts: int) -> float:
    return max(60.0, float(n_texts) * _EMBED_SECS_PER_TEXT)


# 向后兼容:保留 EMBED_MODEL 常量名(外部模块如 extract/ 直接引用它)
EMBED_MODEL = DEFAULT_EMBED_MODEL


# 平台兜底资格角色(享受平台共享 embedder / Vertex SA 兜底)。
# 单一来源:与「纯 admin 管理权」(role == 'admin',见 api._deps.is_admin)是不同职责,资格集合不同,绝不跨用。
_PLATFORM_FALLBACK_ROLES = {"admin", "vip_user"}


def _is_google_generative_openai_base(base_url: str) -> bool:
    return "generativelanguage.googleapis.com" in (base_url or "").lower()


def has_platform_fallback_role(user_or_id) -> bool:
    """是否拥有「平台兜底资格」(role ∈ _PLATFORM_FALLBACK_ROLES = {admin, vip_user})。

    单一谓词,消除散落的硬编码角色集。接受两种入参以省去多余 DB 往返:
      - user dict(已加载,含 'role')→ 直接读 role,不查库。
      - user_id(int / 可转 int)    → 查 users.role。
    其他用户(默认 role='user' / '')不享受,防白嫖付费 Gemini key。

    注意:这是「资格」(admin + vip_user),与「纯 admin 管理权」(role == 'admin',
    见 api._deps.is_admin)是不同职责,资格集合不同,绝不跨用。
    """
    if isinstance(user_or_id, dict):
        return (user_or_id.get("role") or "").lower() in _PLATFORM_FALLBACK_ROLES
    if not user_or_id:
        return False
    try:
        from platform_app.db import connect
        with connect() as db:
            row = db.execute("select role from users where id = %s", (int(user_or_id),)).fetchone()
        return bool(row and (row.get("role") or "").lower() in _PLATFORM_FALLBACK_ROLES)
    except Exception:
        return False


def _is_admin(user_id: int | None) -> bool:
    """检查 user_id 是否享受平台 embedder 兜底(admin 或 vip_user)。

    内部 = has_platform_fallback_role(单一来源);函数名保留向后兼容本模块多处调用。
    """
    return has_platform_fallback_role(user_id)


def _vec_literal(v: list[float]) -> str:
    """list[float] → pgvector "[..]" 字面量。"""
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"
