---
title: Conversations and topics
summary: How Threa groups messages into conversations, what statuses mean, and how to rename, split, move, hide or resolve a topic.
section: conversations
order: 9
---

# Conversations and topics

A busy channel or DM holds several discussions at once. Threa reads the messages and groups them into conversations, also called topics, each with a title. Conversations are what the [board](/guide/board) shows as cards. A conversation always stays inside one root stream, so it never mixes messages from two channels.

## Statuses

Every conversation is active, stalled or resolved.

- A conversation with no new activity for 24 hours goes from active to stalled.
- A conversation with no activity for 7 days becomes resolved.
- You can mark one resolved yourself and reopen it later.

New activity in a stalled or automatically resolved conversation makes it active again. A conversation you resolved yourself stays resolved until you reopen it.

A resolved conversation shows a check mark and a muted title, on its board card and in its panel. Stalled has no marker of its own.

## The conversation menu

Each board card and conversation panel has a **Conversation actions** menu (the three dots). Items that don't apply are left out. In scratchpads there is no **Split with AI…**, and the first item reads **Rename scratchpad…**.

- **Rename topic…** opens a dialog with a "Topic name" field. Save it with **Save**.
- **Regenerate title** asks Threa for a new title. It shows only when the current title was set by a person or predates automatic titles.
- **Mark resolved** or **Reopen**.
- **Copy link**.
- **Split with AI…** asks the model to regroup the conversation into smaller topics. It lists the proposed groups, and nothing changes until you press **Split into N conversations**. The first group keeps this conversation's title and the rest become new conversations. If the model finds the conversation focused, the dialog says "This conversation looks focused — no split suggested." and you close it. **Try again** appears only when the analysis fails.
- **Open an aside**, in streams that support asides. Not in encrypted or archived streams. See [Asides](/guide/asides).
- **Hide from board** or **Unhide from board**.

## Moving messages between topics

Grouping is automatic, and you can correct it from a message's menu.

- **Move to sub-topic…** re-files the message into another conversation under the same root.
- **New sub-topic** opens a thread under the message and creates a child conversation for it. It appears on board cards and in the conversation panel, and only for a message with no thread yet. See [Threads](/guide/threads).
- **Move to conversation…** and **Move messages to conversation…** appear when the conversation overlay is on. The second one works on several selected messages, which you can move to another conversation or split into a new one.
- **Reply in conversation** files your next send into that conversation, and **Show in conversation** opens the message's conversation in the side panel.

## Messages that are still settling

When Threa is unsure where a new message belongs, it places the message provisionally. The row is dimmed, and its menu leads with two items:

- **Keep here** confirms the placement.
- **Not this topic…** opens the picker to choose another topic.

A provisional placement also settles when you react to or save the message, and it settles by itself once it has been provisional for about 30 minutes.

## The overlay and the list

In channels and DMs on desktop, the **Conversation overlay** button in the stream header turns the overlay on and off. The chevron beside it opens a menu with **Conversation overlay** and **Conversations list**. On mobile, the same two items are in the stream actions sheet.

- The overlay marks each conversation with a coloured dot and lists them in a **Conversations in view** panel with message counts. Click one to focus it.
- On desktop, hover a message and use the **Correct conversation** button beside it. It opens a picker headed "This message belongs to…", with a **New conversation** option. On touch, use **Move to conversation…** from the message menu.
- The list shows conversations by last activity. Each row has a title, a message count and a relative time, and expands to show its messages. **Open in panel** opens the conversation in the side panel.

Before any conversation is detected, the panel says "No conversations detected yet".

The **Settle** keyboard shortcut (E) is a different feature. It acts on an Inbox row or the open stream, and it does not change a conversation's status. See [Keyboard shortcuts](/guide/keyboard-shortcuts).
