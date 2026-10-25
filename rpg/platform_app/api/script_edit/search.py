"""platform_app.api.script_edit.search —— 全书检索(用户面板 Cmd/Ctrl+Shift+F)。

在所有章节正文搜词/短语/正则,返回结构化命中。仅 owner。纯机械搬家,行为零变化。
"""
from __future__ import annotations

import time
from typing import Any

from fastapi import Depends

from ...db import connect, limit_value
from ...perms import script_owned
from .._deps import json_response, require_user
from ._shared import router

# 正则执行护栏:Python 内置 re 没有超时,灾难性回溯(如 (a+)+$)会把 worker 卡死。
# 用 regex 模块(支持 timeout);依赖缺失时正则模式直接 400,绝不退回无超时的 re。
try:  # pragma: no cover - 依赖环境
    import regex as _regex_mod
except ImportError:  # pragma: no cover
    _regex_mod = None

_REGEX_PER_CHAPTER_TIMEOUT_S = 0.05   # 单章扫描上限
_REGEX_TOTAL_DEADLINE_S = 1.5         # 整次检索累计上限,避免 1000 章 × 50ms


@router.get("/api/scripts/{script_id}/search")
async def api_script_search(script_id: int, q: str = "", regex: bool = False,
                            chapter_min: int | None = None, chapter_max: int | None = None,
                            limit: int = 80, user=Depends(require_user)):
    """全书检索(用户面板 Cmd/Ctrl+Shift+F):在所有章节正文搜词/短语/正则,返回结构化命中
    (章号 + 标题 + 偏移 + 上下文片段)。**仅 owner**(云端多用户隔离)。

    regex=true 时带执行超时:单章 50ms、整次 1.5s,超时返回 400 可行动提示,
    不让灾难性正则拖死 worker。"""
    uid = int(user["id"])
    query = (q or "").strip()
    if not query:
        return json_response({"ok": True, "results": [], "total": 0})
    import re as _re
    if regex and _regex_mod is None:
        # 没有带 timeout 的实现时,宁可禁用正则,也不能把用户提供的任意模式交给
        # 标准库 re:灾难性回溯无法中断,会把 worker 永久卡住。requirements 已固定
        # regex,正常部署不会走到这里;依赖缺失时给可行动提示而不是冒险执行。
        return json_response(
            {"ok": False, "error": "正则检索组件未安装(regex),已禁用正则模式;请改用普通检索或安装依赖"},
            status_code=400,
        )
    if regex:
        try:
            pat = _regex_mod.compile(query, _regex_mod.I)
        except Exception as exc:
            return json_response({"ok": False, "error": f"正则无效: {exc}"}, status_code=400)
    else:
        try:
            pat = _re.compile(_re.escape(query), _re.I)
        except _re.error as exc:
            return json_response({"ok": False, "error": f"正则无效: {exc}"}, status_code=400)
    lim = limit_value(limit, default=80, maximum=300)
    CAP = 3000
    where = "script_id=%s"
    params: list[Any] = [script_id]
    if chapter_min is not None:
        where += " and chapter_index>=%s"
        params.append(int(chapter_min))
    if chapter_max is not None:
        where += " and chapter_index<=%s"
        params.append(int(chapter_max))
    if not regex:
        where += " and content ILIKE %s"
        params.append(f"%{query}%")
    with connect() as db:
        if not script_owned(db, script_id, uid):
            return json_response({"ok": False, "error": "无权访问该剧本"}, status_code=403)
        rows = db.execute(
            f"select chapter_index, title, content from script_chapters where {where} order by chapter_index",
            tuple(params),
        ).fetchall()
    results: list[dict[str, Any]] = []
    total = 0
    capped = False
    started_at = time.monotonic()
    for row in rows:
        ci = row.get("chapter_index")
        title = str(row.get("title") or "")
        content = str(row.get("content") or "")
        if not content:
            continue
        try:
            # 只有 regex 模式需要 timeout(标准库 re 的 pattern 不接受该参数;
            # 正则模式在上方已保证 regex 模块存在)。
            matches = (pat.finditer(content, timeout=_REGEX_PER_CHAPTER_TIMEOUT_S)
                       if regex else pat.finditer(content))
            for m in matches:
                total += 1
                if len(results) < lim:
                    s = max(0, m.start() - 48)
                    e = min(len(content), m.end() + 48)
                    results.append({
                        "chapter_index": ci, "title": title, "offset": m.start(),
                        "snippet": content[s:e].replace("\n", " ").strip(),
                        "pre": "…" if s > 0 else "", "suf": "…" if e < len(content) else "",
                    })
                if total >= CAP:
                    capped = True
                    break
        except TimeoutError:
            return json_response(
                {"ok": False, "error": "正则执行超时:请简化正则(避免嵌套量词/大量回溯)或缩小章节范围"},
                status_code=400,
            )
        if capped:
            break
        if regex and (time.monotonic() - started_at) > _REGEX_TOTAL_DEADLINE_S:
            return json_response(
                {"ok": False, "error": "正则检索耗时过长已中止:请缩小章节范围或简化正则"},
                status_code=400,
            )
    return json_response({"ok": True, "results": results,
                          "total": total, "capped": capped,
                          "chapters": len({r["chapter_index"] for r in results})})
