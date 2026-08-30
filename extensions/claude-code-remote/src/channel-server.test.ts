import { describe, expect, mock, spyOn, test } from "bun:test"
import type { BotRuntimeTransport } from "@threahq/bot-runtime-client"
import {
  ThreaClient,
  type ClaimedDelegation,
  type ClaimedInvocation,
  type DelegationClient,
  type DeliveredTurn,
  type RemoteSessionConfig,
} from "@threahq/remote-session"
import {
  CHANNEL_TOOLS,
  ChannelServer,
  buildInstructions,
  formatDelegationContent,
  parsePermissionVerdict,
  runClaudeCommand,
  verdictCandidateText,
} from "./channel-server"

describe("parsePermissionVerdict", () => {
  test("parses allow/deny in long and short forms", () => {
    expect(parsePermissionVerdict("yes abcde")).toEqual({ behavior: "allow", requestId: "abcde" })
    expect(parsePermissionVerdict("y abcde")).toEqual({ behavior: "allow", requestId: "abcde" })
    expect(parsePermissionVerdict("no abcde")).toEqual({ behavior: "deny", requestId: "abcde" })
    expect(parsePermissionVerdict("n abcde")).toEqual({ behavior: "deny", requestId: "abcde" })
  })

  test("tolerates surrounding whitespace and autocorrect caps", () => {
    expect(parsePermissionVerdict("  YES ABCDE  ")).toEqual({ behavior: "allow", requestId: "abcde" })
  })

  test("rejects ids using 'l' (outside Claude Code's id alphabet)", () => {
    expect(parsePermissionVerdict("yes ablde")).toBeNull()
  })

  test("rejects ordinary chat that isn't a verdict", () => {
    expect(parsePermissionVerdict("yes please do it")).toBeNull()
    expect(parsePermissionVerdict("approve it")).toBeNull()
    expect(parsePermissionVerdict("yes")).toBeNull()
  })
})

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
    renewClaim: async () => ({ notFound: false }),
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

describe("verdictCandidateText", () => {
  test("an ordinary message's prompt is the candidate", () => {
    expect(verdictCandidateText(makeInvocation({ promptMarkdown: "yes abcde" }))).toBe("yes abcde")
  })

  test("a /steer's folded text is the candidate (busy-session replies arrive as steer args)", () => {
    expect(verdictCandidateText(makeSteerInvocation("no abcde"))).toBe("no abcde")
  })

  test("strips an embedded steer directive anywhere in an ordinary swept message", () => {
    for (const promptMarkdown of ["/steer yes abcde", "yes /steer abcde", "yes abcde /steer"]) {
      expect(verdictCandidateText(makeInvocation({ trigger: "active-scratchpad", promptMarkdown }))).toBe("yes abcde")
    }
  })

  test("other session-control commands never carry a verdict", () => {
    const model = makeInvocation({
      trigger: "session-control",
      promptMarkdown: "/model opus",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_2", name: "model", args: "opus" } },
    })
    expect(verdictCandidateText(model)).toBeNull()
  })
})

/** A relay-enabled server with the MCP wire and Threa session stubbed for direct permission-path calls. */
function permissionServer() {
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
    interceptVerdict: (invocation: ClaimedInvocation) => Promise<boolean>
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
  ;(server.session as unknown as { link?: { rootStreamId: string } }).link = { rootStreamId: "stream_root" }
  const deliver = async (invocationId: string) => {
    await internals.deliverToClaude({
      invocationId,
      streamId: "stream_turn",
      sourceMessageId: `msg_${invocationId}`,
      content: "Do the thing",
      sealed: false,
    })
    notifications.length = 0
  }
  return { server, internals, notifications, invocationPosts, streamPosts, invocationPostSpy, deliver }
}

describe("ChannelServer permission verdict routing", () => {
  test("posts the approval prompt through the delivered invocation, then routes its verdict", async () => {
    const { server, internals, notifications, invocationPosts, streamPosts, deliver } = permissionServer()
    await deliver("binv_turn")
    await internals.handlePermissionRequest({
      request_id: "krjtt",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "bun run test",
    })
    expect(invocationPosts[0]?.invocationId).toBe("binv_turn")
    expect(invocationPosts[0]?.body.content).toContain("yes krjtt")
    expect(invocationPosts[0]?.body.metadata?.["cc.channel.permissionRequest"]).toBe("krjtt")
    expect(streamPosts).toEqual([])
    expect(server.session.interceptHoldsClaims).toBe(true)

    expect(await internals.interceptVerdict(makeInvocation({ promptMarkdown: "yes krjtt" }))).toBe(true)
    expect(notifications).toEqual([
      { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "allow" } },
    ])
    expect(server.session.interceptHoldsClaims).toBe(false)
    await server.shutdown()
  })

  test("should keep the completed invocation for permission prompts until a new turn is delivered", async () => {
    const { server, internals, invocationPosts, streamPosts, deliver } = permissionServer()
    spyOn(server.session, "reply").mockResolvedValue({ ok: true, message: "sent", closedTurn: true })
    await deliver("binv_completed")
    await server.handleToolCall("reply", "binv_completed", "Done.")

    await internals.handlePermissionRequest({
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run the old turn's command",
      input_preview: "pwd",
    })
    await deliver("binv_replacement")
    await internals.handlePermissionRequest({
      request_id: "fghij",
      tool_name: "Bash",
      description: "Run the new turn's command",
      input_preview: "bun test",
    })

    expect({ invocationIds: invocationPosts.map((post) => post.invocationId), streamPosts }).toEqual({
      invocationIds: ["binv_completed", "binv_replacement"],
      streamPosts: [],
    })
    await server.shutdown()
  })

  test("falls back to the root stream only before the first delivered turn", async () => {
    const { server, internals, invocationPosts, streamPosts } = permissionServer()

    await internals.handlePermissionRequest({
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "pwd",
    })

    expect(invocationPosts).toEqual([])
    expect(streamPosts.map((post) => post.streamId)).toEqual(["stream_root"])
    await server.shutdown()
  })

  test("never falls back to the root when the delivered invocation route rejects the prompt", async () => {
    const { server, internals, streamPosts, invocationPostSpy, deliver } = permissionServer()
    await deliver("binv_revoked")
    invocationPostSpy.mockRejectedValue(new Error("request is no longer routable"))

    await internals.handlePermissionRequest({
      request_id: "fghij",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "pwd",
    })

    expect(streamPosts).toEqual([])
    await server.shutdown()
  })

  test("a verdict folded into /steer args still reaches the prompt instead of steering the session", async () => {
    const { server, internals, notifications } = permissionServer()
    await internals.handlePermissionRequest({
      request_id: "krjtt",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "",
    })
    expect(await internals.interceptVerdict(makeSteerInvocation("no krjtt"))).toBe(true)
    expect(notifications).toEqual([
      { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "deny" } },
    ])
    await server.shutdown()
  })

  test("non-verdict steers and other control commands pass through untouched", async () => {
    const { server, internals, notifications } = permissionServer()
    await internals.handlePermissionRequest({
      request_id: "krjtt",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "",
    })
    expect(await internals.interceptVerdict(makeSteerInvocation("focus on the failing test"))).toBe(false)
    expect(
      await internals.interceptVerdict(
        makeInvocation({
          trigger: "session-control",
          promptMarkdown: "/model opus",
          metadata: { command: { executionKind: "bot-runtime", id: "cmd_2", name: "model", args: "opus" } },
        })
      )
    ).toBe(false)
    expect(notifications).toEqual([])
    // The request is still pending, so the claim hold stays up.
    expect(server.session.interceptHoldsClaims).toBe(true)
    await server.shutdown()
  })

  test("a verdict with no matching open request falls through to the normal turn path", async () => {
    const { server, internals, notifications } = permissionServer()
    expect(await internals.interceptVerdict(makeInvocation({ promptMarkdown: "yes krjtt" }))).toBe(false)
    expect(notifications).toEqual([])
    await server.shutdown()
  })
})

describe("ChannelServer lifecycle gating", () => {
  test("shutdown before start never touches the Threa session", async () => {
    const config = makeConfig()
    const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
    const sessionShutdown = spyOn(server.session, "shutdown")
    await server.shutdown()
    expect(sessionShutdown).not.toHaveBeenCalled()
  })

  test("shutdown after start shuts the session down", async () => {
    const config = makeConfig()
    const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
    const sessionStart = spyOn(server.session, "start").mockResolvedValue()
    const sessionShutdown = spyOn(server.session, "shutdown").mockResolvedValue()
    await server.start()
    await server.shutdown()
    expect(sessionStart).toHaveBeenCalled()
    expect(sessionShutdown).toHaveBeenCalled()
  })
})

describe("ChannelServer tool routing", () => {
  function makeServer() {
    const config = makeConfig()
    return new ChannelServer(config, new ThreaClient(config), makeFakeTransport())
  }

  test("send and reply delegate to the session, which owns open and closed requests alike", async () => {
    const server = makeServer()
    const sendInterim = spyOn(server.session, "sendInterim").mockResolvedValue({ ok: true, message: "sent" })
    const sessionReply = spyOn(server.session, "reply").mockResolvedValue({
      ok: true,
      message: "Posted as a follow-up message — request binv_1 had already closed, and stays closed.",
    })

    expect(await server.handleToolCall("send", "binv_1", "Halfway.")).toEqual({ ok: true, message: "sent" })
    const late = await server.handleToolCall("reply", "binv_1", "One more thought.")

    expect(sendInterim).toHaveBeenCalledWith("binv_1", "Halfway.")
    expect(sessionReply).toHaveBeenCalledWith("binv_1", "One more thought.")
    expect(late.ok).toBe(true)
    expect(late.message).toContain("follow-up")
  })

  test("the reply that reports closing the turn ends the trace and carry-on hold", async () => {
    const server = makeServer()
    spyOn(server.session, "isInflight").mockImplementation(() => {
      throw new Error("ChannelServer must not infer close evidence from a snapshot")
    })
    spyOn(server.session, "reply").mockResolvedValue({ ok: true, message: "sent", closedTurn: true })
    const onTurnClosed = mock(() => {})
    const internals = server as unknown as {
      tracer: { endTurn: (id: string) => void }
      carryOn?: { onTurnClosed: (id: string) => void }
    }
    internals.carryOn = { onTurnClosed }
    const endTurn = spyOn(internals.tracer, "endTurn").mockImplementation(() => {})

    await server.handleToolCall("reply", "binv_1", "Done.")

    expect(endTurn).toHaveBeenCalledTimes(1)
    expect(endTurn).toHaveBeenCalledWith("binv_1")
    expect(onTurnClosed).toHaveBeenCalledTimes(1)
    expect(onTurnClosed).toHaveBeenCalledWith("binv_1")
  })

  test("should end one turn for concurrent identical replies", async () => {
    const server = makeServer()
    spyOn(server.session, "isInflight").mockImplementation(() => {
      throw new Error("ChannelServer must not infer close evidence from a snapshot")
    })
    let replies = 0
    spyOn(server.session, "reply").mockImplementation(async () => {
      replies += 1
      return replies === 1 ? { ok: true, message: "sent", closedTurn: true } : { ok: true, message: "sent" }
    })
    const onTurnClosed = mock(() => {})
    const internals = server as unknown as {
      tracer: { endTurn: (id: string) => void }
      carryOn?: { onTurnClosed: (id: string) => void }
    }
    internals.carryOn = { onTurnClosed }
    const endTurn = spyOn(internals.tracer, "endTurn").mockImplementation(() => {})

    await Promise.all([
      server.handleToolCall("reply", "binv_1", "Done."),
      server.handleToolCall("reply", "binv_1", "Done."),
    ])

    expect(endTurn).toHaveBeenCalledTimes(1)
    expect(onTurnClosed).toHaveBeenCalledTimes(1)
  })

  test("a delegation id keeps its own routing and never reaches the session", async () => {
    const { server, calls } = await startDelegatingServer("dlg_1")
    const sessionSend = spyOn(server.session, "sendInterim").mockResolvedValue({
      ok: false,
      message: "no open request",
    })

    await server.handleToolCall("reply", "dlg_1", "Fixed in abc123.")
    await flush()
    expect(calls.completes).toEqual([{ id: "dlg_1", resultMarkdown: "Fixed in abc123." }])

    // The executor is gone, so a late send falls through to the session exactly as before.
    const late = await server.handleToolCall("send", "dlg_1", "One more thought.")
    expect(late.ok).toBe(false)
    expect(sessionSend).toHaveBeenCalled()

    await server.shutdown()
  })
})

describe("CHANNEL_TOOLS schemas", () => {
  test("send and reply both require non-empty invocation_id and text", () => {
    expect(CHANNEL_TOOLS.map((tool) => tool.name)).toEqual(["send", "reply"])
    for (const tool of CHANNEL_TOOLS) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        properties: {
          invocation_id: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
        },
        required: ["invocation_id", "text"],
      })
    }
  })
})
