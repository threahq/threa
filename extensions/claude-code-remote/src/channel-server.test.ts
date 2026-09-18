import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotRuntimeTransport } from "@threahq/bot-runtime-client"
import { writeSessionWakeNote } from "@threahq/harness-client"
import {
  DecisionAbandonedError,
  ThreaClient,
  type ClaimedDelegation,
  type ClaimedInvocation,
  type DecisionOutcome,
  type DecisionRequest,
  type DecisionRequestInput,
  type DelegationClient,
  type DeliveredTurn,
  type RemoteSessionConfig,
} from "@threahq/remote-session"
import {
  CHANNEL_TOOLS,
  ChannelServer,
  buildInstructions,
  formatDelegationContent,
  permissionPreviewBlock,
  runClaudeCommand,
} from "./channel-server"

describe("buildInstructions", () => {
  test("always tells Claude to reply with the invocation_id", () => {
    const text = buildInstructions(false)
    expect(text).toContain("reply")
    expect(text).toContain("invocation_id")
  })

  test("documents both the send and reply tools", () => {
    const text = buildInstructions(false)
    expect(text).toContain("`send`")
    expect(text).toContain("`reply`")
    expect(text).toContain("invocation_id")
  })

  test("mentions permission forwarding only when relay is enabled", () => {
    expect(buildInstructions(true).toLowerCase()).toContain("approv")
    expect(buildInstructions(false).toLowerCase()).not.toContain("approv")
  })

  test("in plain-MCP mode says the channel is inactive instead of claiming a scratchpad link", () => {
    const text = buildInstructions(false, false)
    expect(text).not.toContain("You are linked")
    expect(text.toLowerCase()).toContain("inactive")
  })
})

function makeConfig(): RemoteSessionConfig {
  return {
    baseUrl: "https://threa.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    displayName: "Claude Code - test",
    instanceId: "cc-test",
    runtimeSessionId: "ccs-test",
    permissionRelay: false,
    pollMs: 60_000,
    idleTimeoutMs: 60_000,
    sealedFullTrace: true,
    keyScope: "host",
    traceMode: "headline",
  }
}

function makeFakeTransport(): BotRuntimeTransport {
  return {
    connect: async () => {},
    disconnect: () => {},
    socketConnected: false,
    sendHello: () => {},
    recordSteps: async () => {},
    observeClaim: () => ({
      sync: async () => {},
      unregister: () => {},
      dispose: () => {},
    }),
    updatePresence: async () => {},
  } as unknown as BotRuntimeTransport
}

function claimedDelegation(id: string): ClaimedDelegation {
  return {
    id,
    streamId: "stream_1",
    title: "Fix the flaky test",
    status: "claimed",
    brief: "The suite is flaky in CI. Find and fix the race.",
    contextRefs: ["memo:memo_1"],
    claimToken: `token-${id}`,
    claimExpiresAt: "2026-07-12T10:15:00.000Z",
    createdAt: "2026-07-12T10:00:00.000Z",
    statusChangedAt: "2026-07-12T10:00:00.000Z",
  }
}

interface DelegationCalls {
  statuses: string[]
  completes: Array<{ id: string; resultMarkdown?: string }>
  fails: Array<{ id: string; errorMessage: string }>
  releases: Array<{ id: string }>
}

/** One open delegation, then an empty queue — the runner claims it and waits on the executor. */
function stubDelegationClient(id: string): { client: DelegationClient; calls: DelegationCalls } {
  const calls: DelegationCalls = { statuses: [], completes: [], fails: [], releases: [] }
  let listed = false
  const client = {
    listOpen: async () => {
      if (listed) return []
      listed = true
      return [claimedDelegation(id)]
    },
    claim: async () => claimedDelegation(id),
    heartbeat: async () => ({ claimExpiresAt: "2026-07-12T10:30:00.000Z" }),
    reportStatus: async (_id: string, _token: string, note: string) => {
      calls.statuses.push(note)
      return claimedDelegation(id)
    },
    complete: async (completedId: string, _token: string, body: { resultMarkdown?: string }) => {
      calls.completes.push({ id: completedId, resultMarkdown: body.resultMarkdown })
      return claimedDelegation(id)
    },
    fail: async (failedId: string, _token: string, errorMessage: string) => {
      calls.fails.push({ id: failedId, errorMessage })
      return claimedDelegation(id)
    },
    release: async (releasedId: string) => {
      calls.releases.push({ id: releasedId })
      return claimedDelegation(id)
    },
  } as unknown as DelegationClient
  return { client, calls }
}

const flush = () => new Promise((r) => setTimeout(r, 20))

async function startDelegatingServer(id: string) {
  const config = { ...makeConfig(), delegations: true }
  const { client, calls } = stubDelegationClient(id)
  const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport(), true, client)
  spyOn(server.session, "start").mockResolvedValue()
  spyOn(server.session, "shutdown").mockResolvedValue()
  await server.start()
  await flush()
  return { server, calls }
}

describe("ChannelServer delegations", () => {
  test("formatDelegationContent carries the brief, the id-addressed protocol, and context refs", () => {
    const text = formatDelegationContent(claimedDelegation("dlg_1"))
    expect(text).toContain('delegation_id="dlg_1"')
    expect(text).toContain("Find and fix the race.")
    expect(text).toContain("memo:memo_1")
    expect(text).toContain('`reply` exactly once with invocation_id "dlg_1"')
  })

  test("claims on start, routes send to the card's progress note, and completes with the reply text", async () => {
    const { server, calls } = await startDelegatingServer("dlg_1")

    const sent = await server.handleToolCall("send", "dlg_1", "Reproduced it; fixing.")
    expect(sent.ok).toBe(true)
    expect(calls.statuses).toEqual(["Reproduced it; fixing."])

    const replied = await server.handleToolCall("reply", "dlg_1", "Fixed in abc123.")
    expect(replied.ok).toBe(true)
    await flush()
    expect(calls.completes).toEqual([{ id: "dlg_1", resultMarkdown: "Fixed in abc123." }])
    expect(calls.fails).toHaveLength(0)

    await server.shutdown()
  })

  test("a delegation reply never touches the scratchpad session's reply path", async () => {
    const { server } = await startDelegatingServer("dlg_1")
    const sessionReply = spyOn(server.session, "reply")
    await server.handleToolCall("reply", "dlg_1", "Done.")
    expect(sessionReply).not.toHaveBeenCalled()
    await server.shutdown()
  })

  test("active delegations make reconnect busy", () => {
    const config = makeConfig()
    const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
    const internals = server as any
    expect(internals.reconnectBusy()).toBe(false)
    internals.openDelegations.set("dlg_1", {})
    expect(internals.reconnectBusy()).toBe(true)
  })

  test("reconnect stops delegation intake and rechecks active work before non-force handoff", async () => {
    const server = new ChannelServer(makeConfig(), new ThreaClient(makeConfig()), makeFakeTransport())
    const internals = server as any
    let stopped = false
    internals.delegations = {
      stop: () => {
        stopped = true
        internals.openDelegations.set("dlg_race", { reject: () => {}, clear: () => {} })
        return Promise.resolve()
      },
    }

    await expect(internals.stopDelegationsForReconnect(false)).rejects.toThrow("Claude became busy")
    expect(stopped).toBe(true)
  })

  test("handoff reset restarts delegation intake while archive-detached, but not during shutdown", () => {
    const server = new ChannelServer(makeConfig(), new ThreaClient(makeConfig()), makeFakeTransport())
    const internals = server as any
    let starts = 0
    internals.delegations = { start: () => starts++ }
    internals.started = true
    internals.session.archivePending = { rootStreamId: "stream_root" }

    internals.restartDelegationsAfterReset()
    internals.shuttingDown = true
    internals.restartDelegationsAfterReset()

    expect(starts).toBe(1)
  })

  test("shared runner stop lets shutdown prevent reconnect spawn and delegation restart", async () => {
    const server = new ChannelServer(makeConfig(), new ThreaClient(makeConfig()), makeFakeTransport())
    const internals = server as any
    let releaseStop!: () => void
    const sharedStop = new Promise<void>((resolve) => (releaseStop = resolve))
    let starts = 0
    internals.started = true
    internals.delegations = { stop: () => sharedStop, start: () => starts++ }
    spyOn(server.session, "shutdown").mockResolvedValue()

    const outcome = await runClaudeCommand(
      "reconnect",
      "--force",
      undefined,
      "runtime",
      undefined,
      () => "root",
      undefined,
      () => internals.stopDelegationsForReconnect(true),
      () => internals.restartDelegationsAfterReset(),
      () => ({ stopped: false, linkGeneration: 1, linkState: "linked", rootStreamId: "root" }),
      () => !internals.shuttingDown
    )
    const reconnect = outcome.afterAck?.()
    await Promise.resolve()
    const shutdown = server.shutdown()
    releaseStop()

    await expect(reconnect).rejects.toThrow(
      "Remote session changed while delegation intake was quiescing; reconnect was not started."
    )
    outcome.onHandoffReset?.()
    await shutdown
    expect(starts).toBe(0)
  })

  test("force reconnect delegates cancellation to the runner and waits for release", async () => {
    const server = new ChannelServer(makeConfig(), new ThreaClient(makeConfig()), makeFakeTransport())
    const internals = server as any
    let releaseStop!: () => void
    internals.delegations = { stop: () => new Promise<void>((resolve) => (releaseStop = resolve)) }
    internals.openDelegations.set("dlg_active", { clear: () => {} })

    let finished = false
    const stopping = internals.stopDelegationsForReconnect(true).then(() => (finished = true))
    await Promise.resolve()
    expect(finished).toBe(false)
    releaseStop()
    await stopping
    expect(finished).toBe(true)
  })

  test("shutdown aborts and releases an in-flight delegation", async () => {
    const { server, calls } = await startDelegatingServer("dlg_1")
    await server.shutdown()
    expect(calls.releases).toEqual([{ id: "dlg_1" }])
    expect(calls.fails).toHaveLength(0)
    expect(calls.completes).toHaveLength(0)
  })

  test("without the delegations flag no runner exists and delegation ids fall through to the session", async () => {
    const config = makeConfig()
    const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
    const sessionReply = spyOn(server.session, "reply").mockResolvedValue({ ok: false, message: "unknown invocation" })
    const result = await server.handleToolCall("reply", "dlg_1", "Done.")
    expect(result.ok).toBe(false)
    expect(sessionReply).toHaveBeenCalled()
  })
})

function makeInvocation(partial: Partial<ClaimedInvocation>): ClaimedInvocation {
  return {
    id: "binv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_root",
    activeStreamId: "stream_root",
    sourceMessageId: "src",
    sourceRevision: 1,
    responseStreamId: "stream_root",
    actor: { type: "bot", id: "bot_1", slug: "claude" },
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "Do the thing",
    authorUserId: "user_1",
    mentionedActorSlugs: [],
    claimToken: "tok",
    claimExpiresAt: "2026-07-18T00:00:00.000Z",
    runtimeSessionId: "rts_1",
    metadata: {},
    ...partial,
  }
}

function makeSteerInvocation(args: string): ClaimedInvocation {
  return makeInvocation({
    id: "binv_steer",
    trigger: "session-control",
    promptMarkdown: args ? `/steer ${args}` : "/steer",
    metadata: { command: { executionKind: "bot-runtime", id: "cmd_1", name: "steer", args } },
  })
}

/** A relay-enabled server with the MCP wire and Threa session stubbed for direct permission-path calls. */
function permissionServer(decision?: { outcome?: DecisionOutcome; error?: Error }) {
  const config = { ...makeConfig(), permissionRelay: true }
  const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
  const internals = server as unknown as {
    mcp: { notification: (msg: { method: string; params: Record<string, unknown> }) => Promise<void> }
    deliverToClaude: (turn: DeliveredTurn) => Promise<void>
    handlePermissionRequest: (params: {
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }) => Promise<void>
  }
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  spyOn(internals.mcp, "notification").mockImplementation(async (msg) => void notifications.push(msg))
  const invocationPosts: Array<{
    invocationId: string
    body: { content: string; metadata?: Record<string, unknown> }
  }> = []
  const streamPosts: Array<{ streamId: string; body: { content: string; metadata?: Record<string, unknown> } }> = []
  const invocationPostSpy = spyOn(server.session, "postToInvocation").mockImplementation(
    async (invocationId: string, body: { content: string; metadata?: Record<string, unknown> }) =>
      void invocationPosts.push({ invocationId, body })
  )
  spyOn(server.session, "postToStream").mockImplementation(
    async (streamId: string, body: { content: string; metadata?: Record<string, unknown> }) =>
      void streamPosts.push({ streamId, body })
  )
  spyOn(server.session, "keepAlive").mockImplementation(() => {})
  const inflight = new Set<string>()
  spyOn(server.session, "isInflight").mockImplementation((invocationId: string) => inflight.has(invocationId))
  spyOn(server.session, "reply").mockImplementation(async (invocationId: string) => {
    inflight.delete(invocationId)
    return { ok: true, message: "posted", closedTurn: true }
  })
  const decisionRequests: Array<{ input: DecisionRequestInput }> = []
  const requestDecisionSpy = spyOn(server.session, "requestDecision").mockImplementation(
    async (input: DecisionRequestInput) => {
      decisionRequests.push({ input })
      if (decision?.error) throw decision.error
      return decision?.outcome ?? RESOLVED_ALLOW
    }
  )
  ;(server.session as unknown as { link?: { rootStreamId: string } }).link = { rootStreamId: "stream_root" }
  const deliver = async (invocationId: string, sealed = false) => {
    await internals.deliverToClaude({
      invocationId,
      streamId: "stream_turn",
      rootStreamId: "stream_root",
      sourceMessageId: `msg_${invocationId}`,
      content: "Do the thing",
      sealed,
    })
    inflight.add(invocationId)
    notifications.length = 0
  }
  return {
    server,
    internals,
    notifications,
    invocationPosts,
    streamPosts,
    invocationPostSpy,
    decisionRequests,
    requestDecisionSpy,
    deliver,
  }
}

const DECISION: DecisionRequest = {
  id: "dreq_1",
  workspaceId: "ws_1",
  streamId: "stream_turn",
  status: "resolved",
  title: "Run `Bash`?",
  options: [],
  allowNote: true,
  version: 2,
}

const RESOLVED_ALLOW: DecisionOutcome = {
  status: "resolved",
  optionId: "allow",
  note: null,
  decision: { ...DECISION, resolution: { optionId: "allow" } },
}

const PERMISSION = {
  request_id: "krjtt",
  tool_name: "Bash",
  description: "Run a command",
  input_preview: '{"command":"bun run test","description":"Run the unit tests"}',
}

describe("ChannelServer permission decisions", () => {
  test("opens a decision card for the delivered turn and answers Claude Code with the verdict", async () => {
    const { server, internals, notifications, decisionRequests, deliver } = permissionServer()
    await deliver("binv_turn")
    await internals.handlePermissionRequest(PERMISSION)

    expect(decisionRequests[0]?.input).toEqual({
      title: "Run `Bash`?",
      body: "Run a command\n\n```sh\nbun run test\n```",
      options: [
        { id: "allow", label: "Allow", tone: "primary" },
        { id: "deny", label: "Deny", tone: "destructive" },
      ],
      allowNote: true,
      externalRef: "krjtt",
      expiresInMs: makeConfig().idleTimeoutMs,
      invocationId: "binv_turn",
    })
    expect(notifications).toEqual([
      { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "allow" } },
    ])
    await server.shutdown()
  })

  test("a resolved note stays on the card and is never sent to Claude Code", async () => {
    const { server, internals, notifications } = permissionServer({
      outcome: { status: "resolved", optionId: "deny", note: "not on prod", decision: RESOLVED_ALLOW.decision },
    })
    await internals.handlePermissionRequest(PERMISSION)
    expect(notifications).toEqual([
      { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "deny" } },
    ])
    await server.shutdown()
  })

  test("a request after the turn was replied to opens an unnamed card, not one on the completed invocation", async () => {
    const { server, internals, notifications, decisionRequests, deliver } = permissionServer()
    await deliver("binv_turn")
    await server.handleToolCall("reply", "binv_turn", "done")
    await internals.handlePermissionRequest(PERMISSION)

    expect(decisionRequests[0]?.input.invocationId).toBeUndefined()
    expect(notifications).toEqual([
      { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "allow" } },
    ])
    await server.shutdown()
  })

  test("a cancelled or expired card denies the tool call", async () => {
    for (const status of ["cancelled", "expired"] as const) {
      const { server, internals, notifications } = permissionServer({
        outcome: { status, decision: { ...DECISION, status } },
      })
      await internals.handlePermissionRequest(PERMISSION)
      expect(notifications).toEqual([
        { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "deny" } },
      ])
      await server.shutdown()
    }
  })

  test("a sealed turn keeps the approval in the terminal and says so on the stream", async () => {
    const { server, internals, notifications, invocationPosts, requestDecisionSpy, deliver } = permissionServer()
    await deliver("binv_sealed", true)
    await internals.handlePermissionRequest(PERMISSION)

    expect(requestDecisionSpy).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
    expect(invocationPosts[0]?.invocationId).toBe("binv_sealed")
    expect(invocationPosts[0]?.body.content).toContain("Answer it in the terminal")
    expect(invocationPosts[0]?.body.metadata?.["cc.channel.permissionRequest"]).toBe("krjtt")
    await server.shutdown()
  })

  test("a sealed turn already replied to still posts the terminal notice through its invocation", async () => {
    const { server, internals, notifications, invocationPosts, streamPosts, requestDecisionSpy, deliver } =
      permissionServer()
    await deliver("binv_sealed", true)
    await server.session.reply("binv_sealed", "done")
    await internals.handlePermissionRequest(PERMISSION)

    expect(requestDecisionSpy).not.toHaveBeenCalled()
    expect(notifications).toEqual([])
    expect(streamPosts).toEqual([])
    expect(invocationPosts[0]?.invocationId).toBe("binv_sealed")
    expect(invocationPosts[0]?.body.content).toContain("Answer it in the terminal")
    await server.shutdown()
  })

  test("a card that cannot be opened leaves the approval in the terminal, unanswered", async () => {
    const { server, internals, notifications, streamPosts } = permissionServer({
      error: new Error("Threa API 409 (DECISION_REQUESTER_NOT_ACTIVE)"),
    })
    await internals.handlePermissionRequest(PERMISSION)

    expect(notifications).toEqual([])
    expect(streamPosts.map((post) => post.streamId)).toEqual(["stream_root"])
    expect(streamPosts[0]?.body.content).toContain("Answer it in the terminal")
    await server.shutdown()
  })

  test("a shutdown-abandoned decision answers nothing and posts nothing", async () => {
    const { server, internals, notifications, invocationPosts, streamPosts } = permissionServer({
      error: new DecisionAbandonedError("dreq_1"),
    })
    await internals.handlePermissionRequest(PERMISSION)
    expect({ notifications, invocationPosts, streamPosts }).toEqual({
      notifications: [],
      invocationPosts: [],
      streamPosts: [],
    })
    await server.shutdown()
  })

  test("falls back to the root stream only before the first delivered turn", async () => {
    const { server, internals, decisionRequests } = permissionServer()
    await internals.handlePermissionRequest(PERMISSION)
    expect(decisionRequests[0]?.input.invocationId).toBeUndefined()
    await server.shutdown()
  })
})

describe("permissionPreviewBlock", () => {
  test("a JSON input with a command renders as a shell block", () => {
    expect(permissionPreviewBlock('{"command":"git push --force","timeout":5000}')).toBe("```sh\ngit push --force\n```")
  })

  test("other JSON input renders pretty-printed", () => {
    expect(permissionPreviewBlock('{"file_path":"/a.ts","content":"x"}')).toBe(
      '```json\n{\n  "file_path": "/a.ts",\n  "content": "x"\n}\n```'
    )
  })

  test("a non-JSON preview is fenced verbatim and long previews are cut", () => {
    expect(permissionPreviewBlock("plain text")).toBe("```\nplain text\n```")
    const long = "x".repeat(2000)
    expect(permissionPreviewBlock(long)).toBe(`\`\`\`\n${"x".repeat(1500)}…\n\`\`\``)
  })
})
