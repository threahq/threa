# @threa/remote-session

SDK for connecting an agent runtime to a Threa scratchpad. A connector
implements one hook, `deliverTurn`, and optionally a session-control actuator.
The SDK links the scratchpad, claims work, keeps presence and claim leases
alive, routes `/steer` and `/stop`, moves attachments in both directions, and
posts interim and final replies. Claude Code and Pi connect to Threa through
this package.

The protocol underneath is public and documented at
[threa.io/developers](https://threa.io/developers) (API reference sections
`Bot runtimes` and `Bot invocations`, and the "Connect your local agent"
recipe). This package is a client for it; nothing here needs a special server.

## Install

```sh
npm install @threa/remote-session
```

Node 20+ or Bun. Pulls in `@threa/bot-runtime-client` (the socket transport)
and `socket.io-client`.

## Which flow you need

Threa dispatches work to a bot in two ways, and the runtime kind you register
with picks the one you get.

Mention-driven. Someone `@mentions` the bot in any stream. Any live instance of
the bot may claim the invocation, do the work, and complete it with a reply.
Available to every runtime kind, including `custom`. This is `ThreaClient`
plus the transport; see [`examples/mention-bot.ts`](examples/mention-bot.ts).

Scratchpad-linked. The runtime owns a scratchpad: every message in it is a
turn for the runtime, the composer offers `/steer`, `/stop`, and whatever
commands the runtime advertises, and the runtime replies in place. This is
`RemoteSession`. Session links are created with `POST /bot-runtime/sessions`,
which today accepts the runtime kinds `pi-local` and `claude-code-channel`
only; a `custom` runtime cannot link a scratchpad yet. See
[`examples/echo-connector.ts`](examples/echo-connector.ts).

## Credentials

Create a bot in Threa (personal or workspace), give it the `mentionable` trait
and, for a scratchpad-linked runtime, `active-scratchpad`. Mint a
`threa_bk_` key on it with `bot-runtime:write`, `bot-invocations:write`,
`messages:write`, `streams:read`, `messages:read`, and `attachments:read`
(add `attachments:write` to send files back, `delegations:read` and
`delegations:write` to run delegations). `loadConfig` reads
`THREA_WORKSPACE_ID`, `THREA_API_KEY`, and optional `THREA_BASE_URL` (default
`https://app.threa.io`) from the environment, or from a JSON file you pass in.

## A connector

```ts
import { hostname } from "node:os"
import {
  RemoteSession,
  ThreaClient,
  loadConfig,
  wireLifecycle,
  type SessionControlActuator,
} from "@threa/remote-session"

const identity = { idPrefix: "oc", sessionIdPrefix: "ocs", displayNamePrefix: "OpenClaw" }
const result = loadConfig({ env: process.env, cwd: process.cwd(), hostname: hostname() }, identity)
if ("error" in result) throw new Error(result.error)

// Only when the connector can drive its runtime; omit it and Threa never
// offers the commands.
const sessionControl: SessionControlActuator = {
  commands: ["stop", "steer", "model"],
  interrupt: () => myRuntime.interrupt(),
  runCommand: async (name, args) => ({ ok: true, message: await myRuntime.run(name, args) }),
}

const session = new RemoteSession({
  config: result.config,
  client: new ThreaClient(result.config),
  runtime: {
    kind: "claude-code-channel",
    busyStatusText: "Working in OpenClaw…",
    forwardedNote: "Forwarded to OpenClaw.",
    shutdownErrorMessage: "OpenClaw channel shut down",
  },
  delegate: {
    // Push a turn into the runtime; resolve when handed off, not when answered.
    deliverTurn: async (turn) => myRuntime.prompt(turn.content, turn.invocationId),
    sessionControl,
  },
})

wireLifecycle(session, process, { logPrefix: "[openclaw-channel]" })
await session.start()

// From inside the runtime, stream progress and close the turn:
await session.sendInterim(invocationId, "halfway there")
await session.reply(invocationId, "done, here is the result")
```

`start()` creates or resumes the scratchpad link for this identity (the
identity is derived from hostname and working directory, so a restart in the
same directory lands in the same scratchpad), opens the socket, and begins
claiming. `deliverTurn` receives each turn with the prompt, any hydrated
history, and downloaded attachments listed in the content.

## What the SDK decides for you

- One normal turn at a time. While a turn is in flight the session claims
  session-control invocations only, so `/stop` and `/steer` reach the runtime
  while the next message waits.
- `/stop` calls `actuator.interrupt()`, closes the in-flight turn (with a
  "Stopped by /stop." note unless the turn had already posted an interim), and
  does not pull the next queued message.
- `/steer` folds the text into the running turn through `actuator.steer` when
  the actuator has it, otherwise interrupts and redelivers the steer text plus
  any queued messages as one combined turn.
- Every other advertised command goes to `actuator.runCommand`, and its
  returned `message` is posted as the acknowledgement.
- Claims are renewed every 40s on a 120s lease; a claim the server no longer
  knows is dropped and presence is resynced.
- A turn that stays silent for `idleTimeoutMs` (default one hour, reset by
  every `sendInterim`) is closed with a notice. Set it above the longest tool
  call your runtime makes.
- `reply` and `sendInterim` return `{ ok, message, retryable }` instead of
  throwing. `ok: false` with `retryable: true` means the request is still
  open and the same call can be repeated.
- If the scratchpad is archived the session goes offline, fails its in-flight
  turns, and waits for an unarchive. If none arrives within the grace window it
  calls `delegate.onArchived`.
- `wireLifecycle` routes SIGINT, SIGTERM, SIGHUP, stdin close, and uncaught
  errors through `shutdown()`, which marks presence offline and fails
  in-flight claims so the scratchpad is never left "busy" with nobody behind it.

`delegate.onLinked(link)` runs on every link create or resume, if you need to
record which scratchpad this process owns.

## Delegations

`DelegationClient` speaks the delegation endpoints (`list`, `get`, `claim`,
`heartbeat`, `status`, `complete`, `fail`, `release`). `DelegationRunner` is an
optional loop over it: it polls or reacts to the `delegation:available` nudge,
claims, heartbeats the lease while your executor runs, and completes or fails
with the executor's result. A 404 from a claim-authenticated call means the
claim is lost; the runner aborts the executor and sends nothing further with
that token.

## Errors

HTTP failures throw `ThreaApiError` with `status` and the server's structured
`code` (for example `SCRATCHPAD_ARCHIVED`, `E2E_STREAM_PLAINTEXT_UNSUPPORTED`).
Socket failures never throw; the transport logs them through the `log` you
pass and falls back to HTTP.

## End-to-end encrypted scratchpads

Set `e2e: true` in the config (or `THREA_E2E=1`) to create the linked
scratchpad encrypted. The SDK mints the stream key, wraps it to the bot
owner's key and its own identity key (persisted at `bikPath`, default
`~/.threa/bik-<kind>.json`), and from then on decrypts claims and seals
replies and trace steps locally. The owner must have set up encryption in
Threa first; until then `start()` logs the reason and retries on each poll.

## Inside the Threa repo

This directory is consumed by `extensions/claude-code-remote` through a
`file:` dependency and runs from `src/`. `bun run build` writes the
publishable package to `dist/`; `bun run pack` produces the tarball.
