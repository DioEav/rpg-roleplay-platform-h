"""console_assistant.write_preview — 写库工具确认弹窗的「改动预览」。

写作搭档 agent 对剧本知识资产(章节正文 / 世界书 / 人物卡 / 锚点 / canon)落库前要二次确认。
此前确认弹窗只显示原始 args(JSON),作者看不清「到底改了什么」。本模块在确认前计算一份
before→after 预览:章节正文给真·前后全文(供前端做 diff / 对照),其余结构化写给「将写入的字段」。

只读;失败一律返回 None(预览缺失绝不阻断确认流程)。供 llm_loop 在 needs_confirm 时调用。
"""
from __future__ import annotations

import json
from typing import Any

# 单字段最大预览长度(章节正文可达上万字;截断只为载荷护栏,diff 仍以截断文本为准并标注)。
_MAX_FIELD = 16000


def _clip(text: str) -> tuple[str, bool]:
    s = str(text or "")
    if len(s) <= _MAX_FIELD:
        return s, False
    return s[:_MAX_FIELD], True


def build_write_preview(
    tool_name: str, args: dict[str, Any] | None, user_id: int | None, script_id: int | None
) -> dict[str, Any] | None:
    """返回 {kind,label,before?,after,truncated?,is_new?} 或 None(无预览,退回原始 args 展示)。"""
    args = dict(args or {})
    try:
        if tool_name == "update_script_chapter":
            return _preview_chapter(args, script_id)
        if tool_name in ("upsert_worldbook_entry", "upsert_worldbook_entries",
                         "update_npc_card", "upsert_canon_entity",
                         "update_anchor", "create_anchor"):
            return _preview_structured(tool_name, args)
        if tool_name in ("resplit_script", "rebuild_script_module", "import_document_as_chapters"):
            return _preview_script_op(tool_name, args, script_id)
    except Exception:
        return None
    return None


def _iso_ts(value: Any) -> str | None:
    """把 DB 的 datetime / 字符串统一成可 JSON 序列化的 ISO 字符串(待确认项会进
    Redis/PG 与 SSE,不能塞 datetime)。"""
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def current_chapter_meta(script_id: int | None, chapter_index: Any) -> dict[str, Any]:
    """chapter_index → 当前稳定 id + updated_at。失败/不存在返回空 dict。

    供 llm_loop 在 update_script_chapter 待确认时注入 base_chapter_id /
    base_updated_at:只改标题时 write_preview 不生成正文 diff,也要把「确认那一刻
    index 指向哪一行、内容版本是多少」固化下来,避免确认期间的重排/手动保存被覆盖。
    """
    if script_id is None:
        return {}
    try:
        ci = int(chapter_index)
    except (TypeError, ValueError):
        return {}
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            row = db.execute(
                "select id, updated_at from script_chapters "
                "where script_id=%s and chapter_index=%s",
                (int(script_id), ci),
            ).fetchone()
        if not row:
            return {}
        return {
            "id": int(row["id"]) if row.get("id") is not None else None,
            "updated_at": _iso_ts(row.get("updated_at")),
        }
    except Exception:
        return {}


def current_chapter_id(script_id: int | None, chapter_index: Any) -> int | None:
    """兼容旧调用:只取稳定 chapter id。新代码应优先用 current_chapter_meta。"""
    return current_chapter_meta(script_id, chapter_index).get("id")


def _preview_chapter(args: dict[str, Any], script_id: int | None) -> dict[str, Any] | None:
    try:
        ci = int(args.get("chapter_index"))
    except (TypeError, ValueError):
        return None
    new_content = args.get("content")
    if new_content is None:
        return None  # 只改标题等非正文改动 → 不做正文 diff(退回原始 args 展示)
    cur_title, cur_content, is_new = "", "", True
    cur_id = None
    cur_updated = None
    if script_id:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            row = db.execute(
                "select id, title, content, updated_at from script_chapters "
                "where script_id=%s and chapter_index=%s",
                (int(script_id), ci),
            ).fetchone()
        if row:
            is_new = False
            cur_id = int(row.get("id")) if row.get("id") is not None else None
            cur_updated = _iso_ts(row.get("updated_at"))
            cur_title = str(row.get("title") or "")
            cur_content = str(row.get("content") or "")
    before, b_trunc = _clip(cur_content)
    after, a_trunc = _clip(str(new_content))
    new_title = str(args.get("title") or "").strip()
    label = f"第{ci}章 {new_title or cur_title}".strip()
    return {
        "kind": "chapter",
        "label": label,
        # 当前 chapter_index 指向的稳定行 id:llm_loop 会把它注入待确认 args 的
        # base_chapter_id,确认执行时工具会再校验 index 是否仍指向同一章;
        # 前端也用它判断内联 diff 的目标是否就是当前标签打开的那一章。
        "chapter_id": cur_id,
        # 确认预览时的内容版本。llm_loop 会注入 base_updated_at,update_chapter 在
        # 同一条 UPDATE 的 WHERE 里复核;确认期间作者手动保存/另一标签写入 → 409,
        # 而不是 AI 整段覆盖。
        "base_updated_at": cur_updated,
        "before": before,
        "after": after,
        "before_chars": len(cur_content),
        "after_chars": len(str(new_content)),
        "truncated": b_trunc or a_trunc,
        "is_new": is_new,
    }


_STRUCT_KIND = {
    "upsert_worldbook_entry": "worldbook",
    "upsert_worldbook_entries": "worldbook",
    "update_npc_card": "npc",
    "upsert_canon_entity": "canon",
    "update_anchor": "anchor",
    "create_anchor": "anchor",
}

_STRUCT_LABEL_KEYS = ("title", "name", "keyword", "logical_key", "story_time_label", "full_name")

# 这些是服务端注入的并发控制字段,不是作者要写入的内容:确认预览里必须剔除,
# 否则卡片会显示 base_updated_at / base_row_version 之类的内部参数。
_INTERNAL_ARGS = frozenset({
    "base_updated_at", "base_row_version", "base_chapter_id",
    "target_chapter_id", "save_details",
})


def _strip_internal(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _strip_internal(v) for k, v in value.items() if k not in _INTERNAL_ARGS}
    if isinstance(value, list):
        return [_strip_internal(v) for v in value]
    return value


def _preview_structured(tool_name: str, args: dict[str, Any]) -> dict[str, Any] | None:
    """结构化写:展示「将写入的字段」(after),供作者落库前核对。不读当前值(字段语义各异、
    key 解析复杂),只把 agent 提议的字段整理成可读 after —— 前端无 before 时按「将写入」渲染。"""
    fields = {
        k: _strip_internal(v) for k, v in args.items()
        if k not in _INTERNAL_ARGS and v not in (None, "", [], {})
    }
    if not fields:
        return None
    label_val = next((str(args.get(k)) for k in _STRUCT_LABEL_KEYS if args.get(k)), "")
    after, trunc = _clip(json.dumps(fields, ensure_ascii=False, indent=2))
    return {
        "kind": _STRUCT_KIND.get(tool_name, "structured"),
        "label": label_val,
        "after": after,
        "truncated": trunc,
        "is_new": tool_name == "create_anchor",
    }


def _script_title(script_id: int | None) -> str:
    if not script_id:
        return ""
    try:
        from platform_app.db import connect, init_db
        init_db()
        with connect() as db:
            row = db.execute("select title from scripts where id=%s", (int(script_id),)).fetchone()
        return str((row or {}).get("title") or "")
    except Exception:
        return ""


def _preview_script_op(tool_name: str, args: dict[str, Any], script_id: int | None) -> dict[str, Any]:
    """破坏性脚本结构操作(resplit / 整本导入 / 知识模块重建)的确认预览。

    这些工具没有单一“实体行”可做 before/after,但确认卡至少要让作者看到:
    目标剧本 + 会执行什么(切章规则/模块/追加还是替换)。此前只显示一句工具描述,
    用户很容易在没意识到目标/模式的情况下批准整本重切。
    """
    title = _script_title(script_id)
    target = (f"{title} (#{script_id})" if title else (f"#{script_id}" if script_id else "未指定剧本"))
    lines = [f"目标剧本: {target}"]
    if tool_name == "resplit_script":
        lines.append(f"切章规则: {args.get('mode') or 'regex'}")
        lines.append("会重新切分整本章节:原章节编号/正文将被替换。")
    elif tool_name == "rebuild_script_module":
        lines.append(f"重建模块: {args.get('module') or '(未指定)'}")
        src = args.get("source") or args.get("mode")
        if src:
            lines.append(f"数据来源: {src}")
        lines.append("会覆盖该模块已派生的数据。")
    else:
        mode = str(args.get("mode") or "append").lower()
        lines.append(f"导入方式: {'替换现有章节' if mode == 'replace' else '追加到末尾'}")
        if args.get("doc_id"):
            lines.append(f"文档 id: {args.get('doc_id')}")
    after, trunc = _clip("\n".join(lines))
    return {
        "kind": "script_op",
        "label": target,
        "after": after,
        "truncated": trunc,
        "is_new": False,
    }
