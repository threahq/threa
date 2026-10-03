---
title: Follow-ups
summary: How an agent schedules itself to come back to a conversation later, and how to see, change or cancel those follow-ups.
section: agents
order: 6
---

# Follow-ups

A follow-up is a reminder an agent sets for itself. At the chosen time the agent wakes up and looks at the conversation again.

## How they work

When you ask an agent to check back later, it schedules a follow-up with a note to its future self and a time. The time must be in the future and within 30 days.

- The agent can list its follow-ups, change a pending one (the note, the time or both) and cancel it.
- When a follow-up fires, the agent starts a new turn in that stream. Nothing is posted as you.
- A follow-up that is cancelled before it fires does not run. If the cancel and the firing happen at the same moment, only one of them takes effect.

## The follow-up card

Scheduling a follow-up puts a card in the timeline with the note and a line reading the agent's name and **fires** plus the time. The note links to the [Agent agenda](/guide/agent-agenda) for this stream. Click **Cancel** to cancel it. The card then reads **Cancelled** and the note is struck through. If it already fired or was cancelled, you get a notice saying so.

A follow-up has one of these states: Scheduled, Ran, Cancelled or Failed.

## Limit

Each stream has a limit on pending follow-ups, 10 by default. At the limit the agent can't schedule another until one fires or is cancelled. Workspace admins can change the limit, from 1 to 100, under **Assistant follow-ups** in the AI Agents tab of Workspace Settings (see [Workspace AI agents](/guide/workspace-ai-agents)).

## Related

- [The Agent agenda](/guide/agent-agenda) lists every follow-up in one place.
- [Delegations and subagents](/guide/delegations-and-subagents).
