---
title: Turning automatic memory off
summary: Where the per-stream Automatic memory switch is, what its default is for each kind of stream, and what turning it off stops.
section: memory
order: 3
---

# Turning automatic memory off

**Automatic memory** decides whether Threa saves memos from a stream's conversations. It is set per stream, and you can turn it off for streams where saved memos would only add noise.

## Change the setting

Open the stream's settings (choose **Open stream settings** in the command palette), go to the **General** tab and use the **Automatic memory** switch. It is available for channels, scratchpads and direct messages. The switch applies right away and no confirmation appears.

## Defaults

- Channels and direct messages start with it on.
- A Quick Note starts with it on.
- A new scratchpad with Ariadne on starts with it off, because a conversation with an agent is not usually worth saving by default. Turn it on from the scratchpad's settings if you want it kept.
- An [aside](/guide/asides) is always off, and its settings have no switch.

## Threads and system streams

A thread follows its parent stream. It has no switch of its own, and changing the parent changes its threads too. System streams, which hold automated messages, have no switch either.

## What turning it off does

- Threa stops extracting memos from new conversations in that stream.
- A conversation already waiting to be processed is skipped if the switch was off by the time Threa got to it.
- The same switch stops automatic to-do capture from the stream and the memos agents write from their own session work.
- Memos that already exist stay. Archive or delete them from the [Memory](app:memory) page.
- Messages stay searchable. You and Ariadne can still find the stream's conversations through search; only the memos are skipped.
- Someone can still ask an agent to save a memo on purpose. See [Using memory in chat](/guide/memory-in-conversations).

Encrypted scratchpads never produce memos, whatever the switch says. For what is saved when it's on, see [How Threa remembers](/guide/how-memory-works).
