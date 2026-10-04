---
title: What is Threa
summary: Threa is chat with a memory underneath. Start in a private scratchpad, add channels for your team, and let Ariadne help.
section: getting-started
order: 1
---

# What is Threa

Threa is a chat app that keeps what matters. You write in conversations like in any other chat tool, and Threa can save the decisions, facts and how-tos from them as memory you can search later. You choose per conversation whether it does.

## Scratchpads come first

You don't need a team to use Threa. A **scratchpad** is a private conversation that only you can open. Use it for notes, half-formed ideas, links you want to keep, or thinking out loud with [Ariadne](/guide/meet-ariadne), the built-in AI companion. See [Your first scratchpad](/guide/your-first-scratchpad).

## Channels, DMs and threads

When you bring other people in, the same building blocks scale up:

- **Channels** are shared spaces for a team or a topic. They are public (anyone in the workspace can read them) or private (invite only).
- **Direct messages** are private conversations between two people.
- **Threads** branch off any message, so a side discussion doesn't bury the main conversation. A thread can have threads of its own.

Everything you can write in is called a stream. The sidebar lists the streams you've joined, and the [Streams](app:streams) page lists every stream you can reach.

## Memory

A chat history is hard to search by gist. Threa turns the important parts into **memos**: short entries such as "Auth refactor held pending token-rotation review". Each memo keeps pointers to the messages it came from, so you can jump back to the original conversation.

When Threa saves something, a "Saved to memory" line appears in the conversation. Open the [Memory](app:memory) page to browse, filter and search everything Threa remembers that you can see. Use [Search](app:search) to find messages and [Files](app:files) to find shared files.

Each stream has an **Automatic memory** setting. It starts on in channels, direct messages and Quick Notes, and off in scratchpads where Ariadne replies, so you choose whether a conversation with her gets remembered. Memory from your private scratchpads stays visible only to you.

## Ariadne

Ariadne is Threa's built-in AI companion. She replies in scratchpads where the companion is on, and you can bring her into any other conversation, except an encrypted one, by mentioning her with `@ariadne`. She can search your workspace and memory, search the web, and read files shared in a conversation. Read [Meet Ariadne](/guide/meet-ariadne) for what she can and can't see.

## Bring your own tools

You can connect your own agents through the public API, the CLI and an MCP server. That is covered in the [developer docs](https://threa.io/developers), not in this guide.
