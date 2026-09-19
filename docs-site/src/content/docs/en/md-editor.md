---
title: "Script Editor"
description: "The Script Editor is a three-panel, VSCode-style editing environment for viewing and modifying all knowledge assets in a script — chapter content, character cards, worldbook entries, timeline anchors, and Canon entities. All five entity types are accessible in one interface, each rendered as YAML front-matter plus a body field."
---

The Script Editor is a three-panel, VSCode-style editing environment for viewing and modifying all knowledge assets in a script: chapter content, character cards, worldbook entries, timeline anchors, and Canon entities. All five entity types are accessible in one interface, each rendered as YAML front-matter plus a body field — what you see is what gets saved.

The right-panel AI assistant understands natural language instructions and can call write tools to update the knowledge base directly, making it suitable for batch edits, rewrites, or adding new lore. When editing body content, pressing ⌘K triggers inline AI continuation or rewriting.

Entry point: "Script Editor" in the left navigation.

---

## Interface Layout

### Top Bar

- **Workspace (script switcher)**: Click the "Workspace" button on the left to switch between scripts owned by the current account, or create a new blank script from the dropdown. Subscribed scripts do not appear here — only scripts you own can be edited.
- **Edit icon group**: Quick access to undo, redo, copy, cut, and paste, acting on the currently focused CodeMirror editor.
- **File menu**: New Chapter, New Blank Script, Rename Current Script, Delete Current Script.
- **Edit menu**: Undo (⌘Z), Redo (⌘⇧Z), Copy (⌘C), Cut (⌘X), Paste (⌘V), Find (⌘F), Select All (⌘A), Go to Line, Save (⌘S).
- **Save button**: A "Save ⌘S" button appears in the top-right when the current tab has unsaved changes. ⌘S works at any time.

### Left Panel: Explorer

Displays all knowledge assets of the current script in five groups:

- **§ Chapters**: Script chapters, listed in chapter order
- **@ Character Cards**: NPC and character cards
- **# Worldbook**: Worldbook entries; drag to reorder priority
- **~ Timeline**: Timeline anchors
- **\* Canon Entities**: Canon knowledge entities

Click a group header to expand or collapse it. Click an entry to open an edit tab in the center panel. The search box at the top filters entries by name across all groups. The left panel width is adjustable by dragging the right divider; the setting is saved automatically.

### Center Panel: Multi-Tab Editor

Each open entity appears as an independent tab in the tab bar. A dot (●) on a tab indicates unsaved changes. Click a tab to switch to it; click × to close (a confirmation appears if there are unsaved changes).

The editor uses CodeMirror 6, with Markdown syntax highlighting, line numbers, bracket matching, and find-and-replace.

### Right Panel: AI Assistant

The AI assistant panel (backed by the `console_assistant` SSE endpoint) accepts natural language instructions and applies them directly to the knowledge base. The right panel width is also adjustable by dragging.

---

## File Format: YAML Front-Matter + Body

Each entity opens as a text file structured as follows:

```
---
field_name: value
array_field:
  - item one
  - item two
---

Body content here…
```

Everything between the two `---` lines is front-matter (YAML). Everything after the second `---` is the body. **Front-matter field names (keys) are frozen** — you can only modify the values after the colon. Adding, removing, or renaming keys is not allowed. The editor blocks input that would change a key name; saving with a modified key set produces an error identifying the offending field.

Body fields by entity type: chapters → `content`, character cards → `background`, worldbook → `content`, timeline anchors → `sample_summary`, Canon entities → `background`. Read-only fields (such as `id`, `word_count`, `avatar_path`) are shown in the front-matter for reference but **are automatically stripped on save and never written back**.

---

## Common Tasks

### Opening and Editing an Entity

Click any entry in the left panel. A new tab opens in the center panel and loads the content. After editing, press ⌘S or click "Save ⌘S" in the top bar to write the changes to the database immediately.

### Creating an Entity

Three methods are available:

1. Click the "＋" icon to the right of a group name in the left panel to create a new entry in that group in place.
2. Right-click the blank area or a group name in the left panel and select "New…".
3. Use the top bar "File" menu → "New Chapter" (chapters only) or "New Blank Script".

When creating in place, a text input appears — type a name and press Enter to confirm, or press Escape to cancel. The new entity opens automatically in the center panel.

### Renaming an Entity

Double-click an entry name in the left panel to edit it in place and press Enter to confirm. Alternatively, right-click and select "Rename". Renaming a chapter changes its title; the chapter number does not change.

### Duplicating an Entity

Right-click a character card, worldbook entry, timeline anchor, or Canon entity and select "Duplicate". A new entry is created with the same name plus a " Copy" suffix. Chapters cannot be duplicated.

### Deleting an Entity

Right-click → "Delete" → confirm in the dialog. **Chapters cannot be deleted here** — deleting a chapter severs its RAG index (embeddings, facts, anchors all reference the chapter as a foreign key) and must be done from the Script Management page. All other four entity types support deletion. Deletion is permanent.

### Reordering Worldbook Entries by Drag-and-Drop

Expand the "# Worldbook" group and drag entries to adjust their priority order. On drop, the system re-numbers priorities top-to-bottom (descending) and writes the new order to the database in bulk.

### In-Body AI Continuation (⌘K)

With any chapter body open:

- **Cursor continuation**: Place the cursor in the body and press ⌘K. An instruction input box appears (may be left blank). Press Enter to trigger. The AI streams continuation text at the cursor position, with new text highlighted as a "pending" region.
- **Selection rewrite**: Select a passage and press ⌘K. The AI replaces the selection with a rewritten version, also entering pending state.
- A "AI generating… Esc to cancel" banner is shown during generation. On completion: "Tab to accept  Esc to discard".
  - **Tab** or **⌘Enter**: Accept the continuation or rewrite; the highlight disappears and the text is kept.
  - **Esc**: Discard; the editor reverts to its pre-AI state.

You can also trigger the same effect from the right panel by typing an instruction in the input box and clicking "Insert at cursor".

### Syncing New Lore to the Knowledge Base

After accepting a continuation or rewrite, if the content introduces or modifies character settings, world rules, or timeline events, a banner appears at the bottom of the editor:

"Sync Settings" — sends the accepted text to the right-panel AI assistant, which reads the existing knowledge base and calls the appropriate write tools (updating character cards, worldbook entries, timeline anchors, etc.) to bring it in sync.  
"Dismiss" — closes the banner without triggering a sync.

### Using the AI Assistant to Modify the Knowledge Base

Type a natural language instruction in the right panel input box — for example, "Make this character's personality darker", "Add a worldbook entry: XX is a synonym for YY", or "Polish the body of Chapter 3". The AI describes what it will change, then calls the relevant write tools to apply the changes. Destructive operations (overwriting existing content) prompt a confirmation: click "Confirm" or "Cancel".

After a write operation succeeds, if the affected entity is already open in the center panel, the tab content refreshes automatically to the latest version.

### Changing AI Write Permission

The write permission button at the bottom-left of the right panel input box has four levels:

- **Read-only**: The AI can only read and answer; no write tools are available.
- **Default** (mapped to "Review before write"): Requires confirmation before destructive writes.
- **Review before write**: Requires confirmation before destructive writes (default level).
- **Full access**: Write operations execute immediately without confirmation.

The setting is saved to account preferences and persists across sessions.

### View Chapter Edit History

The editor's bottom status bar has a **History** button (available while a chapter tab is open) → it opens the chapter's **edit history**:

- **Manual edits**: your saves in the editor (including the 2.5-second autosave) record one entry, titled like "manual edit of chapter #1";
- **AI rewrites**: when the AI assistant rewrites this chapter, an entry titled like "AI rewrite of chapter #1" is recorded;
- **Revert / undone**: entries left by restore or undo operations (they carry a snapshot too, so they can be rolled back again).

**Consecutive edits are coalesced**: while you keep editing the same chapter (within 10 minutes by default) only one entry is kept, shown as "N saves"; editing again after a pause starts a new entry — autosave will not pile up entries.

Each entry's **Restore to before** button rolls the chapter text back to the version *before* that entry (works for AI edits, manual edits, and restore/undo operations themselves). **A restore is itself reversible**: if you clicked by mistake, reopen the list with the **History** button at the bottom (the drawer closes automatically after a restore) and click **Restore to before** on the newly created "restore chapter #N to before #M" entry to go back to the state before it.

> After a restore the text shown in the editor does not change immediately (same-tab content is never re-injected, so your in-progress typing and cursor position are never clobbered) — close the chapter tab and reopen it (or switch to another chapter and back) to see the restored text.

When the list piles up with entries you no longer need, the **Delete** button on each entry removes it: **only that entry (and its snapshot) is removed — the chapter text is untouched**, and deletion cannot be undone.

Manual-edit entries never feed the AI assistant's **Undo** button (that one serves AI edits only), so the two do not interfere.

> Script-wide "Roll back to this version" is not yet available — see the Scripts docs' "View Version History".

### Creating or Switching Scripts

Use the "Workspace" dropdown in the top bar: click an existing script name to switch to it, or select "＋ New Blank Script" to create one with a first chapter. Switching scripts closes all open tabs.

---

## FAQ

**Why can't I edit the field names in the front-matter?**
Field names are frozen by design — each entity type's field set maps one-to-one to the database schema. Adding or removing keys is meaningless and would silently lose data. Only the values after the colon can be edited. If the freeze protection triggers, the editor blocks your input; press ⌘Z to undo to a valid state.

**"Front-matter fields are frozen" error on save — what do I do?**
You accidentally deleted or renamed a field name. Follow the error message to identify the field, restore the original key name (only the part before the colon), keep the value, and save again.

**Why can't chapters be deleted here?**
Deleting a chapter severs its RAG index — embeddings, facts, and anchors all use the chapter as a foreign key, making the impact significant. Chapter deletion is performed from the Script Management page, not the editor.

**The AI assistant modified the knowledge base, but my tab didn't refresh?**
If the affected tab has unsaved local changes, the system will not automatically overwrite them. A message appears: "The AI updated this entry, but you have unsaved changes — not auto-refreshed." You must decide manually whether to discard your local changes and reload.

**I subscribed to someone else's script. Can I edit it in the editor?**
No. The editor only loads scripts you own; subscribed scripts do not appear in the workspace switcher. To edit one, first fork it to your account from the Script Management page, then open it in the editor.

**Can I leave the ⌘K instruction blank?**
Yes. When left blank, the AI infers the continuation direction from context (chapter number and existing body). Providing an instruction gives the AI more specific direction, such as "add more dialogue" or "describe the environment".

---

## Related

- [Script Management](/en/scripts) — Import scripts, trigger knowledge base rebuilds, manage chapters
- [Character Cards](/en/cards) — Full field reference for character cards and in-game behavior
- [Worldbook](/en/worldbook) — Worldbook entry injection mechanism and batch operations
- [Timeline](/en/timeline) — Timeline anchor structure and progress advancement
- [In-Game AI Assistant](/en/game-composer) — Write permission levels for the same AI assistant in-game
