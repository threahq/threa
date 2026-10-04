---
title: The "In this stream" panel
summary: The panel that collects a stream's links, files, memories, threads and agent items, plus in-conversation search and the stream brief.
section: conversations
order: 11
---

# The "In this stream" panel

The **In this stream** panel lists the links, files, images, captured memories, threads and agent tasks of one stream in a single place. Items collect there on their own as the conversation goes. It also gives you a way to search the stream, and the stream's brief shows up in its timeline.

## Open it

- On desktop, press the **In this stream** button in the stream header. It opens as a column on the right edge, and the button stays highlighted while it is open.
- On mobile, open the stream actions sheet and pick **In this stream** ("Links, files & memories").

The panel works in channels, DMs, scratchpads and threads. The address carries `?context=` while it is open, so a refresh or a shared link opens the same panel.

## What it lists

Items are grouped by day, and the header shows the total. Chips under the search box filter the list. A chip appears only when it has items, and each shows its count.

- **All** shows everything.
- **Agent** shows follow-ups and delegations together. It appears only when there are some.
- **Pull requests**, **Links**, **Media**, **Files**, **Memories**, **Delegations**, **Follow-ups** and **Threads** show one kind each. **Links** also includes pull requests.

In a channel, DM or scratchpad the panel covers the stream and all of its threads. Opened from a thread, it covers that thread only.

Selecting a row takes you to the item:

- A link opens in a new tab, or inside Threa when it points to a Threa page.
- An image, video or previewable document (PDF, Markdown, HTML or text) opens in the gallery. Any other file jumps to its message.
- A memory opens its detail view. See [Using memory in chat](/guide/memory-in-conversations).
- A thread opens in the side panel.
- A delegation or follow-up jumps to its message in the timeline.
- **Go to message** on a link row, or on a file that opens in the gallery, jumps to the message that contained it. It appears when you hover the row, and always on touch screens.

The search box ("Search this stream's links, files, memories…") narrows the list by text. Its filter menu adds **from**, **after** and **before**. The panel reports any other [search filter](/guide/search-filters) as not supported, because the list is already limited to one stream.

An encrypted stream's list is built on your device only. Offline, the panel shows what is cached on the device and says so. See [Encrypted scratchpads](/guide/encrypted-scratchpads).

## Search in conversation

The magnifier button in the stream header is titled **Search in conversation**. It opens a search bar over the timeline, scoped to messages in that stream. It shows a match count such as 1/5. Enter moves to the next match, Shift+Enter to the previous one, and the arrow buttons step to older or newer results. Escape closes it. The button is not shown in threads. For searching across the workspace, see [Search basics](/guide/search-basics).

## The stream brief

A stream can have a brief, a short standing note of goals, decisions and preferences that the AI reads on every turn. It is plain markdown of up to 4,000 characters. You edit it in the Companion tab of [stream settings](/guide/stream-settings). Encrypted streams have no brief.

An AI persona can also keep the brief up to date with its `update_stream_brief` tool, with a one-line reason. Brief changes are never silent. The timeline shows a row such as "Ariadne updated the stream brief" ("created" the first time) with the reason, and selecting **stream brief** opens the Companion tab so you can review or correct the text. If a persona write collides with a human edit, the persona is handed your current text and retries on top of it.

The stream's description appears in the timeline too. Setting or clearing it adds a row reading "`<name>` set the description" with the text, or "`<name>` cleared the description".
