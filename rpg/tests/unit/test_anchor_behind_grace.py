"""回看宽限契约:锚点可见/可补标/phase close 收束三处必须同源。

背景:progress_chapter 可能被节奏兜底/估章推到 pending 锚点之前。若不处理,
这些锚点既不在史官候选窗口、也不在面板 recent_pending,手动 satisfy 还会被
下界拒绝 → 永远 pending,世界线收束统计永远不收敛(save=205 的 1.1 万 pending)。

修复契约(本文件只锁源码结构,不连 DB):
  1. 史官候选窗口的 chapter_min 必须按 anchor_lookback_chapter_min 放宽;
  2. 面板 recent_pending 必须用同一宽限下界;
  3. 手动 satisfy 的下界必须用同一宽限下界;
  4. phase close 的自动收束阈值必须取 max(reached, progress_chapter) 再减宽限;
  5. 超过宽限的锚点由 expire_behind_anchors 自动 superseded。
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_reconcile_candidate_window_uses_grace():
    src = _read("gm_serving/anchor_reconcile.py")
    assert "anchor_lookback_chapter_min(ch_min)" in src, \
        "史官候选窗口必须按回看宽限放宽下界,否则被进度越过的早期锚点看不到"
    assert "chapter_min=_pending_min" in src
    assert "expire_behind_anchors(" in src, "超过宽限的锚点必须在每回合收束"


def test_api_recent_pending_uses_grace():
    src = _read("platform_app/api/saves.py")
    assert "_pending_min = anchor_lookback_chapter_min(_ch_min)" in src, \
        "面板 recent_pending 必须与史官候选同一宽限下界"
    assert "chapter_min=_pending_min" in src


def test_api_satisfy_lower_bound_uses_grace():
    src = _read("platform_app/api/saves.py")
    assert "anchor_lookback_chapter_min(win_min)" in src, \
        "手动 satisfy 的下界必须用回看宽限,否则玩家点不了宽限内的早期锚点"
    assert "src_ch < lookback_min" in src


def test_phase_close_audit_uses_progress_and_grace():
    src = _read("save_phase_manager.py")
    assert "max(reached, progress)" in src, \
        "phase close 收束阈值必须纳入 progress_chapter(只看 reached 会漏掉 pace 越过的情况)"
    assert "anchor_lookback_chapter_min(" in src
    assert "ANCHOR_BEHIND_GRACE_CHAPTERS" in src
