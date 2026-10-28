"""回归:开场不得把结构化 ops JSON / 工具元叙述漏给玩家。

根因(基准 rpg/bench 首跑测出):routes/game.py 开场只抽尾部 markdown 选项,未走 chat
路径落库前那套清洗 → ```json ops 围栏被存进历史并显示给玩家。修:开场复用同一套 stripper。
本测试锁定"开场可见文本 = 三层 stripper(strip_json_state_ops→meta_preamble→leaked_scaffold)"
确实剥净 ops,而结构化解析仍能从含 ops 原文拿到 ops。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from state import (  # noqa: E402
    StreamToolCallGuard,
    strip_json_state_ops,
    strip_leaked_scaffold,
    strip_meta_tool_preamble,
    strip_tool_call_markup,
)


def _opening_visible(raw: str) -> str:
    # 与 routes/game/opening.py 开场清洗同一链
    return strip_leaked_scaffold(strip_meta_tool_preamble(
        strip_json_state_ops(strip_tool_call_markup(raw))))


def test_tool_call_marker_and_chinese_preamble_removed():
    """线上 mimo-v2.6-flash 实测：开场只剩「我先查看…」+ 原始 marker。

    开场没有工具循环，模型照搬 system prompt 的“每轮先查锚点”，这句幕后旁白和
    <<TOOL_CALL>>…<<END_TOOL_CALL>> 都必须整段剥掉。"""
    raw = (
        "我先查看待发生锚点和存档历史，以确定开场的时空骨架。\n\n"
        '<<TOOL_CALL>>{"server_id": "worldline", "tool": "list_pending_anchors", '
        '"arguments": {"limit": 5}}<<END_TOOL_CALL>>'
    )
    vis = _opening_visible(raw)
    assert vis == "", vis
    assert "TOOL_CALL" not in vis
    assert "待发生锚点" not in vis


def test_tool_call_marker_removed_but_story_kept():
    raw = (
        "我先记录历史并推进开场。\n\n"
        '<<TOOL_CALL>>{"server_id":"memory-core","tool":"record_history_anchor",'
        '"arguments":{"save_id":"current","summary":"开场"}}<<END_TOOL_CALL>>\n\n'
        "雨夜，车站的灯忽明忽暗，月台上只剩你一个人。"
    )
    vis = _opening_visible(raw)
    assert vis == "雨夜，车站的灯忽明忽暗，月台上只剩你一个人。", vis
    assert "TOOL_CALL" not in vis


def test_unclosed_tool_call_marker_is_removed():
    raw = "正文还在。\n\n<<TOOL_CALL>>{\"server_id\":\"worldline\",\"tool\":\"list_pending_anchors\""
    vis = _opening_visible(raw)
    assert "TOOL_CALL" not in vis
    assert vis == "正文还在。", vis


def test_stream_tool_call_guard_suppresses_split_marker():
    g = StreamToolCallGuard(hold_meta_preamble=True)
    out = []
    for chunk in ("我", "先查看锚点。\n\n<<TOOL", "_CALL>>{\"tool\":", "\"x\"}<<END_TOOL", "_CALL>>\n\n正", "文"):
        out.append(g.feed(chunk))
    out.append(g.flush())
    assert "".join(out).strip() == "正文", out


def test_stream_tool_call_guard_keeps_ordinary_text():
    g = StreamToolCallGuard(hold_meta_preamble=True)
    a = g.feed("雨夜，车站的灯忽明忽暗。\n\n")
    b = g.feed("你站在月台上。")
    c = g.flush()
    assert (a + b + c).strip() == "雨夜，车站的灯忽明忽暗。\n\n你站在月台上。", (a, b, c)


def test_opening_system_prompt_declares_no_tools():
    """开场生成不能再向模型宣告工具协议，否则弱模型会先“查锚点/历史”再停住。"""
    from agents.gm.master import _OPENING_NO_TOOLS_SUFFIX, GameMaster

    class _Backend:
        last_usage = {}

        def call(self, system, messages, max_tokens):
            self.system = system
            return "开场正文"

    gm = GameMaster.__new__(GameMaster)
    gm._backend = _Backend()
    gm._build_system = lambda *a, **kw: "BASE SYSTEM"
    gm._turn_message = lambda *a, **kw: "USER"
    gm._reset_backend_usage = lambda: None
    gm._active_state = object()

    assert gm.generate_opening(object(), "") == "开场正文"
    assert "BASE SYSTEM" in gm._backend.system
    assert _OPENING_NO_TOOLS_SUFFIX in gm._backend.system
    assert "不要输出 `<<TOOL_CALL>>`" in gm._backend.system


def test_fenced_ops_removed_from_opening():
    raw = (
        "你睁开眼，发现自己置身于一座废弃的车站。月台上空无一人。\n\n"
        "```json\n[{\"op\": \"set\", \"path\": \"world.location\", \"value\": \"废弃车站\"}]\n```"
    )
    vis = _opening_visible(raw)
    assert "```json" not in vis
    assert '"op"' not in vis
    assert "废弃的车站" in vis  # 叙事正文保留


def test_bare_trailing_ops_removed():
    raw = "她转身离去，背影消失在雨幕中。\n[{\"op\":\"set\",\"path\":\"npc.她.state\",\"value\":\"离开\"}]"
    vis = _opening_visible(raw)
    assert '"op"' not in vis and "[{" not in vis
    assert "雨幕" in vis


def test_clean_opening_unchanged():
    raw = "晨光洒进房间，新的一天开始了。你深吸一口气。"
    assert _opening_visible(raw).strip() == raw.strip()
