---
title: Who can see what
summary: Who can read each kind of stream, what stays private to you, and what agents and bots can see.
section: privacy
order: 3
---

# Who can see what

Access in Threa follows the stream: who can read a message depends on where it was sent. Labels and encrypted scratchpads follow their own rules, and agents see a slice of the workspace that depends on where you invoke them.

## Streams

- Scratchpads are private to you. Only people you add can read one, and adding someone to a thread in a scratchpad also adds them to the scratchpad.
- Direct messages are always private to the two people in them.
- A channel is **Public** ("Anyone in the workspace can find and join") or **Private** ("Only invited members can access"). Everyone in the workspace can read a public channel without joining it.
- Threads have no access of their own. They inherit it from the channel, scratchpad or DM they belong to, so a thread in a private channel is readable only by that channel's members.
- Changing a channel between public and private asks for confirmation. Making it private hides it from non-members, and they can no longer find or join it.

## Labels

Every label is private to you. See [Labels](/guide/labels).

## Memory

Memory only shows you memos from streams you can access. Some memos are visible only to their owner. See [How memory works](/guide/how-memory-works).

## What agents can see

When you talk to Ariadne or another AI agent, what it can look up depends on the stream where you invoke it:

- In your own private scratchpad with no other members, it can see what you can see.
- In a scratchpad that has other members, it sees public streams plus that scratchpad.
- In a private channel, it sees public streams plus that channel.
- In a public channel, it sees public streams only.
- In a DM, it sees only what both people in the DM can access.
- In an aside, it can see what you can see.
- In a thread, it follows the channel or scratchpad the thread belongs to.

A stream's settings also let you limit which kinds of tools agents may use there. See [Agent tool privacy](/guide/agent-tool-privacy).

## Bots

A bot can read public channels but only posts in streams it was added to, and other members can see which streams that is. Private channels stay invisible to it until it is added. A personal bot with **Read everything you can read** switched on can read whatever you can read, except end-to-end encrypted streams. See [Bots](/guide/bots-overview).

## Encrypted scratchpads

The servers store only ciphertext for these, and a stream's name is stored encrypted too. Ariadne, when you invite her, reads the content in memory for the duration of a turn and sends it to a language model provider, and her web tools send requests to the web. Agents you invite with **Invite agent** can read every message. See [Encrypted scratchpads](/guide/encrypted-scratchpads) and [Encryption limits and key recovery](/guide/encryption-limits-and-recovery).
