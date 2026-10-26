---
title: "Settings: Memory"
description: "Control the GM's memory injection behavior — how many source passages are retrieved each turn, how many tokens are injected, when old memories are archived, and the toggles and capacity limits for each of the three memory buckets."
---

Control the GM's memory injection behavior — how many source passages are retrieved each turn, how many tokens are injected, when old memories are archived, and the toggles and capacity limits for each of the three memory buckets. Tuning these parameters lets you balance the GM's recall breadth against context cost and response latency.

Navigation: top bar **Settings** → **Memory** (left sidebar).

---

## Key Concepts

### Retrieval and Injection

Each turn, the system retrieves the passages most relevant to the current scene from the memory store (retrieval), then writes the results into the AI prompt for that turn (injection). More injected content gives the GM broader recall but increases token usage.

### Memory Buckets

Memories are organized into three typed buckets:

- **Pinned bucket**: Important facts pinned manually by you or the GM. Highest priority — all pinned entries up to the pinned cap are candidates, then trimmed by the token budget.
- **World bucket**: Main quest/objective, narrative facts, player notes, and archived summaries. Injected by recency window, not dumped in full.
- **Character bucket**: Persistent character state such as abilities and resources. Injected by recency window.

Each bucket can be enabled or disabled independently. Disabling a bucket removes its contents from every prompt path (MemoryProvider is the single injection source).

### Fact Store

When memories are archived, they move into the fact store. Their content is not deleted — it is simply demoted from "injected every turn" to "retrieved only when relevant."

---

## Parameters

### Memory: Retrieval Behavior

| Parameter | Description | Default | Range |
|---|---|---|---|
| Default retrieval depth | Number of most recent entries injected per non-pinned bucket | 8 | 2–20 |
| History summary window | The most recent N turns compressed into a summary and fed to the model | 10 | 3–20 |
| Memory token budget per turn | Maximum tokens of memory content injected into context per request | 1600 | 200–5000 (step 50) |
| Auto-archive after N turns | Memory entries older than this turn count are automatically moved to the fact store | 50 | 10–200 (step 5) |

Retrieval depth and the token budget both constrain the final injected volume. Pinned memory ignores retrieval depth: all pinned entries up to the pinned cap are candidates, then trimmed by the token budget.

### Memory: Bucket Configuration

| Parameter | Description | Default |
|---|---|---|
| Pinned bucket capacity | Maximum number of pinned entries (5–100); also the per-turn injection candidate cap, trimmed by the token budget | 20 |
| Enable pinned bucket | When disabled, the pinned bucket is not maintained; retrieval uses only the world and character buckets | On |
| Enable world bucket | When disabled, world-book memories are skipped during retrieval | On |
| Enable character bucket | When disabled, character-relationship memories are skipped during retrieval | On |

---

## Common Tasks

### Adjust Retrieval Depth or Token Budget

1. Go to **Settings → Memory** and locate the target parameter in the **Memory: Retrieval Behavior** section.
2. Drag the slider or type a value directly into the numeric field on the right.
3. The value is saved automatically when you release the slider or the field loses focus. No save button is needed.

### Disable a Memory Bucket

1. In the **Memory: Bucket Configuration** section, find the toggle for the bucket you want to disable (e.g. **Enable world bucket**).
2. Click the toggle to set it to **Disabled**. The change takes effect immediately for subsequent turns.

### Adjust the Pinned Bucket Capacity

1. In **Memory: Bucket Configuration**, locate the **Pinned bucket capacity** field.
2. Enter a value between 5 and 100. The setting saves when the field loses focus.

> If you lower the capacity below the current number of pinned entries, the excess entries are moved to the fact store one by one during the next write operation.

---

## Tuning Recommendations

### Early in a Campaign (Few Memories)

The defaults (retrieval depth 6, token budget 800) are sufficient for most sessions — no adjustment needed.

### Mid to Late Campaign (Large Memory Backlog)

- Increase retrieval depth to 8–12 so the GM can see more relevant history.
- Increase the token budget to 1000–1500 to accommodate more retrieved content.
- Lower the auto-archive threshold to 30–40 to move old memories into the fact store sooner and prevent the memory store from growing unwieldy.

### Reducing API Cost

- Lowering the token budget (400–600) is the most direct way to reduce per-turn token usage.
- Disable buckets that are not in use — for example, disable the world bucket for a simple setting with minimal worldbuilding.

### Large NPC Ensemble Stories

- Keep the character bucket enabled.
- Increase retrieval depth to 10–15 to surface more character-relationship entries.

---

## FAQ

**Q: The GM keeps forgetting an important detail. What can I do?**
A: In the in-game **Memory** panel (sidebar), pin that entry manually. Pinned entries go into the pinned bucket and are injected every turn without fail. See [Game: Memory Panel](/en/game-memory).

**Q: What are the downsides of a very high retrieval depth?**
A: More tokens are injected each turn, which increases API cost and may push other content out of the context window. Raise the token budget first, then increase retrieval depth.

**Q: Is archived memory lost?**
A: No. Archiving only demotes an entry from "always injected" to "retrieved when relevant." The content remains in the fact store and is surfaced normally when the scene calls for it.

**Q: What does increasing the history summary window do?**
A: More turns of conversation history are compressed into a summary, helping the GM retain a longer narrative thread. Keep in mind that the summarization itself consumes an additional model call.

**Q: How does the memory token budget relate to the model's context window?**
A: The memory token budget controls only the memory portion of the prompt. The overall context window (including conversation history and system prompt) is configured on the **Model Parameters** page. The memory budget cannot exceed the total context allocation.

---

## Related

- [Game: Memory Panel](/en/game-memory)
- [Model Configuration](/en/settings-models)
- [Module Model Assignment](/en/settings-modules)
- [Model Parameters](/en/settings-modelparams)
