---
title: Stream settings
summary: What each tab of a stream's settings does, from notification levels to the brief and archiving.
section: conversations
order: 4
---

# Stream settings

Every stream has a settings dialog. Open it from the **Stream actions** menu in the header, or from **Settings** in a sidebar row's menu. Channels, scratchpads, DMs and threads have three tabs: General, Companion and Members. Where the workspace has the feature enabled, workspace admins also see a fourth tab on channels, **Connect**, for sharing the channel with another workspace. System streams and asides show General only.

## General

What you see depends on the stream type.

- **Notifications**: how much this stream notifies you. **Default** uses the stream type's default. See [Notification levels](/guide/notification-levels) for what each level means. Scratchpads and DMs offer Everything and Muted. Channels and threads also offer Activity and Mentions only. Asides never notify: Muted is their only level.
- **Visibility**: public or private for channels, and changing it asks you to confirm. Scratchpads and DMs are always private, and threads inherit visibility from their root.
- **Channel name**: the slug of a channel. **Save** appears once you change it.
- **Display name**: the name of a scratchpad. **Save** appears once you change it, and **Regenerate title** appears when the name was set by hand. A thread shows its name read-only, with the same **Regenerate title** button (not on encrypted threads). A DM shows its name read-only as **Virtual stream name**. A locked encrypted scratchpad asks you to unlock it before renaming.
- **Description**: channels, scratchpads and DMs. Rich text, written in the same editor as messages, with **Save** and **Reset**. Delete everything and save to clear it.
- **Automatic memory**: channels, scratchpads and DMs. Extracts and saves knowledge from this stream's conversations. Threads follow their parent. Turn it off for busy streams where captured memories add noise. See [Automatic memory](/guide/automatic-memory-toggle).
- **Danger zone**: channels, scratchpads and threads. **Archive** hides the stream from the sidebar for everyone, and **Unarchive** restores it. Only the stream's creator sees this section, and for a thread also the creator of its root stream. A thread under an archived stream stays read-only and out of the sidebar until the stream is unarchived.

## Companion

This tab controls the AI in the stream.

- **Companion mode**: **Companion** means Ariadne reads new messages and replies. **Quiet** means no AI replies and no inference cost. Channels, DMs and threads have it too, and it starts as Quiet there. See [Companion modes](/guide/companion-modes).
- **Companion agent**: which agent replies here. Threads under a scratchpad inherit its agent. Sessions already running keep their agent, and new sessions use the new choice. This is hidden on encrypted scratchpads.
- **Restrict tool access**: visible only to the scratchpad's creator. Off by default, which lets Ariadne use every tool she has. When on, you choose the groups she may use: Web, Workspace, GitHub and Linear. Groups the workspace hasn't set up are hidden. She can always reply. On an encrypted scratchpad only Web is available.
- **Brief**: a short standing context Ariadne reads on every turn, such as goals, decisions and preferences that outlive any one conversation. Select **Add a brief** or **Edit**, write Markdown (up to 4000 characters) and **Save**. A thread shares the brief of the stream it sits under. If someone else saved a brief while you were editing, Threa tells you and lets you save over it or start from theirs. Encrypted streams have no brief.

## Members

Lists the stream's members, with a filter. People who can manage members also see the bots added to the stream. Adding and removing people is covered in [Adding people and bots to a stream](/guide/stream-members-and-invites).
