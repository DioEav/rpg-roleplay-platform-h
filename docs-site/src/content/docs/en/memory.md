---
title: "Memory Management"
description: "The memory system controls how much history the GM can recall and which content is retrieved and injected into the prompt each turn. Memory operates on two levels: during a game session you can view and edit the current save's memory in the sidebar panel; global defaults are configured under Platform Settings → Memory."
---

The memory system controls how much history the GM can recall and which content is retrieved and injected into the prompt each turn. Memory operates on two levels: during a game session you can view and edit the current save's memory in the sidebar panel; global defaults are configured under Platform Settings → Memory.

Access: In-game right panel → Memory tab; or Platform Settings → Memory.

---

## Key Concepts

### Memory Buckets

Memory is organized into three buckets by type:

- **Pinned bucket**: Facts you or the GM have manually pinned. Highest priority — injected as candidates up to the pinned cap (still trimmed by the token budget). Use this for facts that must never be forgotten, such as "the protagonist has lost their left hand."
- **World bucket**: Main quest/objective, narrative facts, player notes, and archived summaries. Injected by recency window, not dumped in full.
- **Character bucket**: Persistent character state such as abilities and resources. Injected by recency window.

Each bucket can be toggled independently under Settings → Memory. Disabling a bucket removes its contents from every prompt path.

### Retrieval and Injection

Before the GM generates a reply each turn, the system takes the most recent N entries from each memory bucket (bounded by the token budget) and injects them into the prompt. True query-relevance recall is handled by the separate "relevant past" layer (`episodic_recall`, disabled by default); the buckets themselves are not semantic search.

### Facts Library

After each GM turn, the Extractor automatically pulls important facts from the conversation and writes them to the facts library. The facts library requires no manual upkeep; injection takes the most recent N entries, and older facts are archived into compressed summaries.

### Relationship to the World Book

The world book and memory buckets are two parallel mechanisms that do not override each other:

- **World book**: Manually maintained world-setting entries, injected by keyword or relevance. Best for long-lived, stable rules, character summaries, and place descriptions.
- **Memory buckets**: Facts dynamically generated during play or manually pinned, focused on the current save's runtime state.

Both contribute content to the GM in the same turn and share the same token budget. When many world book entries are active, consider lowering the memory injection limit accordingly.

---

## Common Tasks

### Pin an Important Fact (In-Game)

Enter a game → right panel Memory tab → click + in the Pinned Memory section → enter the content and confirm. The entry is pinned immediately; the GM will see it on the next turn.

### Unpin a Memory (In-Game)

Find the entry in the Pinned Memory list → click × on the right → confirm removal. The entry is no longer guaranteed to be injected, but its content is not deleted.

### Add a Player Note (In-Game)

Right panel Memory tab → click + in the Player Notes section → enter the content. Notes are private reminders for you; the GM is not guaranteed to read them every turn (unlike pinned memory, which is force-injected).

### See What the GM Referenced This Turn

The Recall section at the bottom of the Memory tab shows the fragments retrieved from the manuscript and history this turn, along with the paragraph count.

### Adjust Memory Settings

Platform Settings → Memory. You can tune retrieval depth, history summary window, per-turn injection token limit, auto-archive interval, and the enabled state of each bucket. Changes save automatically and take effect on the next GM call.

---

## FAQ

**What is the difference between pinned memory and player notes?**
Pinned memory is injected into the GM's context every turn (subject to the token quota — do not overfill it). Player notes are private; the GM is not guaranteed to read them each turn.

**What happens when the pinned memory bucket is full?**
The bucket has a cap (20 entries by default, adjustable in settings). Once the cap is reached, new entries are rejected; delete an old entry first. They are not moved to the facts library automatically.

**The GM keeps forgetting something. What should I do?**
Pin that fact in the in-game memory panel. Once in the pinned bucket it is injected every turn. If it is still being forgotten, check whether the per-turn injection token limit is set too low, causing content to be truncated.

**Will turning off a bucket delete its contents?**
No. Disabling a bucket only stops retrieval and injection from that bucket; the data is retained and resumes normal operation when the bucket is re-enabled.

**Will using memory and the world book together exceed the token budget?**
Both draw from the same per-turn token budget. If the context is frequently truncated, lower the per-turn injection token limit, disable one of the buckets, or reduce the number of always-on world book entries.

---

## See Also

- [In-Game Memory Panel](/en/game-memory) — View pinned memory, facts library, notes, and this-turn recall
- [Settings · Memory](/en/settings-memory) — Retrieval depth, token limit, bucket toggles
- [World Book](/en/worldbook) — The world-setting injection mechanism that runs parallel to memory
- [In-Game World Book Panel](/en/game-worldbook) — View world book state during a session
