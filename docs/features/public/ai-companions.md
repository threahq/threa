---
title: AI Companions
status: shipped
audience: public
since: 2026-05
surfaces: [scratchpads, stream-settings, message-timeline, trace-view]
public_site: true
summary: >
  Turn on a companion for a stream and Ariadne reads new messages and replies in
  the thread, with a live activity card and a full trace of every step she took.
---

## What it does

A companion is an AI participant in a stream. Turn it on for a scratchpad and
Ariadne, Threa's built-in companion, reads each new message and replies in the
thread. Turn it off and the same stream is silent storage with no AI and no
inference cost.

Ariadne is a thinking companion, not just a chat bot. She can search your
workspace (messages, streams, people, attachments), look things up on the web,
read URLs, run longer research, and pull from connected GitHub and Linear. She
answers in the stream like any other participant, so her replies live alongside
your own messages and stay part of the thread's history.

Two ways to reach her:

- **Companion mode.** Switch a stream to "Companion" and she responds to every
  new message you post there: you think out loud, she keeps up. A new scratchpad
  starts this way; a plain "quick note" starts quiet.
- **By mention.** Type `@ariadne` in any message and she replies to that one
  message, whether or not companion mode is on.

When a thread is opened off a scratchpad that has companion mode on, the thread
inherits it, so Ariadne keeps responding inside nested threads without you
turning it on again.

## How you use it

- **Start with or without her.** "New Scratchpad" creates a stream with the
  companion on; "New Quick Note" creates the same kind of stream with it off, for
  plain capture. You can flip either one later.
- **Companion mode toggle.** Open a stream's settings and pick Companion or
  Quiet. Companion means Ariadne reads new messages and replies; Quiet means the
  stream is just storage. The change saves right away.
- **Spot which streams have her.** A scratchpad with the companion on shows a
  sparkle marker in the sidebar and a companion indicator in its header.
- **Watch her work.** While Ariadne is running, an activity card appears in the
  timeline: "Ariadne is working…" with a live count of steps and messages and a
  short line describing the current phase (for example "Planning queries…"). When
  she finishes it settles into "Session complete" with the step count, duration,
  and how many messages she sent.
- **Open the trace.** Click that card to see the full trace: every step she took,
  the tools she called, her reasoning, and the sources she pulled from. The trace
  streams in live as she works and stays available after she's done.
- **Stop a long run.** During a long research step the activity card shows a Stop
  button so you can cut it short.

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
  ciphertext, so the toggle is informational there and replies never happen.
  (The separate enclave path that lets a companion serve an encrypted stream is
  documented under e2e-encrypted-scratchpads, not here.)
- **External bots are a different feature.** The "bot status strip" that shows
  Available / Working / Not connected is for third-party bot runtimes, not for
  Ariadne. Her status shows as the in-timeline activity card described above.

## Related

- [`docs/core-concepts.md`](../../core-concepts.md) describes personas as data at
  the domain level.
