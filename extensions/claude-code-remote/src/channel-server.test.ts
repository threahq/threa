import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotRuntimeTransport } from "@threahq/bot-runtime-client"
import { writeSessionWakeNote } from "@threahq/harness-client"
import {
  DecisionAbandonedError,
  ThreaClient,
  type ClaimedDelegation,
  type DecisionOutcome,
  type DecisionRequest,
  type DecisionRequestInput,
  type DelegationClient,
  type DeliveredTurn,
  type RemoteSessionConfig,
} from "@threahq/remote-session"
import {
  CHANNEL_SOURCE,
  ChannelServer,
  buildInstructions,
  channelTools,
  formatDelegationContent,
  permissionPreviewBlock,
  runClaudeCommand,
} from "./channel-server"
import type { CarryOnController } from "./carry-on"
import * as tmuxControl from "./tmux-control"
import { StopHookListener } from "./stop-hook-listener"

describe("buildInstructions", () => {
  test("always tells Claude to reply with the invocation_id", () => {
    const text = buildInstructions({ permissionRelay: false })
    expect(text).toContain("reply")
    expect(text).toContain("invocation_id")
  })

  test("documents both the send and reply tools", () => {
    const text = buildInstructions({ permissionRelay: false })
    expect(text).toContain("`send`")
    expect(text).toContain("`reply`")
    expect(text).toContain("invocation_id")
  })

  test("mentions permission forwarding only when relay is enabled", () => {
    expect(buildInstructions({ permissionRelay: true }).toLowerCase()).toContain("approv")
    expect(buildInstructions({ permissionRelay: false }).toLowerCase()).not.toContain("approv")
  })

  test("in plain-MCP mode says the channel is inactive instead of claiming a scratchpad link", () => {
    const text = buildInstructions({ permissionRelay: false, channelActive: false })
    expect(text).not.toContain("You are linked")
    expect(text.toLowerCase()).toContain("inactive")
  })

  test("in hook mode says the request closes when the turn ends, not on reply", () => {
    const text = buildInstructions({ permissionRelay: false, hookMode: true })
    const replyTool = channelTools(true).find((tool) => tool.name === "reply")!
    expect({
      closesByItself: text.includes("closes by itself when you finish your turn"),
      replyCloses: text.includes("`reply` posts the message AND closes"),
      toolDoesNotClose: replyTool.description.includes("does not close the request"),
    }).toEqual({ closesByItself: true, replyCloses: false, toolDoesNotClose: true })
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
  const server = new ChannelServer(config, new ThreaClient(config), makeFakeTransport(), CHANNEL_SOURCE, client)
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

/** A relay-enabled server with the MCP wire and Threa session stubbed for direct permission-path calls. */
/** A channel server whose session is stubbed to hold delivered turns in flight until a closing call. */
function stubbedTurnServer(config: RemoteSessionConfig, stopHooks?: StopHookListener) {
  const server = new ChannelServer(
    config,
    new ThreaClient(config),
    makeFakeTransport(),
    CHANNEL_SOURCE,
    undefined,
    stopHooks
  )
  const internals = server as unknown as {
    mcp: { notification: (msg: { method: string; params: Record<string, unknown> }) => Promise<void> }
    deliverToClaude: (turn: DeliveredTurn) => Promise<void>
    handlePermissionRequest: (params: {
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }) => Promise<void>
    tracer: { endTurn: (invocationId: string) => void }
    carryOn: Pick<CarryOnController, "onApiError" | "onTurnClosed" | "stop"> | undefined
  }
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = []
  spyOn(internals.mcp, "notification").mockImplementation(async (msg) => void notifications.push(msg))
  const inflight = new Set<string>()
  spyOn(server.session, "isInflight").mockImplementation((invocationId: string) => inflight.has(invocationId))
  const deliver = async (invocationId: string, sealed = false) => {
    await internals.deliverToClaude({
      invocationId,
      streamId: "stream_turn",
      rootStreamId: "stream_root",
      sourceMessageId: `msg_${invocationId}`,
      content: "Do the thing",
      attachments: [],
      sealed,
    })
    inflight.add(invocationId)
    notifications.length = 0
  }
  return { server, internals, notifications, inflight, deliver }
}

function permissionServer(decision?: { outcome?: DecisionOutcome; error?: Error }) {
  const { server, internals, notifications, inflight, deliver } = stubbedTurnServer({
    ...makeConfig(),
    permissionRelay: true,
  })
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

describe("stop hooks", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "threa-stop-hooks-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const turnLine = (invocationId: string) =>
    `{"type":"user","message":{"content":"<channel invocation_id=\\"${invocationId}\\">Do the thing</channel>"}}`
  const queueLine = (operation: string, content?: string) =>
    JSON.stringify({ type: "queue-operation", operation, timestamp: "2026-10-15T08:00:00.000Z", content })

  async function hookServer() {
    const socketPath = join(dir, "session.sock")
    const listener = await StopHookListener.listen(socketPath, () => {})
    const { server, internals, inflight, deliver: deliverTurn } = stubbedTurnServer(makeConfig(), listener)
    const calls: Array<{ method: string; invocationId: string; text?: string }> = []
    spyOn(server.session, "sendInterim").mockImplementation(async (invocationId: string, text: string) => {
      calls.push({ method: "sendInterim", invocationId, text })
      return { ok: true, message: "sent" }
    })
    for (const method of ["reply", "endTurn"] as const) {
      spyOn(server.session, method).mockImplementation(async (invocationId: string, text?: string) => {
        calls.push({ method, invocationId, text })
        inflight.delete(invocationId)
        return { ok: true, message: "sent", closedTurn: true as const }
      })
    }
    const tracerEnds: string[] = []
    spyOn(internals.tracer, "endTurn").mockImplementation((invocationId: string) => void tracerEnds.push(invocationId))
    const transcript = join(dir, "transcript.jsonl")
    const deliver = async (invocationId: string) => {
      await deliverTurn(invocationId)
      writeFileSync(transcript, `${turnLine(invocationId)}\n`)
    }
    return { server, internals, socketPath, calls, tracerEnds, inflight, transcript, deliver }
  }

  test("a forwarded Stop closes the turn with Claude's last message and ends its trace", async () => {
    const { server, socketPath, calls, tracerEnds, transcript, deliver } = await hookServer()
    await deliver("binv_turn")

    const hook = Bun.spawn(["bun", join(import.meta.dir, "stop-hook-forwarder.ts"), socketPath], {
      stdin: new Blob([
        JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript, last_assistant_message: "Done." }),
      ]),
      stdout: "pipe",
    })
    const exitCode = await hook.exited
    for (let i = 0; i < 100 && calls.length === 0; i++) await flush()

    expect({ exitCode, stdout: await new Response(hook.stdout).text(), calls, tracerEnds }).toEqual({
      exitCode: 0,
      stdout: "",
      calls: [{ method: "endTurn", invocationId: "binv_turn", text: "Done." }],
      tracerEnds: ["binv_turn"],
    })
    await server.shutdown()
  })

  test("reply posts without closing the turn", async () => {
    const { server, calls, inflight, deliver } = await hookServer()
    await deliver("binv_turn")

    const result = await server.handleToolCall("reply", "binv_turn", "Here is the answer.")

    expect({ result, calls, open: inflight.has("binv_turn") }).toEqual({
      result: { ok: true, message: "sent" },
      calls: [{ method: "sendInterim", invocationId: "binv_turn", text: "Here is the answer." }],
      open: true,
    })
    await server.shutdown()
  })

  test("a Stop from a turn that never saw the invocation leaves it open", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    writeFileSync(transcript, '{"type":"user","content":"a terminal prompt"}\n')

    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Unrelated." })

    expect(calls).toEqual([])
    await server.shutdown()
  })

  test("a StopFailure closes the turn with the error", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")

    await server.handleStopSignal({
      event: "StopFailure",
      transcriptPath: transcript,
      error: "invalid_request",
      message: "Prompt is too long",
    })

    expect(calls).toEqual([
      {
        method: "reply",
        invocationId: "binv_turn",
        text: "⚠️ Claude Code stopped with an error before finishing this turn: invalid_request: Prompt is too long",
      },
    ])
    await server.shutdown()
  })

  test("a quota StopFailure goes to carry-on instead of closing the turn", async () => {
    const { server, internals, calls, transcript, deliver } = await hookServer()
    const apiErrors: Array<{ invocationId: string; text: string }> = []
    await deliver("binv_turn")
    internals.carryOn = {
      onApiError: (invocationId, text) => (apiErrors.push({ invocationId, text }), true),
      onTurnClosed: () => {},
      stop: () => {},
    }

    await server.handleStopSignal({
      event: "StopFailure",
      transcriptPath: transcript,
      error: "rate_limit",
      message: "You've hit your limit · resets 3pm",
    })

    expect({ calls, apiErrors }).toEqual({
      calls: [],
      apiErrors: [{ invocationId: "binv_turn", text: "You've hit your limit · resets 3pm" }],
    })
    await server.shutdown()
  })

  test("a Stop while Claude holds queued input posts that turn's answer and leaves the invocation open", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    writeFileSync(
      transcript,
      [
        queueLine("enqueue", '<channel invocation_id="binv_turn">'),
        queueLine("dequeue"),
        turnLine("binv_turn"),
        queueLine("enqueue", "[Steer from the Threa scratchpad — fold into the current work]\nalso check the docs"),
      ].join("\n") + "\n"
    )

    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Done." })

    expect(calls).toEqual([{ method: "sendInterim", invocationId: "binv_turn", text: "Done." }])
    await server.shutdown()
  })

  test("the turn that takes queued input posts its own answer when it closes the invocation", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    const steer = "[Steer from the Threa scratchpad — fold into the current work]\nalso check the docs"
    writeFileSync(transcript, [turnLine("binv_turn"), queueLine("enqueue", steer)].join("\n") + "\n")
    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Code fixed." })
    writeFileSync(
      transcript,
      [turnLine("binv_turn"), queueLine("enqueue", steer), queueLine("dequeue")].join("\n") + "\n"
    )

    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Docs checked." })

    expect(calls).toEqual([
      { method: "sendInterim", invocationId: "binv_turn", text: "Code fixed." },
      { method: "endTurn", invocationId: "binv_turn", text: "Docs checked." },
    ])
    await server.shutdown()
  })

  test("a Stop after the turn posted with reply closes without posting its final text again", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    await server.handleToolCall("reply", "binv_turn", "Here is the answer.")

    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Recap." })

    expect(calls).toEqual([
      { method: "sendInterim", invocationId: "binv_turn", text: "Here is the answer." },
      { method: "endTurn", invocationId: "binv_turn", text: undefined },
    ])
    await server.shutdown()
  })

  test("a Stop after queued input was taken mid-turn closes the turn", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    const steer = "[Steer from the Threa scratchpad — fold into the current work]\nalso check the docs"
    writeFileSync(
      transcript,
      [turnLine("binv_turn"), queueLine("enqueue", steer), queueLine("remove", steer)].join("\n") + "\n"
    )

    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Done." })

    expect(calls).toEqual([{ method: "endTurn", invocationId: "binv_turn", text: "Done." }])
    await server.shutdown()
  })

  test("a Stop whose transcript cannot be read still closes the turn", async () => {
    const { server, calls, deliver } = await hookServer()
    await deliver("binv_turn")

    await server.handleStopSignal({
      event: "Stop",
      transcriptPath: join(dir, "missing.jsonl"),
      lastAssistantMessage: "Done.",
    })

    expect(calls).toEqual([{ method: "endTurn", invocationId: "binv_turn", text: "Done." }])
    await server.shutdown()
  })

  test("a Stop from another turn while the invocation is only queued leaves it open", async () => {
    const { server, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    writeFileSync(
      transcript,
      [
        '{"type":"user","message":{"content":"a terminal prompt"}}',
        queueLine("enqueue", '<channel invocation_id="binv_turn">'),
      ].join("\n") + "\n"
    )

    await server.handleStopSignal({ event: "Stop", transcriptPath: transcript, lastAssistantMessage: "Unrelated." })

    expect(calls).toEqual([])
    await server.shutdown()
  })

  test("a StopFailure carry-on declines closes the turn with the error", async () => {
    const { server, internals, calls, transcript, deliver } = await hookServer()
    await deliver("binv_turn")
    internals.carryOn = { onApiError: () => false, onTurnClosed: () => {}, stop: () => {} }

    await server.handleStopSignal({
      event: "StopFailure",
      transcriptPath: transcript,
      error: "rate_limit",
      message: "You've hit your limit · resets 3pm",
    })

    expect(calls).toEqual([
      {
        method: "reply",
        invocationId: "binv_turn",
        text: "⚠️ Claude Code stopped with an error before finishing this turn: rate_limit: You've hit your limit · resets 3pm",
      },
    ])
    await server.shutdown()
  })
})

describe("ChannelServer steering", () => {
  let dir: string
  const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "threa-steer-"))
    process.env.TMUX = "/tmp/tmux-1/default,1,0"
    process.env.TMUX_PANE = "%1"
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const steerOf = (server: ChannelServer) =>
    (
      server.session as unknown as {
        delegate: { sessionControl: { steer?: (text: string, streamId: string) => Promise<boolean> } }
      }
    ).delegate.sessionControl.steer

  test("a session launched without the Stop hook offers no steer; messages wait for the next turn", async () => {
    const { server } = stubbedTurnServer(makeConfig())
    try {
      expect(steerOf(server)).toBeUndefined()
    } finally {
      await server.shutdown()
    }
  })

  test("a steer waits while a Stop is closing the turn", async () => {
    const pasted = spyOn(tmuxControl, "steerText").mockResolvedValue(true)
    const socketPath = join(dir, "session.sock")
    const listener = await StopHookListener.listen(socketPath, () => {})
    const { server, deliver } = stubbedTurnServer(makeConfig(), listener)
    let finishClose: () => void = () => {}
    const closing = new Promise<void>((resolve) => (finishClose = resolve))
    let closeStarted = false
    spyOn(server.session, "endTurn").mockImplementation(async () => {
      closeStarted = true
      await closing
      return { ok: true, message: "sent", closedTurn: true as const }
    })
    try {
      await deliver("binv_turn")
      const hook = Bun.spawn(["bun", join(import.meta.dir, "stop-hook-forwarder.ts"), socketPath], {
        stdin: new Blob([JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Done." })]),
      })
      await hook.exited
      for (let i = 0; i < 100 && !closeStarted; i++) await flush()
      const whileClosing = await steerOf(server)!("also check the docs", "stream_turn")
      finishClose()
      await flush()
      const afterClose = await steerOf(server)!("also check the docs", "stream_turn")

      expect({ whileClosing, afterClose, pastes: pasted.mock.calls.length }).toEqual({
        whileClosing: false,
        afterClose: true,
        pastes: 1,
      })
    } finally {
      pasted.mockRestore()
      await server.shutdown()
    }
  })
})
