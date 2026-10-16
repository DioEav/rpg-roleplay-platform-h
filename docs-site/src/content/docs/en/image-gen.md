---
title: "AI Image Generation"
description: "Meadhall supports AI image generation across multiple contexts: character card avatars, reference sheets, script covers, in-chat illustrations, and game scene images. All image generation requires your own API Key (BYOK); no shared quota is provided by the platform."
---

Meadhall supports AI image generation across multiple contexts: character card avatars, reference sheets, script covers, in-chat illustrations, and game scene images. All image generation requires your own API Key (BYOK); no shared quota is provided by the platform.

Entry points vary by context: the character card edit page, the script edit page, the game/tavern chat toolbar, and Settings → Module Models.

The **unified image dialog (MediaStudio)** consolidates three image sources: AI generation, local upload, and gallery selection. Clicking to change an image — whether a character avatar, script cover, or any other position — opens this dialog.

---

## Prerequisites: Configuring an Image Generation Model

Image generation is BYOK-only. You must first add a supported provider API Key under Settings → API Keys, then select the corresponding provider and model under Settings → Module Models → Image Generation Model.

Supported provider types include Vertex AI (Gemini), DashScope (Tongyi Wanxiang), Doubao, and any OpenAI-compatible image generation endpoint (including relay services such as OpenRouter).

If no Key is configured, clicking "Generate" shows a "No image generation model API Key configured" prompt with a link to the settings page. If the Key is invalid (authentication failure), the specific error message from the provider is shown.

---

## Common Tasks

### Changing a Character Avatar

Open the "Characters" page, find the target character card, and click the avatar area or the "Change Image" button to open the MediaStudio dialog.

The dialog opens on the "AI Generate" tab by default:
1. Enter a generation prompt in the text box. More detail yields better results (e.g., "Young woman in a white hanfu, clear gaze, ink wash style").
2. Select a provider and model in the "Image Generation Model" picker (only models that support image generation are listed).
3. Choose a ratio in "Size / Ratio" — portrait 2:3 (832x1216) is recommended for character avatars.
4. Click "Generate". Generation runs asynchronously; "Generating, please wait…" is shown while it runs.
5. When generation completes, the dialog closes and the avatar updates automatically.

You can also switch to the "Upload" tab to upload a local image directly, or use the "Gallery" tab to reuse a previously generated or uploaded image.

### Changing a Script Cover

Open the script edit page and click the cover area to open the MediaStudio dialog. Widescreen 16:9 (1344x768) is recommended for script covers. The workflow is the same as changing a character avatar.

### Generating / Maintaining a Character Reference Sheet

A reference sheet is a full-body illustration capturing the character's appearance, personality, and background. It is managed separately from the avatar.

Open the "Characters" page, enter the target character card's edit view, and switch to the "Reference Sheet" tab:

- **Generate Now**: Click "Generate Now". The system assembles a prompt from the character's appearance and personality fields, adds the task to the async queue, and updates the reference sheet when complete.
- **Upload**: Click "Upload Reference Sheet" to upload a local image directly.
- **Auto-sync**: Enable "Auto-sync reference sheet on persona update" to trigger regeneration automatically whenever the character card is saved with changed persona content. Requires a configured image generation API Key.
- **History Gallery**: "Reference Sheet History" shows all past generation results for this character. Click a thumbnail to set it as the current reference sheet (the avatar is also updated).

### Generating a Scene Image in Chat

The bottom toolbar of the game or tavern chat has an "AI Image" button (image icon). Click it to open the image generation dialog:

1. Enter a prompt describing the current scene or character action.
2. Select a model and size (square 1:1 is recommended for in-chat illustrations).
3. Click "Generate".

The generated image is embedded inside the corresponding assistant message bubble, not posted as a separate message. The image position persists across page refreshes (stored in local storage).

### Selecting a Resolution / Ratio

All image generation dialogs include a "Size / Ratio" picker with five options:

| Option | Ratio | Pixels | Best for |
|--------|-------|--------|---------|
| Portrait 2:3 | 2:3 | 832x1216 | Character avatars, reference sheets |
| Square 1:1 | 1:1 | 1024x1024 | Chat illustrations, account avatars |
| Landscape 3:2 | 3:2 | 1216x832 | General landscape images |
| Tall 9:16 | 9:16 | 768x1344 | Mobile portrait style |
| Widescreen 16:9 | 16:9 | 1344x768 | Script covers |

The platform remembers your selection per context (kind), so the dialog restores your last choice when reopened for the same context. Note: Vertex AI (Gemini series) does not support custom sizes via API parameters — the size selection is ignored and the model outputs its default aspect ratio.

### Cancelling an In-Progress Generation Task

The "Background Tasks" panel in the bottom-right corner shows active image generation tasks. Find the task and click "Cancel" to abort it.

### Cropping an Image

Click an uploaded or generated image to view it full-screen. In the preview, click "Crop" to enter crop mode: drag the crop frame or its corner handles to adjust the region, then click "Apply Crop" to confirm. The image is automatically compressed (longest edge capped at 1280px, JPEG quality 0.85) and uploaded.

---

## FAQ

**"No image generation model API Key configured" — what do I do?**

Go to Settings → API Keys and add a Key for your chosen image generation provider. Then go to Settings → Module Models, find the "Image Generation Model" row, and select the provider and model. After completing both steps, click "Generate" again.

**"Daily image generation limit reached" — what does that mean?**

Some provider accounts impose a daily call limit. This is unrelated to the platform — the limit is set by the account that owns the API Key. Switch to a different Key or wait until the limit resets the next day.

**My configured model doesn't appear in the image model picker?**

The picker only shows models flagged as having image generation capability. If your model is missing, it either does not support image generation or the provider's `base_url` points to a text-only endpoint.

**I selected a size for Vertex AI but it had no effect?**

Vertex AI (Gemini series) does not support custom size parameters. The size selection is silently ignored by the backend, and the image is output at the model's default aspect ratio.

**I clicked "Generate Now" for the reference sheet but nothing changed?**

Reference sheet generation runs in an async queue. The avatar and reference sheet history update automatically when the task completes. If "Auto-sync on persona update" is enabled, saving the character card triggers generation automatically — no need to click manually.

**Where do generated images appear?**

- Character avatars, script covers, reference sheets: update in place upon completion and are archived in the File Library.
- Chat / game scene images: embedded inside the corresponding assistant message bubble and persist after page refresh.
- Historical images: viewable in the character card's "Reference Sheet History" or in the File Library.

---

## Related

- [Character Cards](/en/cards)
- [Scripts](/en/scripts)
- [Model Configuration](/en/settings-models)
- [Module Models](/en/settings-modules)
- [File Library](/en/tasks)
- [Tavern Mode](/en/tavern)
