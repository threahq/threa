---
title: Delegations and subagents
summary: How an agent hands work to your local coding agent or to another model, and how to follow, answer and cancel it.
section: agents
order: 8
---

# Delegations and subagents

An agent can hand work on in two ways. A delegation goes to your own local agent. A subagent is another model that answers you in a thread.

## Delegations

When a task is long, code-heavy or needs your machine, an agent can delegate it. This posts a delegation card in the stream. The card is visible to every member of the stream, and your local agent can claim it.

The card shows a title and a status line with who acted and the status: Open, Claimed, Running, Completed, Failed, Cancelled or Claim expired. Its menu has:

- **View result** for a completed delegation, and **Discuss in thread** or **Open thread**.
- **Copy prompt** and **Copy delegation link**.
- **Show hand-off prompt** or **Hide hand-off prompt**.
- **Requeue**, only when the claim expired.
- **Mark done** and **Cancel delegation**, until the delegation has finished.

The hand-off prompt contains the brief, links to context, and instructions for a local agent. With a Threa API key that has the delegation scopes, a local agent can inspect the task, claim it, report progress, and complete or fail it. When it completes, the result is posted into the conversation. Without API access, press **Mark done** yourself when the work is finished. For keys and linked agents see [Personal API keys](/guide/personal-api-keys) and [Linked coding agents](/guide/linked-coding-agents). For the API itself see [threa.io/developers](https://threa.io/developers).

## Subagents

An agent can hand a question to another model. That model answers in a thread off a card in the stream. The model is chosen from the list your workspace allows. It has workspace tools but has not read the conversation, so the agent writes it a brief.

Only one subagent can run at a time per conversation surface (a channel or scratchpad, including its threads). If an agent tries to start another, it is told **A subagent is already running in this stream.** and has to wait or ask you to cancel the first. **Try again** on an old card tells you another subagent is already running.

The subagent card shows one of these states:

- **Working**
- **Waiting for you**, when the model asked a question. Use **Answer in thread**.
- **Done**, with **View result**.
- **Failed**, with a reason.
- **Cancelled**, with who cancelled it.
- **Expired**, when it sat idle too long.

The card's actions are **Open thread**, **Try again** for a failed or expired subagent, and **Cancel subagent**. When the subagent finishes, it posts its closing answer in its thread and the card flips to done.

## Subagent models

- You can narrow the list for your own conversations under **Subagent models** in your [AI settings](app:settings/ai). The section shows only if your workspace offers at least two models, with prices next to each.
- Workspace admins set the list the workspace offers in the AI Agents tab of Workspace Settings (see [Workspace AI agents](/guide/workspace-ai-agents)).

## Track it

Both appear in the [Agent agenda](/guide/agent-agenda).
