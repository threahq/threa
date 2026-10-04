---
title: Using memory in chat
summary: Embed a memo in a message with /memo, and how Ariadne and other agents search, read and save memos.
section: memory
order: 4
---

# Using memory in chat

Memos can be pulled into a conversation in two ways. You can embed one in a message yourself, and agents can search memory, read memos and save new ones while they work for you.

## Embed a memo with /memo

In the composer, type `/memo` followed by a space and a few words, for example:

```
/memo auth rewrite
```

A list of matching memos opens, using the same search as the [Memory](app:memory) page, limited to memos that can be shared into the stream you are writing in. With no words after `/memo `, it lists recent memos. Each entry shows the title, the knowledge type and tags. Pick one and it is inserted as a memo chip, and the typed text is removed. If nothing matches, the list says "No memos found".

You can also type `/` and choose **memo** from the command list, which fills in `/memo ` for you. Unlike most slash commands, it works in the middle of a sentence.

After you send the message, a card for each memo appears below it, showing the knowledge type, up to two tags, the title and the date. Select the card to preview the memo in place, with a link through to the Memory page. The embed is not available in a stream's description.

Readers who can't open the memo see only its title on the card. The same applies in encrypted conversations, where the server can't read the message.

## What agents do with memory

When an agent such as Ariadne works in a conversation, she can use memory in three ways. Search and save need the matching tools switched on for her:

- Recall: Threa can put memos that match the current message in front of her before she replies.
- Search: she can search the workspace's history, which includes memos, and open a memo to read its abstract, key points, tags and source messages. Ariadne's search runs through her research tools, so it needs **Workspace** allowed (see [Controlling what agents may use](/guide/agent-tool-privacy)). She reaches only what the person she is helping could open. In a conversation others can read, that narrows to the conversation itself, public channels and the memory built from them.
- Save: she can save a memo when you ask her to ("remember that...") or when something clearly worth keeping was just settled.

A memo saved this way appears in the "Saved to memory:" line in the stream, like any other. It carries a badge, "AI-captured" or "Captured by" followed by the agent's name, and its Provenance section says it was written by the agent from its own session work. If the same knowledge is already saved, she is told so and no duplicate is made.

An agent's explicit save follows where it is. In a private scratchpad it is saved as **About you**, and in a channel it is shared. The **Automatic memory** switch does not block it, because the switch only governs automatic capture. See [Turning automatic memory off](/guide/automatic-memory-toggle).

For what Ariadne can see and do, read [Meet Ariadne](/guide/meet-ariadne). For how memos are made, read [How Threa remembers](/guide/how-memory-works).
