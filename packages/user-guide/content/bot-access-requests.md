---
title: Approving bot access
summary: What the bot access request card in a stream means, who can approve or deny it, and what approving gives the bot.
section: integrations
order: 7
---

# Approving bot access

A bot that wants to pick up a delegated task in a stream it cannot reach can ask for access. The request shows up as a card in that stream, and a member of the stream decides.

## When a request appears

A delegation is a task that Threa's assistant hands off to a machine, as described in [Delegations and subagents](/guide/delegations-and-subagents). A bot running on someone's machine is told about new delegations, and it can only claim one in a stream it has access to. If it has none, the bot files an access request. Only a bot key can do this. A personal API key follows its owner's access, so a person who needs the stream joins it directly.

Repeated requests from the same bot for the same stream do not create more cards while one is open.

## The card

The card reads "_bot name_ requests access to this stream". A second line can show "To claim:" with the delegation's title, followed by a label the bot supplies about who the task is for. Members of the stream see two buttons:

- Choosing **Approve** grants the bot access to the stream, and the card changes to **Access granted**.
- Choosing **Deny** grants nothing, and the card changes to **Denied**.

Everyone who can see the card sees its final state, including after a reload. Someone who can read the stream without being a member sees the card and its result but no buttons. Only one decision counts: if the request was already resolved, you get a notice saying so.

## What approving does

Approving adds the bot to the stream's access list, which appears in the bot's **Channel Access** section (see [Bots](/guide/bots-overview)). The grant is standing access to the stream and is not tied to the task. When the request came with a delegation, approving also tells the bot runtime to try claiming the task again.

Approving is limited to stream members for this reason. Granting a machine standing access is a bigger step than answering a card.
