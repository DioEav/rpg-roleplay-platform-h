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
- **World bucket**: Main quest/objective, narrative facts, player notes, and archived summaries. Candidates start from a recency window; the actual injection size is decided by the token budget, not dumped in full.
- **Character bucket**: Persistent character state such as abilities and resources. A wider candidate window than facts, still trimmed by the token budget.

Each bucket can be toggled independently under Settings → Memory. Disabling a bucket removes its contents from every prompt path. While the world bucket is off, automatic fact archiving is paused so re-enabling it does not reveal that the middle of the story was silently compressed. The in-game Memory panel can also override the recall window, token budget, token-estimate factor, pinned limit, facts soft limit, and bucket switches **per save** — only changed fields are stored, everything else keeps following the global settings, and each field can be reset to "follow global" independently.

### Retrieval and Injection

Before the GM generates a reply each turn, the system builds a candidate window per bucket (facts/summaries expand with the recall setting; notes/abilities/resources have a higher candidate floor), then the section weights and token budget decide the actual injection size, preferring the newest entries. When active facts exceed the facts soft limit, every turn checks and archives the oldest down to that limit; summaries are batched by the archive scan interval or by chunk size, preventing both the mid-range gap and per-turn fragment summaries. Token estimation remains chars // 2 by default; the token-estimate factor can be raised for Chinese-heavy tokenizers, and the memory layer and episodic recall now share the same factor. It also runs a lightweight keyword/entity/current-location recall for older facts and notes outside the candidate window. True semantic recall is handled by the separate "Long-history episodic recall" layer (`episodic_recall`, on by default and can be disabled in settings).

### Facts Library

After each GM turn, the Extractor automatically pulls important facts from the conversation and writes them to the facts library. The facts library requires no manual upkeep; injection takes the most recent N entries, and older facts are archived into compressed summaries. Archived originals remain in the long-term archive and can be recalled when "Long-history episodic recall" is enabled; they are not injected every turn by default. When the GM explicitly corrects an old fact, the old version is marked superseded: it stays in save history but is no longer injected, so two contradictory versions are not active at once. Players can edit, delete, or pin facts directly in the memory panel; the "Memory history" section supports search, status filtering and pagination, and lets them review and restore archived/superseded entries. Restoring an older version asks for confirmation when it conflicts with a current version, then supersedes the current similar/direct replacement. Once the state archive exceeds 1000 entries, older originals move to KB cold storage and are retained permanently (queried by save + branch ancestry + afactc prefix); `query_memory` archived scope falls back to them. Explicitly deleted facts immediately retire their hot/cold events and record text + hash tombstones so cold storage cannot resurrect them. The history panel's "Search older archive" uses the same server-side pagination endpoint. Archive summaries carry compact character/location/time metadata, and arc summaries also keep the emotion arc. The GM can also use `query_memory` to search current, archived, summary, and arc memory by text/entity/time/status (`active`, `superseded`, `orphaned`, `rejected`, `archived`); `scope=all` deduplicates by text across layers. Every 5 phases, a deterministic "arc" summary is generated (including key player decisions) from phases older than the recent 4-phase window, so 300+ turn games can still review earlier story arcs without duplicating phase digests.

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
