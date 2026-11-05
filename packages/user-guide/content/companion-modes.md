---
title: Companion and Quiet mode
summary: How a scratchpad decides whether an agent replies to every message, and how to pick which agent that is.
section: agents
order: 1
---

# Companion and Quiet mode

Every scratchpad is either in Companion mode or Quiet mode. In Companion mode an agent reads new messages and replies. In Quiet mode the scratchpad is storage only.

## Choose a mode

Open the scratchpad's settings and go to the **Agent** page (see [Stream settings](/guide/stream-settings)). Under **Agent replies** you pick one of two options:

- **On** (Companion mode): the agent answers each new message.
- **Quiet**: no agent replies and no AI usage.

In a Quiet scratchpad you can still bring an agent in by mentioning it. See [Mentioning and working with agents](/guide/talking-to-agents). In an encrypted scratchpad, mentions don't reach agents because the server can't read them. Ariadne replies there through Companion mode once she is invited, and other agents only after you invite them (see [Encrypted scratchpads](/guide/encrypted-scratchpads)).

## Choose the agent

The **Agent** select on the same page sets which agent replies in this scratchpad. The options carry badges: **Your default**, **Workspace default** and **Personal**. Personal agents are the ones you made yourself (see [Creating your own persona](/guide/custom-personas)).

Encrypted scratchpads don't show the select: Ariadne always replies there. Changing the agent affects new sessions. A session that is already running keeps the agent it started with. Threads inherit the agent and the mode of the scratchpad they belong to.

An aside is always a companion conversation, so its mode can't be changed.

## Channels, DMs and threads

The same **Agent** page opens in the settings of channels, DMs and threads. Agent replies start as Quiet there, so no agent replies to every message unless someone turns them on. Only a thread under a scratchpad inherits the scratchpad's mode and agent.

## Defaults

When you create a scratchpad it starts with a default agent, resolved in this order:

1. **Your default agent**, set on the [Your AI](app:settings/ai) settings page.
2. The workspace default, which workspace admins set.
3. Ariadne.

Defaults apply when a scratchpad is created. Changing a default later doesn't change scratchpads that already exist.

## Related

- Restrict what the companion may use: [Controlling what agents may use](/guide/agent-tool-privacy).
- Encrypted scratchpads: [Encrypted scratchpads](/guide/encrypted-scratchpads).
