---
title: AI Companions
status: shipped
audience: public
since: 2026-05
surfaces: [scratchpads, stream-settings, workspace-settings, message-timeline, trace-view]
public_site: true
summary: >
  A per-stream on/off setting; when it's on, Ariadne reads each new message and
  replies in the thread. An activity card and a step-by-step trace show what it did.
related: [architecture/agent-runtime.md]
---

## What it does

A companion is an AI agent attached to a stream. Each stream carries a companion
mode that is either on or off. With it on, the stream's companion agent reads each
new message in the stream and replies in the thread. With it off, the stream is
storage only and nothing runs.

The default companion is Ariadne, Threa's built-in agent. A workspace can also
create its own agents (see "Custom agents" below) and pick which one replies in
each stream.

Ariadne replies as a normal participant: its messages land in the stream next to
yours and stay in the thread's history. It has a set of tools it can call while it
works: searching the workspace (messages, streams, people, attachments), searching
the web and reading URLs, a longer research mode, and reading from GitHub and
Linear when those integrations are connected.

A companion runs in two cases:

- **Companion mode on.** The stream's companion agent responds to every new message
  in the stream. A new scratchpad starts with companion mode on; a quick note starts
  with it off.
- **A mention.** Writing `@ariadne` in a message invokes Ariadne for that one
  message, regardless of the stream's companion mode.

Companion mode is inherited down a scratchpad: a thread opened under a scratchpad
that has it on runs the companion too, without being switched on per thread.

## How it surfaces

- **Creating one.** "New Scratchpad" makes a stream with companion mode on; "New
  Quick Note" makes the same kind of stream with it off. Either can be changed
  later.
- **The toggle.** A stream's settings has a Companion / Quiet switch. Companion
  means the agent reads new messages and replies; Quiet means storage only. It
  saves immediately.
- **The agent picker.** Below the toggle, a stream's settings offers a Companion
  agent select listing the built-in Ariadne plus any workspace custom agents.
  Picking one sets which agent replies here; it saves immediately. Threads inherit
  their scratchpad's agent.
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

## Custom agents

Admins manage agents from workspace settings → **AI Agents**. The roster lists the
built-in Ariadne and any workspace custom agents. Two kinds, with different editing
scope:

- **Ariadne (built-in) is bounded.** An admin can change her toolset, model, and
  two style presets — a Tone (warm / neutral / direct) and a Brevity (brief /
  balanced / thorough). Her name, avatar, and system prompt are fixed; the prompt
  shows read-only.
- **Custom agents are fully editable.** "New agent" forks an existing agent (Ariadne
  or another custom) into an editable copy — its prompt, tools, model, and style
  carry over. A custom agent has a full editor: name, description, avatar (emoji or
  an uploaded image), free-form system prompt, free-text Tone and Brevity guidance,
  tools, model, an optional escalation model, and temperature / max tokens. Custom
  agents can be archived (and restored from an Archived list); a stream pointing at
  an archived agent falls back to Ariadne.

Both editors carry the same test-drive, draft, and revision-history behavior:
edits sync into a server-side draft, a bound test scratchpad lets an admin talk to
the candidate agent before saving, and every save appends a restorable revision.

## Boundaries

- **Custom agents are workspace-only.** They live in the workspace that created
  them; there is no cross-workspace or global agent. An internal "Empty Agent"
  shell exists but is not a product-facing companion.
- **End-to-end encrypted streams always run Ariadne.** The companion runs inside
  the encryption enclave there and the agent picker is hidden — a custom agent's
  pointer is ignored on an encrypted scratchpad. The enclave path is documented
  under e2e-encrypted-scratchpads.
- **External bots are a different feature.** The "bot status strip" that shows
  Available / Working / Not connected is for third-party bot runtimes, not for
  companion agents. Companion status shows as the in-timeline activity card
  described above.

## Related

- [`architecture/agent-runtime.md`](../architecture/agent-runtime.md) is the
  subsystem that runs a companion: the loop, the session lifecycle, tools, and traces.
- [`docs/core-concepts.md`](../../core-concepts.md) describes personas as data at
  the domain level.
