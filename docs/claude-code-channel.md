# Driving Claude Code from Threa (the channel extension)

This explains how `extensions/claude-code-remote/` lets you control a local Claude Code session from a Threa scratchpad, the same way `extensions/pi-remote/` does for Pi. Read this to understand the mechanism; the README covers setup.

## The two halves, and why they're inverted

There are two independent systems to bridge, and they push in opposite directions.

**Claude Code channels** are a _push-into-the-session_ mechanism. A "channel" is an MCP server that Claude Code launches as a subprocess and talks to over stdio. The channel pushes events into the running session as MCP notifications, and Claude reads them as `<channel source="…">…</channel>` blocks. If the channel exposes a `reply` tool, Claude can call it to send something back out. The channel is the active party: it decides when to inject an event.

**Threa's bot-runtime** is a _pull-from-the-queue_ mechanism. A runtime (like the Pi extension) registers presence, then claims work from Threa. When a human posts a message in a scratchpad whose "active actor" is the bot, the backend writes a `bot_invocation` row and notifies the runtime over a `/bot` websocket. The runtime claims the invocation, does the work, streams trace steps, and completes it with a final reply that posts back into the scratchpad. Threa is the queue; the runtime is a worker that pulls.

So Claude Code wants to _receive pushes_, and Threa wants to _be pulled from_. The channel extension is the adapter that sits between them: it is a Threa worker on one side and a Claude Code channel on the other, turning each claimed invocation into a pushed channel event, and each `reply` tool call into an invocation completion.

```
  Threa web/mobile                    your machine
 ┌────────────────┐        ┌──────────────────────────────────────────┐
 │  scratchpad     │       │  claude (the running session)             │
 │  "fix the bug"  │       │      ▲  pushes <channel> events            │
 └───────┬─────────┘       │      │  + exposes the reply tool           │
         │ message         │  ┌───┴───────────────────────────┐        │
         ▼                 │  │ threa channel (MCP subprocess) │        │
 ┌─────────────────┐       │  │  - claims invocations          │        │
 │  Threa backend   │◄──────┼──┤  - pushes them into the session│        │
 │  bot-runtime API │  HTTP │  │  - reply tool -> /complete     │        │
 │  + /bot socket   │──────►│  │  - relays permission prompts   │        │
 └─────────────────┘ claim  │  └────────────────────────────────┘        │
        pushes              └──────────────────────────────────────────┘
   bot_invocation:available
```

## What runs where

The extension is a single MCP server (`src/index.ts` → `ChannelServer`). Claude Code spawns it with `bun src/index.ts` when you start with `--dangerously-load-development-channels server:threa`. Inside that one process:

- `ThreaClient` (`src/threa-client.ts`) is a thin HTTP client for the Threa bot-runtime API plus a websocket-hint resolver.
- `ChannelServer` (`src/channel-server.ts`) owns the MCP `Server`, a socket.io connection to the `/bot` namespace, and the bridge logic.
- `config.ts` resolves credentials and derives stable ids.

It talks to Threa over HTTPS and a websocket, reusing the public bot-runtime API that already serves Pi. The only backend change is making `claude-code-channel` a first-class linked runtime kind (see [A first-class runtime kind](#a-first-class-runtime-kind) below) — small and additive; everything else rides the existing rails.

## Startup: linking a scratchpad

When the process starts it:

1. Reads `THREA_WORKSPACE_ID` / `THREA_API_KEY` (env or `~/.claude/threa-channel/config.json`) and derives an `instanceId` and `runtimeSessionId` by hashing `hostname + cwd`. Deriving them from the directory means relaunching Claude Code in the same project reuses the same scratchpad instead of spawning a new one each time.
2. `POST /bot-runtime/sessions`, which **creates a scratchpad**, sets the bot as that scratchpad's **active actor**, registers presence, and returns the session link (and the scratchpad URL, which it logs).
3. Resolves the region websocket URL (`GET /api/workspaces/:ws/config`) and connects the `/bot` socket, sending `bot:hello`.
4. Marks presence `available` and starts a backstop claim poll.

### A first-class runtime kind

The channel reports `runtimeKind: "claude-code-channel"`. Originally only `pi-local` could create a session link (the session-create schema was pinned to it, and `claude-code-channel` was configured `sessionLinking: "none"`), so the first cut rode the Pi rails by presenting as `pi-local`. The backend now treats `claude-code-channel` as a first-class linked kind: the session-create schema accepts it, the service stamps the presence and link rows with it, and `runtime-kind-config` gives it `sessionLinking: "required"` with its own "not linked" notice. The only Pi-specific bit withheld is session-control (`/compact`, `/model`, …), which a channel can't drive and so doesn't advertise. The backend change was small and additive — see `apps/backend/src/features/public-api/schemas.ts`, `bot-runtimes/runtime-kind-config.ts`, and `bot-runtimes/service.ts`.

## Inbound: a Threa message becomes a Claude prompt

1. You type in the scratchpad. Because the bot is the active actor, the backend writes a `bot_invocation` (trigger `active-scratchpad`) targeted at this session and emits `bot_invocation:available` over the socket.
2. The channel claims it (`POST /bot-invocations/claim`). The claim response already carries the prompt **and** the hydrated recent conversation, so no extra fetch is needed.
3. The channel pushes it into the session:

   ```
   mcp.notification({
     method: 'notifications/claude/channel',
     params: {
       content: "<the prompt + compact history>",
       meta: { invocation_id, stream_id, source_message_id },
     },
   })
   ```

   Claude sees `<channel source="threa" invocation_id="…">…</channel>` and starts working against your real files.

4. The channel tracks the invocation as "in-flight", flips presence to `busy`, and records one trace step so the scratchpad's session card shows activity.

A claim holds a lease (`claimTtlSeconds`, max 300) that expires if not renewed, so the channel renews every in-flight claim on a timer for as long as Claude is still working.

The channel handles one turn at a time. A message you send while Claude is still working waits in Threa until the current turn completes, then gets claimed and pushed. The one exception is a permission verdict (below), which is pulled through immediately so a blocked turn can continue.

## Outbound: the reply tool completes the invocation

The channel exposes one tool, `reply(invocation_id, text)`. Claude is told (via the server's `instructions`, which land in its system prompt) to call it exactly once per `<channel>` event. When Claude calls it:

1. The channel looks up the in-flight invocation by `invocation_id`.
2. It calls `POST /bot-invocations/:id/complete` with `finalMessageMarkdown: text`. That posts the reply into the scratchpad and closes the invocation.
3. It clears the in-flight entry, and when nothing is in flight, flips presence back to `available`.

The `reply` tool is the only path back to Threa, which is why the instructions insist on it. As a safety net, an in-flight invocation that is never answered is force-closed after `replyTimeoutMs` (default 30 minutes) with a short notice, so a session can't get wedged in `busy` forever.

## Attachments

Attachments cross in both directions, but the claim response doesn't carry them, so each direction needs a little extra work.

**Inbound (scratchpad → working directory).** The claim's hydrated history is text only — no attachment metadata, and the trigger message itself isn't in it. So before pushing the event, the channel lists the recent messages of the invocation's stream (`GET /streams/:id/messages`), picks the attachments on the source message plus any on the history Claude is being shown, downloads each into `.threa-attachments/<invocation_id>/` under the working directory (via a short-lived signed URL from `GET /attachments/:id/url`), and appends a manifest of local paths to the channel content. Claude reads the files straight from disk. The whole step is best-effort: a key without `attachments:read`, or any download failure, is logged and the prompt still goes through without the files.

**Outbound (working directory → scratchpad).** The `reply` tool's text may contain `THREA_ATTACH: <path>` lines. Before completing the invocation, the channel strips those lines, uploads each file (`POST /attachments`, multipart), and appends `[name](attachment:<id>)` links to the reply markdown. The backend associates the uploads with the posted message purely from those links — there is no separate attachment-ids field on `complete`. A failed upload is reported inline rather than dropping the reply.

## Permission relay: approving tools from Threa

When Claude calls a tool that needs approval and you're not at the terminal, the session would normally stall. The channel opts into permission relay (`claude/channel/permission`). The loop:

1. Claude Code sends the channel a `notifications/claude/channel/permission_request` with a five-letter `request_id`, the tool name, and a short description.
2. The channel posts that into the scratchpad as a normal message: _"Claude Code wants to run `Bash`… Reply `yes abcde` or `no abcde`."_
3. You reply in the scratchpad. That reply is itself a scratchpad message, so it comes back to the channel as another claimed invocation. The channel recognizes the `yes <id>` / `no <id>` shape against its open requests and, instead of pushing it to Claude as a new prompt, sends Claude Code the verdict (`notifications/claude/channel/permission`) and silently closes that invocation.

The local terminal dialog stays open the whole time, so whichever answer arrives first wins. Because anyone who can post in the scratchpad can approve, only enable relay in workspaces you trust. Disable it with `THREA_PERMISSION_RELAY=0`, or skip prompts entirely with `--dangerously-skip-permissions` for unattended use.

## Resilience

- If the `/bot` socket can't connect (or drops), the backstop poll keeps claiming work; the socket just makes delivery near-instant.
- If linking the scratchpad fails at startup (Threa briefly unreachable), the poll loop retries the link on its next tick.
- The MCP transport is stdout, so the extension never writes there: all diagnostics go to stderr, surfaced in `~/.claude/debug/<session-id>.txt` and `/mcp`.
- On shutdown it fails any in-flight invocations and marks presence `offline`.

## Pi extension vs. this channel

| Concern                                   | Pi extension (`pi-remote`)                                | This channel (`claude-code-remote`)                                  |
| ----------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| Where it runs                             | Inside Pi, via Pi's extension API                         | A subprocess Claude Code spawns over stdio                           |
| How it gets a prompt                      | Claims invocation, injects via `pi.sendUserMessage`       | Claims invocation, pushes a `notifications/claude/channel` event     |
| How it returns a reply                    | Hooks Pi's `agent_end`, posts the captured assistant text | Claude calls the `reply` tool, which completes the invocation        |
| Trace detail                              | Rich per-tool steps (it hooks Pi's tool events)           | One "working" step (a channel can't see Claude's tool calls)         |
| Session control (`/compact`, `/model`, …) | Yes                                                       | No (a channel can't drive Claude's session)                          |
| Permission prompts                        | N/A (Pi runs the model in-process)                        | Relayed into the scratchpad as messages                              |
| Attachments                               | Downloads inbound, `THREA_ATTACH:` uploads outbound       | Same, but inbound needs an extra stream-messages fetch to find them  |
| Backend changes                           | None                                                      | Small — `claude-code-channel` made a first-class linked runtime kind |

## Limits today

- Single "working" trace step rather than a per-tool trace.
- No session-control commands (a channel can't drive Claude's host session).
