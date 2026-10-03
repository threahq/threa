---
title: Managing AI agents
summary: How workspace admins manage the shared agent roster and set workspace-wide limits on what the assistants may do.
section: workspace
order: 4
---

# Managing AI agents

The **AI Agents** tab in Workspace Settings is where workspace admins manage the agents everyone in the workspace can use and set limits on what the assistants do on their own. Only admins see this tab. Admins can also reach it from the command palette with **AI Agents settings**.

## The agents list

The list shows built-in agents (marked **Built-in**) and the custom agents your workspace has created. An agent with edits on top of its defaults carries a **Customized** badge. Each row has an **Edit** button that opens the agent's editor.

- Built-in agents have bounded editing: tools, model and style.
- Custom agents are fully editable. You make one by forking.
- Changes apply to every stream the agent takes part in.

## Creating an agent

**New agent** opens a dialog. Pick a source under **Copy from**, or choose **Blank agent**, give it a **Name**, and select **Create**. A fork carries over the source's prompt, tools, model and style, and Threa opens the new agent's editor. For what you can set there, see [Custom personas](/guide/custom-personas).

## Archiving and restoring

An archived agent leaves the list and the companion picker, and streams that used it fall back to the built-in companion. Archive a custom agent with the **Archive** button at the bottom of its editor, which asks you to confirm. Archived agents appear in a collapsed **Archived** list at the bottom of the roster, each with an **Unarchive** button.

## Assistant behavior

These settings apply to the whole workspace.

- **Default companion**: the agent that answers in scratchpads where neither the scratchpad nor the member has picked one. Changes take effect for every such scratchpad from then on.
- **Assistant follow-ups**: how many pending follow-ups the assistant may hold per stream before it stops scheduling more. The default is 10, and the field accepts 1 to 100. The value saves when you leave the field; an invalid entry reverts. See [Follow-ups](/guide/follow-ups).
- **Subagent models**: the models an assistant may hand a task to as a subagent, and the models a built-in agent may escalate to. Each entry shows its price per 1M tokens, and delegating spends the workspace's AI budget at those rates. Two models are ticked by default (GPT-5.6 Terra and Claude Sonnet 5). Models marked **Premium** are off until an admin ticks them. With nothing ticked, assistants cannot delegate to another model. See [Delegations and subagents](/guide/delegations-and-subagents).
- **Sandbox internet access**: lets commands the assistant runs reach the internet, in conversations that also allow web access. It is on by default. Attachments the assistant copies into its sandbox could then leave the workspace. Changing the setting gives those conversations a fresh sandbox, so files made in the old one are gone.

Spending by these agents is tracked on the usage page described in [AI usage and budget](/guide/ai-usage-and-budget).
