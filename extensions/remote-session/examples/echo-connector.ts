// A scratchpad-linked connector: the runtime owns a scratchpad, every message
// in it is a turn, and /steer and /stop work from the composer.
//
//   THREA_WORKSPACE_ID=ws_… THREA_API_KEY=threa_bk_… bun examples/echo-connector.ts
//
// The "runtime" here is a timer that echoes the turn after ECHO_DELAY_MS, so the
// session-control paths have something to interrupt. Replace `runtime` with a
// bridge to a real agent; everything else stays.

import { hostname } from "node:os"
import { RemoteSession, ThreaClient, loadConfig, wireLifecycle } from "@threahq/remote-session"

const runtimeKind = process.env.THREA_RUNTIME_KIND ?? "custom"
const echoDelayMs = Number(process.env.ECHO_DELAY_MS ?? 0)

const loaded = loadConfig(
  { env: process.env, cwd: process.cwd(), hostname: hostname() },
  { idPrefix: "echo", sessionIdPrefix: "echos", displayNamePrefix: "Echo" }
)
if ("error" in loaded) {
  console.error(loaded.error)
  process.exit(1)
}

let pending: { invocationId: string; content: string; timer: ReturnType<typeof setTimeout> } | undefined

const runtime = {
  prompt(invocationId: string, content: string): void {
    void session.sendInterim(invocationId, "Working on it.")
    const timer = setTimeout(async () => {
      const turn = pending
      pending = undefined
      if (!turn) return
      await session.reply(turn.invocationId, `Echo: ${turn.content}`)
    }, echoDelayMs)
    pending = { invocationId, content, timer }
  },
  interrupt(): boolean {
    if (pending) clearTimeout(pending.timer)
    pending = undefined
    return true
  },
  steer(text: string): boolean {
    if (!pending) return false
    pending.content = `${pending.content}\n${text}`
    return true
  },
}

const session = new RemoteSession({
  config: loaded.config,
  client: new ThreaClient(loaded.config),
  runtime: {
    kind: runtimeKind,
    busyStatusText: "Echoing…",
    forwardedNote: "Forwarded to the echo runtime.",
    shutdownErrorMessage: "Echo connector shut down",
  },
  delegate: {
    deliverTurn: async (turn) => runtime.prompt(turn.invocationId, turn.content),
    sessionControl: {
      commands: ["stop", "steer"],
      interrupt: () => runtime.interrupt(),
      steer: (text) => runtime.steer(text),
      runCommand: async (name) => ({ ok: false, message: `Unsupported command: /${name}` }),
    },
    onLinked: (link) => console.error(`linked to ${loaded.config.baseUrl}${link.streamUrlPath}`),
  },
  log: (line) => console.error(`[echo] ${line}`),
})

wireLifecycle(session, process, { logPrefix: "[echo]" })
await session.start()
