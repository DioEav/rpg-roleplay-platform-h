---
title: "Settings: Modules"
description: "Meadhall uses several internal AI sub-modules, each responsible for a distinct task — primary narration, intent parsing, vector embedding, image generation, and more. Assign a specific model to any module, or set your personal default GM model. Modules without an explicit override inherit from the primary GM."
---

Meadhall uses several internal AI sub-modules, each responsible for a distinct task — primary narration, intent parsing, vector embedding, image generation, and more. Assign a specific model to any module, or set your personal default GM model. Modules without an explicit override inherit from the primary GM.

Navigation: top bar **Settings** → **Module Models** (left sidebar).

---

## Key Concepts

### Primary GM Default Model

The first row in the list is the **Primary GM Default Model**. It is saved to your personal preferences and applies to all new sessions and any saved game that has not had its model individually changed. All other modules inherit from this model unless overridden.

### Module Override

Each module row has its own model selector. Selecting **Follow Primary GM** (or leaving it blank) clears the override and restores inheritance. The vector embedding and image generation modules are exceptions — they require an explicit selection and do not support inheritance.

### Model List Source

The selector only lists models from providers you have configured in **API Keys** that have been successfully synced. If a model is missing, go to **API Keys** and confirm that the corresponding provider key has been added correctly.

---

## Module Reference

| Module | Purpose | Recommended tier |
|---|---|---|
| Primary GM Default | Core narrative model for player conversation | Flagship |
| Context sub-agent | Structures player intent and retrieval plans from ambiguous input | Mid-range |
| Command parsing agent | Translates `/set` natural language commands into structured operations | Mid-range or small |
| Console assistant | Dedicated model for the admin sidebar console | Same tier as primary GM |
| Narrative extractor | Secondary parse of GM output to extract state operations (step 2 of two-step GM mode) | Cheap/small |
| Character card generator | Creative tool in the sidebar for generating or refining character cards | Mid-range to flagship |
| AI field organizer | Used when importing Tavern cards with **Organize fields with AI** checked — converts free text into structured fields | Mid-range or small |
| Consistency scorer | Scores character card generation output for consistency (0–1, threshold 0.6) | Cheap/small |
| Acceptance validator | Checks whether GM output satisfies curator acceptance conditions | Cheap/small |
| Compact summarizer | Condenses long session history into phase summaries for GM long-term recall | Mid-range or small |
| Black swan event agent | Sub-agent that proactively triggers world events | Mid-range |
| Generic sub-agent fallback | Used by any sub-agent that does not have a dedicated model assigned | Mid-range |
| Vector embedding (RAG) | Embedding model for memory retrieval and semantic search after book parsing | Dedicated embedding model |
| Image generation | All AI image generation — chat images, character avatars, script covers, character sheets | Dedicated image model |

---

## Common Tasks

### Change the Primary GM Default Model

1. Go to **Settings → Module Models**.
2. Find the **Primary GM Default Model** row and click the selector on the right.
3. Choose a model from the list. The change saves immediately and takes effect the next time a new session is created or an existing session without a model override is loaded.

### Assign a Model to a Specific Module

1. Find the module row and click its selector.
2. Choose from the list of synced models or type a model ID directly.
3. The change saves immediately — no confirmation button is needed.

### Clear a Module Override (Restore Inheritance)

1. Find the module's selector and choose **Follow Primary GM** (usually the first item or the blank option).
2. The change takes effect immediately. The module will track future changes to the primary GM model automatically.

### Configure the Vector Embedding Model

The vector embedding module requires a model that supports the embedding API — standard chat models are not compatible.

1. In **API Keys**, add a key for a provider that offers embedding (e.g. Vertex AI, OpenAI, Cohere).
2. In the **Vector Embedding (RAG)** row, select the appropriate embedding model.
3. Note: switching the embedding model requires re-embedding any scripts that were previously processed. Old vectors are not compatible with the new model.

Users without an embedding key will see RAG retrieval fall back to a degraded mode. Admin and VIP users have a platform fallback (Gemini free tier); the configuration page shows the current fallback status below that row.

### Configure the Image Generation Model

1. In **API Keys**, add a key for a provider that supports image generation (e.g. Vertex AI, Doubao, Tongyi).
2. In the **Image Generation** row, select the target model. This selection is synchronized with the model picker in the image generation dialog.
3. If no image generation key is configured, Meadhall prompts you to add one when you attempt to generate an image — it does not fail silently.

---

## FAQ

**Q: The model I want isn't in the list.**
A: The list only includes models from providers with a successfully synced key. Go to **API Keys**, add the key for that provider, and click **Fetch Models** to sync.

**Q: What is the narrative extractor and do I need it?**
A: The narrative extractor is the second step of the two-step GM mode. The primary GM generates narrative text; the extractor then parses that text into structured state operations. Enabling it improves state consistency but increases API cost by roughly 20% per turn. The default single-step GM is sufficient for most users — consider enabling two-step mode only if you encounter persistent state inconsistencies.

**Q: When do module model changes take effect?**
A: Changes are saved immediately. Each backend module reads its configuration on the next invocation. Active conversations are not interrupted — the new model applies starting from the next message.

**Q: Can Anthropic or DeepSeek models be used for vector embedding?**
A: No. Neither provider offers an embedding API, so neither appears in the vector embedding model selector.

**Q: What is the generic sub-agent fallback for?**
A: When a sub-agent has no dedicated model assigned, the platform first checks the primary GM setting. The generic sub-agent fallback provides an additional middle layer for unified management of sub-agents without individual configurations. In most cases, leaving it to follow the primary GM is sufficient.

---

## Related

- [API Keys and Model Configuration](/en/settings-models)
- [Model Parameters](/en/settings-modelparams)
- [Image Generation](/en/image-gen)
- [Memory Settings](/en/settings-memory)
