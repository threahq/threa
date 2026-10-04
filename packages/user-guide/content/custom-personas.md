---
title: Creating your own persona
summary: How to make a personal agent with its own instructions, tools and model, test it, and use it in your scratchpads.
section: agents
order: 5
---

# Creating your own persona

A persona is an agent with its own instructions, tools and model. You can make personal personas that only you can see and use in your scratchpads.

## Create one

Go to the **My personas** section in your [AI settings](app:settings/ai) and click **New persona**. In the dialog, pick a persona under **Copy from** to fork it, with its prompt, tools, model and style carried over, or pick **Blank persona**. Enter a **Name** and click **Create**. This opens the editor.

Workspace admins can also manage workspace-wide agents from the AI Agents tab of Workspace Settings (see [Workspace AI agents](/guide/workspace-ai-agents)). The editor is the same page. You can open it if you own the persona or if you are a workspace admin.

## The editor

- **Name** (up to 100 characters) and **Description** (up to 500).
- **Avatar**: upload an image (JPEG, PNG or WebP), or use an emoji. An uploaded image takes precedence.
- **System prompt**: the standing instructions the persona runs on every turn. Required, up to 8000 characters.
- **Tone** and **Brevity**: each overrides the default guidance for that. Up to 500 characters each.
- **Knowledge**: files the persona always carries in its context. Text, PDF, Word, Excel or JSON, up to 50 files of 20 MB each. Click **Add file** or **Attach existing**. Large files are carried as short summaries.
- **Tools**: a checklist grouped like the groups in [Controlling what agents may use](/guide/agent-tool-privacy). A dot marks a change from the default.
- **Model** and **Escalation model**. The escalation model is used for harder turns and is chosen from the workspace's delegation models. Choose **None (no escalation)** to turn it off.
- **Temperature** (0 to 2) and **Max tokens**.

## Drafts, saving and history

Your edits sync as a draft. The footer shows whether the draft is synced, and **Save** applies it. **Discard** reverts all unsaved edits to the last saved configuration.

**History** opens **Revision history**, with earlier versions newest first. Restoring a version makes it current and keeps the rest in history.

## Test chat

The **Test chat** pane lets you talk to the persona before you commit. Turns run against your draft, and nothing from the test chat is saved to memory. In the test chat the persona can't schedule follow-ups, update the stream brief, delegate tasks, start subagents, save memos, run commands or change your settings, even when those tools are ticked. On a narrow screen it is the **Test draft** button. Saving or discarding the draft ends the test chat.

## Use it

- Pick it as the **Companion agent** in a scratchpad (see [Companion and Quiet mode](/guide/companion-modes)).
- Mention it (see [Mentioning and working with agents](/guide/talking-to-agents)).

A personal persona can only be used by its owner.

## Archive

The **Archive persona** section removes the persona from the roster and the companion picker. Streams that used it fall back to the built-in companion. Archived personas are listed under **Archived** in the same place, where you can unarchive them.
