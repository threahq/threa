---
title: Mentioning and working with agents
summary: How to bring an agent into a conversation with a mention, and how to follow, redirect or stop what it is doing.
section: agents
order: 2
---

# Mentioning and working with agents

Mention an agent by name in a message to ask it to work on something. The agent answers, and a session card shows what it is doing.

## Mentioning an agent

Type `@` and pick the agent from the mention list, where agents carry an **AI** tag (see [Mentions and links](/guide/mentions-and-links)). Where the answer appears depends on the conversation:

- **In a channel**, the agent starts a thread on your message and answers there.
- **In a thread, a scratchpad or a direct message**, it answers in place.

A few rules decide whether a mention reaches an agent:

- A mention in a message you write brings the agent in. Messages written by agents or bots, and slash commands, don't.
- A personal persona can only be mentioned by the person who made it.
- A persona that has been archived is skipped.
- If you mention several agents, each one gets its own session.
- Mentions don't bring agents into an encrypted scratchpad. Ariadne answers there through Companion mode once you invite her, and other agents can read it only once you invite them. See [Encrypted scratchpads](/guide/encrypted-scratchpads).

In a scratchpad in Companion mode the agent replies to each message without a mention. See [Companion and Quiet mode](/guide/companion-modes).

## The session card

While an agent works, a card under your message shows its progress. Clicking the card opens the trace. The card shows one of these states:

- **is working…**, preceded by the agent's name, with the current step and counts.
- **Session complete**, with the number of steps, the duration, the messages sent and the changes made.
- **Session failed**.
- **Session stopped**, shown when an AI spend limit stopped the session.
- **Interrupted, retrying…**
- **Session deleted**, shown when the message that started it was deleted.

A **Version N** badge appears when the agent ran again, for example after you edited the message that started it. Changes the agent made appear as a grid under the card.

## Steering a running session

While a session is running, the card has two buttons:

- **Redirect**: puts the cursor in the message box; the message you send next is folded into the current work.
- **Stop**: the agent wraps up with what it has so far.

## Show trace and sources

When a session is not running, hover the card for **Show trace and sources**. The same item is in the context menu of a message the agent wrote. It opens the **Agent Session Trace**, which lists what the agent did and what it drew on.

## Related

- What the agent can reach: [What agents can do](/guide/what-agents-can-do).
- The built-in agent: [Meet Ariadne](/guide/meet-ariadne).
