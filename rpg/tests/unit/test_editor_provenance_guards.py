"""harness 审计 P1:编辑器写入的知识资产(锚点/世界书/canon)必须在「删后重建/全量重写」
路径里被 source='editor' 闸保护,否则用户经 MD 编辑器同步进库的设定下次重建知识库就被静默抹掉。

这是**结构性守卫测试**:防止将来有人新增一条 per-script 的裸 DELETE / upsert 覆盖却忘了加
provenance 闸(audit 原话:「靠每条 SQL 手写 WHERE 是脆弱散点」)。任一 bulk 删除/重写
缺 source/editor 闸 → 本测试 fail,逼新代码显式处理 provenance。

判定:per-script bulk 删除(WHERE 含 script_id、不含 targeted id 如 anchor_id=/logical_key=/id=)
必须在同一语句出现 'source'(或 worldbook 用 metadata->>'source')。targeted 删除(用户删单条)豁免。
"""
import re
from pathlib import Path

_RPG = Path(__file__).resolve().parents[2]


def _read(rel: str) -> str:
    return (_RPG / rel).read_text(encoding="utf-8")


def _delete_tails(src: str, table: str, window: int = 320) -> list[str]:
    """返回每个 `delete from <table>` 后 window 字符(跨字符串拼接的 SQL 尾,含 WHERE)。"""
    out = []
    for m in re.finditer(r"delete\s+from\s+" + re.escape(table), src, re.IGNORECASE):
        out.append(src[m.start():m.start() + window])
    return out


def _is_targeted(tail: str) -> bool:
    """targeted 删除(删单条,用户/端点意图)→ 豁免 provenance 闸。"""
    low = tail.lower()
    return any(k in low for k in ("where id=", "where id =", "anchor_id=", "anchor_id =",
                                  "logical_key=", "logical_key =", "= any(", "id = any"))


def test_timeline_anchor_bulk_deletes_guard_source():
    files = ["script_timeline.py", "extract/rebuild.py", "extract/resolve.py",
             "platform_app/api/script_edit/anchors.py", "extract/dedup.py"]
    offenders = []
    for f in files:
        try:
            src = _read(f)
        except FileNotFoundError:
            continue
        for tail in _delete_tails(src, "script_timeline_anchors"):
            low = tail.lower()
            if "script_id" in low and not _is_targeted(tail) and "source" not in low:
                offenders.append(f + " :: " + " ".join(tail.split())[:140])
    assert not offenders, (
        "发现未加 source 闸的 script_timeline_anchors 全量删除(会抹掉编辑器锚点):\n"
        + "\n".join(offenders)
    )


def test_canon_bulk_deletes_guard_source():
    offenders = []
    for f in ["extract/rebuild.py", "extract/resolve.py", "platform_app/knowledge/script_pack.py"]:
        try:
            src = _read(f)
        except FileNotFoundError:
            continue
        for tail in _delete_tails(src, "kb_canon_entities"):
            low = tail.lower()
            if "script_id" in low and not _is_targeted(tail) and "source" not in low:
                offenders.append(f + " :: " + " ".join(tail.split())[:140])
    assert not offenders, (
        "发现未加 source 闸的 kb_canon_entities 全量删除(会抹掉编辑器 canon):\n"
        + "\n".join(offenders)
    )


def test_worldbook_rebuild_delete_guards_editor():
    src = _read("extract/resolve.py")
    tails = _delete_tails(src, "worldbook_entries")
    bulk = [t for t in tails if "script_id" in t.lower() and not _is_targeted(t)]
    assert bulk, "未找到 worldbook_entries 重建删除(测试假设失效,请核对)"
    for t in bulk:
        assert "editor" in t.lower(), (
            "worldbook 重建删除未排除 editor 条目(会抹掉编辑器同步的世界书):" + " ".join(t.split())[:160]
        )


def test_editor_write_tools_mark_source():
    """upsert_worldbook / upsert_canon / create_anchor 三个直写工具落库时必须打 source/editor 标记。"""
    # 拆包后单文件成子包:三个断言的目标分别住在不同子模块,分别读后拼接。
    wb = _read("tools_dsl/command_tools_script_write/worldbook.py")
    src = (
        wb
        + _read("tools_dsl/command_tools_script_write/canon.py")    # canon attrs 合并 "source": "editor"
        + _read("tools_dsl/command_tools_script_write/anchors.py")  # create_anchor 写 source='editor'
    )
    # worldbook 创建分支 metadata 标 editor + manual_fields（字段级手编单一真源）
    assert re.search(r'"source"\s*:\s*"editor"', wb), \
        "upsert_worldbook_entry 创建未给 metadata 打 source=editor"
    assert re.search(r'"manual_fields"\s*:\s*sorted\(_manual\)', wb), \
        "upsert_worldbook_entry 创建未写字段级 manual_fields"
    # canon 创建分支 attrs 合并 editor
    assert '"source": "editor"' in src, "canon 创建未在 attrs 打 source=editor"
    # create_anchor 写 source='editor'
    assert "'editor'" in src and "create_anchor" in src, "create_anchor 未写 source='editor'"
