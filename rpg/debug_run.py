"""IDEA 调试专用启动器（正式运行请继续用 uvicorn app:app，不要用本文件）。

背景：IDEA 2024.3 的 pydev 调试器在执行用户代码前会无条件给 asyncio.run 打
nest_asyncio 补丁（pydevd.py:1559 → pydevd_nest_asyncio._patch_asyncio），
补丁版签名是 run(main, debug=False)——不认识 uvicorn >= 0.38 传入的
loop_factory 关键字，导致：
    TypeError: _patch_asyncio.<locals>.run() got an unexpected keyword
               argument 'loop_factory'

修法：在 pydevd 补丁之后、import uvicorn 之前，把 asyncio.run 包一层兼容
签名（接受并忽略 loop_factory——pydevd 补丁本就自管事件循环，且 uvicorn
默认 loop="auto" 时 loop_factory=None）。这样 uvicorn._compat 在 import 时
捕获到的是兼容版，调试器的 async 断点/表达式求值能力完整保留。
"""
import asyncio

# pydevd 的 nest_asyncio 补丁版（调试器启动时已替换 asyncio.run）
_patched_run = asyncio.run


def _compatible_run(main, *, debug=False, loop_factory=None):
    return _patched_run(main, debug=debug)


asyncio.run = _compatible_run

import uvicorn

from app import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7860, log_level="info")
