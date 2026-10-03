---
title: Dictating messages
summary: Speak a message into the composer, how polished and original text work, and the Dictation settings for model, polish level and steering words.
section: messages
order: 13
---

# Dictating messages

The microphone button in the composer turns speech into text in your draft. A small model can tidy the transcript as you speak, and you can switch back to the exact words that were recognized.

## Dictating

Select **Dictate a message** (the microphone icon) in the composer and start talking. The button turns red and shows a running clock. Words you are still saying appear in the draft as a live preview and become real text once they are recognized. Select **Stop dictation** to end the take. The text lands at the cursor, so you can dictate into the middle of a draft.

A take stops by itself after 10 minutes. In the last minute the clock counts down and reads "left". If no sound reaches the microphone for a while, a warning appears over the button. Select it to dismiss it. If a take fails, the button reads **Retry dictation** and the reason is shown above it.

The button is greyed out when the browser can't capture the microphone. Hover it to see why.

## Polished and original text

With polishing on, a small model cleans up the transcript while you speak. A pill above the microphone reads **Showing polished**. Select it to switch the dictated text to **Showing original**, the words as they were recognized, and select it again to switch back. The pill goes away shortly after you stop, and the toggle is not available after that.

How much the model changes is set under **Polish dictated text** in settings (see below). It also reads the rest of your draft, so dictated text fits the sentence around it.

## Dictation settings

Open [Dictation](app:settings/dictation) in your settings.

- **Voice Dictation Model** chooses the speech-to-text provider. **Use server default** is currently ElevenLabs Scribe v2. The other options are ElevenLabs Scribe v2 and Deepgram Nova-3. Both detect the language automatically, and the Deepgram option is described as lower latency.
- **Polish dictated text** has three levels. **Opinionated** is the default and cleans up the most: it drops filler words, applies self-corrections, formats lists and expands spoken emoji shortcodes. **Minor** only fixes punctuation, capitalization and obvious typos. **Off** puts the raw transcript into the editor with no model involved.
- **Dictation steering words** are spellings the model is nudged toward, such as product names, people and jargon. Type a word and press Enter or comma to add it, and remove it with the x on its chip. You can add up to 50 words of up to 48 characters each. Threa and Ariadne are always included.

## Workspace steering words

Workspace admins can add steering words that apply to everyone's dictation in [Dictation](app:workspace-settings/dictation) in the workspace settings. Other members see the list read-only, with the note "Only workspace admins can change the shared steering words." Your own words are added on top of the shared ones.
