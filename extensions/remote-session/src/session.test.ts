import { describe, expect, test } from "bun:test"
import type { BotRuntimeTransport } from "@threa/bot-runtime-client"
import {
  RemoteSession,
  buildSteerContent,
  claimCapabilitiesFor,
  formatInvocationContent,
  isSessionControlInvocation,
  parseSessionControlCommand,
  runtimeCapabilitiesFor,
  supportedCapabilitiesFor,
  type RemoteSessionDelegate,
  type RuntimeDescriptor,
  type SessionControlActuator,
} from "./session"
import type { RemoteSessionConfig } from "./identity"
import type { ClaimedInvocation, ThreaClient } from "./client"

function makeConfig(overrides?: Partial<RemoteSessionConfig>): RemoteSessionConfig {
  return {
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    displayName: "Test Runtime - test",
    instanceId: "rt-test",
    runtimeSessionId: "rts-test",
    permissionRelay: false,
    pollMs: 3000,
    idleTimeoutMs: 3_600_000,
    sealedFullTrace: true,
    ...overrides,
  }
}

const RUNTIME: RuntimeDescriptor = {
  kind: "test-runtime",
  busyStatusText: "Working…",
  forwardedNote: "Forwarded to the runtime.",
  shutdownErrorMessage: "Test runtime shut down",
}

/** A ThreaClient stub that records the calls the send/timeout paths make. */
function makeFakeClient() {
  const calls = {
    sendMessage: [] as Array<{ streamId: string; body: Record<string, unknown> }>,
    complete: [] as Array<{ id: string; body: Record<string, unknown> }>,
  }
  const client = {
    sendMessage: async (streamId: string, body: Record<string, unknown>) => {
      calls.sendMessage.push({ streamId, body })
    },
    complete: async (id: string, body: Record<string, unknown>) => {
      calls.complete.push({ id, body })
    },
    uploadAttachment: async () => {
      throw new Error("unexpected upload in test")
    },
  }
  return { client: client as unknown as ThreaClient, calls }
}

function makeFakeTransport() {
  const presence: Record<string, unknown>[] = []
  const transport = {
    connect: async () => {},
    disconnect: () => {},
    socketConnected: false,
    sendHello: () => {},
    recordSteps: async () => {},
    renewClaim: async () => ({ notFound: false }),
    updatePresence: async (body: Record<string, unknown>) => {
      presence.push(body)
    },
  }
  return { transport: transport as unknown as BotRuntimeTransport, presence }
}

function makeSession(
  client: ThreaClient,
  transport: BotRuntimeTransport,
  delegate: Partial<RemoteSessionDelegate> = {}
): RemoteSession {
  return new RemoteSession({
    config: makeConfig(),
    client,
    delegate: { deliverTurn: async () => {}, ...delegate },
    runtime: RUNTIME,
    transport,
  })
}

/** Seed an in-flight turn the way deliverTurn would, with a harmless deadline timer. */
function seedInflight(session: RemoteSession, invocation: ClaimedInvocation, sentCount = 0): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(session as any).inflight.set(invocation.id, { invocation, deadline: setTimeout(() => {}, 1e9), sentCount })
}

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
    claimExpiresAt: "2026-06-16T00:00:00.000Z",
    runtimeSessionId: "rts_1",
    metadata: {},
    ...partial,
  }
}

describe("parseSessionControlCommand", () => {
  test("reads name + args from structured command metadata", () => {
    const inv = makeInvocation({
      trigger: "session-control",
      promptMarkdown: "/steer focus on the failing test",
      metadata: {
        command: { executionKind: "bot-runtime", id: "cmd_1", name: "steer", args: "focus on the failing test" },
      },
    })
    expect(parseSessionControlCommand(inv)).toEqual({ name: "steer", args: "focus on the failing test" })
  })

  test("falls back to parsing the prompt for a session-control invocation without metadata", () => {
    const inv = makeInvocation({ trigger: "session-control", promptMarkdown: "/model opus", metadata: {} })
    expect(parseSessionControlCommand(inv)).toEqual({ name: "model", args: "opus" })
  })

  test("handles a no-arg command", () => {
    const inv = makeInvocation({ trigger: "session-control", promptMarkdown: "/stop", metadata: {} })
    expect(parseSessionControlCommand(inv)).toEqual({ name: "stop", args: "" })
  })

  test("returns null for a normal message even if it starts with a slash", () => {
    const inv = makeInvocation({ trigger: "active-scratchpad", promptMarkdown: "/not-a-command really", metadata: {} })
    expect(parseSessionControlCommand(inv)).toBeNull()
    expect(isSessionControlInvocation(inv)).toBe(false)
  })
})

describe("buildSteerContent", () => {
  test("returns the single part verbatim", () => {
    expect(buildSteerContent(["just this"])).toBe("just this")
  })

  test("combines multiple parts most-recent-last under one header", () => {
    const combined = buildSteerContent(["first queued", "second queued", "the steer"])
    expect(combined).toContain("Handle all of the following together (most recent last):")
    expect(combined.indexOf("first queued")).toBeLessThan(combined.indexOf("the steer"))
  })
})

describe("capability selection", () => {
  const actuator: SessionControlActuator = {
    commands: ["stop", "steer", "model"],
    modelSuggestions: [{ value: "opus", label: "Opus" }],
    thinkingLevels: ["low", "high"],
    interrupt: () => true,
    runCommand: async () => ({ ok: true, message: "ok" }),
  }

  test("advertises session-control only when an actuator is present", () => {
    expect(supportedCapabilitiesFor(true)).toContain("session-control")
    expect(supportedCapabilitiesFor(false)).not.toContain("session-control")
  })

  test("claims everything when idle but session-control only when busy", () => {
    expect(claimCapabilitiesFor(false, true)).toEqual(["active-scratchpad", "mentionable", "session-control"])
    expect(claimCapabilitiesFor(true, true)).toEqual(["session-control"])
  })

  test("claims nothing while busy without runtime control (caller must not claim)", () => {
    expect(claimCapabilitiesFor(true, false)).toEqual([])
  })

  test("publishes the actuator's commands, model suggestions, and thinking levels", () => {
    const enabled = runtimeCapabilitiesFor("rts_1", actuator)
    expect(enabled.supportsSessionControlCommands).toBe(true)
    expect(enabled.sessionControlCommands).toEqual(["stop", "steer", "model"])
    expect(enabled.modelSuggestions).toEqual([{ value: "opus", label: "Opus" }])
    expect(enabled.thinkingLevels).toEqual(["low", "high"])
    expect(enabled.runtimeSessionId).toBe("rts_1")

    const disabled = runtimeCapabilitiesFor("rts_1", undefined)
    expect(disabled.supportsSessionControlCommands).toBeUndefined()
    expect(disabled.sessionControlCommands).toBeUndefined()
    expect(disabled.thinkingLevels).toBeUndefined()
    expect(disabled.runtimeSessionId).toBe("rts_1")
  })
})

describe("formatInvocationContent", () => {
  test("returns just the prompt when there is no prior context", () => {
    expect(formatInvocationContent(makeInvocation({ promptMarkdown: "Fix the bug" }))).toBe("Fix the bug")
  })

  test("falls back to a placeholder for an empty prompt", () => {
    expect(formatInvocationContent(makeInvocation({ promptMarkdown: "   " }))).toBe("(empty message)")
  })

  test("appends history but excludes the source message itself", () => {
    const content = formatInvocationContent(
      makeInvocation({
        promptMarkdown: "Now do Y",
        sourceMessageId: "src",
        context: {
          kind: "inline",
          messages: [
            {
              messageId: "m1",
              role: "user",
              authorId: "u",
              authorType: "user",
              authorDisplayName: "Alice",
              contentMarkdown: "did X",
              createdAt: "t1",
            },
            {
              messageId: "src",
              role: "user",
              authorId: "u",
              authorType: "user",
              authorDisplayName: "Alice",
              contentMarkdown: "Now do Y",
              createdAt: "t2",
            },
          ],
        },
      })
    )
    expect(content).toContain("Now do Y")
    expect(content).toContain("Earlier in this scratchpad")
    expect(content).toContain("- Alice: did X")
    // the source message must not be duplicated into the history block
    expect(content.match(/Now do Y/g)?.length).toBe(1)
  })

  test("truncates an over-long history message", () => {
    const content = formatInvocationContent(
      makeInvocation({
        context: {
          kind: "inline",
          messages: [
            {
              messageId: "m1",
              role: "user",
              authorId: "u",
              authorType: "user",
              contentMarkdown: "z".repeat(5000),
              createdAt: "t1",
            },
          ],
        },
      })
    )
    expect(content.includes("z".repeat(2000))).toBe(true)
    expect(content.includes("z".repeat(2001))).toBe(false)
  })
})

describe("RemoteSession.sendInterim", () => {
  test("posts an interim message to the turn's stream and keeps the request open", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    const invocation = makeInvocation({ id: "binv_send", responseStreamId: "stream_turn" })
    seedInflight(session, invocation)

    const res = await session.sendInterim(invocation.id, "halfway there")

    expect(res).toEqual({ ok: true, message: "sent" })
    expect(calls.sendMessage[0]).toEqual({
      streamId: "stream_turn",
      body: {
        content: "halfway there",
        clientMessageId: "remote-send-binv_send-1",
        metadata: { "remote.invocationId": "binv_send", "remote.interim": "true" },
      },
    })
    // The turn is not completed, and the send is counted toward the idle-timeout policy.
    expect(calls.complete).toEqual([])
    expect(
      (session as unknown as { inflight: Map<string, { sentCount: number }> }).inflight.get("binv_send")?.sentCount
    ).toBe(1)
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_send")
  })

  test("errors without posting when the invocation is not open", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)

    const res = await session.sendInterim("binv_missing", "hi")

    expect(res.ok).toBe(false)
    expect(calls.sendMessage).toEqual([])
  })

  test("reports a closed turn when the idle timeout fires mid-send", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    const invocation = makeInvocation({ id: "binv_race", responseStreamId: "stream_turn" })
    seedInflight(session, invocation)

    // Simulate onReplyTimeout firing during the post: the entry is removed from
    // the in-flight map while sendMessage is in flight.
    ;(client as unknown as { sendMessage: (s: string, b: Record<string, unknown>) => Promise<void> }).sendMessage =
      async (streamId, body) => {
        ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_race")
        calls.sendMessage.push({ streamId, body })
      }

    const res = await session.sendInterim("binv_race", "progress")

    // The message still posted (it can't be un-posted), but the result is not a
    // clean "sent" — it tells the runtime the turn already closed.
    expect(calls.sendMessage[0]?.streamId).toBe("stream_turn")
    expect(res.ok).toBe(false)
    expect(res.message).toContain("already closed")
  })
})

describe("RemoteSession.onReplyTimeout", () => {
  test("posts the no-reply notice when the turn sent nothing", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_silent" }), 0)

    await (session as unknown as { onReplyTimeout: (id: string) => Promise<void> }).onReplyTimeout("binv_silent")

    expect(calls.complete[0]?.body.finalMessageMarkdown).toContain("without sending a reply")
    expect(calls.complete[0]?.body.noResponse).toBeUndefined()
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.has("binv_silent")).toBe(false)
  })

  test("closes silently when the turn already sent interim messages", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_progress" }), 2)

    await (session as unknown as { onReplyTimeout: (id: string) => Promise<void> }).onReplyTimeout("binv_progress")

    expect(calls.complete[0]?.body.noResponse).toBe(true)
    expect(calls.complete[0]?.body.finalMessageMarkdown).toBeUndefined()
  })
})

describe("RemoteSession session-archived handling", () => {
  test("goes offline, fails in-flight turns, and hands the connector the final word", async () => {
    const failed: string[] = []
    const client = {
      fail: async (id: string) => {
        failed.push(id)
      },
    } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    const archived: Array<{ rootStreamId: string }> = []
    const session = makeSession(client, transport, { onArchived: (payload) => void archived.push(payload) })
    seedInflight(session, makeInvocation({ id: "binv_running" }))

    await (session as unknown as { handleSessionArchived: (p: unknown) => Promise<void> }).handleSessionArchived({
      runtimeSessionId: "rts-test",
      rootStreamId: "stream_root",
    })

    expect(presence.at(-1)?.status).toBe("offline")
    expect(failed).toEqual(["binv_running"])
    expect(archived).toEqual([{ rootStreamId: "stream_root" }])
  })

  test("ignores an event for a different runtime session (stale re-registration)", async () => {
    const { client } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const archived: unknown[] = []
    const session = makeSession(client, transport, { onArchived: (payload) => void archived.push(payload) })

    await (session as unknown as { handleSessionArchived: (p: unknown) => Promise<void> }).handleSessionArchived({
      runtimeSessionId: "rts-someone-else",
      rootStreamId: "stream_root",
    })

    expect(archived).toEqual([])
    expect(presence).toEqual([])
  })
})

describe("RemoteSession.shutdown", () => {
  test("marks presence offline and fails every in-flight claim", async () => {
    const failed: Array<{ id: string; body: Record<string, unknown> }> = []
    const client = {
      fail: async (id: string, body: Record<string, unknown>) => {
        failed.push({ id, body })
      },
    } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_a", claimToken: "tok_a" }))
    seedInflight(session, makeInvocation({ id: "binv_b", claimToken: "tok_b" }))

    await session.shutdown()

    expect(presence.at(-1)?.status).toBe("offline")
    expect(failed.map((entry) => entry.id).sort()).toEqual(["binv_a", "binv_b"])
    const a = failed.find((entry) => entry.id === "binv_a")
    expect(a?.body.claimToken).toBe("tok_a")
    expect(a?.body.errorMessage).toBe("Test runtime shut down")
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.size).toBe(0)
  })
})

describe("session control via the actuator", () => {
  test("routes an advertised command to runCommand and acks with its message", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const ran: Array<{ name: string; args: string }> = []
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer", "model"],
        interrupt: () => true,
        runCommand: async (name, args) => {
          ran.push({ name, args })
          return { ok: true, message: "Set model to `opus`." }
        },
      },
    })
    const invocation = makeInvocation({
      id: "binv_cmd",
      trigger: "session-control",
      promptMarkdown: "/model opus",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_1", name: "model", args: "opus" } },
    })

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(invocation)

    expect(ran).toEqual([{ name: "model", args: "opus" }])
    expect(calls.complete[0]?.body.finalMessageMarkdown).toBe("Set model to `opus`.")
  })

  test("steer always posts a supersede note carrying the steer text", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const delivered: string[] = []
    const session = makeSession(client, transport, {
      deliverTurn: async (turn) => {
        delivered.push(turn.content)
      },
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    // A turn that already posted interim messages — the steer must still leave a note.
    seedInflight(session, makeInvocation({ id: "binv_running", responseStreamId: "stream_turn" }), 3)
    ;(client as unknown as { claim: () => Promise<null> }).claim = async () => null

    const steer = makeInvocation({
      id: "binv_steer",
      trigger: "session-control",
      promptMarkdown: "/steer look at the tests instead",
      metadata: {
        command: { executionKind: "bot-runtime", id: "cmd_2", name: "steer", args: "look at the tests instead" },
      },
    })
    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(steer)

    const interruptedClose = calls.complete.find((entry) => entry.id === "binv_running")
    expect(interruptedClose?.body.finalMessageMarkdown).toContain("now handling")
    expect(interruptedClose?.body.finalMessageMarkdown).toContain("look at the tests instead")
    expect(delivered).toEqual(["look at the tests instead"])
  })
})
