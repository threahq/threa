---
title: Stream settings
summary: What each page of a stream's settings does, from notification levels to the brief and archiving.
section: conversations
order: 4
---

# Stream settings

A stream's settings open in the settings window, under **This stream**. Open them from **Settings** in the **Stream actions** menu in the header or in a sidebar row's menu, or run **Open stream settings** from the command palette. Channels, scratchpads, DMs and threads have three pages: **General**, **Agent** and **Stream members**. Where the workspace has the feature enabled, workspace admins also see a fourth page on channels, **Sharing**, for sharing the channel with another workspace. System streams and asides show General only.

## General

What you see depends on the stream type.

- **Notify me about**: how much this stream notifies you. The first option, such as **Channel default**, follows the default for the stream type, and a thread follows the stream it sits under. See [Notification levels](/guide/notification-levels) for what each level means. Scratchpads and DMs offer Everything and Muted. Channels and threads also offer Activity and Mentions only. Asides never notify: Muted is their only level.
- **Stream name**: the slug of a channel, or the name of a scratchpad. It saves when you leave the field or press Enter. A scratchpad also offers **Regenerate title** when the name was set by hand. A thread shows its name read-only, with the same **Regenerate title** button (not on encrypted threads). A DM shows its name read-only, because it is named after the people in it. A locked encrypted scratchpad asks you to unlock it before renaming.
- **Description**: channels, scratchpads and DMs. Rich text, written in the same editor as messages. Delete everything and save to clear it.
- **Visibility**: **Public**, **Open to guests** or **Private** for channels, and changing it asks you to confirm. Scratchpads and DMs are always private, and threads follow the stream they sit under.
- **Automatic memory**: channels, scratchpads and DMs. Saves knowledge from this stream's conversations. Threads follow their parent. Turn it off for busy streams where captured memories add noise. See [Automatic memory](/guide/automatic-memory-toggle).
- **Archive**: channels, scratchpads and threads. **Archive** hides the stream from the sidebar for everyone, and **Unarchive** restores it. Only the stream's creator sees this section, and for a thread also the creator of its root stream. A thread under an archived stream stays read-only and out of the sidebar until the stream is unarchived.

## Agent

This page controls the AI in the stream.

- **Agent replies**: **On** means the agent answers each new message. **Quiet** means no agent replies and no AI usage. Channels, DMs and threads have it too, and it starts as Quiet there. See [Companion modes](/guide/companion-modes).
- **Agent**: which agent replies here. Threads under a scratchpad use its agent. Sessions already running keep their agent, and new sessions use the new choice. An encrypted scratchpad always uses Ariadne.
- **What shapes replies**: the picked agent's model and instructions, the tools it can use, and what it knows about your device, each with who can change it.
- **Brief**: a short standing context the agent reads on every turn, such as goals, decisions and preferences that outlive any one conversation. Select **Add brief** or **Edit**, write Markdown (up to 4000 characters) and **Save**. A thread shares the brief of the stream it sits under. If someone else saved a brief while you were editing, Threa tells you and lets you save over it or start from theirs. Encrypted streams have no brief. In a scratchpad, **Your instructions** links to the instructions you set for all your scratchpads.
- **Restrict tool access**: visible only to the scratchpad's creator. Off by default, which lets the agent use every tool it has. When on, you choose the groups it may use: Web, Workspace, GitHub and Linear. Groups the workspace hasn't set up are hidden. It can always reply. On an encrypted scratchpad only Web is available.

## Stream members

Lists the stream's members, with a filter. People who can manage members also see the bots added to the stream. Adding and removing people is covered in [Adding people and bots to a stream](/guide/stream-members-and-invites).
