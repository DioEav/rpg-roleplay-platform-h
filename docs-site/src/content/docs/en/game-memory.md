---
title: "In-Game · Memory Panel"
description: "The Memory panel consolidates the current save's objective settings, facts you have manually pinned, the GM's auto-accumulated fact library, your personal notes, and the reference material the GM retrieved in the last turn. Use it to see exactly what the GM currently \"knows\", and to actively write or delete pinned memories and notes."
---

The Memory panel consolidates the current save's objective settings, facts you have manually pinned, the GM's auto-accumulated fact library, your personal notes, and the reference material the GM retrieved in the last turn. Use it to see exactly what the GM currently "knows", and to actively write or delete pinned memories and notes.

Access: Game right sidebar → switch the top tab to "Memory".

---

## Key Concepts

### Main Quest and Current Objective

The top of the panel shows two lines of text: the **main quest** from the script's settings above, and the **current sub-objective** dynamically updated by the GM as the story progresses below. Both are read-only and cannot be edited here.

### Pinned Memory

A list of entries marked with a pin icon. Each turn, all pinned entries up to `pinned_max` (default 20) are candidates for injection, then trimmed by the per-turn token budget. They will not be forgotten merely because they are far back in the conversation. Use it for character settings, key agreements, or important item clues that must never be omitted.

You can manually add and delete pinned memory entries.

### Fact Library

Auto-extracted and written by the GM; manual editing is not supported. After each turn of narrative, the system extracts key facts (NPC status changes, events that occurred, etc.) and stores them in the fact library for future turns to reference.

### Player Notes

A free-form space for your own records. Notes are **not guaranteed to be read by the GM every turn** (unlike pinned memory, they are not force-injected), making them suitable for hypotheses, ideas, and conversation excerpts. You can freely add and delete note entries.

### Last Turn Retrieval

The block at the bottom of the panel shows the text snippets the GM retrieved from the knowledge base or conversation history in the previous turn, along with the number of passages retrieved that turn (shown in the top-right corner). This tells you what background material the GM is currently drawing on. The block is read-only and refreshes automatically each turn.

---

## Common Tasks

### Add a pinned memory entry

Click the + button to the right of the "Pinned Memory" heading → type text in the input box that appears → confirm. The entry immediately appears in the list and will be read by the GM on the next turn.

### Delete a pinned memory entry

Find the entry to delete → click the close button on its right side → confirm the prompt. The entry will no longer be injected into context.

### Add a player note

Click the + button to the right of the "Player Notes" heading → enter the content → confirm. Notes do not affect the GM's required-reading list; they are for your personal reference only.

### Delete a player note

Find the note entry to delete → click the close button on its right side → confirm the dialog.

### See what the GM referenced this turn

Check the "Last Turn Retrieval" block at the bottom of the panel. It contains excerpts from the source material or conversation history, along with the passage count for this turn.

---

## FAQ

**What is the difference between pinned memory and player notes?**
Pinned memory is injected as candidates up to `pinned_max` each turn, then trimmed by the token budget. Player notes are for your reference only; the GM is not guaranteed to read them every turn.

**How many pinned memory entries should I add?**
There is a hard bucket cap, `pinned_max` (20 by default), plus a per-turn token budget. When pinned memory is very large, entries beyond the budget are trimmed. Keep only truly critical settings pinned; put the rest in player notes.

**Can I delete or edit fact library entries?**
No. The fact library is maintained automatically by the system in the background. The panel displays it as read-only; manual editing and deletion are not supported.

**When does the Last Turn Retrieval update?**
It updates automatically after each GM turn, showing the reference passages retrieved from the knowledge base or conversation history that turn. Refresh the panel to see the latest content.

**Do changes here affect other saves?**
No. The Memory panel operates on the runtime state of the current game session. Changes affect only this save.

---

## Related

- [Worldbook Panel](/en/game-worldbook) — Scene settings and world rules
- [Timeline Panel](/en/game-timeline) — Story progress and convergence anchors
- [Characters Panel](/en/game-characters) — NPC status and relationships
- [Memory Settings](/en/settings-memory) — Global default memory strategy settings
