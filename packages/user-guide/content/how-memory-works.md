---
title: How Threa remembers
summary: What Threa saves from conversations, when it saves it, who can see it, and how a memo moves from active to archived or superseded.
section: memory
order: 1
---

# How Threa remembers

Threa reads conversations after they settle and saves the lasting parts as memos, so decisions and findings don't stay buried in old messages. You can browse them on the [Memory](app:memory) page.

## What gets saved

Threa groups related messages into conversations and looks at each one as a whole. It saves a memo only when the participants produced something worth recalling later. Each memo has one of five knowledge types:

- Decision: a choice the participants made, with the reasons for it.
- Procedure: a sequence they worked out that reliably gets something done, such as a setup, a fix or a process.
- Learning: something they discovered or confirmed themselves, for example through debugging or an experiment.
- Reference: a stable fact they pinned down, such as an id, a value, a name or a location.
- Context: lasting background on why something is the way it is.

Passing status ("it's broken right now"), reactions to news and conversations that were only chat usually produce nothing. One conversation can produce up to five memos. A memo has a title, an abstract, key points, tags and links back to the messages it came from.

## When it happens

Saving is not immediate. A single message on its own waits until it is at least 10 minutes old, so replies have time to arrive. A conversation that is still going waits until it has been quiet for 30 minutes. One that has been resolved or has stalled is picked up on the next pass.

Afterwards the stream shows a line that reads "Saved to memory:" followed by the memo titles. Select a title to preview the memo without leaving the conversation.

If someone edits a message in a conversation, Threa looks at that conversation again. If someone deletes a message that a memo cites, a memo with no surviving source message is archived, and one that still has other sources is marked superseded.

## Who can see a memo

- Memos from a private scratchpad or an [aside](/guide/asides) are labelled **About you** and are visible only to you.
- Memos from channels, public scratchpads and direct messages are visible to the people who can open the conversation they came from.
- Encrypted conversations produce no memos.

Agents can save memos too. Those show a badge, either "AI-captured" or "Captured by" followed by the agent's name. See [Using memory in chat](/guide/memory-in-conversations).

## Memo states

- Active: shown by default on the Memory page.
- Archived: set aside but kept. You can restore it from the Memory page.
- Superseded: replaced by a newer memo. The older one links to its replacement with "Replaced by a newer memo".

Whether a conversation is saved at all is set by **Automatic memory**. See [Turning automatic memory off](/guide/automatic-memory-toggle).
