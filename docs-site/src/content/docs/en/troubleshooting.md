---
title: Troubleshooting
description: Step-by-step guidance for the most common setup blockers in Meadhall, including BYOK model configuration failures, credentials_required errors, and local model timeouts.
---

This page covers the setup issues new users encounter most often. If you have not yet completed key configuration, start with [Getting Started](/en/getting-started) and [Model Setup](/en/settings-models). This guide assumes you have registered an account and attempted to add a key.

---

## Model and API key problems

### I added a key but no models appear in the selector

This is the most common first-run blocker. The usual causes are:

**1. The key failed the connectivity check**

After you add a key, the platform automatically fetches the model list from the provider. If the network is unreachable or the key is invalid, this sync fails and the provider shows as "unreachable." Its models will not appear in any selector.

Steps to diagnose:
- Open **Settings → Model Setup** and check the provider's status indicator.
- Click the provider to open the details panel and click **Check Connection** to see the specific error.
- Common failure reasons: incorrect key (extra spaces or missing characters), wrong Base URL (especially Google AI Studio), or network restrictions blocking outbound connections to overseas providers.

**2. The provider toggle is turned off**

Each provider row has an on/off toggle on the right. When turned off (grey), all models from that provider are hidden across the entire platform, even if the key is valid. Toggle it back on.

**3. All individual models are hidden**

The "Manage visible models" dialog lets you hide specific models. If every model under a provider was hidden, the selector will be empty. Open the details panel, click "Manage visible models," and re-enable the models you need.

**4. The model list was never synced**

If the initial sync failed due to a transient network error, the local model list is empty. Manually trigger a sync by clicking **Check Connection** in the provider details panel.

---

### What does "credentials_required" mean and how do I fix it?

`credentials_required` is a standardized error signal returned by the backend. It means the operation requires a model whose provider has no configured API key.

When the frontend detects this signal, it shows a blocking modal with two resolution paths:
- **Switch model**: pick a model from a provider that already has a working key; or
- **Add key**: fill in an API key for the required provider inline in the modal — the platform saves the key and retries automatically.

This error appears when:
- You send a message in a game but the currently selected model's provider has no key.
- You trigger image generation, script extraction, or another capability whose required provider has no key.

The definitive fix is to go to **Settings → Model Setup**, add a valid key for the provider, and confirm the status turns green.

---

### How do I confirm a key is working?

Reliable confirmation steps:

1. Open **Settings → Model Setup** and locate the provider.
2. The connectivity status indicator on the provider row should be green (reachable).
3. Open the provider details panel and switch to the **Models** tab — you should see a non-empty list of synced models.
4. Open the model selector in-game (top of the game view) or in **Settings → Module Configuration** — models from that provider should be listed.

If step 2 shows yellow (degraded) or red (unreachable), click **Check Connection** to see the specific error message from the provider.

---

### What Base URL should I enter for an OpenAI-compatible endpoint?

| Scenario | Base URL |
|---|---|
| OpenAI (official) | `https://api.openai.com/v1` (default, no change needed) |
| Google AI Studio (Gemini) | `https://generativelanguage.googleapis.com/v1beta/openai` (must include `/v1beta/openai`) |
| Relay / custom proxy | `https://your-relay.example.com/v1` |
| Local vLLM / Ollama | `http://127.0.0.1:8000/v1` |
| DashScope (Qwen) OpenAI-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` |

**The most common mistake**: Google AI Studio's Base URL entered as `https://generativelanguage.googleapis.com/v1beta`, missing the trailing `/openai` segment. Every request will return 404. The correct path is `/v1beta/openai`.

Base URL is a per-user credential field — changes only affect your own account and do not modify the global catalog.

**Using a relay**: select the matching provider (or "Custom") in the provider dropdown, replace the Base URL with the relay address, and enter the relay-issued key.

---

### What is the difference between an embedding model and a chat model? Why do I need to configure them separately?

**Chat models (LLM)** handle narrative generation, intent parsing, character card extraction, and all other text-generation tasks.

**Embedding models** convert text into numeric vectors for memory retrieval and semantic book search (RAG). This is a distinct API — standard chat models cannot serve as embedding models.

The two types must be configured separately because:
- The set of providers that offer an embedding API is a different subset. **Anthropic and DeepSeek do not provide an embedding API** and will not appear in the embedding model selector even if you have valid keys for them.
- Providers that support embedding include Vertex AI (Google), OpenAI, Cohere, and others.

**Configuration path**: **Settings → Module Configuration** → **Vector Embedding (RAG)** row → select an embedding model.

Users without an embedding key will see RAG retrieval fall back to a degraded mode. Admin and VIP users have a platform fallback (Gemini free tier); the configuration page shows the current fallback status beneath the row.

After switching embedding models, previously indexed scripts must be re-embedded — old vectors are not compatible with a new model.

---

## Game playback problems

### Clicking "Start" or "Send" does nothing

Diagnose in order:

1. **No usable model** — the model selector is empty or the current model is unavailable. Check **Settings → Model Setup** and confirm at least one provider shows green, with models visible in the selector.

2. **Credentials intercept** — the backend returned `credentials_required` and the frontend raised a blocking modal. Check whether the modal is present (it may be behind another layer), then follow its prompts to add a key or switch models.

3. **Network timeout** — the request was sent but received no response. Open the browser's developer tools (Network tab) and check whether a request is hanging indefinitely. If using overseas providers, verify your proxy settings.

4. **Script not ready** — in the new-game wizard, scripts marked "not ready" disable the Start button. Wait for background extraction to finish (the status column in Script Management turns green) then try again.

---

### My local model is very slow or requests time out mid-generation

Local deployments (desktop app or self-hosted) running CPU inference often need several minutes to produce the first token. The default timeout may not be sufficient.

**Default timeout values:**
- Server deployment: 300 seconds
- Local / desktop deployment: 1800 seconds

**How to adjust:** go to **Settings → Model Parameters** → **Request Timeout** and enter the desired value in seconds. The ceiling for local deployment is 7200 seconds (2 hours); for server deployment it is 900 seconds.

If timeouts are frequent but the local model itself is functional:
- Reduce **Max Tokens** to shorten individual generation runs.
- Switch to a smaller local model.
- Confirm the local inference server (vLLM, llama.cpp, etc.) is still running and has the model loaded.

---

### A save fails to load, or the game shows a loading spinner indefinitely

1. Refresh the page — transient network issues usually resolve on reload.
2. Check the browser console for error messages; the specific text helps narrow down the cause.
3. Verify the selected model is available: click the model label at the top of the game view to inspect the current selection.
4. If the spinner persists for more than five minutes, go to **Settings → Model Setup** and click **Check Connection** to confirm the provider is reachable.

---

## Network and connectivity

### Overseas providers are unreachable from my region

Providers such as OpenAI, Anthropic, and Google AI Studio may be inaccessible without a proxy in certain regions.

Options (choose one):

- **HTTP proxy**: when adding or editing a key, set "Connection type" to "HTTP Proxy" and enter your local proxy address (for example `http://127.0.0.1:7890`). The address must use the `http://` scheme.
- **OpenRouter**: a single OpenRouter key aggregates dozens of providers through OpenRouter's endpoint. Register at openrouter.ai, select "OpenRouter" in the provider dropdown, and enter your key.
- **Regional providers**: DashScope (Qwen), DeepSeek, and Hunyuan are domestic providers that do not require a proxy.

Proxy settings are per-user and only affect your own API calls.

---

## Related

- [Model Setup](/en/settings-models) — add keys, manage providers, sync model lists
- [Module Configuration](/en/settings-modules) — assign models to GM, extraction, embedding, and other sub-modules
- [Model Parameters](/en/settings-modelparams) — adjust request timeout and sampling parameters
- [Getting Started](/en/getting-started) — complete walkthrough from registration to first game
