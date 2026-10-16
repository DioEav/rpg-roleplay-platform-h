---
title: "Character Cards"
description: "The Character Cards page manages character profiles across three sub-pages: My Cards (PCs you play), NPC Cards (supporting cast in each script), and the Online Card Library (publicly shared cards from other users). User cards are account-level and shared across scripts; NPC cards belong to a specific script."
---

The Character Cards page manages character profiles across three sub-pages: **My Cards** (PCs you play), **NPC Cards** (supporting cast in each script), and **Online Card Library** (publicly shared cards from other users). User cards are account-level and shared across scripts; NPC cards belong to a specific script.

Entry point: top navigation bar → Character Cards. Switch between sub-pages using the sidebar navigation (My Cards / NPC Cards / Online Card Library).

---

## Key Concepts

### Card Type Comparison

| | My Cards (PC) | NPC Cards | Online Card Library |
|---|---|---|---|
| Represents | Your player character | Script NPCs (LLM-extracted or manually created) | PC cards shared publicly by other users |
| Ownership | Account-level, shared across scripts | Bound to a specific script | Becomes your own card after import |
| Visibility | Private / Public | Script-only / Private / Public | Public |

### Character Card Fields

The edit form is organized into four groups:

**Basic Info**
- **Name** (required): The primary name the GM uses to identify this character
- **Full Name**: Fill in when different from Name (e.g., Western full names)
- **Role / Tagline**: Social role or a brief positioning description
- **Aliases**: Comma-separated; the GM uses these to recognize alternate names for the same character
- **Tags**: Comma-separated; used for search and semantic activation

**Profile**
- **Background**: Origins and circumstances before the story begins
- **Appearance**: Description of clothing, expression, etc.
- **Personality**: Behavioral tendencies
- **Speech Style**: How the character speaks — the GM uses this as a reference for voice
- **Current Status**: Injected each turn to reflect the character's real-time situation

**Narrative Settings**
- **Secrets**: Visible to the GM only; never disclosed directly to the player
- **Dialogue Examples**: One per line; helps the GM imitate the character's voice

**Injection Parameters**: Controls how much weight this card has in the GM context
- **Importance** (default 100): Affects recall priority; higher values are injected first
- **Token Budget** (default 450): Maximum tokens injected for this card per turn
- **Priority** (default 100): Tie-breaker when importance scores are equal
- **First Appearance Chapter** (NPC only): The card is not injected before this chapter
- **Visibility**: Private / Public (NPC cards also have a Script-only option)
- **Enabled**: When off, this card is excluded from injection entirely

### Avatar and Character Art

Every card can have an avatar. PC and persona-type cards additionally support **Character Art**, which is distinct from the avatar:

- **Avatar**: Used for display — shown in card lists, the Characters panel in the game sidebar, tavern chat avatars, etc.
- **Character Art**: Dedicated to appearance generation; maintains a full history. Clicking any historical image sets it as current and also updates the displayed avatar.

---

## Common Tasks

### Create a New User Card

In My Cards, click **New Character Card** in the top-right corner → fill in Name (required) and other fields → click **Create Character Card**. The avatar can only be set after the card is saved.

### Edit a Character Card

Click any row in the list to expand the detail panel below, which contains three tabs:
- **Character Info**: Key attributes at a glance
- **Profile**: Read-only view of the full character profile
- **Edit**: Inline editing of all fields; click **Save** in the top-right corner when done

You can also click **Edit** directly on a card in the list to open a full-screen editor.

### Set an Avatar

Click **Generate Character Art** in the top-right of the detail panel to generate one via AI (requires an image generation model key configured). Alternatively, click the cover area of the card to open the MediaStudio panel, which supports AI generation, manual local upload, and selection from your media library.

### Upload / Manage Character Art (PC and Persona Cards Only)

Detail panel → **Character Art** tab:
- **Generate Now**: Generates based on current appearance/personality description; added to an async queue and automatically updates the avatar on completion
- **Upload Character Art**: Saves a local image directly as the current character art
- **Character Art History**: Shows all historical character art for this card; click any image to set it as current
- **Auto-sync on Profile Update**: When enabled, saving the card triggers automatic regeneration if the profile content has changed

A row of inline thumbnails is also shown on the left side of the detail panel; click any to preview or crop and set as current.

### Search and Filter

The search bar above the list supports keyword search by name, role, bio, or tags. Filter buttons toggle between All / Pinned / Published. On the NPC Cards sub-page, an additional filter by script is available.

### Publish to the Online Card Library

In My Cards, click **More** on a card → **Publish to Online Library**. The card becomes visible to all users. When already published, choose **Unpublish** to retract. Published cards display your username and import count in the library.

### Import SillyTavern Character Cards

Supported formats: `.png` (PNG with embedded metadata), `.json`, `.webp`. Up to 8 files per import, each up to 5 MB.

1. Click **Import** (download icon) in the top-right corner.
2. Switch to the **Character Card** tab (default). Choose a file method:
   - **Upload Files**: Drag into the dashed area or click to select; multiple files supported
   - **Paste JSON**: Paste character card JSON text directly → click **Parse JSON** to preview
3. Verify the name, format, and description in the preview area.
4. Optionally enable **AI Field Splitting** — for older cards with long undivided description blocks, the AI will sort content into background/personality/appearance fields (uses AI credits; off by default).
5. Click **Import** to finish.

In the same dialog, switch to the **Chat History** tab to import SillyTavern `.jsonl` chat logs, which are converted into a new save.

### Duplicate a Card

In the **More** menu on a card, select **Duplicate as New Card**. An independent copy is created with a suffix appended to the name; edit each copy independently afterward.

### Export a Character Card

From the **More** menu on a card:
- **Export Card Image (.png)**: Exports a PNG with embedded metadata, importable directly into SillyTavern
- **Export SillyTavern Card (.json)**: Exports in JSON format, compatible with the SillyTavern V2 spec

### Convert an NPC Card to a User Card

NPC cards are bound to their script and cannot be used directly in a new game. To use an NPC as a player character, convert it to a user card:

- In the NPC Cards list, click **More** on a card → **Convert to User Card**. The system copies the NPC's full profile to My Cards and automatically adds a "From NPC" tag.
- The original NPC card in the script is unaffected; the two are independent.

### Import from the Online Card Library

In the **Online Card Library** sub-page, search for a public card and click **Import**. The entire card is copied to your My Cards; you can edit it freely afterward with no link back to the original.

---

## FAQ

**What token budget should I set?**
Recommended ranges: protagonist 600–800, major NPC 400–600, minor NPC 200–400. The total injection across all cards should not exceed roughly 1/4 of the model's context window.

**I imported a PNG card but the content is empty — why?**
Some PNG cards have non-standard metadata formats. The system will attempt to parse them. If the preview is empty, try importing the corresponding JSON file using the Paste JSON method instead.

**Where do I manage NPC cards?**
NPC cards belong to their script. Besides the NPC Cards sub-page here, you can also access them via Scripts → select a script → NPC Cards tab in the detail panel.

**The avatar disappeared after saving the card — what happened?**
Meadhall has fixed the bug where saving a character card could clear the avatar path (the backend upsert now preserves the avatar field if it is not included in the update). If avatar loss still occurs, re-set the avatar from the detail panel.

**Can an NPC card be shared across multiple scripts?**
Not directly — NPC cards are bound to a single script. To reuse one across scripts, convert it to a user card and select it in the new game wizard, or create a card with the same name under the target script.

---

## Related

- [Scripts](/en/scripts) — View and extract NPC cards at the script level
- [Saves](/en/saves) — Choose a character card when starting a game
- [New Game Wizard](/en/new-game-wizard) — How character cards are used in the new game flow
- [Game Characters Panel](/en/game-characters) — View the active character card during gameplay
- [Image Generation](/en/image-gen) — Model configuration and usage for image generation
