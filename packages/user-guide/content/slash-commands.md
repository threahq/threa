---
title: Slash commands
summary: The commands you can type after a slash in the composer, where each one is available and what it does.
section: messages
order: 11
---

# Slash commands

Type `/` in the composer to open a list of commands. The list only shows commands that work in the stream you are in, and you can narrow it by typing part of a name or description.

Some commands run on their own and make up the whole message. Others open a picker and can be used in the middle of a sentence.

## Commands that make up the message

These only appear when the `/` is at the very start of the message. They show up in the composer as a command chip, and they run when you send.

- `/invite` adds people to the stream. Type `/invite` followed by one or more mentions, for example `/invite @sam @ravi`. It works in channels, and in threads whose parent is a channel. Bots can be invited too, but only by workspace admins and owners. Anyone else who names a bot gets "Insufficient permissions to invite bots".
- `/aside` opens a private aside with Ariadne beside what you are reading. It is offered in channels, DMs, scratchpads and threads, but not in encrypted streams, not in archived streams, and not inside an aside. See [Asides: a private side-chat with Ariadne](/guide/asides).

## Commands for a scratchpad with a linked agent

These two only appear in a top-level scratchpad that has a coding agent linked to it, not in threads under it, such as Claude Code or Pi. See [Linking Claude Code, Pi or Hermes](/guide/linked-coding-agents) for how the link works.

- `/replies` chooses where the linked agent answers messages you post in the scratchpad. `/replies thread` answers in a thread on each message, and `/replies flat` answers in the scratchpad itself. Without an argument it reports the current setting.
- `/thread` followed by a message sends that one message and has the agent answer in a thread. It is not offered in encrypted streams.

While a linked session is live, it can add session-control commands to the list, such as `/stop`, `/status`, `/model`, `/compact` and `/steer`. Which ones appear depends on the agent. They are not covered here.

## Pickers you can use anywhere

These add something to your message instead of sending a command. They work in the middle of a sentence too.

- `/memo` ("Search and embed a memo") searches [memory](app:memory) and embeds a memo in your message. See [Using memory in chat](/guide/memory-in-conversations).
- `/snippet` ("Attach a block of text or code") opens the snippet editor and attaches the result as a file. It needs a composer that can upload files.
- `/attachment` ("Place an attached file at the cursor") places a reference to one of your attached files where the cursor is, or lets you upload a new file. It only appears when the composer has a file to place or can upload one. See [Attachments and the Files page](/guide/attachments-and-files).
- `/giphy` ("Search and attach a GIF") opens a GIF search. It is only available in workspaces where a Giphy key has been set up. See [Snippets, GIFs and link previews](/guide/snippets-gifs-and-previews).

Picking one of these from the list removes the typed `/` text and opens the picker. No command chip is added.

## Other triggers

Three characters open a suggestion list without a slash: `@` for people and agents, `#` for channels, and `:` for emoji. See [Mentions and channel links](/guide/mentions-and-links) and [Emoji and reactions](/guide/emoji-and-reactions).
