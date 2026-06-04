---
title: AI Companions
status: shipped
audience: public
since: 2026-05
surfaces: [scratchpads, stream-settings, message-timeline, trace-view]
public_site: true
summary: >
  Turn on a companion for a stream and Ariadne reads new messages and replies in
  the thread. A live activity card and a step-by-step trace show what it did.
---

## What it does

A companion is an AI participant in a stream. Turn it on for a scratchpad and
Ariadne, Threa's built-in companion, reads each new message and replies in the
thread. Turn it off and the stream is storage only, with no AI replies.

Ariadne can search your workspace (messages, streams, people, attachments),
search the web, read URLs, run longer research, and read from connected GitHub
and Linear. Replies post into the stream like any other message, so they sit
alongside yours and stay in the thread's history.

Two ways to invoke it:

- **Companion mode.** Switch a stream to "Companion" and Ariadne replies to every
  new message you post there. A new scratchpad starts this way; a plain quick note
  starts quiet.
- **By mention.** Type `@ariadne` in a message and it replies to that one message,
  whether or not companion mode is on.

When you open a thread off a scratchpad that has companion mode on, the thread
inherits it, so Ariadne keeps replying in the thread without you turning it on
again.

## How you use it

- **Start with or without it.** "New Scratchpad" creates a stream with the
  companion on; "New Quick Note" creates the same kind of stream with it off, for
  plain capture. You can change either one later.
- **Companion mode toggle.** In a stream's settings, pick Companion or Quiet.
  Companion means Ariadne reads new messages and replies; Quiet means the stream is
  storage only. The change saves right away.
- **See which streams have it.** A scratchpad with the companion on shows a sparkle
  marker in the sidebar and a companion indicator in its header.
- **Activity card.** While Ariadne is running, an activity card in the timeline
  reads "Ariadne is working…" with a running count of steps and messages and a line
  for the current phase (for example "Planning queries…"). When it finishes the
  card reads "Session complete" with the step count, duration, and number of
  messages sent.
- **Trace.** Click the card to open the trace: each step, the tools called, the
  reasoning, and the sources used. It streams in as Ariadne works and stays
  available afterward.
- **Stop a long run.** During a long research step the card shows a Stop button.

## Boundaries

- **Ariadne is the only companion today.** The persona model is data-driven (a
  persona carries its own name, avatar, model, system prompt, and tool list), and
  the schema supports workspace-specific personas, but there is no UI to create
  them or to pick a different one. Companion mode always uses Ariadne. There is
  also an internal "Empty Agent" shell that is not a product-facing companion.
- **No persona picker.** A stream stores which persona its companion uses, and the
  update API accepts one, but the settings screen only offers on/off. Choosing a
  persona per stream is not exposed.
- **End-to-end encrypted streams keep the companion off.** Ariadne can't read
  ciphertext, so the toggle is informational there and replies never happen. The
  separate enclave path that lets a companion serve an encrypted stream is
  documented under e2e-encrypted-scratchpads, not here.
- **External bots are a different feature.** The "bot status strip" that shows
  Available / Working / Not connected is for third-party bot runtimes, not for
  Ariadne. Companion status shows as the in-timeline activity card described above.

## Related

- [`docs/core-concepts.md`](../../core-concepts.md) describes personas as data at
  the domain level.
