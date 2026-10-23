"""schemas.models — 模型目录与 API 管理路由请求模型。"""
from __future__ import annotations

from typing import Annotated, Any

from pydantic import Field

from schemas._common import _BaseRequest

_Str256 = Annotated[str, Field(max_length=256)]


class ModelsSelectRequest(_BaseRequest):
    api_id: str | None = ""
    model_id: str | None = ""
    # A1: 如果提供 save_id，写存档级 session_model 而不动全局 catalog
    save_id: int | None = None
    # task: 切换作用域 — "user"(默认,per-user prefs) / "global"(admin only,改 catalog)
    # save_id 优先;此字段仅当 save_id 缺时才看
    scope: str | None = "user"


class ModelsReasoningRequest(_BaseRequest):
    """思考档位写入。

    - save_id 非空 → 写该存档的 session_reasoning(对话框里的「本对话」作用域)
    - save_id 为空 → 写用户级 model_effort(所有对话共享)
    两个字段都带 api_id/model_id:切换模型后旧档位自动失效,不会被套到新模型上。
    """
    api_id: _Str256 | None = ""
    model_id: _Str256 | None = ""
    level: _Str256 | None = ""
    save_id: int | None = None


class ModelsUpsertApiRequest(_BaseRequest):
    """upsert_api 直接消费整个 body dict,字段透传即可。
    已知字段加了 max_length=256 约束;其余透传字段仍允许(extra="allow")。
    """
    model_config = __import__('pydantic').ConfigDict(extra="allow")
    api_id: _Str256 | None = None
    name: _Str256 | None = None
    base_url: _Str256 | None = None
    kind: _Str256 | None = None
    api_format: _Str256 | None = None


class ModelsUpsertModelRequest(_BaseRequest):
    """model 字段透传。允许前端直接发 flat payload (api_id + 各 model 字段)。"""
    model_config = __import__('pydantic').ConfigDict(extra="allow")
    api_id: str | None = ""
    model: dict[str, Any] | None = None


class ModelsDeleteModelRequest(_BaseRequest):
    api_id: str | None = ""
    model_id: str | None = None
    real_name: str | None = ""


class ModelsProbeRequest(_BaseRequest):
    api_id: str | None = ""
    model: str | None = None
    timeout: int | None = 15
