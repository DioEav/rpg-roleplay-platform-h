"""agents.image_gen.vertex — Vertex AI (Gemini image) 图片适配器。

复用平台 Service Account（core.vertex_sa.load_sa_credentials）认证，无需用户 BYOK
api_key 字符串。模型如 gemini-3.1-flash-image / gemini-3-pro-image 通过
generate_content 的 IMAGE response modality 返回内联图片字节。
"""
from __future__ import annotations

from typing import Any

from agents.image_gen.base import ImageGenError, reference_images


def _reference_image_cap(model: str) -> int | None:
    """该 Vertex 模型支持的参考图张数上限;不支持返回 None。

    Gemini 图像模型(名字含 image)走 GenerateContent 的多模态 contents —— 与文本并列塞
    image part 即可 i2i/多图融合;官方建议 ≤3 张(更多效果递减),代码截 6 张留余量。
    Imagen 系是纯文生图,不吃参考图。上限数字以官方文档为准。
    """
    m = (model or "").lower()
    if "imagen" in m:
        return None
    return 6 if "image" in m else None


def generate(
    prompt: str,
    params: dict[str, Any],
    *,
    api_id: str,
    model: str,
    api_key: str = "",
    base_url: str | None = None,
    user_id: int | None = None,
) -> list[bytes]:
    """用 Vertex SA 调 Gemini image 模型生图，返回图片字节列表。

    api_key 被忽略（Vertex 走 SA）；user_id 用于 load_sa_credentials（生产鉴权模式取
    用户 BYOK SA，本地匿名模式取全局 SA）。
    """
    try:
        from google import genai
        from google.genai import types

        from core.vertex_sa import load_sa_credentials
    except Exception as exc:  # pragma: no cover - import env issue
        raise ImageGenError(f"vertex genai import failed: {exc}") from exc

    credentials, project_id = load_sa_credentials(user_id)
    if credentials is None or project_id is None:
        raise ImageGenError(
            "vertex SA unavailable — 该用户无可用 Service Account"
            "（生产模式需在 设置 → API & 模型 上传 SA）"
        )

    client = genai.Client(
        vertexai=True,
        project=project_id,
        location="global",
        credentials=credentials,
    )

    # 参考图(i2i):与文本并列塞进 contents —— Gemini 图像模型原生吃多模态输入。
    # contents 接受 str 与 Part 混排(SDK 把 str 转 text part);上限不支持的模型(Imagen)
    # **显式抛错**,不静默丢图。
    contents: list[Any] = [prompt]
    refs = reference_images(params)
    if refs:
        _cap = _reference_image_cap(model)
        if _cap is None:
            raise ImageGenError(
                f"vertex: 模型「{model}」不支持参考图 —— Imagen 是纯文生图,"
                f"请改选 Gemini 图像模型（名字含 image）"
            )
        for _b, _mime in refs[:_cap]:
            contents.append(types.Part.from_bytes(data=_b, mime_type=_mime))

    try:
        resp = client.models.generate_content(
            model=model,
            contents=contents,
            config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
        )
    except Exception as exc:
        raise ImageGenError(f"vertex generate_content failed: {exc}") from exc

    images: list[bytes] = []
    for cand in (getattr(resp, "candidates", None) or []):
        content = getattr(cand, "content", None)
        for part in (getattr(content, "parts", None) or []):
            inline = getattr(part, "inline_data", None)
            data = getattr(inline, "data", None) if inline else None
            if data:
                images.append(bytes(data))

    if not images:
        # 无图片部分：可能被安全过滤或模型只返回了文本，带上文本帮助诊断
        txt = ""
        try:
            txt = getattr(resp, "text", None) or ""
        except Exception:
            txt = ""
        raise ImageGenError(f"vertex returned no image part (text={txt[:200]!r})")

    return images
