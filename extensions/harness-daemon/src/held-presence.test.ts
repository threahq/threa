import { describe, expect, it } from "bun:test"
import type { SessionPresenceSnapshot } from "@threahq/harness-client"
import {
  createHeldPresence,
  heldPresenceBody,
  SUPERVISOR_HELD_CAPABILITY,
  type HeldPresenceDeps,
} from "./held-presence"
import type { ManagedAgent } from "./types"

const snapshot: SessionPresenceSnapshot = {
  runtimeKind: "claude-code-channel",
  instanceId: "inst-1",
  runtimeSessionId: "sess-1",
  displayName: "touch",
  capabilities: { supportsSessionControlCommands: true, sessionControlCommands: ["stop", "model"] },
  manifest: { commands: [{ name: "model" }] },
  updatedAt: "2026-09-19T10:00:00.000Z",
}

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "agt_1",
    name: "touch",
    runtime: "claude",
    status: "suspended",
    runtimeSessionId: "sess-1",
    heldPresence: snapshot,
    command: [],
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    ...overrides,
  }
}

interface Posted {
  path: string
  body: Record<string, unknown>
}

function deps(overrides: Partial<HeldPresenceDeps> = {}): HeldPresenceDeps & { posted: Posted[]; logs: string[] } {
  const posted: Posted[] = []
  const logs: string[] = []
  return {
    posted,
    logs,
    target: () => ({ baseUrl: "https://app.threa.io", workspaceId: "ws_1", apiKey: "key" }),
    post: async (_target, path, body) => {
      posted.push({ path, body: body as Record<string, unknown> })
      return new Response(null, { status: 200 })
    },
    log: (message) => logs.push(message),
    ...overrides,
  }
}

describe("held presence body", () => {
  it("replays the snapshot as an available session, marked and keyless", () => {
    expect(heldPresenceBody(snapshot)).toEqual({
      runtimeKind: "claude-code-channel",
      instanceId: "inst-1",
      runtimeSessionId: "sess-1",
      displayName: "touch",
      status: "available",
      acceptingInvocations: true,
      capabilities: {
        supportsSessionControlCommands: true,
        sessionControlCommands: ["stop", "model"],
        [SUPERVISOR_HELD_CAPABILITY]: true,
      },
      manifest: { commands: [{ name: "model" }] },
    })
  })
})

describe("holding presence for suspended sessions", () => {
  it("posts presence for a suspended row and leaves every other row alone", async () => {
    const d = deps()
    const outcomes = await createHeldPresence(d)([
      agent(),
      agent({ id: "agt_2", name: "online-one", status: "online" }),
      agent({ id: "agt_3", name: "stopped-one", status: "stopped" }),
      agent({ id: "agt_4", name: "tombstoned-one", tombstonedAt: "2026-09-19T08:00:00.000Z" }),
    ])
    expect(outcomes).toEqual([{ agent: "touch", runtimeSessionId: "sess-1", status: "held", detail: "inst-1" }])
    expect(d.posted.map((entry) => entry.path)).toEqual(["/bot-runtime/presence"])
  })

  it("skips a session with no snapshot rather than inventing one", async () => {
    const d = deps()
    const outcomes = await createHeldPresence(d)([agent({ heldPresence: undefined })])
    expect(outcomes).toEqual([
      {
        agent: "touch",
        runtimeSessionId: "sess-1",
        status: "skipped",
        detail: "no presence snapshot captured at suspend",
      },
    ])
    expect(d.posted).toEqual([])
    expect(d.logs).toEqual(["harnessd: holding presence for touch: no presence snapshot captured at suspend"])
  })

  it("reports a rejected write and keeps going on the next pass", async () => {
    const d = deps({ post: async () => new Response("bot key required", { status: 403 }) })
    const hold = createHeldPresence(d)
    const [outcome] = await hold([agent()])
    expect(outcome).toEqual({
      agent: "touch",
      runtimeSessionId: "sess-1",
      status: "failed",
      detail: "403 bot key required",
    })
    await hold([agent()])
    expect(d.logs).toEqual(["harnessd: holding presence for touch: 403 bot key required"])
  })

  it("reports a missing runtime credential instead of taking the pass down", async () => {
    const d = deps({
      target: () => {
        throw new Error("harnessd: no runtime-specific Threa credentials found")
      },
    })
    const outcomes = await createHeldPresence(d)([agent()])
    expect(outcomes).toEqual([
      {
        agent: "touch",
        runtimeSessionId: "sess-1",
        status: "failed",
        detail: "harnessd: no runtime-specific Threa credentials found",
      },
    ])
  })
})
