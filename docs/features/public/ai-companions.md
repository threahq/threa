---
title: AI Companions
status: shipped
audience: public
since: 2026-05
surfaces: [scratchpads, stream-settings, message-timeline, trace-view]
public_site: true
summary: >
  A per-stream on/off setting; when it's on, Ariadne reads each new message and
  replies in the thread. An activity card and a step-by-step trace show what it did.
related: [architecture/agent-runtime.md]
---

## What it does

A companion is an AI agent attached to a stream. Each stream carries a companion
mode that is either on or off. With it on, Ariadne (Threa's built-in companion)
reads each new message in the stream and replies in the thread. With it off, the
stream is storage only and nothing runs.

Ariadne replies as a normal participant: its messages land in the stream next to
yours and stay in the thread's history. It has a set of tools it can call while it
works: searching the workspace (messages, streams, people, attachments), searching
the web and reading URLs, a longer research mode, and reading from GitHub and
Linear when those integrations are connected.

A companion runs in two cases:

- **Companion mode on.** Ariadne responds to every new message in the stream. A
  new scratchpad starts with companion mode on; a quick note starts with it off.
- **A mention.** Writing `@ariadne` in a message invokes Ariadne for that one
  message, regardless of the stream's companion mode.

Companion mode is inherited down a scratchpad: a thread opened under a scratchpad
that has it on runs the companion too, without being switched on per thread.

## How it surfaces

- **Creating one.** "New Scratchpad" makes a stream with companion mode on; "New
  Quick Note" makes the same kind of stream with it off. Either can be changed
  later.
- **The toggle.** A stream's settings has a Companion / Quiet switch. Companion
  means Ariadne reads new messages and replies; Quiet means storage only. It saves
  immediately.
- **Indicators.** A scratchpad with companion mode on shows a sparkle marker in the
  sidebar and a companion indicator in its header.
- **The activity card.** While a run is in progress, a card in the timeline shows
  "Ariadne is working…" with a running count of steps and messages and the current
  phase (for example "Planning queries…"). When the run ends the card shows
  "Session complete" with the step count, duration, and number of messages sent.
- **The trace.** Opening the card shows the trace of the run: each step, the tools
  called, the reasoning, and the sources used. It streams in while the run is going
  and stays available afterward.
- **Stopping a run.** During a long research step the card shows a Stop button.

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

- [`architecture/agent-runtime.md`](../architecture/agent-runtime.md) is the
  subsystem that runs a companion: the loop, the session lifecycle, tools, and traces.
- [`docs/core-concepts.md`](../../core-concepts.md) describes personas as data at
  the domain level.
