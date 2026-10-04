---
title: What agents can do
summary: The tools an agent such as Ariadne can use in a conversation, grouped by what they are for.
section: agents
order: 3
---

# What agents can do

Agents act through tools. This article lists Ariadne's tools in plain words. A custom persona gets the tools its editor ticks (see [Creating your own persona](/guide/custom-personas)), and what any agent may use in a given scratchpad can be narrowed (see [Controlling what agents may use](/guide/agent-tool-privacy)).

## Messaging and participation

- Send a message and add or remove an emoji reaction.
- Schedule, list, change and cancel follow-ups (see [Follow-ups](/guide/follow-ups)).
- Update the stream's brief.
- Hand a task to your local agent, or hand a question to another model (see [Delegations and subagents](/guide/delegations-and-subagents)).

## Web and research

- Search the public web, and read a web page or a JSON resource.
- Read Threa's public user guide to answer how-to questions about the app.
- Run a research pass of about two minutes. It looks across the public web, workspace knowledge and memory, and connected GitHub or Linear where they are available. It returns one summarized brief with citations.

## Memory

- Read a memo: its abstract, key points, tags and source messages.
- Save a fact, decision, procedure or learning to workspace memory.

## Files

- Find attachments by file name or content.
- Read an attachment. It returns extracted text, structured data, or the image itself. Large files are read in parts.

## Sandbox

An agent can run a shell command in a sandbox tied to the conversation. It gets back the output, the error output and the exit code, and it can copy up to 10 workspace attachments into the sandbox first. Commands time out after 60 seconds unless the agent asks for longer, up to 5 minutes.

- If the sandbox expired or its internet access changed, the next command starts a fresh one and the files from the old one are gone. The agent is told when that happens.
- Sandbox images include Python with common data and document libraries, plus LibreOffice.
- Internet access from the sandbox needs both the workspace setting and web access for that conversation. Workspace admins set the workspace side (see [Workspace AI agents](/guide/workspace-ai-agents)).
- Encrypted scratchpads don't have a sandbox.

## GitHub and Linear

These are read-only and need the integration to be connected (see [GitHub and Linear](/guide/github-and-linear)).

- **GitHub**: repositories and branches, commits, pull requests and their files, file contents and code search, Actions runs and failed job logs, releases, and issues.
- **Linear**: issues, an issue by identifier such as ENG-123 with its comments, projects, and a project with its linked issues.

## Your own settings

In your own scratchpads (not encrypted ones), and only when you started the turn, an agent can change these settings when you ask: theme, message display, date format, time format, timezone, language, notification level, where unread streams open, and your working schedule. It should change only what you asked for and tell you what it changed. It can't change your scratchpad instructions, your companion, keyboard shortcuts or voice settings. A change may be held for approval.

## Workspace search

Ariadne searches messages, streams, people and memory through the research pass. A custom persona can also be given tools that search messages, streams and people directly, and read a stream's messages.
