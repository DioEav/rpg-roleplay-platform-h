"""归档摘要精修的【接线】回归测试 —— 防 v1.41.0 世界心跳老坑复发。

老坑:心跳曾错接进 sync-only 的 _run_post_gm_parallel,而生产默认 postproc 模式
是 async(fire-and-forget),该函数在默认部署下不被调用 → 功能静默空转三处注释
自警。摘要精修同样必须接线在 gm.py 的【async 生产默认路径】(create_task 起 +
两个 return 前 await)。本测试用源码结构断言做绊线:防"删启动/删 await"这类让
功能静默失效的改动;注意它防删除不防挪位(彻底防挪位需跑通整条 async 流程,
成本不成比例,配合 memory_summary 行为测试使用)。
"""
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from chat_pipeline import gm  # noqa: E402


def test_async_production_path_wires_memory_summary_refine():
    src = inspect.getsource(gm)
    # 1) async 路径确实启动精修任务(懒起:仅在有 pending 时)
    assert "refine_pending_summary" in src, "gm.py async 路径未接线归档摘要精修"
    assert "asyncio.create_task(asyncio.to_thread(_ms_refine" in src, "精修任务未按心跳同款 create_task 模式启动"
    # 2) recorder-unified 早退分支与普通 async 分支【两个 return 前】都 await
    #    (少一处 = 那条路径的精修结果不落盘)
    assert src.count("await _ms_task") >= 2, "async 路径存在未 await _ms_task 的提前 return(精修结果会丢)"


def test_sync_parity_worker_still_wired():
    """sync 模式/enqueue 降级路径的 parity worker 仍在(_run_post_gm_parallel 4 worker)。"""
    from chat_pipeline import postproc
    src = inspect.getsource(postproc)
    assert "_worker_memory_summary" in src
    assert src.count("_worker_memory_summary()") >= 2  # 定义 + gather 调用
    assert "await asyncio.gather(" in src
