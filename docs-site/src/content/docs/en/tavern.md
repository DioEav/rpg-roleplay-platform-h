---
title: "Tavern Mode"
description: "Tavern mode is a space for 1:1 conversations with a single AI character. No script, no GM narration, no save file needed — just open a conversation and start chatting. The layout mirrors the Claude web app: conversation history on the left, a single-column chat area and input box on the right."
---

Tavern mode is a space for 1:1 conversations with a single AI character, with no script, GM narration, or save file required. Conversation history sits in the left panel; the right panel holds the chat area and input box. It is well-suited for pure roleplay, testing character card personas, or quick chats without starting a full game session.

Entry point: the "Tavern" item in the top navigation bar, or the Tavern entry on the home page.

---

## Key Concepts

### Conversations and Character Cards

Each Tavern conversation is bound to one character card (the character the AI plays). A character card stores the character name, persona description, and opening message. When a conversation is created, the backend automatically inserts the card's `first_mes` field as the first AI message.

You can also create a conversation without a character card — the AI will establish a character through tool calls during the chat.

### Independent Save Files

Tavern conversations are stored as independent save files, isolated from script game saves. Each conversation has its own complete history and can be archived, renamed, exported, or deleted.

### Persona (Player Persona)

The character card describes who the AI plays; the persona describes who you play. You can view and edit the persona card bound to the current conversation in the "My Persona" tab of the sidebar drawer.

---

## Common Tasks

### Starting a New Conversation

**Option 1: New blank conversation**

Click "New Conversation" at the top of the left panel. The backend creates a character-less conversation and the AI will establish a character during the chat.

**Option 2: Pick a character card**

Click "Select Character" in the left panel to open the character card picker. Click a card to create a new conversation bound to that character and enter the chat automatically.

**Option 3: Import a SillyTavern character card**

1. Click the "Import Character Card" button in the left panel, or drag a character card file into the blank area of the left panel.
2. Supported formats: `.png` (image with embedded metadata), `.json`, `.webp`.
3. A conversation is created automatically and the chat opens.

### Sending a Message

Type in the bottom input box and press Enter or click the send button. You can attach files or images by clicking the "+" button to the left of the input box and choosing an attachment type. Click "Stop" during generation to interrupt it.

### Uploading Attachments

Click the "+" button on the input box:

- **File**: Upload any file (12 MB limit); the AI can read its contents to advance the conversation.
- **Image**: Upload an image file the AI can reference.
- **Character Card**: Upload a `.png` / `.json` / `.webp` character card file; the AI can parse and import it using tool calls.

### Multiple-Choice Prompts

The AI can trigger a multiple-choice prompt via the `ask_player_choice` tool. Options appear as buttons above the input box — click one to select it and send it as your reply. You can also close the prompt by clicking the X and type your response manually.

### Viewing Character Info / Editing Persona / Editing System Prompt

Click the character name in the conversation header or the character card button on the right to open the right-side drawer, which has three tabs:

- **AI Character**: Shows the details of the character card bound to this conversation.
- **My Persona**: View and edit your persona card (name, persona description, etc.). Click "Edit", make changes, and save.
- **System Prompt**: Set a custom system prompt for this conversation (persona constraints, behavior instructions, etc.) that applies only to this conversation. Click "Edit", make changes, and save.

### Adjusting Model Parameters

Click "Model Parameters" in the left panel to open the sampling parameters drawer, where you can adjust temperature, top-p, and other settings. Changes apply to all Tavern conversations.

### Viewing the Thinking Process

If the selected model supports extended thinking, the AI will show a "Thinking…" indicator above the message during generation. After generation, this collapses into a "Thinking Process" label. Click it to expand and read the full reasoning.

### Viewing Tool Call Details

When the AI calls a tool (such as importing a character card or setting character info), a collapsed tool call block appears in the message area showing the tool name summary. Click it to expand and see the name, parameters, and result of each tool call.

### Retrying a Failed Message

If generation fails, a "Generation failed" error appears in the message area. Click "Retry" to resend the last input.

### Automatic Conversation Naming

After the first exchange completes, the AI automatically generates a title for the conversation, which appears in the left panel conversation list. You can rename it manually at any time.

### Renaming a Conversation

Hover over a conversation row in the left panel list and click the "..." menu → "Rename", or double-click the conversation title to edit it in place and press Enter to save.

### Archiving a Conversation

In the left panel list, click "..." → "Archive". The conversation moves to the archive section (collapsed at the bottom of the list). Click "Unarchive" to restore it.

### Exporting Chat History

Click the "Download" button on the right side of the conversation header. After confirmation, the chat is exported as a SillyTavern-compatible JSONL file that can be imported back into SillyTavern or this platform. The export includes the opening message and the full conversation history.

### Importing Chat History

Click "Import Character Card", select "Chat History (JSONL)" as the import type in the import dialog, upload a SillyTavern-exported JSONL file, and enter the corresponding character name to restore the history.

### Deleting a Conversation

In the left panel list, click "..." → "Delete" → confirm in the dialog. Deletion is permanent and cannot be undone.

### Editing Character Cards

Click "Character Cards (Edit)" in the left panel to go to the character card management page, where you can create, edit, or delete character cards under your account. Changes here affect new conversations going forward and do not retroactively alter existing conversations.

---

## FAQ

**The left panel list is empty — nothing is there?**
Click "New Conversation" or "Select Character" to start your first conversation. You can also drag a character card file directly into the left panel area to import it quickly.

**"Model Key not configured" prompt?**
If no conversation model Key is available when you send a message, a guidance card appears above the input box. Select or configure an API Key there and click "Retry". You can also click "Go to Settings" to navigate to the model settings page.

**The character's opening message didn't appear?**
After creating a conversation, the system automatically inserts the opening message as the first AI message. If the imported character card has no `first_mes` field, there is no opening message — just start chatting.

**Where is my conversation history?**
The "History" section of the left panel lists all active conversations. Archived conversations are collapsed at the bottom of the list under "Archived" — click to expand.

**Why isn't the thinking process / tool call block showing?**
Extended thinking requires a model that supports it. Tool call blocks only appear when the AI actually calls a tool (such as importing a character card or setting character info).

**Can I use the exported JSONL in SillyTavern?**
Yes, the export format is SillyTavern chat-compatible. The reverse also works: JSONL exported from SillyTavern can be imported back into Meadhall via the import dialog.

---

## Related

- [Character Cards](/en/cards) — Manage AI character cards (create / edit / delete)
- [Settings - Models](/en/settings-models) — Configure API Keys and models
- [Settings - Model Parameters](/en/settings-params) — Adjust sampling parameters (temperature, etc.)
- [Image Generation](/en/image-gen) — Generate images in conversations
