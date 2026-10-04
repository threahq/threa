---
title: Controlling what agents may use
summary: How the owner of a scratchpad restricts an agent to chosen groups of tools.
section: agents
order: 4
---

# Controlling what agents may use

By default Ariadne can use every tool she has in a scratchpad. The owner of a scratchpad can restrict her to chosen groups of tools.

## Restrict tool access

Open the scratchpad's settings and go to the **Companion** tab (see [Stream settings](/guide/stream-settings)). Only the person who owns the scratchpad sees the tool access control. Turn on **Restrict tool access**, then tick the groups to allow:

- **Web**: web search, fetching public URLs, and internet access in the sandbox.
- **Workspace**: search the workspace's messages, streams and memos, read files, run commands in a sandbox, save memos and change your settings.
- **GitHub**: read from connected GitHub.
- **Linear**: read from connected Linear.

Only groups for integrations that are set up are shown. The agent can always reply, so **Messaging & participation** is not a switch. That group covers sending messages, reactions, follow-ups, delegations, subagents, the stream brief and the Threa guide.

If you tick nothing, the agent can only read the scratchpad and reply. A change takes effect on the agent's next turn.

## How the groups interact

- Allowing **GitHub** alone does not give the agent general web access.
- Allowing **Web** also allows the agent to read GitHub.
- Sandbox internet access needs the workspace setting and **Web** to both allow it.
- Saving a memo and changing your settings need **Workspace**.
- Ariadne searches the workspace's messages, streams and people through her research tool, which needs **Web**. It searches the workspace only when **Workspace** is allowed too. With **Web** alone her research covers the web only, and with **Workspace** alone she can't search messages.

## Encrypted scratchpads

In an encrypted scratchpad only **Web** can be allowed. The other groups are shown as unavailable with a **Soon** label, because the agent has only web tools inside the encrypted environment today. See [Encrypted scratchpads](/guide/encrypted-scratchpads).

## Related

- The tools themselves: [What agents can do](/guide/what-agents-can-do).
- Tools for a custom persona are chosen in its editor: [Creating your own persona](/guide/custom-personas).
