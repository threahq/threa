# @threa/remote-session

The Threa remote-session SDK. Everything a connector needs to bridge an
interactive agent runtime (Claude Code, Pi, a future Hermes/OpenClaw-style
client) to a Threa scratchpad lives here; a connector implements two small
hooks and inherits the rest.

Local-first: consumed via `file:../remote-session` inside this repo (not
published to npm). `extensions/claude-code-remote` is the reference consumer.

## What the SDK owns

- **Identity** — stable per-directory instance/session ids (`deriveStableId`),
  config resolution from env + file (`loadConfig`), display names.
- **`ThreaClient`** — the bot HTTP API (sessions, claim/complete/fail,
  messages, attachments).
- **`RemoteSession`** — the whole loop: scratchpad linking, claim drain with
  busy semantics, `/steer` folding + `/stop`, presence, claim renewal, idle
  timeouts, inbound/outbound attachments, interim sends and final replies.
- **Lifecycle** — `wireLifecycle` routes every process-death path through one
  graceful teardown. Active delegation executions are aborted cooperatively and
  live claims are released; shutdown waits briefly for release, then continues.

## Delegation client and runner

`DelegationClient` exposes the harness-independent HTTP protocol: inspect with `get`, claim, call `heartbeat` manually as needed, report progress, then complete, fail, or release. Any HTTP client can use the same endpoints. `DelegationRunner` is optional convenience, not a protocol requirement.

The runner polls for open work or accepts availability nudges, claims directly from either path, and automatically heartbeats held claims. Custom clients can use `DelegationClient.get` for the inspect-first flow before claiming. An executor result completes the task; an executor error marks it failed. Controlled `stop()` aborts execution cooperatively and releases the live claim. A 404 from a claim-authenticated heartbeat or progress call means the claim is known lost: the runner aborts best effort and does not send a terminal or release request with that token. Other heartbeat failures are logged; server-side claim checks remain authoritative.

## What a connector implements

```ts
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

// Optional: only when the connector can actually drive its runtime.
const sessionControl: SessionControlActuator = {
  commands: ["stop", "steer", "model"],
  interrupt: () => myRuntime.interrupt(),
  runCommand: async (name, args) => ({ ok: true, message: await myRuntime.run(name, args) }),
}

const session = new RemoteSession({
  config: result.config,
  client: new ThreaClient(result.config),
  runtime: {
    kind: "openclaw-channel",
    busyStatusText: "Working in OpenClaw…",
    forwardedNote: "Forwarded to OpenClaw.",
    shutdownErrorMessage: "OpenClaw channel shut down",
  },
  delegate: {
    // Push a turn into the runtime; resolve when handed off.
    deliverTurn: async (turn) => myRuntime.prompt(turn.content, turn.invocationId),
    sessionControl,
  },
})

wireLifecycle(session, process, { logPrefix: "[openclaw-channel]" })
await session.start()

// From inside the runtime, stream progress and close the turn:
await session.sendInterim(invocationId, "halfway there")
await session.reply(invocationId, "done — here's the result")
```

`stop` and `steer` are actuated by the SDK itself (they manipulate SDK-owned
turn state) through `actuator.interrupt()`; every other advertised command is
routed to `actuator.runCommand`, which returns the ack markdown posted to the
scratchpad. A connector with no way to drive its runtime simply omits
`sessionControl` and Threa never offers the commands (fail-safe).

## Distribution

Inside the repo, `file:` deps resolve the siblings. For a standalone install
(a machine without a threa checkout), vendor this package's `src` files the way
`claude-code-remote/install-local.ts` does — its `VENDORED` list is the
template.
