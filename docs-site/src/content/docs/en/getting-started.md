---
title: Getting started
description: End-to-end first-play walkthrough — account creation, LLM API key setup, importing a novel, and starting your first game.
---

This guide walks you through your first complete session in Meadhall: registering an account, adding an LLM API key, importing a novel, creating a save, and playing your first round. Allow 10–15 minutes, not counting script extraction time.

---

## Step 1: Create an account / sign in

If you are not already signed in, Meadhall redirects you to the login page automatically.

**Register a new account**

1. Switch to the "Register" tab on the login page.
2. Fill in your username, password, display name, and email address.
3. Check the boxes for the Terms of Service, Privacy Policy, Acceptable Use Policy, and age confirmation, then click "Register".
4. A verification code is sent to the email address you provided — enter it to complete registration.

**Sign in to an existing account**

Enter your username and password on the login page and click "Sign in". You are redirected to the main interface on success.

> Usernames are case-insensitive, but special characters such as `@` are preserved. Enter your username exactly as it was registered.

---

## Step 2: Add an LLM API key

Meadhall is BYOK (Bring Your Own Key) — the platform has no shared keys built in. You must supply an API key from at least one AI provider before the game GM, extraction, and image generation features will work. **Until a key is added, the model selector is empty and starting a game is not possible.**

Navigate to: top bar "Settings" → "Model setup" (see [Model setup](/en/settings-models) for full details).

1. Click "Add API key" in the upper-right corner of the page.
2. Choose your provider from the "Provider" dropdown (e.g. OpenAI, Anthropic, DeepSeek, Google AI Studio). The Base URL is filled in automatically after you select a provider.
3. Paste your API key and click "Add".
4. The platform syncs the available model list from the provider. When the provider entry shows green status, it is ready to use.

Common providers and where to obtain keys:

| Provider | Sign-up URL |
|---|---|
| OpenAI | platform.openai.com |
| Anthropic | console.anthropic.com |
| Google AI Studio | aistudio.google.com |
| DeepSeek | platform.deepseek.com |
| OpenRouter (aggregator) | openrouter.ai |

> **Network access**: If you are on a network where certain providers are unreachable, set "Connection type" to "HTTP proxy" and enter your local proxy address (e.g. `http://127.0.0.1:7890`) when adding the key, or use OpenRouter as an aggregator proxy. See the FAQ section of [Model setup](/en/settings-models) for details. If the provider still shows as unreachable after adding a key, see [Troubleshooting](/en/troubleshooting).

---

## Step 3: Import a novel script

Every game in Meadhall is built on an imported script (a novel uploaded as a `.txt` file).

Navigate to: top navigation bar "Scripts" → "Import script" in the upper-right corner (see [Scripts](/en/scripts) for full details).

1. Click "Import script" to open the import page.
2. Drag and drop or browse to a `.txt` file (UTF-8 encoding). Files up to approximately 50 MB are recommended.
3. The "Chapter split preview" dialog opens, showing the number of chapters detected, total word count, and a confidence score. A score above 85 % appears green and indicates the auto-detected split rule is reliable. If the score is low or chapters appear misaligned, click "Try another rule" to switch the splitting rule manually.
4. Once the preview looks correct, click "Confirm import".

**After you confirm, the following pipeline runs in the background** (requires an LLM key; time depends on the novel's length):

- Chapter splitting (seconds)
- NPC character card generation
- Worldbook entry extraction
- Timeline anchor construction
- Vector index build

You can check progress in the "Status" column on the Scripts list page. **Until all modules are ready, the script is marked "Not ready" in the new-game wizard and cannot be selected. Wait for extraction to finish before proceeding.**

> To skip the LLM extraction phase and only split chapters, turn off the "Generate character cards" and "Generate worldbook" switches on the import page. You can trigger those steps individually from the script detail panel at any time later.

---

## Step 4: Create a save and start a game

Navigate to: top navigation bar "Saves" → "New game" in the upper-right corner (see [New game wizard](/en/wizard) and [Saves](/en/saves) for full details).

**The wizard has four required sections:**

1. **Basic info**: Enter a save name (the default pre-fill is fine) and choose the ready script from the "Script" dropdown. If the script still shows "Not ready", extraction has not finished — go back to the Scripts page and wait.

2. **Choose character**: Select the character card you want to play as.
   - **My card library**: use an existing card or Persona
   - **Script NPC**: play directly as a character from the novel (origin is locked to "Native" automatically)
   - **Create new card**: fill in a name and details to create a card on the spot

3. **Birth point**: Pick a timeline anchor that sets where in the story you begin. Anchors are grouped by narrative stage; each one shows a chapter range and a plot summary. The list only loads after you have selected a script.

4. **Origin and identity** (optional): Choose how your character enters the story world (soul transmigration, body transmigration, dual soul, or native). Optionally attach an identity overlay. You can skip this section and the defaults take effect.

The summary panel on the right updates in real time. Once all required items are checked, the "Start game" button becomes clickable. Click it — the save is created and you enter the game immediately.

---

## Step 5: Play your first round

Once inside the game, the input panel is pinned to the bottom of the screen (see [Input panel](/en/input) for full details).

**Send your first message:**

1. Type an action, line of dialogue, or scene description in the input box.
2. Press Enter to send (default), or click the "Send" button. The GM (AI game master) streams a response.

**A few useful controls:**

- Type `/` to open the slash-command menu (update location, time, pin a memory, etc.)
- Click "Continue" to let the GM advance the story without any player input
- Click the model label on the right to switch the active AI model
- Click "Stop" at any time to interrupt GM output mid-stream

**Tip for your first interaction**: simply describe in natural language what your character is doing, or write a line of dialogue. The GM responds within the context of the novel's world. No command syntax is required to begin.

---

## Common first-run issues

**Script dropdown in the new-game wizard is empty**
You need to complete Step 3 first. The script must finish chapter splitting and anchor construction (status column shows ready) before it appears as selectable.

**Script shows "Not ready" and cannot be selected**
Extraction is still running in the background. Time varies by novel length and LLM response speed — typically a few minutes to around fifteen minutes. Check progress on the Scripts page and reopen the wizard once the status turns green.

**Model selector inside the game is empty**
No LLM API key has been added, or the provider you added shows as unreachable. Return to "Settings → Model setup" to verify the key and check network connectivity. See [Troubleshooting](/en/troubleshooting).

**Pressing Enter inserts a newline but sends the message instead**
Click the "↵" toggle button in the lower-right corner of the input box to disable "Enter to send". After toggling, Enter inserts a newline and Cmd/Ctrl + Enter sends.

---

## What to explore next

- [Model setup](/en/settings-models) — manage multiple provider keys, show/hide models
- [Scripts](/en/scripts) — extraction status, vector index rebuild, editing character cards
- [New game wizard](/en/wizard) — full reference for every wizard section
- [Saves](/en/saves) — branch management, export, and resuming a game
- [Input panel](/en/input) — slash commands, @mention, permission modes
