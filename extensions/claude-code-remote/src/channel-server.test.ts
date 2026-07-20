import { describe, expect, spyOn, test } from "bun:test"
import type { BotRuntimeTransport } from "@threa/bot-runtime-client"
import {
  ThreaClient,
  type ClaimedDelegation,
  type ClaimedInvocation,
  type DelegationClient,
  type RemoteSessionConfig,
} from "@threa/remote-session"
import {
  ChannelServer,
  buildInstructions,
  formatDelegationContent,
  parsePermissionVerdict,
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
}

/** One open delegation, then an empty queue — the runner claims it and waits on the executor. */
function stubDelegationClient(id: string): { client: DelegationClient; calls: DelegationCalls } {
  const calls: DelegationCalls = { statuses: [], completes: [], fails: [] }
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

  test("shutdown fails an in-flight delegation instead of stranding its claim", async () => {
    const { server, calls } = await startDelegatingServer("dlg_1")
    await server.shutdown()
    expect(calls.fails).toEqual([{ id: "dlg_1", errorMessage: "Claude Code channel shut down mid-delegation" }])
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

  test("strips an embedded steer directive from an ordinary swept message", () => {
    expect(
      verdictCandidateText(makeInvocation({ trigger: "active-scratchpad", promptMarkdown: "/steer yes abcde" }))
    ).toBe("yes abcde")
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
  const posts: Array<{ streamId: string; body: { content: string; metadata?: Record<string, unknown> } }> = []
  spyOn(server.session, "postToStream").mockImplementation(
    async (streamId: string, body: { content: string; metadata?: Record<string, unknown> }) =>
      void posts.push({ streamId, body })
  )
  spyOn(server.session, "keepAlive").mockImplementation(() => {})
  ;(server.session as unknown as { activeTurnStream?: string }).activeTurnStream = "stream_turn"
  return { server, internals, notifications, posts }
}

describe("ChannelServer permission verdict routing", () => {
  test("posts the approval prompt, then a plain 'yes <id>' reply routes to it and releases the claim hold", async () => {
    const { server, internals, notifications, posts } = permissionServer()
    await internals.handlePermissionRequest({
      request_id: "krjtt",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: "bun run test",
    })
    expect(posts[0]?.streamId).toBe("stream_turn")
    expect(posts[0]?.body.content).toContain("yes krjtt")
    expect(posts[0]?.body.metadata?.["cc.channel.permissionRequest"]).toBe("krjtt")
    expect(server.session.interceptHoldsClaims).toBe(true)

    expect(await internals.interceptVerdict(makeInvocation({ promptMarkdown: "yes krjtt" }))).toBe(true)
    expect(notifications).toEqual([
      { method: "notifications/claude/channel/permission", params: { request_id: "krjtt", behavior: "allow" } },
    ])
    expect(server.session.interceptHoldsClaims).toBe(false)
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
