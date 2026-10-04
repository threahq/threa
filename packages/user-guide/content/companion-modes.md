---
title: Companion and Quiet mode
summary: How a scratchpad decides whether an agent replies to every message, and how to pick which agent that is.
section: agents
order: 1
---

# Companion and Quiet mode

Every scratchpad is either in Companion mode or Quiet mode. In Companion mode an agent reads new messages and replies. In Quiet mode the scratchpad is storage only.

## Choose a mode

Open the scratchpad's settings and go to the **Companion** tab (see [Stream settings](/guide/stream-settings)). Under **Companion mode** you pick one of two options:

- **Companion**: the agent reads new messages and replies in the thread.
- **Quiet**: no AI replies and no inference cost.

In a Quiet scratchpad you can still bring an agent in by mentioning it. See [Mentioning and working with agents](/guide/talking-to-agents). In an encrypted scratchpad, mentions don't reach agents because the server can't read them. Ariadne replies there through Companion mode once she is invited, and other agents only after you invite them (see [Encrypted scratchpads](/guide/encrypted-scratchpads)).

## Choose the agent

The **Companion agent** select on the same tab sets which agent replies in this scratchpad. The options carry badges: **Your default**, **Workspace default** and **Personal**. Personal agents are the ones you made yourself (see [Creating your own persona](/guide/custom-personas)).

Encrypted scratchpads don't show the select: Ariadne always replies there. Changing the agent affects new sessions. A session that is already running keeps the agent it started with. Threads inherit the agent and the mode of the scratchpad they belong to.

An aside is always a companion conversation, so its mode can't be changed.

## Channels, DMs and threads

The same **Companion** tab opens in the settings of channels, DMs and threads. The mode there starts as Quiet, so no agent replies to every message unless someone switches it to Companion. Only a thread under a scratchpad inherits the scratchpad's mode and agent.

## Defaults

When you create a scratchpad it starts with a default agent, resolved in this order:

1. Your own **Default companion**, set in your [AI settings](app:settings/ai).
2. The workspace default, which workspace admins set.
3. Ariadne.

Defaults apply when a scratchpad is created. Changing a default later doesn't change scratchpads that already exist.

## Related

- Restrict what the companion may use: [Controlling what agents may use](/guide/agent-tool-privacy).
- Encrypted scratchpads: [Encrypted scratchpads](/guide/encrypted-scratchpads).
