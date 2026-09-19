import { describe, expect, test } from "bun:test"
import type { LocalTmuxPane } from "./discovery"
import type { DoneRequest } from "./done"
import { suspendPlaceholderCommand } from "./suspend"
import { supervisedDone, type SupervisedDoneDeps } from "./supervised-done"
import type { ManagedAgent } from "./types"

const AGENT: ManagedAgent = {
  id: "claude-1",
  name: "fix-sidebar",
  runtime: "claude",
  status: "suspended",
  worktree: "/repo/fix-sidebar",
  instanceId: "cc-sidebar",
  runtimeSessionId: "ccs-sidebar",
  suspendedAt: "2026-09-19T09:00:00.000Z",
  command: [],
  createdAt: "2026-09-19T08:00:00.000Z",
  updatedAt: "2026-09-19T09:00:00.000Z",
}

const PLACEHOLDER: LocalTmuxPane = {
  sessionName: "harness",
  windowName: "fix-sidebar",
  windowId: "@7",
  paneId: "%12",
  panePid: 4242,
  cwd: "/repo/fix-sidebar",
  startCommand: suspendPlaceholderCommand(AGENT),
}

const OTHER_PANE: LocalTmuxPane = { ...PLACEHOLDER, windowId: "@8", paneId: "%13", startCommand: "claude --resume" }

function claimResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        id: "binv_done",
        rootStreamId: "stream_root",
        activeStreamId: "stream_thread",
        claimToken: "claim-secret",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd_1", name: "done", args: "" } },
        ...overrides,
      },
    })
  )
}

interface Trace {
  posts: Array<{ path: string; body: Record<string, unknown> }>
  killed: string[]
  done: DoneRequest[]
  failed: string[]
  logs: string[]
}

function makeDeps(
  respond: (path: string, body: Record<string, unknown>) => Response | Promise<Response>,
  overrides: Partial<SupervisedDoneDeps> = {}
): { deps: SupervisedDoneDeps; trace: Trace } {
  const trace: Trace = { posts: [], killed: [], done: [], failed: [], logs: [] }
  const deps: SupervisedDoneDeps = {
    target: () => ({ baseUrl: "https://threa.test", workspaceId: "ws_1", apiKey: "threa_bk_test" }),
    post: async (_target, path, body) => {
      trace.posts.push({ path, body: body as Record<string, unknown> })
      return respond(path, body as Record<string, unknown>)
    },
    panes: () => [OTHER_PANE, PLACEHOLDER],
    killPane: (paneId) => trace.killed.push(paneId),
    reporter: () => ({
      progress: async () => undefined,
      complete: async () => undefined,
      fail: async (message) => void trace.failed.push(message),
      stop: () => undefined,
    }),
    done: async (request) => void trace.done.push(request),
    log: (message) => trace.logs.push(message),
    ...overrides,
  }
  return { deps, trace }
}

describe("supervisedDone", () => {
  test("claims by invocation id, kills the placeholder, and winds the session down", async () => {
    const { deps, trace } = makeDeps(() => claimResponse())

    const outcome = await supervisedDone(AGENT, "binv_done", deps)

    expect({ outcome, claim: trace.posts[0], killed: trace.killed, done: trace.done, failed: trace.failed }).toEqual({
      outcome: { status: "done" },
      claim: {
        path: "/bot-invocations/claim",
        body: {
          runtimeKind: "claude-code-channel",
          instanceId: "cc-sidebar",
          runtimeSessionId: "ccs-sidebar",
          supportedCapabilities: ["session-control"],
          claimTtlSeconds: 120,
          invocationId: "binv_done",
        },
      },
      killed: ["%12"],
      done: [
        {
          ref: "claude-1",
          rootStreamId: "stream_root",
          claim: {
            runtime: "claude",
            workspaceId: "ws_1",
            invocationId: "binv_done",
            instanceId: "cc-sidebar",
            claimToken: "claim-secret",
          },
        },
      ],
      failed: [],
    })
  })

  test("leaves the wake to the caller when the claim came back empty", async () => {
    const { deps, trace } = makeDeps(() => new Response(JSON.stringify({ data: null })))

    expect(await supervisedDone(AGENT, "binv_done", deps)).toEqual({
      status: "unclaimed",
      reason: "already claimed elsewhere",
    })
    expect({ killed: trace.killed, done: trace.done }).toEqual({ killed: [], done: [] })
  })

  test("leaves the wake to the caller when the claim request fails", async () => {
    const { deps } = makeDeps(() => new Response("nope", { status: 503 }))

    expect((await supervisedDone(AGENT, "binv_done", deps)).status).toBe("unclaimed")
  })

  test("fails the command it cannot run instead of dropping a claim it cannot release", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "another command",
        { metadata: { command: { executionKind: "bot-runtime", id: "c", name: "model", args: "" } } },
        "harnessd claimed /model, which it cannot run for a suspended session.",
      ],
      [
        "bad arguments",
        { metadata: { command: { executionKind: "bot-runtime", id: "c", name: "done", args: "now" } } },
        "Usage: `/done [--force]`.",
      ],
      ["the scratchpad itself", { activeStreamId: "stream_root" }, "Done is only available inside a thread session."],
    ]

    for (const [, overrides, message] of cases) {
      const { deps, trace } = makeDeps(() => claimResponse(overrides))
      const outcome = await supervisedDone(AGENT, "binv_done", deps)
      expect({ outcome, failed: trace.failed, killed: trace.killed, done: trace.done }).toEqual({
        outcome: { status: "failed", reason: message },
        failed: [message],
        killed: [],
        done: [],
      })
    }
  })

  test("refuses when no pane carries this session's suspension notice", async () => {
    const { deps, trace } = makeDeps(() => claimResponse(), { panes: () => [OTHER_PANE] })

    expect(await supervisedDone(AGENT, "binv_done", deps)).toEqual({
      status: "failed",
      reason: "The suspended session's pane could not be identified; wake it and run /done there.",
    })
    expect(trace.killed).toEqual([])
  })

  test("refuses when two panes carry the same notice", async () => {
    const { deps } = makeDeps(() => claimResponse(), { panes: () => [PLACEHOLDER, { ...PLACEHOLDER, paneId: "%99" }] })

    expect((await supervisedDone(AGENT, "binv_done", deps)).status).toBe("failed")
  })

  test("reports a wind-down that threw, leaving the row for the next ordinary wake", async () => {
    const { deps, trace } = makeDeps(() => claimResponse(), {
      done: async () => {
        throw new Error("teardown failed, nothing removed")
      },
    })

    expect(await supervisedDone(AGENT, "binv_done", deps)).toEqual({
      status: "failed",
      reason: "teardown failed, nothing removed",
    })
    // The reporter is `doneAgent`'s from here: failing it twice would overwrite its reason.
    expect(trace.failed).toEqual([])
  })
})
