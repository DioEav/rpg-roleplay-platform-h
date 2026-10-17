"""platform_app/storage.py — 统一存储抽象（S1 基座）。

单一真相源：所有用户文件路径均从此模块的常量派生，消除各处 parents[N] 硬编码。

OSS 替换点：store_bytes() 函数体 —— 目前写本地磁盘；换 OSS 时只改这一函数即可，
public_url() 也需同步返回 CDN URL。
"""
from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# 根目录 & 子目录常量
# ---------------------------------------------------------------------------

PLATFORM_DATA_ROOT = Path(
    os.environ.get(
        "RPG_DATA_ROOT",
        str(Path(__file__).resolve().parents[1] / "platform_data"),
    )
)

AI_IMAGES_DIR     = PLATFORM_DATA_ROOT / "ai_images"
AVATARS_DIR       = PLATFORM_DATA_ROOT / "avatars"
SCRIPTS_DIR       = PLATFORM_DATA_ROOT / "scripts"
LIBRARY_DIR       = PLATFORM_DATA_ROOT / "library"
UPLOAD_CHUNKS_DIR = PLATFORM_DATA_ROOT / "upload_chunks"


# ---------------------------------------------------------------------------
# 公共 URL 构造
# ---------------------------------------------------------------------------

def public_url(storage_key: str) -> str:
    """把 storage_key（形如 'kind/filename'）转成对外 HTTP URL。

    OSS 替换点：换 CDN 时此处返回 CDN 绝对 URL。
    """
    return f"/api/storage/{storage_key}"


# ---------------------------------------------------------------------------
# 路径解析（含穿越防护）
# ---------------------------------------------------------------------------

def resolve_path(storage_key: str) -> Path:
    """把 storage_key 解析为绝对 Path，并校验不逃出 PLATFORM_DATA_ROOT。

    Raises ValueError if the resolved path escapes the root (path traversal
    防护）。
    """
    candidate = (PLATFORM_DATA_ROOT / storage_key).resolve()
    root_resolved = PLATFORM_DATA_ROOT.resolve()
    # 必须是 root 的严格子路径（不允许恰好等于 root）
    if root_resolved not in candidate.parents:
        raise ValueError(
            f"storage_key 路径越界（穿越防护）：{storage_key!r}"
        )
    return candidate


# ---------------------------------------------------------------------------
# 落盘
# ---------------------------------------------------------------------------

def store_bytes(data: bytes, *, kind: str, filename: str) -> tuple[str, str]:
    """把 data 落盘到 PLATFORM_DATA_ROOT/{kind}/{filename}（mkdir -p）。

    返回 (storage_key, url)。

    OSS 替换点：换 OSS 时把此函数体替换为上传到对象存储桶的逻辑，
    storage_key 保持不变（仍为 f"{kind}/{filename}"），url 改为 CDN URL。
    """
    dest_dir = PLATFORM_DATA_ROOT / kind
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    dest.write_bytes(data)
    storage_key = f"{kind}/{filename}"
    url = public_url(storage_key)
    return storage_key, url


# ---------------------------------------------------------------------------
# 删除
# ---------------------------------------------------------------------------

def delete_file(storage_key: str) -> None:
    """删除物理文件（missing_ok：不存在则静默）。"""
    try:
        path = resolve_path(storage_key)
    except ValueError:
        return
    path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# 关联反查（供删除前检查引用）
# ---------------------------------------------------------------------------

def find_references(url: str) -> list[dict]:
    """查询哪些业务记录引用了该 URL/路径。

    扫描列：
      users.avatar_url
      scripts.cover_image_url
      character_cards.avatar_path
      card_persona_images.image_url

    返回 list[{kind, table, id, title/name, owner_id}]，供前端删除确认弹窗展示；
    owner_id 是引用方归属(用户卡=卡主, NPC 卡/剧本封面=剧本 owner),删除时据此判断
    是否有「其他用户」仍在引用 —— 有则只解除引用、保留物理文件。
    用户量有限，全扫可接受；迁移到 user_assets 后可改用 ref_kind/ref_id 结构化反查。
    """
    from .db import connect, init_db

    init_db()
    results: list[dict] = []

    with connect() as db:
        # users.avatar_url
        rows = db.execute(
            "select id, username from users where avatar_url = %s",
            (url,),
        ).fetchall()
        for r in rows:
            results.append({
                "kind": "avatar",
                "table": "users",
                "id": r["id"],
                "name": r["username"],
                "owner_id": r["id"],
            })

        # scripts.cover_image_url
        try:
            rows = db.execute(
                "select id, title, owner_id from scripts where cover_image_url = %s",
                (url,),
            ).fetchall()
            for r in rows:
                results.append({
                    "kind": "cover",
                    "table": "scripts",
                    "id": r["id"],
                    "title": r["title"],
                    "owner_id": r["owner_id"],
                })
        except Exception:
            pass

        # character_cards.avatar_path — 用户卡直接挂 user_id;剧本 NPC 卡归属剧本 owner
        try:
            rows = db.execute(
                """
                select cc.id, cc.name, coalesce(cc.user_id, s.owner_id) as owner_id
                  from character_cards cc
                  left join scripts s on s.id = cc.script_id
                 where cc.avatar_path = %s
                """,
                (url,),
            ).fetchall()
            for r in rows:
                results.append({
                    "kind": "card_avatar",
                    "table": "character_cards",
                    "id": r["id"],
                    "name": r["name"],
                    "owner_id": r["owner_id"],
                })
        except Exception:
            pass

        # card_persona_images.image_url — 归属其所属卡片的 owner
        try:
            rows = db.execute(
                """
                select cpi.id, coalesce(cc.user_id, s.owner_id) as owner_id
                  from card_persona_images cpi
                  join character_cards cc on cc.id = cpi.card_id
                  left join scripts s on s.id = cc.script_id
                 where cpi.image_url = %s
                """,
                (url,),
            ).fetchall()
            for r in rows:
                results.append({
                    "kind": "persona_image",
                    "table": "card_persona_images",
                    "id": r["id"],
                    "owner_id": r["owner_id"],
                })
        except Exception:
            pass

    return results


def foreign_references(user_id: int, references: list[dict]) -> list[dict]:
    """从 find_references 结果中筛出不属于 user_id 的引用。

    owner_id 缺失(历史数据/异常)按「他人」处理:宁可保留文件,也不误删别人还在用的图。
    """
    foreign: list[dict] = []
    for ref in references or []:
        owner = ref.get("owner_id")
        if owner is None or int(owner) != int(user_id):
            foreign.append(ref)
    return foreign
