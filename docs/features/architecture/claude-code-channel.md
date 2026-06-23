---
title: Claude Code Channel
status: shipped
audience: internal
kind: subsystem
invariants: [INV-4]
entry_points:
  - extensions/claude-code-remote/src/channel-server.ts
  - extensions/claude-code-remote/src/index.ts
  - extensions/claude-code-remote/src/threa-client.ts
  - extensions/claude-code-remote/src/attachments.ts
  - apps/backend/src/features/bot-runtimes/runtime-kind-config.ts
  - apps/backend/src/features/bot-runtimes/socket-handler.ts
public_site: false
summary: >
  A Claude Code stdio MCP server that links a local Claude Code session to a Threa
  scratchpad: messages posted there are dispatched to Claude as a turn, and Claude
  replies back through the bot-runtime public API.
---

## The gist

A Claude Code channel turns a Threa scratchpad into the front end for a local Claude Code
session. You run the `threa-channel` extension (`@threa/claude-code-remote`) as a Claude
Code stdio MCP server; it creates a linked scratchpad, and from then on every message you
post in that scratchpad is dispatched to your Claude Code session as a turn, and Claude's
answer is posted back as a message in the same scratchpad.

It is one of the external bot-runtime kinds, alongside `pi-local`. It does not run inside the
backend; it is a local process that talks to the regional backend over the bot-runtime public
API. The backend treats it like any other runtime: a user message in a scratchpad whose active
actor is the bot becomes a bot invocation, the invocation is offered to the connected runtime,
the runtime claims it, works, and completes it. The channel's whole job is to bridge that
invocation protocol to Claude Code's MCP tool interface.

The mental model: the backend owns the invocation lifecycle (the same outbox-driven path every
bot uses, INV-4); the channel is a thin, resilient client that claims a turn, forwards it to
Claude as an MCP notification, and turns Claude's `send`/`reply` tool calls back into Threa
messages and completions. If you only need that model, stop here. The rest is the protocol and
the resilience details.

## How it works

**Process model and linking.** `main()` connects the stdio MCP transport first so Claude Code
discovers the channel's tools, then starts the Threa bridge (`src/index.ts`). On start the
channel calls the session-create endpoint with `runtimeKind: "claude-code-channel"` plus a
stable `instanceId` and `runtimeSessionId` derived from `sha256(hostname:cwd)`. The backend
creates a scratchpad, adds the bot, makes the bot the stream's active actor, and returns a
stream URL. Because the bot is the active actor, messages in that scratchpad dispatch to the
channel with no @-mention needed. Relaunching in the same directory reuses the same link
(idempotent on the derived ids).

**Two transports.** State changes go over HTTP under the `/api/v1/workspaces/:id/...` bot-runtime
API with a bearer bot key (presence, claim, renew, steps, complete, fail, messages, attachments)
in `src/threa-client.ts`. A Socket.IO connection to the `/bot` namespace is a push-only fast path:
the backend pushes `bot_invocation:available` to wake the channel and `bot:resync` to ask it to
re-announce. A polling loop is the backstop, running every few seconds and backing off to 30s once
the socket is healthy, so the channel still works if the socket hint fails. The channel announces
itself once per connection with `bot:hello` (its kind, ids, capabilities, and an output manifest),
and the backend acks a snapshot of available invocations and owned claims (`socket-handler.ts`).

**A turn.** A scratchpad message becomes a `bot_invocations` row via the bot-invocation outbox
handler, which emits `bot_invocation:available`. The channel claims one turn at a time, registers
it in-flight, sets presence busy, records a single "thinking" step ("Forwarded to Claude Code."),
builds the turn content (the prompt plus a bounded slice of recent history), and fires an MCP
notification to Claude carrying the content and the invocation metadata. Claude answers with two
MCP tools the channel registers: `send` for interim messages and `reply` for the final answer.
`reply` calls the complete endpoint with the final markdown; `send` posts a plain interim stream
message (tagged in metadata, deduped by a per-send `clientMessageId`) without closing the
invocation. A claim is renewed on a timer at a third of its lease so a single miss cannot expire it.

**Idle, not absolute, timeout.** Each in-flight turn carries a deadline that resets on any sign of
life (an interim `send`, or a permission prompt). It is an inactivity timer (default one hour, with
a floor), explicitly not a cap on how long a turn may run, because Claude cannot heartbeat while
blocked inside a single long tool call. When it fires, a turn that already sent something completes
silently; a turn that sent nothing posts a short "ended the turn without sending a reply" note.

**Attachments** (`src/attachments.ts`). Inbound is best-effort: since the claim context omits
attachments, the channel scans recent stream messages, downloads attachments on the source and
shown-history messages through short-lived signed URLs into a local `.threa-attachments/<id>/`
directory, and appends a manifest of local paths to the prompt. Outbound, Claude adds
`THREA_ATTACH: <path>` lines to its reply; the channel strips those directives, uploads each file,
and rewrites the reply to carry attachment links. Failures on either side degrade to a logged note
rather than dropping the turn.

**Lifecycle and shutdown** (`src/index.ts`). Every death path routes through one idempotent
graceful teardown: SIGINT/SIGTERM/SIGHUP, stdin end/close (the parent Claude Code process died or
was replaced), and uncaught exceptions. Teardown disconnects the socket, marks presence offline,
and fails all in-flight claims, so a dead channel flips its turns to failed rather than leaving them
stuck busy. A short bounded exit guard stops a hung request from holding the process past Claude
Code's own shutdown window. This matters because Claude Code does not respawn a dead stdio MCP
server mid-session, so the channel has to clean up after itself.

## Details worth knowing

**Dispatch policy is keyed by runtime kind.** `runtime-kind-config.ts` marks `claude-code-channel`
as `sessionLinking: "required"`. If a message arrives for the bot with no active session link, the
backend posts a "not linked, start Claude Code with the Threa channel" notice instead of dispatching.

**Presence is derived from the in-flight count**, not declared: busy while any turn is live,
available when idle, offline on shutdown.

**Identity ids are constrained.** `instanceId` and `runtimeSessionId` are the `sha256(hostname:cwd)`
hashes and must match the hello schema's id pattern; they are what makes relaunch idempotent.

**stdout is reserved for the MCP transport.** All diagnostics go to stderr; writing to stdout would
corrupt the protocol.

**Secrets stay out of tracked files.** The workspace id and bot key come from a home-directory config
(`~/.claude/threa-channel/config.json`) or environment, never from a committed `.mcp.json`. The
`defaultLabel` config is sent as the new scratchpad's label, and only applied when the scratchpad is
first created (a relink returns the existing link and does not relabel).

**Research-preview gating.** Loading a custom channel into Claude Code needs the development-channels
flag; this is a preview surface.

## Boundaries

- **No per-tool trace.** A channel only observes the inbound turn and Claude's `send`/`reply`, not
  Claude's individual tool calls, so the Threa trace card shows a single working step, not a
  step-by-step trace the way an in-process persona or Pi does.
- **No heartbeat during one long tool call.** Claude cannot `send` while blocked, so the idle timeout
  must exceed the longest single operation a turn will run.
- **One turn at a time.** A message sent while Claude is working queues until the current reply lands;
  a permission verdict is the only thing that jumps the queue.
- **Inbound attachments are best-effort and bounded** to a recent-message scan; a very old attachment
  may not be picked up, and a missing read scope is skipped rather than failing the turn.

## Invariants

- **INV-4.** The inbound side rides the outbox: a scratchpad message becomes a bot invocation through
  the bot-invocation outbox handler and is delivered as `bot_invocation:available`, rather than the
  channel being poked directly. The channel claims, renews, and completes against that invocation.

## Entry points

- `extensions/claude-code-remote/src/channel-server.ts`: the orchestrator. MCP `send`/`reply` tools,
  claim and drain, the single trace step, the idle timeout, permission relay, the `/bot` socket,
  presence, renew, and the poll backstop.
- `extensions/claude-code-remote/src/index.ts`: process bootstrap and the graceful-shutdown wiring
  that routes every death path through one idempotent teardown.
- `extensions/claude-code-remote/src/threa-client.ts`: the HTTP client for the bot-runtime API and the
  socket-hint resolution and URL building.
- `extensions/claude-code-remote/src/attachments.ts`: inbound download and the outbound `THREA_ATTACH`
  upload and link rewrite.
- `apps/backend/src/features/bot-runtimes/runtime-kind-config.ts`: per-kind dispatch policy
  (`sessionLinking: "required"` for this kind).
- `apps/backend/src/features/bot-runtimes/socket-handler.ts`: the `/bot` namespace, `bot:hello`
  validation, and the bootstrap-snapshot ack.
