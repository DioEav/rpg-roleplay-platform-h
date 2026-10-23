"""agents.gm.backends.responses — OpenAI Responses API 兼容 backend。

与 `_OpenAICompatBackend`(Chat Completions)并列，供 provider 显式选择
`api_format=responses` 时使用。对外契约完全一致：
call / call_structured / stream / stream_with_mcp_loop / probe / last_usage /
supports_native_tools，因此 GameMaster、控制台、探活、usage 记账无需感知协议差异。

关键差异（见 docs/design/K_model_layer_and_image_gen.md）：
  · 请求用 `instructions` + `input`，输出是 `output[]` items；
  · 工具定义是平铺的 {type:function,name,description,parameters}；
  · 工具续跑用 `function_call_output` + `call_id`，默认无状态(store=False)；
  · 思考控制是 `reasoning={"effort": ...}`，输出上限是 `max_output_tokens`。
"""
from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any

import httpx

from agents.gm.helpers import _openai_text_marker_loop
from core.logging import get_logger
from model_reasoning import (
    build_responses_params,
    effective_max_tokens,
    resolve_spec_for_call,
)

log = get_logger(__name__)

_MAX_RETRIES = 1
_MIN_OUTPUT_TOKENS = 16  # Responses 推理模型对极小预算会直接 400；探活/ping 用 64。

# 「我们主动加的、provider 未必认」的参数字段，按组独立剥离。
_SAMPLING_KEYS = ("temperature", "top_p")
_REASONING_KEYS = ("reasoning",)
_TEXT_KEYS = ("text",)
_STORE_KEYS = ("store",)


def _is_retryable(exc: Exception) -> bool:
    if isinstance(exc, httpx.TimeoutException):
        return True
    try:
        from openai import APIStatusError
        if isinstance(exc, APIStatusError) and exc.status_code >= 500:
            return True
    except ImportError:
        pass
    return False


def _is_bad_request(exc: Exception) -> bool:
    try:
        from openai import BadRequestError
    except ImportError:
        return False
    return isinstance(exc, BadRequestError)


def _is_tools_unsupported(exc: Exception) -> bool:
    try:
        from openai import BadRequestError
    except ImportError:
        return False
    return isinstance(exc, BadRequestError)


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _dump(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        return dict(obj)
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump(exclude_none=True)
        except Exception:
            return {}
    return {}


def _has_any(kwargs: dict[str, Any], keys: tuple[str, ...]) -> bool:
    return any(k in kwargs for k in keys)


def _strip_keys(kwargs: dict[str, Any], keys: tuple[str, ...]) -> None:
    for k in keys:
        kwargs.pop(k, None)


class _ResponsesBackend:
    """OpenAI Responses API 后端。Duck-type 与另外三个 backend 一致。"""

    supports_native_tools = True

    # 进程内记忆：只记「已经证明被拒」的组，成功重试后才写。
    _unsupported_combos: set[tuple[str, str, Any]] = set()
    _sampling_rejected_combos: set[tuple[str, str, Any]] = set()
    _reasoning_rejected_combos: set[tuple[str, str, Any]] = set()
    _text_rejected_combos: set[tuple[str, str, Any]] = set()
    _store_rejected_combos: set[tuple[str, str, Any]] = set()

    def __init__(self, model: str, base_url: str, env_key: str,
                 display_kind: str = "openai_compat",
                 user_id: int | None = None, api_id: str | None = None,
                 model_meta: dict[str, Any] | None = None):
        from agents.gm.backends._client import prepare_openai_client

        prepared = prepare_openai_client(
            model=model, base_url=base_url, env_key=env_key,
            display_kind=display_kind, user_id=user_id, api_id=api_id,
        )
        self.client = prepared.client
        self.model_name = model
        self.kind = display_kind
        self.api_id = api_id or display_kind
        self.user_id = user_id
        self.api_format = "responses"
        self._model_meta = model_meta
        self._reasoning_override: dict[str, Any] | None = None
        self._last_effective_max_tokens: int | None = None
        self.last_usage: dict[str, Any] = {}
        log.info(f"[GM] {display_kind} · {model} (base={prepared.effective_base or 'default'}, "
                 f"key from {prepared.source}, format=responses)")

    # ── reasoning ────────────────────────────────────────────────────────

    def _reasoning_state(self):
        try:
            return resolve_spec_for_call(
                self.user_id, self.api_id, self.model_name,
                model_dict=getattr(self, "_model_meta", None),
                override=getattr(self, "_reasoning_override", None),
            )
        except Exception as exc:
            log.warning(f"[responses] reasoning resolve failed: {exc}")
            return ({"supported": False, "levels": ["auto"]}, "auto")

    def _reasoning_param(self, state=None) -> dict:
        spec, level = state if state is not None else self._reasoning_state()
        try:
            return build_responses_params(spec, level)
        except Exception as exc:
            log.warning(f"[responses] build reasoning params failed: {exc}")
            return {}

    def _effective_max_tokens(self, max_tokens: int, state=None) -> int:
        spec, level = state if state is not None else self._reasoning_state()
        try:
            out = int(effective_max_tokens(spec, level, int(max_tokens)))
        except Exception:
            out = int(max_tokens or 0)
        return max(out, _MIN_OUTPUT_TOKENS)

    def _sampling_kwargs(self, default_temperature: float) -> dict[str, Any]:
        try:
            from agents.gm.backends._gen_params import resolve_gen_params
            gen = resolve_gen_params(self.user_id)
        except Exception:
            gen = {}
        out: dict[str, Any] = {"temperature": gen.get("temperature", default_temperature)}
        if "top_p" in gen:
            out["top_p"] = gen["top_p"]
        return out

    def _tuning_kwargs(self, default_temperature: float, state=None) -> dict[str, Any]:
        out = self._sampling_kwargs(default_temperature)
        out.update(self._reasoning_param(state))
        return out

    # ── request / retry ──────────────────────────────────────────────────

    def _create(self, **kwargs):
        """responses.create 包装：400 时按「采样 → 思考 → 结构化 → store」分段退参。

        只有真正被拒的那一组才会被记住。tools 不在本函数剥离 —— 由调用方决定
        是否降级到 text marker（需要验证不带 tools 的请求确实被接受）。
        """
        combo = (self.api_id, self.model_name, self.user_id)
        if combo in self._sampling_rejected_combos:
            _strip_keys(kwargs, _SAMPLING_KEYS)
        if combo in self._reasoning_rejected_combos:
            _strip_keys(kwargs, _REASONING_KEYS)
        if combo in self._text_rejected_combos:
            _strip_keys(kwargs, _TEXT_KEYS)
        if combo in self._store_rejected_combos:
            _strip_keys(kwargs, _STORE_KEYS)
        if "max_output_tokens" in kwargs:
            try:
                kwargs["max_output_tokens"] = max(
                    _MIN_OUTPUT_TOKENS, int(kwargs["max_output_tokens"] or 0))
            except (TypeError, ValueError):
                kwargs["max_output_tokens"] = _MIN_OUTPUT_TOKENS
        self._last_effective_max_tokens = kwargs.get("max_output_tokens")

        try:
            return self.client.responses.create(**kwargs)
        except Exception as exc:
            if not _is_bad_request(exc):
                raise

            original_exc = exc
            trial = dict(kwargs)
            groups = (
                ("采样参数", _SAMPLING_KEYS, self._sampling_rejected_combos),
                ("思考参数", _REASONING_KEYS, self._reasoning_rejected_combos),
                ("结构化输出", _TEXT_KEYS, self._text_rejected_combos),
                ("store", _STORE_KEYS, self._store_rejected_combos),
            )
            for label, keys, memo in groups:
                if not _has_any(trial, keys):
                    continue
                _strip_keys(trial, keys)
                try:
                    resp = self.client.responses.create(**trial)
                except Exception as exc2:
                    if not _is_bad_request(exc2):
                        raise
                    original_exc = exc2
                    continue
                memo.add(combo)
                log.info(f"[responses] {self.api_id}/{self.model_name} 拒绝{label}(400)→ 已剥离重试成功")
                return resp
            raise original_exc from exc

    # ── message conversion / output parsing ──────────────────────────────

    @staticmethod
    def _message_text(content: Any) -> str:
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") in ("text", "input_text", "output_text"):
                    parts.append(str(part.get("text") or ""))
            return "".join(parts)
        return str(content or "")

    def _input_from_messages(self, system: str, messages: list[dict]) -> tuple[str, list[dict]]:
        instructions = str(system or "")
        items: list[dict] = []
        for m in messages or []:
            if not isinstance(m, dict):
                continue
            role = str(m.get("role") or "user")
            content = m.get("content")
            if role == "system":
                text = self._message_text(content)
                if text.strip():
                    instructions = (instructions + "\n\n" + text).strip() if instructions else text
                continue
            if role in ("user", "assistant"):
                text = self._message_text(content)
                if role == "assistant":
                    items.append({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text}],
                    })
                else:
                    items.append({"role": "user", "content": text})
                continue
            # 已是 Responses item（极少见，例如调用方直接传 function_call_output）
            if m.get("type"):
                items.append(dict(m))
            elif content:
                items.append({"role": "user", "content": self._message_text(content)})
        return instructions, items

    @staticmethod
    def _output_text(resp: Any) -> str:
        text = _get(resp, "output_text")
        if text:
            return str(text).strip()
        parts: list[str] = []
        for item in (_get(resp, "output") or []):
            if _get(item, "type") != "message":
                continue
            for c in (_get(item, "content") or []):
                if _get(c, "type") in ("output_text", "text"):
                    parts.append(str(_get(c, "text") or ""))
        return "".join(parts).strip()

    @staticmethod
    def _finish_reason(resp: Any, calls: list[Any] | None = None) -> str | None:
        if calls:
            return "tool_calls"
        status = str(_get(resp, "status") or "")
        if status == "incomplete":
            details = _get(resp, "incomplete_details")
            reason = str(_get(details, "reason") or "") if details else ""
            if reason == "max_output_tokens":
                return "length"
            if reason == "content_filter":
                return "content_filter"
            return reason or "length"
        if status in ("completed", "succeeded"):
            return "stop"
        return None

    def _capture_usage(self, resp: Any, *, finish_reason: str | None = None,
                       max_tokens: int | None = None) -> None:
        usage = _get(resp, "usage")
        if not usage:
            return

        def _num(*names: str) -> int:
            for name in names:
                val = _get(usage, name)
                if val is not None:
                    try:
                        return int(val)
                    except (TypeError, ValueError):
                        pass
            return 0

        input_tokens = _num("input_tokens", "prompt_tokens")
        output_tokens = _num("output_tokens", "completion_tokens")
        total_tokens = _num("total_tokens") or (input_tokens + output_tokens)
        in_details = _get(usage, "input_tokens_details") or _get(usage, "prompt_tokens_details") or {}
        out_details = _get(usage, "output_tokens_details") or _get(usage, "completion_tokens_details") or {}
        cached = int(_get(in_details, "cached_tokens", 0) or 0)
        reasoning = int(_get(out_details, "reasoning_tokens", 0) or 0)
        self.last_usage = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached,
            "reasoning_tokens": reasoning,
            "total_tokens": total_tokens,
        }
        fr = finish_reason or self._finish_reason(resp)
        if fr:
            self.last_usage["finish_reason"] = str(fr)
        if max_tokens:
            self.last_usage["max_tokens"] = int(max_tokens)

    # ── public backend contract ──────────────────────────────────────────

    def call(self, system: str, messages: list[dict], max_tokens: int) -> str:
        from core.prompt_log import log_llm_prompt
        log_llm_prompt(kind="gm_chat", api_id=self.api_id, model=self.model_name,
                       system=system, messages=messages)
        state = self._reasoning_state()
        instructions, input_items = self._input_from_messages(system, messages)
        tuning = self._tuning_kwargs(0.9, state)
        kwargs: dict[str, Any] = {
            "model": self.model_name,
            "input": input_items,
            "max_output_tokens": self._effective_max_tokens(max_tokens, state),
            "store": False,
            **tuning,
        }
        if instructions:
            kwargs["instructions"] = instructions

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES + 1):
            try:
                resp = self._create(**kwargs)
                break
            except Exception as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES and _is_retryable(exc):
                    log.warning(f"[responses] call attempt {attempt + 1} failed ({exc}), retrying…")
                    time.sleep(1.0)
                    continue
                raise
        else:  # pragma: no cover - 循环必然 break 或 raise
            raise last_exc  # type: ignore[misc]

        self._capture_usage(
            resp,
            finish_reason=self._finish_reason(resp),
            max_tokens=getattr(self, "_last_effective_max_tokens", max_tokens),
        )
        return self._output_text(resp)

    def call_structured(self, system: str, messages: list[dict], max_tokens: int) -> str:
        from core.prompt_log import log_llm_prompt
        log_llm_prompt(kind="gm_structured", api_id=self.api_id, model=self.model_name,
                       system=system, messages=messages)
        sys_text = (system or "") + "\n\n你必须只返回合法 JSON，不能包含 Markdown 代码围栏或解释文字。"
        state = self._reasoning_state()
        instructions, input_items = self._input_from_messages(sys_text, messages)
        kwargs: dict[str, Any] = {
            "model": self.model_name,
            "input": input_items,
            "max_output_tokens": self._effective_max_tokens(max_tokens, state),
            "store": False,
            "text": {"format": {"type": "json_object"}},
        }
        if instructions:
            kwargs["instructions"] = instructions
        resp = self._create(**kwargs)
        self._capture_usage(
            resp,
            finish_reason=self._finish_reason(resp),
            max_tokens=getattr(self, "_last_effective_max_tokens", max_tokens),
        )
        return self._output_text(resp)

    def probe(self, timeout_sec: float | None = None) -> str:
        """最小连通性请求：不带 system / 采样 / 思考。"""
        kwargs: dict[str, Any] = {
            "model": self.model_name,
            "input": "1",
            "max_output_tokens": 64,
            "store": False,
        }
        if timeout_sec:
            kwargs["timeout"] = float(timeout_sec)
        resp = self._create(**kwargs)
        return self._output_text(resp)

    def stream(self, system: str, messages: list[dict], max_tokens: int) -> Iterator[str]:
        from core.prompt_log import log_llm_prompt
        log_llm_prompt(kind="gm_chat_stream", api_id=self.api_id, model=self.model_name,
                       system=system, messages=messages)
        state = self._reasoning_state()
        instructions, input_items = self._input_from_messages(system, messages)
        kwargs: dict[str, Any] = {
            "model": self.model_name,
            "input": input_items,
            "max_output_tokens": self._effective_max_tokens(max_tokens, state),
            "store": False,
            "stream": True,
            **self._tuning_kwargs(0.9, state),
        }
        if instructions:
            kwargs["instructions"] = instructions

        saw_text = False
        final_resp = None
        for ev in self._create(**kwargs):
            etype = str(_get(ev, "type") or "")
            if etype == "response.output_text.delta":
                delta = _get(ev, "delta") or ""
                if delta:
                    saw_text = True
                    yield str(delta)
            elif etype == "response.completed":
                final_resp = _get(ev, "response")
            elif etype in ("response.failed", "error"):
                err = _get(ev, "error") or _get(_get(ev, "response"), "error") or etype
                raise RuntimeError(f"responses stream failed: {err}")

        if final_resp is not None:
            self._capture_usage(
                final_resp,
                finish_reason=self._finish_reason(final_resp),
                max_tokens=getattr(self, "_last_effective_max_tokens", max_tokens),
            )
            # 部分网关只发 completed、不发 delta；兜底一次性吐出最终正文。
            if not saw_text:
                text = self._output_text(final_resp)
                if text:
                    yield text

    # ── native tools loop ────────────────────────────────────────────────

    def stream_with_mcp_loop(
        self,
        system: str,
        messages: list[dict],
        mcp_tools: list[dict[str, Any]],
        max_iterations: int,
        max_tokens: int,
        mcp_call,
    ) -> Iterator[dict[str, Any]]:
        combo_key = (self.api_id, self.model_name, self.user_id)
        if combo_key in self._unsupported_combos:
            yield from _openai_text_marker_loop(
                self, system, messages, mcp_tools, max_iterations, max_tokens, mcp_call)
            return

        sep = "__"
        from agents.gm.backends import _tiered
        from core.config import tiered_tools_enabled as _tiered_enabled
        from core.config import tool_window_size as _tool_window

        def _mk_tool(t: dict[str, Any]) -> dict[str, Any] | None:
            sid = str(t.get("server_id", ""))
            tname = str(t.get("name", ""))
            if not sid or not tname:
                return None
            full_name = _tiered.tool_full_name(t)
            schema_raw = t.get("schema") or {"type": "object", "properties": {}}
            if not isinstance(schema_raw, dict):
                schema_raw = {"type": "object", "properties": {}}
            if schema_raw.get("type") != "object":
                schema_raw = {"type": "object", "properties": schema_raw.get("properties", {})}
            # Responses 的工具是平铺结构（name/description/parameters 在顶层）。
            return {
                "type": "function",
                "name": full_name,
                "description": (t.get("description") or "")[:512],
                "parameters": schema_raw,
            }

        window_tools, overflow_index, catalog_lines = _tiered.split_window(
            mcp_tools, _tool_window(), _tiered_enabled())
        loaded_overflow: set[str] = set()
        tools: list[dict[str, Any]] = []
        for t in window_tools:
            m = _mk_tool(t)
            if m:
                tools.append(m)
        if catalog_lines:
            tools.append({
                "type": "function",
                "name": _tiered.LOAD_TOOLS_FULL_NAME,
                "description": _tiered.load_tools_description(catalog_lines),
                "parameters": _tiered.LOAD_TOOLS_PARAMS,
            })

        if not tools:
            for chunk in self.stream(system, messages, max_tokens=max_tokens):
                yield {"type": "text", "text": chunk}
            return

        instructions, input_items = self._input_from_messages(system, messages)
        state = self._reasoning_state()
        effective_max = self._effective_max_tokens(max_tokens, state)
        first_attempt = True

        for iteration in range(max_iterations):
            calls: list[Any] = []
            saw_text = False
            final_resp = None
            try:
                from core.prompt_log import log_llm_prompt
                log_llm_prompt(kind="gm_chat_stream", api_id=self.api_id, model=self.model_name,
                               messages=input_items)
                kwargs: dict[str, Any] = {
                    "model": self.model_name,
                    "input": input_items,
                    "max_output_tokens": effective_max,
                    "store": False,
                    "tools": tools,
                    "tool_choice": "auto",
                    "stream": True,
                    **self._tuning_kwargs(0.9, state),
                }
                if instructions:
                    kwargs["instructions"] = instructions
                for ev in self._create(**kwargs):
                    etype = str(_get(ev, "type") or "")
                    if etype == "response.output_text.delta":
                        delta = _get(ev, "delta") or ""
                        if delta:
                            saw_text = True
                            yield {"type": "text", "text": str(delta)}
                    elif etype in ("response.reasoning_summary_text.delta", "response.reasoning_text.delta"):
                        delta = _get(ev, "delta") or ""
                        if delta:
                            yield {"type": "reasoning", "text": str(delta)}
                    elif etype == "response.output_item.done":
                        item = _get(ev, "item")
                        if str(_get(item, "type") or "") == "function_call":
                            calls.append(item)
                    elif etype == "response.completed":
                        final_resp = _get(ev, "response")
                    elif etype in ("response.failed", "error"):
                        err = _get(ev, "error") or _get(_get(ev, "response"), "error") or etype
                        raise RuntimeError(f"responses stream failed: {err}")
            except Exception as exc:
                if first_attempt and _is_tools_unsupported(exc):
                    log.warning(f"[gm] {self.api_id}/{self.model_name} Responses 带 tools 首跳被拒(400): {exc}"
                                f" → 本轮改走 text marker,不带 tools 能通才记为不支持")
                    marked = False
                    for ev in _openai_text_marker_loop(
                            self, system, messages, mcp_tools, max_iterations, max_tokens, mcp_call):
                        if not marked:
                            self._unsupported_combos.add(combo_key)
                            marked = True
                            log.warning(f"[gm] {self.api_id}/{self.model_name} 不带 tools 的请求被接受"
                                        f" → 本进程内记为不支持 native tools")
                        yield ev
                    return
                raise
            first_attempt = False

            if final_resp is not None:
                if not calls:
                    calls = [
                        item for item in (_get(final_resp, "output") or [])
                        if str(_get(item, "type") or "") == "function_call"
                    ]
                self._capture_usage(
                    final_resp,
                    finish_reason=self._finish_reason(final_resp, calls),
                    max_tokens=getattr(self, "_last_effective_max_tokens", effective_max),
                )
                # 流式没给 delta 时用最终 output 兜底；工具轮通常正文为空。
                if not calls and not saw_text:
                    text = self._output_text(final_resp)
                    if text:
                        yield {"type": "text", "text": text}

            if not calls:
                return

            # 把本轮 assistant 输出（message + function_call）回填到下一轮 input。
            # 少数网关只发 output_item.done、不发 completed：没有 final_resp 时至少把
            # 已收集到的 function_call item 回填，保证工具循环仍能继续。
            if final_resp is not None:
                for item in (_get(final_resp, "output") or []):
                    itype = str(_get(item, "type") or "")
                    if itype in ("message", "function_call"):
                        dumped = _dump(item)
                        if dumped:
                            input_items.append(dumped)
            else:
                for item in calls:
                    dumped = _dump(item)
                    if dumped:
                        input_items.append(dumped)

            for idx, item in enumerate(calls):
                full_name = str(_get(item, "name") or "")
                call_id = str(_get(item, "call_id") or f"call_{iteration}_{idx}")
                try:
                    args = json.loads(str(_get(item, "arguments") or "{}"))
                    if not isinstance(args, dict):
                        args = {}
                except Exception:
                    args = {}
                if sep in full_name:
                    server_id, _, tool_name = full_name.partition(sep)
                else:
                    server_id, tool_name = "", full_name

                if _tiered.is_load_tools(server_id, tool_name):
                    newly, ack = _tiered.resolve_load(args, overflow_index, loaded_overflow)
                    for t in newly:
                        m = _mk_tool(t)
                        if m:
                            tools.append(m)
                    yield {"type": "tool_call", "server_id": "tiered",
                           "tool": "load_tools", "arguments": args}
                    yield {"type": "tool_result", "ok": bool(newly), "result": ack, "error": None}
                    input_items.append({
                        "type": "function_call_output", "call_id": call_id, "output": ack,
                    })
                    continue

                yield {"type": "tool_call", "server_id": server_id,
                       "tool": tool_name, "arguments": args}
                if not tool_name:
                    result = {"ok": False, "error": "这次工具调用没有工具名,未执行。请带上工具名重新调用。"}
                else:
                    try:
                        result = mcp_call(server_id, tool_name, args)
                    except Exception as exc:
                        result = {"ok": False, "error": f"call_tool 异常: {exc}"}
                if not isinstance(result, dict):
                    result = {"ok": False, "error": f"工具返回了非 dict 结果: {result!r}"}
                yield {
                    "type": "tool_result", "ok": bool(result.get("ok")),
                    "result": result.get("result"), "error": result.get("error"),
                }
                truncated = json.dumps(result, ensure_ascii=False)[:2000]
                input_items.append({
                    "type": "function_call_output", "call_id": call_id, "output": truncated,
                })

        yield {"type": "text",
               "text": "\n\n【已达本轮工具调用上限 (限制为本次回复内的调用次数,下一条消息自动重置),本轮终止】"}
