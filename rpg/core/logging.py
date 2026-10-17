"""core.logging — 项目级 logger 入口。

当前项目大量用 print()，后续可改用 logger。此模块提供统一 get_logger()
入口，避免子模块各自 logging.getLogger(__name__)。
"""
from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

_LOG_DIR_NAME = "logs"
_LOG_FILE_NAME = "backend.log"
_file_handler_attached = False


def default_log_file_path() -> str:
    """后端日志文件默认路径:锚定 rpg/ 包根(不随 CWD 漂移)。

    「系统日志」admin 页(/api/admin/logs)在 LOG_FILE 未设时读同一个默认值
    —— 两处必须同源,改路径只改这里的常量,勿在端点另行硬编码。
    """
    return str(Path(__file__).resolve().parents[1] / _LOG_DIR_NAME / _LOG_FILE_NAME)


def get_logger(name: str = "rpg") -> logging.Logger:
    """获取一个 logger 实例。"""
    return logging.getLogger(name)


def setup_default_logging(level: int = logging.INFO) -> None:
    """配置默认 logger:stderr(basicConfig)+ 落盘(RotatingFileHandler)。

    落盘是为了「系统日志」admin 页有数据可读:该端点读 LOG_FILE 指向的文件,
    未设时读 default_log_file_path(),与本函数写的是同一个文件。
    - 路径可用环境变量 LOG_FILE 覆盖;
    - delay=True:首条日志才建文件,避免 import 即写盘;
    - 创建失败(只读盘等)仅告警,进程照常以 stderr 运行;
    - 多 worker(--workers 4)各自持同一文件的 handler,轮转瞬间理论上存在
      竞态,仅可能丢个别行,对诊断页可接受。
    """
    global _file_handler_attached
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    if _file_handler_attached:
        return
    _file_handler_attached = True
    file_path = os.environ.get("LOG_FILE") or default_log_file_path()
    try:
        Path(file_path).parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            file_path,
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
            delay=True,
        )
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        ))
        logging.getLogger().addHandler(handler)
    except Exception as exc:
        logging.getLogger(__name__).warning(
            "log file %s unavailable, stderr only: %s", file_path, exc,
        )
