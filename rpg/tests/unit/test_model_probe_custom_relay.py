"""单模型探查必须支持自建中转站。

自建中转站 / 用户同步模型只存在于 per-user overlay,全局 catalog 没有。
probe_availability 传了 user_id 时必须用 load_catalog_for_user,否则会在
find_api 处直接返回「api_id 不存在」,用户永远无法探查自己正在用的渠道。
"""
import model_probe
import model_registry


def _reset_health():
    model_probe._HEALTH_CACHE.clear()


def test_probe_availability_uses_user_catalog_for_custom_relay(monkeypatch):
    _reset_health()
    user_catalog = {"apis": [{
        "id": "myrelay",
        "_custom": True,
        "enabled": True,
        "models": [{"id": "mimo-v2.6-flash", "real_name": "mimo-v2.6-flash"}],
    }]}

    monkeypatch.setattr(model_registry, "load_catalog_for_user", lambda uid: user_catalog)
    monkeypatch.setattr(model_registry, "load_model_catalog", lambda: {"apis": []})
    monkeypatch.setattr(model_probe, "_require_user_credential", lambda: False)

    seen = {}

    class _FakeBackend:
        def probe(self, timeout_sec=None):
            seen["probe_timeout"] = timeout_sec
            return "1"

    class _FakeGM:
        def __init__(self, api_id, model, user_id):
            seen["gm"] = (api_id, model, user_id)
            self._backend = _FakeBackend()

    import agents.gm as gm_mod
    monkeypatch.setattr(gm_mod, "GameMaster", _FakeGM)

    out = model_probe.probe_availability(
        "myrelay", "mimo-v2.6-flash", timeout_sec=5, user_id=7)

    assert out["ok"] is True
    assert out["model_used"] == "mimo-v2.6-flash"
    assert seen["gm"] == ("myrelay", "mimo-v2.6-flash", 7)
    # 探查走最小 probe(不带 system/采样/思考参数),timeout 透传到 backend
    assert seen["probe_timeout"] == 5
    # health cache 已写入 → /api/models 能立即回显探查结果
    cached = model_probe.get_health("myrelay", "mimo-v2.6-flash")
    assert cached and cached["status"] == "ok"


def test_probe_availability_skips_embedding_models(monkeypatch):
    """embedding 模型不做 chat 探查:直接返回 unsupported,且不污染健康状态。"""
    _reset_health()
    user_catalog = {"apis": [{
        "id": "myrelay",
        "_custom": True,
        "enabled": True,
        "models": [{
            "id": "bge-m3",
            "real_name": "bge-m3",
            "capabilities": ["embedding"],
        }],
    }]}
    monkeypatch.setattr(model_registry, "load_catalog_for_user", lambda uid: user_catalog)
    monkeypatch.setattr(model_registry, "load_model_catalog", lambda: {"apis": []})
    monkeypatch.setattr(model_probe, "_require_user_credential", lambda: False)

    out = model_probe.probe_availability("myrelay", "bge-m3", user_id=7)

    assert out["ok"] is False
    assert out["status_detail"] == "unsupported"
    assert "embedding" in out["error"]
    assert model_probe.get_health("myrelay", "bge-m3") is None


def test_get_capabilities_detects_tts_and_asr():
    """TTS / ASR 不能沿用同步默认的 text/streaming;前缀默认表也不能把它们拉回 chat。"""
    tts = model_probe.get_capabilities(
        "myrelay", "mimo-v2.5-tts", ["text", "streaming"])
    assert "audio_gen" in tts
    assert "text" not in tts and "streaming" not in tts

    # gpt-4o-mini-tts 会命中 gpt-4o-mini 前缀默认(tools/json_mode 等),
    # 但 TTS 名称必须覆盖这些继承值。
    tts2 = model_probe.get_capabilities(
        "openai", "gpt-4o-mini-tts", ["text", "streaming"])
    assert tts2 == ["audio_gen"]

    asr = model_probe.get_capabilities(
        "myrelay", "whisper-large-v3", ["text", "streaming"])
    assert "asr" in asr and "audio_input" in asr
    assert "text" not in asr and "streaming" not in asr
    assert model_probe.CAPABILITY_LABELS["asr"] == "语音识别"

    # 普通聊天模型不受影响
    chat = model_probe.get_capabilities(
        "myrelay", "mimo-v2.5", ["text", "streaming"])
    assert "text" in chat and "audio_gen" not in chat and "asr" not in chat

    # 多模态聊天(音频输入)仍保留 text,不会被误判成 ASR
    mm = model_probe.get_capabilities(
        "myrelay", "gpt-4o-audio-preview",
        ["text", "streaming", "audio_input"])
    assert "text" in mm and "audio_input" in mm

    # embedding 模型也不能保留同步默认的 text/streaming
    emb = model_probe.get_capabilities(
        "myrelay", "text-embedding-3-small", ["text", "streaming"])
    assert emb == ["embedding"]


def test_probe_availability_skips_tts_models(monkeypatch):
    """同步默认 caps 是 text/streaming 的 TTS 模型,探查也必须按名字识别并跳过。"""
    _reset_health()
    user_catalog = {"apis": [{
        "id": "myrelay",
        "_custom": True,
        "enabled": True,
        "models": [{
            "id": "mimo-v2.5-tts",
            "real_name": "mimo-v2.5-tts",
            "capabilities": ["text", "streaming"],
        }],
    }]}
    monkeypatch.setattr(model_registry, "load_catalog_for_user", lambda uid: user_catalog)
    monkeypatch.setattr(model_registry, "load_model_catalog", lambda: {"apis": []})
    monkeypatch.setattr(model_probe, "_require_user_credential", lambda: False)

    out = model_probe.probe_availability("myrelay", "mimo-v2.5-tts", user_id=7)

    assert out["ok"] is False
    assert out["status_detail"] == "unsupported"
    assert "不是对话模型" in out["error"]
    assert model_probe.get_health("myrelay", "mimo-v2.5-tts") is None


def test_openai_compat_probe_is_minimal():
    """探查请求必须不带 system / 采样 / 思考参数,且 timeout 透传到 SDK。"""
    from agents.gm.backends.openai_compat import _OpenAICompatBackend

    backend = object.__new__(_OpenAICompatBackend)
    backend.model_name = "mimo-v2.6-flash"

    seen = {}

    class _Message:
        content = "1"

    class _Choice:
        message = _Message()

    class _Response:
        choices = [_Choice()]

    class _Completions:
        def create(self, **kwargs):
            seen.update(kwargs)
            return _Response()

    class _Chat:
        completions = _Completions()

    class _Client:
        chat = _Chat()

    backend.client = _Client()

    assert backend.probe(timeout_sec=12) == "1"
    assert seen["model"] == "mimo-v2.6-flash"
    assert seen["messages"] == [{"role": "user", "content": "1"}]
    assert seen["max_tokens"] == 64
    assert seen["timeout"] == 12.0
    # 关键:不携带任何 system / 采样 / 思考字段
    assert "system" not in seen
    assert "temperature" not in seen
    assert "top_p" not in seen
    assert "reasoning_effort" not in seen
    assert "extra_body" not in seen
