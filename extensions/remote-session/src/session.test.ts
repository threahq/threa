import { describe, expect, spyOn, test } from "bun:test"
import type {
  BotRuntimeHello,
  BotRuntimeTransport,
  InvocationInputUpdate,
  ObserveClaimParams,
} from "@threahq/bot-runtime-client"
import {
  COMPLETED_TURN_MEMORY,
  RECONNECT_HANDOFF_FALLBACK_MS,
  RemoteSession,
  buildSteerContent,
  claimCapabilitiesFor,
  effectiveRuntimeManifest,
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreaApiError, type ClaimedInvocation, type ThreaClient } from "./client"
import { fireIdleTimeout, gate } from "./session.test-support"

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
    traceMode: "headline",
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
    invocationMessage: [] as Array<{ id: string; body: Record<string, unknown> }>,
    complete: [] as Array<{ id: string; body: Record<string, unknown> }>,
    fail: [] as Array<{ id: string; body: Record<string, unknown> }>,
  }
  const client = {
    sendMessage: async (streamId: string, body: Record<string, unknown>) => {
      calls.sendMessage.push({ streamId, body })
    },
    sendInvocationMessage: async (id: string, body: Record<string, unknown>) => {
      calls.invocationMessage.push({ id, body })
    },
    complete: async (id: string, body: Record<string, unknown>) => {
      calls.complete.push({ id, body })
    },
    fail: async (id: string, body: Record<string, unknown>) => {
      calls.fail.push({ id, body })
    },
    uploadAttachment: async () => {
      throw new Error("unexpected upload in test")
    },
  }
  return { client: client as unknown as ThreaClient, calls }
}

function makeFakeTransport(onSync?: (params: ObserveClaimParams) => void | Promise<void>) {
  const presence: Record<string, unknown>[] = []
  const steps: Array<{ invocationId: string; frames: Array<{ stepType: string; content: string }> }> = []
  const observations = new Map<
    string,
    {
      params: ObserveClaimParams
      disposed: boolean
      unregistered: boolean
      update(update: InvocationInputUpdate, signal?: AbortSignal): Promise<"applied" | "restart-required">
      cancel(): Promise<void>
      lose(): Promise<void>
    }
  >()
  const transport = {
    connect: async () => {},
    disconnect: () => {},
    socketConnected: false,
    sendHello: () => {},
    recordSteps: async (
      invocationId: string,
      _claimToken: string,
      frames: Array<{ stepType: string; content: string }>
    ) => {
      steps.push({ invocationId, frames })
    },
    observeClaim: (params: ObserveClaimParams) => {
      const record = {
        params,
        disposed: false,
        unregistered: false,
        async update(update: InvocationInputUpdate, signal = new AbortController().signal) {
          return await params.callbacks.onInputUpdated(update, signal)
        },
        async cancel() {
          await params.callbacks.onCancelled()
        },
        async lose() {
          await params.callbacks.onClaimLost?.()
        },
      }
      observations.set(params.invocationId, record)
      return {
        sync: async () => {
          await onSync?.(params)
        },
        unregister: () => {
          record.unregistered = true
        },
        dispose: () => {
          record.disposed = true
        },
      }
    },
    updatePresence: async (body: Record<string, unknown>) => {
      presence.push(body)
    },
  }
  return {
    transport: transport as unknown as BotRuntimeTransport,
    presence,
    steps,
    observations,
  }
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

/** Seed an in-flight turn through the production registration path. */
function seedInflight(session: RemoteSession, invocation: ClaimedInvocation, sentCount = 0): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const route = (session as any).registerTurn(invocation)
  route.sentCount = sentCount
}

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
    claimExpiresAt: "2026-06-16T00:00:00.000Z",
    runtimeSessionId: "rts_1",
    metadata: {},
    ...partial,
  }
}

describe("effectiveRuntimeManifest", () => {
  const actuator = (steer?: SessionControlActuator["steer"]): SessionControlActuator => ({
    commands: [],
    interrupt: () => true,
    ...(steer ? { steer } : {}),
    runCommand: async () => ({ ok: true, message: "ok" }),
  })

  test("derives update mode only from native steering and preserves output", () => {
    expect({
      live: effectiveRuntimeManifest(
        { input: { updates: "restart" }, output: { reply: true, trace: false } },
        actuator(async () => true)
      ),
      restart: effectiveRuntimeManifest({ input: { updates: "live" }, output: { sources: true } }, actuator()),
      none: effectiveRuntimeManifest(undefined, undefined),
    }).toEqual({
      live: { input: { updates: "live" }, output: { reply: true, trace: false } },
      restart: { input: { updates: "restart" }, output: { sources: true } },
      none: { input: { updates: "restart" }, output: {} },
    })
  })
})

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
    // Invocation-bound, not stream-addressed: the claim decides where it lands.
    expect(calls.sendMessage).toEqual([])
    expect(calls.invocationMessage).toEqual([
      {
        id: "binv_send",
        body: {
          instanceId: "rt-test",
          claimToken: "tok",
          content: "halfway there",
          clientMessageId: "remote-send-binv_send-1",
          metadata: { "remote.invocationId": "binv_send", "remote.interim": "true" },
        },
      },
    ])
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
    expect(calls.invocationMessage).toEqual([])
  })

  // The idle timeout is queued like any other post: it cannot cut in front of a
  // send already on the wire, and a send behind it lands as a follow-up.
  test("a send queued behind the idle timeout's completion posts as a follow-up", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_race", responseStreamId: "stream_turn" }))

    let releaseCompletion: (() => void) | undefined
    const completionBlocked = new Promise<void>((resolve) => {
      releaseCompletion = resolve
    })
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        await completionBlocked
        calls.complete.push({ id, body })
      }
    const timedOut = fireIdleTimeout(session, "binv_race")
    const sending = session.sendInterim("binv_race", "progress")
    releaseCompletion!()
    await timedOut
    const res = await sending

    expect(res.ok).toBe(true)
    expect(res.message).toContain("follow-up")
    expect(calls.invocationMessage[0]?.id).toBe("binv_race")
    // A second send is a new message even when its text matches the first: the
    // route must not retain a successful post as a retryable pending body.
    await session.sendInterim("binv_race", "progress")
    expect(calls.invocationMessage.map((call) => call.body.clientMessageId)).toEqual([
      "remote-send-binv_race-1",
      "remote-send-binv_race-2",
    ])
  })

  // A send already on the wire holds the queue, so the idle timeout runs only
  // after it commits — and it commits onto the same route the closed turn keeps,
  // or the next message reuses a spent client id the server dedupes away.
  test("a post in flight holds the idle timeout until its sequence commits", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_order", responseStreamId: "stream_turn" }))

    let releasePost: (() => void) | undefined
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    ;(
      client as unknown as { sendInvocationMessage: (i: string, b: Record<string, unknown>) => Promise<void> }
    ).sendInvocationMessage = async (id, body) => {
      await postBlocked
      calls.invocationMessage.push({ id, body })
    }

    const sending = session.sendInterim("binv_order", "progress")
    const timedOut = fireIdleTimeout(session, "binv_order")
    releasePost!()
    const res = await sending
    await timedOut
    const late = await session.sendInterim("binv_order", "and one more")

    expect(res).toEqual({ ok: true, message: "sent" })
    expect(late.ok).toBe(true)
    expect(calls.invocationMessage.map((call) => call.body.clientMessageId)).toEqual([
      "remote-send-binv_order-1",
      "remote-send-binv_order-2",
    ])
    // The send re-armed the deadline before the timeout ran, so the turn was
    // never silent — but the fired timer still closed it once, not twice.
    expect(calls.complete).toHaveLength(0)
  })
})

describe("RemoteSession.onReplyTimeout", () => {
  test("posts the no-reply notice when the turn sent nothing", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_silent" }), 0)

    await fireIdleTimeout(session, "binv_silent")

    expect(calls.complete[0]?.body.finalMessageMarkdown).toContain("without sending a reply")
    expect(calls.complete[0]?.body.noResponse).toBeUndefined()
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.has("binv_silent")).toBe(false)
  })

  test("closes silently when the turn already sent interim messages", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_progress" }), 2)

    await fireIdleTimeout(session, "binv_progress")

    expect(calls.complete[0]?.body.noResponse).toBe(true)
    expect(calls.complete[0]?.body.finalMessageMarkdown).toBeUndefined()
  })

  test("should replay the exact timeout body when the re-armed deadline fires", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    const attempts: Array<Record<string, unknown>> = []
    let failNext = true
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (_id, body) => {
        attempts.push(body)
        if (failNext) {
          failNext = false
          throw new Error("connection reset after the server committed")
        }
      }
    seedInflight(session, makeInvocation({ id: "binv_timeout_retry" }))

    await fireIdleTimeout(session, "binv_timeout_retry")
    await fireIdleTimeout(session, "binv_timeout_retry")

    expect({ attempts, stillInflight: session.isInflight("binv_timeout_retry") }).toEqual({
      attempts: [attempts[0]!, attempts[0]!],
      stillInflight: false,
    })
  })
})

describe("RemoteSession late delivery after completion", () => {
  /** Close a turn the way a normal reply does, so the session remembers its route. */
  async function replyAndClose(session: RemoteSession, invocation: ClaimedInvocation, text = "Done.") {
    seedInflight(session, invocation)
    return session.reply(invocation.id, text)
  }

  test("a late send posts a follow-up bound to the turn's own invocation and leaves the request closed", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    await replyAndClose(session, makeInvocation({ id: "binv_late", responseStreamId: "stream_turn" }))

    const res = await session.sendInterim("binv_late", "One more thought.")

    expect(res.ok).toBe(true)
    expect(res.message).toContain("follow-up")
    expect(calls.sendMessage).toEqual([])
    expect(calls.invocationMessage).toEqual([
      {
        id: "binv_late",
        body: {
          instanceId: "rt-test",
          claimToken: "tok",
          content: "One more thought.",
          clientMessageId: "remote-send-binv_late-1",
          metadata: { "remote.invocationId": "binv_late", "remote.followUp": "true" },
        },
      },
    ])
    expect(calls.complete).toHaveLength(1)
  })

  test("an exact repeat of the successful reply reports that success and posts nothing", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    await replyAndClose(session, makeInvocation({ id: "binv_repeat" }), "Done.")

    const again = await session.reply("binv_repeat", "Done.")

    expect(again).toEqual({ ok: true, message: "sent" })
    expect(calls.invocationMessage).toEqual([])
    expect(calls.complete).toHaveLength(1)
  })

  test("a changed late reply posts a follow-up, and repeating that one dedupes in turn", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    await replyAndClose(session, makeInvocation({ id: "binv_changed" }), "Done.")

    const changed = await session.reply("binv_changed", "Actually, one correction.")
    const repeat = await session.reply("binv_changed", "Actually, one correction.")

    expect(changed.ok).toBe(true)
    expect(repeat).toEqual({ ok: true, message: "sent" })
    expect(calls.invocationMessage.map((call) => call.body.content)).toEqual(["Actually, one correction."])
  })

  test("a turn closed by the idle timeout stays routable, and the late reply is new content", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_idle", responseStreamId: "stream_turn" }))

    await fireIdleTimeout(session, "binv_idle")
    const late = await session.reply("binv_idle", "Here it is.")

    expect(late.ok).toBe(true)
    expect(calls.invocationMessage[0]).toMatchObject({
      id: "binv_idle",
      body: { content: "Here it is.", clientMessageId: "remote-send-binv_idle-1" },
    })
  })

  test("a turn stopped by /stop is not routable — the late reply fails honestly", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_stopped" }))

    await (
      session as unknown as { completeInterruptedTurns: (note: string) => Promise<void> }
    ).completeInterruptedTurns("Stopped by /stop.")
    const late = await session.reply("binv_stopped", "Late anyway.")

    expect(late.ok).toBe(false)
    expect(late.message).toContain("No open request")
    expect(calls.invocationMessage).toEqual([])
  })

  test("should retain a refreshed completed route when the LRU bound evicts an untouched route", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    const ids = Array.from({ length: COMPLETED_TURN_MEMORY }, (_, index) => `binv_lru_${index}`)
    for (const id of ids) await replyAndClose(session, makeInvocation({ id }))

    const refreshed = await session.sendInterim(ids[0]!, "Refresh me.")
    await replyAndClose(session, makeInvocation({ id: "binv_lru_overflow" }))
    const retained = await session.sendInterim(ids[0]!, "Still here.")
    const evicted = await session.sendInterim(ids[1]!, "Gone.")

    expect({
      refreshed: refreshed.ok,
      retained: retained.ok,
      evicted: evicted.message,
      postedIds: calls.invocationMessage.map((call) => call.id),
    }).toEqual({
      refreshed: true,
      retained: true,
      evicted: `No open request with invocation_id ${ids[1]!} — interim messages need an open request (it may have been answered or closed).`,
      postedIds: [ids[0]!, ids[0]!],
    })
  })

  for (const lifecycle of ["shutdown", "archive"] as const) {
    test(`should revoke completed routes during ${lifecycle}`, async () => {
      const { client, calls } = makeFakeClient()
      const { transport } = makeFakeTransport()
      const session = makeSession(client, transport)
      const invocationId = `binv_completed_${lifecycle}`
      await replyAndClose(session, makeInvocation({ id: invocationId }))

      if (lifecycle === "shutdown") await session.shutdown()
      else {
        await (session as unknown as { detachForArchive: (rootStreamId: string) => Promise<void> }).detachForArchive(
          "stream_root"
        )
      }
      const late = await session.sendInterim(invocationId, "Too late.")

      expect({ late, posts: calls.invocationMessage }).toEqual({
        late: {
          ok: false,
          retryable: false,
          message: `No open request with invocation_id ${invocationId} — interim messages need an open request (it may have been answered or closed).`,
        },
        posts: [],
      })
      if (lifecycle === "archive") await session.shutdown()
    })
  }
})

describe("RemoteSession concurrent posts on one turn", () => {
  const asInternal = (session: RemoteSession) => session as unknown as { clearInflight: (id: string) => void }

  test("plaintext: identical sends started concurrently still reserve distinct ids", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_same", responseStreamId: "stream_turn" }))
    const blocked = gate()
    let attempts = 0
    ;(
      client as unknown as { sendInvocationMessage: (i: string, b: Record<string, unknown>) => Promise<void> }
    ).sendInvocationMessage = async (id, body) => {
      attempts += 1
      if (attempts === 1) await blocked.promise
      calls.invocationMessage.push({ id, body })
    }

    const first = session.sendInterim("binv_same", "same text")
    await tick()
    const second = session.sendInterim("binv_same", "same text")
    blocked.open()
    await Promise.all([first, second])

    expect(calls.invocationMessage.map((call) => call.body.clientMessageId)).toEqual([
      "remote-send-binv_same-1",
      "remote-send-binv_same-2",
    ])
    asInternal(session).clearInflight("binv_same")
  })

  test("plaintext: a concurrent later post cannot overwrite a failed post's body", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_hold", responseStreamId: "stream_turn" }))
    const attempts: Array<Record<string, unknown>> = []
    let failFirst = true
    ;(
      client as unknown as { sendInvocationMessage: (i: string, b: Record<string, unknown>) => Promise<void> }
    ).sendInvocationMessage = async (id, body) => {
      attempts.push(body)
      if (failFirst && body.content === "first") {
        failFirst = false
        throw new Error("connection reset after the server committed")
      }
      calls.invocationMessage.push({ id, body })
    }

    const [failed, later] = await Promise.all([
      session.sendInterim("binv_hold", "first"),
      session.sendInterim("binv_hold", "second"),
    ])
    const retry = await session.sendInterim("binv_hold", "first")

    expect(failed).toMatchObject({ ok: false, retryable: true })
    expect(later.ok).toBe(true)
    expect(retry.ok).toBe(true)
    expect(attempts.map((body) => [body.clientMessageId, body.content])).toEqual([
      ["remote-send-binv_hold-1", "first"],
      ["remote-send-binv_hold-2", "second"],
      ["remote-send-binv_hold-1", "first"],
    ])
    asInternal(session).clearInflight("binv_hold")
  })
})

/** Resolve on the next macrotask, so a queued route task has actually started. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// Completion is a state, not a gap. While it is on the wire the turn stays
// addressable, so nothing that arrives meanwhile can be told the id is unknown —
// and nothing may record it as completed unless the server said so.
describe("RemoteSession completion is a closing state", () => {
  test("a send during a blocked completion posts through the turn's route, never unknown-id", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_hold", responseStreamId: "stream_turn" }))
    const blocked = gate()
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        await blocked.promise
        calls.complete.push({ id, body })
      }

    const replying = session.reply("binv_hold", "Done.")
    await tick()
    const sending = session.sendInterim("binv_hold", "One more thought.")
    blocked.open()
    const replied = await replying
    const sent = await sending

    expect(replied).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(sent.ok).toBe(true)
    expect(sent.message).toContain("follow-up")
    expect(sent.message).not.toContain("No open request")
    expect(calls.invocationMessage).toHaveLength(1)
    expect(calls.complete).toHaveLength(1)
  })

  test("should report close evidence only for the concurrent identical reply that closes the turn", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_dup" }))
    const blocked = gate()
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        await blocked.promise
        calls.complete.push({ id, body })
      }

    const first = session.reply("binv_dup", "Done.")
    await tick()
    const second = session.reply("binv_dup", "Done.")
    blocked.open()

    expect(await first).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(await second).toEqual({ ok: true, message: "sent" })
    expect(calls.complete).toHaveLength(1)
    expect(calls.invocationMessage).toEqual([])
  })

  test("a failed completion re-opens the turn, and the next reply retries it rather than following up", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_reopen" }))
    let failNext = true
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        if (failNext) {
          failNext = false
          throw new Error("completion POST failed")
        }
        calls.complete.push({ id, body })
      }

    const failed = await session.reply("binv_reopen", "Done.")
    expect(failed).toMatchObject({ ok: false, retryable: true })
    expect(session.isInflight("binv_reopen")).toBe(true)

    const retried = await session.reply("binv_reopen", "Done.")

    expect(retried).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(calls.complete).toHaveLength(1)
    expect(calls.invocationMessage).toEqual([])
  })

  test("should leave in-flight claims to lapse and still go offline when the host is gone", async () => {
    const { client, calls } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_hostgone" }))

    await session.shutdown({ hostGone: true })

    expect({ fails: calls.fail, presence: presence.at(-1)?.status }).toEqual({ fails: [], presence: "offline" })
    expect((await session.sendInterim("binv_hostgone", "later")).message).toContain("No open request")
  })

  test("should fail in-flight claims on an ordinary shutdown", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_stopped" }))

    await session.shutdown()

    expect(calls.fail.map(({ id, body }) => ({ id, errorMessage: body.errorMessage }))).toEqual([
      { id: "binv_stopped", errorMessage: "Test runtime shut down" },
    ])
  })

  test("shutdown settles an in-flight completion instead of racing a /fail past it", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_shutrace" }))
    const blocked = gate()
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        await blocked.promise
        calls.complete.push({ id, body })
      }

    const replying = session.reply("binv_shutrace", "Done.")
    await tick()
    const shutting = session.shutdown()
    blocked.open()
    const replied = await replying
    await shutting

    expect(replied).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(calls.complete).toHaveLength(1)
    expect(calls.fail).toEqual([])
    expect((await session.sendInterim("binv_shutrace", "later")).message).toContain("No open request")
  })

  test("shutdown fails a turn whose completion came back unacknowledged", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_shutfail" }))
    const blocked = gate()
    ;(client as unknown as { complete: () => Promise<void> }).complete = async () => {
      await blocked.promise
      throw new Error("completion POST failed")
    }

    const replying = session.reply("binv_shutfail", "Done.")
    await tick()
    const shutting = session.shutdown()
    blocked.open()
    const replied = await replying
    await shutting

    expect(replied.ok).toBe(false)
    expect(calls.complete).toEqual([])
    expect(calls.fail.map((entry) => entry.id)).toEqual(["binv_shutfail"])
  })

  test("an archive during a completion cannot re-insert the route or publish available again", async () => {
    const { client, calls } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_archrace", responseStreamId: "stream_turn" }))
    const blocked = gate()
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        await blocked.promise
        calls.complete.push({ id, body })
      }

    const replying = session.reply("binv_archrace", "Done.")
    await tick()
    const detaching = (
      session as unknown as { detachForArchive: (rootStreamId: string) => Promise<void> }
    ).detachForArchive("stream_root")
    blocked.open()
    await replying
    await detaching

    expect(presence.map((entry) => entry.status)).not.toContain("available")
    const late = await session.sendInterim("binv_archrace", "into an archived scratchpad")
    expect(late.ok).toBe(false)
    expect(late.message).toContain("No open request")
    expect(calls.invocationMessage).toEqual([])
  })

  for (const lifecycle of ["shutdown", "archive"] as const) {
    test(`a queued /stop close stays tracked and cannot start after ${lifecycle}`, async () => {
      const { client, calls } = makeFakeClient()
      const { transport } = makeFakeTransport()
      const session = makeSession(client, transport)
      const invocationId = `binv_stop_${lifecycle}`
      seedInflight(session, makeInvocation({ id: invocationId, responseStreamId: "stream_turn" }))
      const blocked = gate()
      let postStarted = false
      ;(
        client as unknown as { sendInvocationMessage: (id: string, body: Record<string, unknown>) => Promise<void> }
      ).sendInvocationMessage = async (id, body) => {
        postStarted = true
        await blocked.promise
        calls.invocationMessage.push({ id, body })
      }

      const posting = session.sendInterim(invocationId, "Already on the wire.")
      while (!postStarted) await tick()
      const stopping = (
        session as unknown as { completeInterruptedTurns: (note: string) => Promise<void> }
      ).completeInterruptedTurns("Stopped by /stop.")
      await tick()
      const tracked = (
        session as unknown as {
          inflight: Map<string, { revoked: boolean; closing?: Promise<unknown> }>
        }
      ).inflight.get(invocationId)
      const wasClosingTracked = Boolean(tracked?.closing)

      let lifecycleSettled = false
      const lifecycleTask = (
        lifecycle === "shutdown"
          ? session.shutdown()
          : (session as unknown as { detachForArchive: (root: string) => Promise<void> }).detachForArchive(
              "stream_root"
            )
      ).then(() => {
        lifecycleSettled = true
      })
      await tick()
      const settledBeforeRelease = lifecycleSettled
      blocked.open()
      await Promise.all([posting, stopping, lifecycleTask])

      expect(tracked).toMatchObject({ revoked: true })
      expect(wasClosingTracked).toBe(true)
      expect(settledBeforeRelease).toBe(false)
      expect(calls.complete.filter((call) => call.id === invocationId)).toEqual([])
      expect(calls.fail.map((call) => call.id)).toContain(invocationId)
    })
  }

  test("a post still preparing when shutdown revokes it never starts its message write", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_prepare_fence", responseStreamId: "stream_turn" }))
    const dir = mkdtempSync(join(tmpdir(), "prepare-fence-"))
    const file = join(dir, "note.txt")
    writeFileSync(file, "payload")
    const blocked = gate()
    let markUploadStarted: () => void = () => {}
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve
    })
    ;(client as unknown as { uploadAttachment: () => Promise<unknown> }).uploadAttachment = async () => {
      markUploadStarted()
      await blocked.promise
      return { id: "att_1", filename: "note.txt", mimeType: "text/plain", sizeBytes: 7 }
    }

    const posting = session.sendInterim("binv_prepare_fence", `Progress.\nTHREA_ATTACH: ${file}`)
    await uploadStarted
    await session.shutdown()
    blocked.open()

    expect(await posting).toMatchObject({ ok: false, retryable: false })
    expect(calls.invocationMessage).toEqual([])
  })
})

describe("RemoteSession final replies are bound to their source text", () => {
  test("changed text after a failed completion resolves the original close first, then follows up", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_bind" }))
    let failNext = true
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        if (failNext) {
          failNext = false
          throw new Error("connection reset after the server committed")
        }
        calls.complete.push({ id, body })
      }

    const failed = await session.reply("binv_bind", "First answer.")
    const changed = await session.reply("binv_bind", "Second, better answer.")

    expect(failed).toMatchObject({ ok: false, retryable: true })
    expect(changed).toMatchObject({ ok: true, closedTurn: true })
    expect(calls.complete.map((entry) => entry.body.finalMessageMarkdown)).toEqual(["First answer."])
    expect(calls.invocationMessage.map((call) => call.body.content)).toEqual(["Second, better answer."])
    expect(await session.reply("binv_bind", "Second, better answer.")).toEqual({ ok: true, message: "sent" })
    expect(calls.invocationMessage).toHaveLength(1)
  })
})

describe("RemoteSession completed-route post errors", () => {
  const closed = async (session: RemoteSession, id: string) => {
    seedInflight(session, makeInvocation({ id, responseStreamId: "stream_turn" }))
    await session.reply(id, "Done.")
  }

  test("a deterministic 4xx ends the route, clears its payloads, and is not retryable", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    await closed(session, "binv_term")
    const internals = session as unknown as {
      completed: Map<string, { pending: Map<number, unknown>; invocation: ClaimedInvocation }>
      terminalReplies: Map<string, unknown>
    }
    const route = internals.completed.get("binv_term")!
    const attempts: Array<Record<string, unknown>> = []
    ;(
      client as unknown as { sendInvocationMessage: (i: string, b: Record<string, unknown>) => Promise<void> }
    ).sendInvocationMessage = async (_id, body) => {
      attempts.push(body)
      throw new ThreaApiError("Invocation claim not found", 404, "NOT_FOUND")
    }

    const refused = await session.sendInterim("binv_term", "Late note.")
    const again = await session.sendInterim("binv_term", "Late note.")

    expect(refused).toMatchObject({ ok: false, retryable: false })
    expect(again).toMatchObject({ ok: false, retryable: false })
    expect(attempts).toHaveLength(1)
    expect(internals.completed.has("binv_term")).toBe(false)
    expect(internals.terminalReplies.has("binv_term")).toBe(true)
    expect(route.pending.size).toBe(0)
    expect(route.invocation.claimToken).toBe("")
    expect(calls.invocationMessage).toEqual([])
  })

  test("an exact repeat of the final reply still reports its original success after that refusal", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    await closed(session, "binv_term_reply")
    ;(client as unknown as { sendInvocationMessage: () => Promise<void> }).sendInvocationMessage = async () => {
      throw new ThreaApiError("Invocation claim not found", 404, "NOT_FOUND")
    }

    await session.sendInterim("binv_term_reply", "Late note.")

    expect(await session.reply("binv_term_reply", "Done.")).toEqual({ ok: true, message: "sent" })
  })

  test.each([408, 425, 429, 502])("retryable response %i keeps the reserved id", async (status) => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    await closed(session, `binv_retry_${status}`)
    const attempts: Array<Record<string, unknown>> = []
    let failNext = true
    ;(
      client as unknown as { sendInvocationMessage: (i: string, b: Record<string, unknown>) => Promise<void> }
    ).sendInvocationMessage = async (id, body) => {
      attempts.push(body)
      if (failNext) {
        failNext = false
        throw new ThreaApiError("Retry later", status)
      }
      calls.invocationMessage.push({ id, body })
    }

    const invocationId = `binv_retry_${status}`
    const refused = await session.sendInterim(invocationId, "Late note.")
    const retried = await session.sendInterim(invocationId, "Late note.")

    expect(refused).toMatchObject({ ok: false, retryable: true })
    expect(retried.ok).toBe(true)
    expect(attempts.map((body) => body.clientMessageId)).toEqual([
      `remote-send-${invocationId}-1`,
      `remote-send-${invocationId}-1`,
    ])
  })
})

describe("RemoteSession terminal route writes", () => {
  test("should fully settle route state and presence after a terminal open-send error", async () => {
    const { client } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_open_terminal" }))
    const internals = session as unknown as {
      inflight: Map<
        string,
        {
          state: string
          deadline?: ReturnType<typeof setTimeout>
          closing?: Promise<unknown>
          pending: Map<number, unknown>
          prepared?: unknown
          invocation: ClaimedInvocation
        }
      >
      terminalReplies: Map<string, unknown>
      activeTurnStream?: string
    }
    const route = internals.inflight.get("binv_open_terminal")!
    clearTimeout(route.deadline)
    let timerFired = false
    route.deadline = setTimeout(() => {
      timerFired = true
    }, 5)
    route.closing = Promise.resolve()
    route.prepared = { stale: true }
    internals.activeTurnStream = "stream_root"
    let attempts = 0
    ;(client as unknown as { sendInvocationMessage: () => Promise<void> }).sendInvocationMessage = async () => {
      attempts += 1
      throw new ThreaApiError("Forbidden", 403, "FORBIDDEN")
    }

    const refused = await session.sendInterim("binv_open_terminal", "Progress.")
    const again = await session.sendInterim("binv_open_terminal", "Progress.")
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(refused).toMatchObject({ ok: false, retryable: false })
    expect(again).toMatchObject({ ok: false, retryable: false })
    expect(attempts).toBe(1)
    expect(internals.inflight.has("binv_open_terminal")).toBe(false)
    expect(internals.terminalReplies.has("binv_open_terminal")).toBe(true)
    expect(route).toMatchObject({
      state: "closed",
      deadline: undefined,
      closing: undefined,
      prepared: undefined,
    })
    expect(route.pending.size).toBe(0)
    expect(route.invocation.claimToken).toBe("")
    expect(internals.activeTurnStream).toBeUndefined()
    expect(timerFired).toBe(false)
    expect(presence.at(-1)?.status).toBe("available")
  })

  test("should leave a newer turn owning the same stream when an older route is terminally evicted", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_old_owner", responseStreamId: "stream_turn" }))
    await session.reply("binv_old_owner", "Done.")
    await (
      session as unknown as { deliverTurn: (invocation: ClaimedInvocation, content: string) => Promise<void> }
    ).deliverTurn(makeInvocation({ id: "binv_new_owner", responseStreamId: "stream_turn" }), "New turn")
    ;(
      client as unknown as { sendInvocationMessage: (id: string, body: Record<string, unknown>) => Promise<void> }
    ).sendInvocationMessage = async (id, body) => {
      if (id === "binv_old_owner") throw new ThreaApiError("Invocation claim not found", 404, "NOT_FOUND")
      calls.invocationMessage.push({ id, body })
    }

    const refused = await session.sendInterim("binv_old_owner", "Late note.")
    await session.postToStream("stream_turn", { content: "Approve the new turn?" })

    expect({
      refused,
      activeTurnStreamId: session.activeTurnStreamId,
      posts: calls.invocationMessage.map((call) => ({ id: call.id, content: call.body.content })),
    }).toEqual({
      refused: {
        ok: false,
        retryable: false,
        message: "Threa rejected the message for request binv_old_owner: Invocation claim not found.",
      },
      activeTurnStreamId: "stream_turn",
      posts: [{ id: "binv_new_owner", content: "Approve the new turn?" }],
    })
    await session.shutdown()
  })

  test("a terminal final-completion error evicts the route and returns non-retryable", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_final_terminal" }))
    const internals = session as unknown as {
      inflight: Map<string, { invocation: ClaimedInvocation }>
      terminalReplies: Map<string, unknown>
    }
    const route = internals.inflight.get("binv_final_terminal")!
    let attempts = 0
    ;(client as unknown as { complete: () => Promise<void> }).complete = async () => {
      attempts += 1
      throw new ThreaApiError("Session is not running", 409, "SESSION_NOT_RUNNING")
    }

    const refused = await session.reply("binv_final_terminal", "Done.")
    const again = await session.reply("binv_final_terminal", "Done.")

    expect(refused).toMatchObject({ ok: false, retryable: false })
    expect(again).toMatchObject({ ok: false, retryable: false })
    expect(attempts).toBe(1)
    expect(internals.inflight.has("binv_final_terminal")).toBe(false)
    expect(internals.terminalReplies.has("binv_final_terminal")).toBe(true)
    expect(route.invocation.claimToken).toBe("")
  })

  test.each([408, 425, 429, 503])("completion status %i retains the prepared final for retry", async (status) => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    const invocationId = `binv_final_retry_${status}`
    seedInflight(session, makeInvocation({ id: invocationId }))
    const attempts: Array<Record<string, unknown>> = []
    let failNext = true
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        attempts.push(body)
        if (failNext) {
          failNext = false
          throw new ThreaApiError("Retry later", status)
        }
        calls.complete.push({ id, body })
      }

    expect(await session.reply(invocationId, "Done.")).toMatchObject({ ok: false, retryable: true })
    expect(await session.reply(invocationId, "Done.")).toEqual({
      ok: true,
      message: "sent",
      closedTurn: true,
    })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
  })

  test("a terminal permission-route error evicts the route and never falls back", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_permission_terminal", responseStreamId: "stream_turn" }))
    let attempts = 0
    ;(client as unknown as { sendInvocationMessage: () => Promise<void> }).sendInvocationMessage = async () => {
      attempts += 1
      throw new ThreaApiError("Invocation claim not found", 404, "NOT_FOUND")
    }
    const body = { content: "Approve?", clientMessageId: "ccperm-abcde" }

    await expect(session.postToInvocation("binv_permission_terminal", body)).rejects.toThrow()
    await expect(session.postToInvocation("binv_permission_terminal", body)).rejects.toThrow()

    expect(attempts).toBe(1)
    expect(calls.sendMessage).toEqual([])
  })
})

describe("RemoteSession permission route posts", () => {
  const PROMPT = { content: "**Claude Code wants to run `Bash`**", clientMessageId: "ccperm-krjtt" }

  test("posts a late plaintext permission prompt through the completed invocation", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_perm_late", responseStreamId: "stream_turn" }))
    await session.reply("binv_perm_late", "Done.")

    await session.postToInvocation("binv_perm_late", {
      ...PROMPT,
      metadata: { "cc.channel.permissionRequest": "krjtt" },
    })

    expect(calls.sendMessage).toEqual([])
    expect(calls.invocationMessage).toEqual([
      {
        id: "binv_perm_late",
        body: {
          instanceId: "rt-test",
          claimToken: "tok",
          content: PROMPT.content,
          clientMessageId: "ccperm-krjtt",
          metadata: { "remote.invocationId": "binv_perm_late", "cc.channel.permissionRequest": "krjtt" },
        },
      },
    ])
  })

  test("falls back to the generic stream send when no turn of ours owns the stream", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    seedInflight(session, makeInvocation({ id: "binv_elsewhere", responseStreamId: "stream_turn" }))

    await session.postToStream("stream_root", PROMPT)

    expect(calls.invocationMessage).toEqual([])
    expect(calls.sendMessage).toEqual([{ streamId: "stream_root", body: PROMPT }])
  })
})

describe("RemoteSession status snapshot", () => {
  test("reports link, socket, and active-turn state without mutation", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)

    expect(session.statusSnapshot).toEqual({
      stopped: false,
      linkGeneration: 0,
      linkState: "unlinked",
      rootStreamId: undefined,
      activeStreamId: undefined,
      socketConnected: false,
      inflightCount: 0,
      activeTurnStreamId: undefined,
    })

    seedInflight(session, makeInvocation({ id: "binv_status" }))
    expect(session.statusSnapshot.inflightCount).toBe(1)
    await session.shutdown()
    expect(session.statusSnapshot.stopped).toBe(true)
  })
})

describe("RemoteSession presence ordering", () => {
  function gateFirstPresence(transport: BotRuntimeTransport) {
    const started = gate()
    const release = gate()
    const settled: string[] = []
    let writes = 0
    ;(transport as unknown as { updatePresence: (body: Record<string, unknown>) => Promise<void> }).updatePresence =
      async (body) => {
        writes += 1
        if (writes === 1) {
          started.open()
          await release.promise
        }
        settled.push(String(body.status))
      }
    return { started: started.promise, release: release.open, settled }
  }

  test("should serialize an in-flight available write before archive offline", async () => {
    const client = { fail: async () => {} } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const presence = gateFirstPresence(transport)
    const session = makeSession(client, transport)
    ;(session as any).link = { rootStreamId: "stream_root" }

    const available = (session as any).syncPresence()
    await presence.started
    const archived = (session as any).handleSessionArchived({
      runtimeSessionId: "rts-test",
      rootStreamId: "stream_root",
    })
    await tick()

    expect(presence.settled).toEqual([])
    presence.release()
    await Promise.all([available, archived])
    expect(presence.settled).toEqual(["available", "offline"])
    await session.shutdown()
  })

  test("should recompute rapid busy and available transitions when each queued write runs", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const presence = gateFirstPresence(transport)
    const session = makeSession(client, transport)
    ;(session as any).link = { rootStreamId: "stream_root" }

    const firstAvailable = (session as any).syncPresence()
    await presence.started
    seedInflight(session, makeInvocation({ id: "binv_presence" }))
    const staleBusy = (session as any).syncPresence()
    ;(session as any).clearInflight("binv_presence")
    const finalAvailable = (session as any).syncPresence()

    presence.release()
    await Promise.all([firstAvailable, staleBusy, finalAvailable])
    expect(presence.settled).toEqual(["available", "available", "available"])
    await session.shutdown()
  })

  for (const lifecycle of ["shutdown", "archive"] as const) {
    test(`should publish offline after an in-flight claim response during ${lifecycle}`, async () => {
      const claimStarted = gate()
      const releaseClaim = gate()
      const serverStatuses: string[] = []
      const client = {
        claim: async () => {
          claimStarted.open()
          await releaseClaim.promise
          serverStatuses.push("available")
          return null
        },
        fail: async () => {},
      } as unknown as ThreaClient
      const { transport } = makeFakeTransport()
      ;(transport as unknown as { updatePresence: (body: Record<string, unknown>) => Promise<void> }).updatePresence =
        async (body) => void serverStatuses.push(String(body.status))
      const session = makeSession(client, transport)
      ;(session as any).link = { rootStreamId: "stream_root" }

      const draining = (session as any).claimDrain() as Promise<boolean>
      await claimStarted.promise
      const teardown =
        lifecycle === "shutdown"
          ? session.shutdown()
          : ((session as any).handleSessionArchived({
              runtimeSessionId: "rts-test",
              rootStreamId: "stream_root",
            }) as Promise<void>)
      await tick()
      releaseClaim.open()
      await Promise.all([draining, teardown])

      expect(serverStatuses).toContain("available")
      expect(serverStatuses.at(-1)).toBe("offline")
      if (lifecycle === "archive") await session.shutdown()
    })
  }
})

describe("RemoteSession session-archived handling (grace window)", () => {
  function makeGraceSession(params: {
    client: ThreaClient
    transport: BotRuntimeTransport
    archiveGraceMs: number
    onArchived?: (payload: { rootStreamId: string }) => void
  }): RemoteSession {
    return new RemoteSession({
      config: makeConfig(),
      client: params.client,
      delegate: { deliverTurn: async () => {}, ...(params.onArchived ? { onArchived: params.onArchived } : {}) },
      runtime: RUNTIME,
      transport: params.transport,
      archiveGraceMs: params.archiveGraceMs,
    })
  }

  const asInternal = (session: RemoteSession) =>
    session as unknown as {
      handleSessionArchived: (p: unknown) => Promise<void>
      handleSessionRestored: (p: unknown) => Promise<void>
      claimDrain: () => Promise<boolean>
      nextPollDelay: (claimed: boolean) => number
      probeArchiveBackstop: () => Promise<void>
      link: { rootStreamId: string } | undefined
      archive: { detached: boolean }
    }

  test("detaches on archive: goes offline, fails in-flight turns, but does NOT wind down within the grace window", async () => {
    const failed: string[] = []
    const client = {
      fail: async (id: string) => {
        failed.push(id)
      },
    } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    const archived: Array<{ rootStreamId: string }> = []
    const session = makeGraceSession({
      client,
      transport,
      archiveGraceMs: 60_000,
      onArchived: (payload) => void archived.push(payload),
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))

    await asInternal(session).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })

    expect(presence.at(-1)?.status).toBe("offline")
    expect(failed).toEqual(["binv_running"])
    // The wind-down is deferred: an unarchive within the grace window reattaches instead.
    expect(archived).toEqual([])
    expect(asInternal(session).archive.detached).toBe(true)
    // Detached: no claims while the scratchpad is archived, and the poll probes at the reattach cadence.
    expect(await asInternal(session).claimDrain()).toBe(false)
    expect(asInternal(session).nextPollDelay(false)).toBe(15_000)
    await session.shutdown()
  })

  test("a missed restore push still reattaches via the poll probe inside the grace window", async () => {
    const created: unknown[] = []
    const client = {
      fail: async () => {},
      createSession: async (body: unknown) => {
        created.push(body)
        return {
          linkId: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_root",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_root",
        }
      },
      claim: async () => null,
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const archived: Array<{ rootStreamId: string }> = []
    const session = makeGraceSession({
      client,
      transport,
      archiveGraceMs: 400,
      onArchived: (payload) => void archived.push(payload),
    })

    // No bot:session_restored ever arrives; the probe (grace/4 = 100ms) must
    // find the server-side revived link before the grace (400ms) expires.
    await asInternal(session).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(created.length).toBeGreaterThanOrEqual(1)
    // The probe WAITS on the archived scratchpad (grace-window reattach) — it
    // must never ask the server to replace it with a fresh one.
    expect((created[0] as Record<string, unknown>).ifArchived).toBe("wait")
    expect(asInternal(session).archive.detached).toBe(false)
    expect(asInternal(session).link).toMatchObject({ rootStreamId: "stream_root" })
    expect(archived).toEqual([])
    await session.shutdown()
  })

  /** Links the session to `stream_root` the way start() does, so the backstop has something to probe. */
  async function withLink(session: RemoteSession): Promise<void> {
    await (session as unknown as { ensureLink: () => Promise<void> }).ensureLink()
  }

  const linkingClient = (overrides: Record<string, unknown>) =>
    ({
      fail: async () => {},
      claim: async () => null,
      createSession: async () => ({
        linkId: "brsl_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_root",
        runtimeSessionId: "rts-test",
        streamUrlPath: "/w/ws_1/s/stream_root",
      }),
      ...overrides,
    }) as unknown as ThreaClient

  test("an archive with no push is caught by the backstop probe and winds down through the same grace window", async () => {
    let links = 0
    const client = linkingClient({
      getStreamArchivedAt: async () => "2026-07-20T10:00:00.000Z",
      // The initial link, then the reattach probes the detach schedules — which
      // keep failing because the scratchpad is still archived.
      createSession: async () => {
        if (links++ > 0) throw new ThreaApiError("scratchpad is archived", 409, "SCRATCHPAD_ARCHIVED")
        return {
          linkId: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_root",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_root",
        }
      },
    })
    const { transport, presence } = makeFakeTransport()
    const archived: Array<{ rootStreamId: string }> = []
    const session = makeGraceSession({
      client,
      transport,
      archiveGraceMs: 300,
      onArchived: (payload) => void archived.push(payload),
    })
    await withLink(session)

    // bot:session_archived never arrived — only the probe knows.
    await asInternal(session).probeArchiveBackstop()

    expect(asInternal(session).archive.detached).toBe(true)
    expect(presence.at(-1)?.status).toBe("offline")
    // Still archived when the grace expires (the reattach probe re-links, but
    // handleSessionRestored never fires), so the connector wind-down runs.
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(archived).toEqual([{ rootStreamId: "stream_root" }])
    await session.shutdown()
  })

  test("the backstop leaves a live scratchpad linked, and a probe failure is never treated as an archive", async () => {
    for (const getStreamArchivedAt of [
      async () => null,
      async () => {
        throw new ThreaApiError("threa unreachable", 503)
      },
    ]) {
      const { transport } = makeFakeTransport()
      const archived: Array<{ rootStreamId: string }> = []
      const session = makeGraceSession({
        client: linkingClient({ getStreamArchivedAt }),
        transport,
        archiveGraceMs: 60_000,
        onArchived: (payload) => void archived.push(payload),
      })
      await withLink(session)

      await asInternal(session).probeArchiveBackstop()

      expect(asInternal(session).archive.detached).toBe(false)
      expect(asInternal(session).link).toMatchObject({ rootStreamId: "stream_root" })
      expect(archived).toEqual([])
      await session.shutdown()
    }
  })

  test("a cold-start link asks the server to replace an archived scratchpad (ifArchived=replace)", async () => {
    const created: unknown[] = []
    const client = {
      createSession: async (body: unknown) => {
        created.push(body)
        return {
          linkId: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_root",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_root",
        }
      },
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)

    await (session as unknown as { ensureLink: () => Promise<void> }).ensureLink()

    // No archivePending at cold start: a deterministic identity pointing at a
    // scratchpad the user archived must mint a fresh one, not wedge on 409s.
    expect(created).toHaveLength(1)
    expect((created[0] as Record<string, unknown>).ifArchived).toBe("replace")
    await session.shutdown()
  })

  test("hands the connector every link it establishes, before presence is synced", async () => {
    const link = {
      linkId: "brsl_1",
      rootStreamId: "stream_root",
      activeStreamId: "stream_root",
      runtimeSessionId: "rts-test",
      streamUrlPath: "/w/ws_1/s/stream_root",
    }
    const client = { createSession: async () => link } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    const seen: Array<{ link: unknown; presenceWrites: number }> = []
    const session = makeSession(client, transport, {
      onLinked: (received) => {
        seen.push({ link: received, presenceWrites: presence.length })
      },
    })

    await (session as unknown as { ensureLink: () => Promise<void> }).ensureLink()

    expect(seen).toEqual([{ link, presenceWrites: 0 }])
    expect(session.statusSnapshot.rootStreamId).toBe("stream_root")
    await session.shutdown()
  })

  test("a shutdown during onLinked leaves the link uncommitted and presence untouched", async () => {
    const link = {
      linkId: "brsl_1",
      rootStreamId: "stream_root",
      activeStreamId: "stream_root",
      runtimeSessionId: "rts-test",
      streamUrlPath: "/w/ws_1/s/stream_root",
    }
    const client = { createSession: async () => link } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    let session!: RemoteSession
    session = makeSession(client, transport, {
      onLinked: async () => {
        await session.shutdown()
      },
    })

    await (session as unknown as { ensureLink: () => Promise<void> }).ensureLink()

    expect(session.statusSnapshot.linkState).toBe("unlinked")
    expect(presence.map((p) => p.status)).toEqual(["offline"])
  })

  test("a supervised cold start can wait instead of replacing an archived scratchpad", async () => {
    const created: unknown[] = []
    const client = {
      createSession: async (body: unknown) => {
        created.push(body)
        return {
          linkId: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_root",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_root",
        }
      },
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const session = new RemoteSession({
      config: makeConfig({ coldStartIfArchived: "wait", coldStartIfMissing: "error" }),
      client,
      delegate: { deliverTurn: async () => {} },
      runtime: RUNTIME,
      transport,
    })

    await (session as unknown as { ensureLink: () => Promise<void> }).ensureLink()

    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ ifArchived: "wait", ifMissing: "error" })
    await session.shutdown()
  })

  test("a supervised cold start rejects a link to another root stream without allowing creation", async () => {
    let request: Record<string, unknown> | undefined
    const client = {
      createSession: async (body: Record<string, unknown>) => {
        request = body
        return {
          linkId: "brsl_other",
          rootStreamId: "stream_other",
          activeStreamId: "stream_other",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_other",
        }
      },
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const session = new RemoteSession({
      config: makeConfig({ expectedRootStreamId: "stream_expected" }),
      client,
      delegate: { deliverTurn: async () => {} },
      runtime: RUNTIME,
      transport,
    })

    await expect((session as unknown as { ensureLink: () => Promise<void> }).ensureLink()).resolves.toBeUndefined()
    expect(request).toMatchObject({ ifMissing: "error" })
    expect((session as unknown as { link?: unknown }).link).toBeUndefined()
    await session.shutdown()
  })

  test("a link response that raced the archive push is dropped — it must not cancel the wind-down", async () => {
    let resolveCreate: ((link: unknown) => void) | undefined
    const client = {
      fail: async () => {},
      createSession: () => new Promise((resolve) => (resolveCreate = resolve)),
      claim: async () => null,
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const session = makeGraceSession({ client, transport, archiveGraceMs: 60_000 })

    // A pre-archive ensureLink is in flight when the archive push lands; its
    // stale (pre-archive) link response resolves afterwards.
    const inflightLink = (session as unknown as { ensureLink: () => Promise<void> }).ensureLink()
    await asInternal(session).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })
    resolveCreate!({
      linkId: "brsl_stale",
      rootStreamId: "stream_root",
      activeStreamId: "stream_root",
      runtimeSessionId: "rts-test",
      streamUrlPath: "/w/ws_1/s/stream_root",
    })
    await inflightLink

    expect(asInternal(session).link).toBeUndefined()
    expect(asInternal(session).archive.detached).toBe(true)
    await session.shutdown()
  })

  test("bot:session_restored within the grace cancels the wind-down and reattaches the same scratchpad", async () => {
    const created: unknown[] = []
    const client = {
      fail: async () => {},
      getMe: async () => ({ kind: "bot" }),
      createSession: async (body: unknown) => {
        created.push(body)
        return {
          linkId: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_root",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_root",
        }
      },
      claim: async () => null,
    } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    const archived: Array<{ rootStreamId: string }> = []
    const session = makeGraceSession({
      client,
      transport,
      archiveGraceMs: 60_000,
      onArchived: (payload) => void archived.push(payload),
    })

    await asInternal(session).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })
    await asInternal(session).handleSessionRestored({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })

    // Reattached: session-create re-issued (the server revives the same link),
    // presence back to available, wind-down cancelled, claims live again.
    expect(created).toHaveLength(1)
    expect(asInternal(session).archive.detached).toBe(false)
    expect(asInternal(session).link).toMatchObject({ rootStreamId: "stream_root" })
    expect(session.statusSnapshot.linkGeneration).toBe(2)
    expect(presence.map((entry) => entry.status)).toEqual(["offline", "available"])
    expect(archived).toEqual([])
    await session.shutdown()
  })

  test("a restore whose re-link fails transiently keeps the detached state so the probe cadence survives", async () => {
    let attempts = 0
    const client = {
      fail: async () => {},
      createSession: async () => {
        attempts += 1
        throw new Error("threa unreachable")
      },
      claim: async () => null,
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const session = makeGraceSession({ client, transport, archiveGraceMs: 60_000 })

    await asInternal(session).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })
    await asInternal(session).handleSessionRestored({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })

    expect(attempts).toBe(1)
    // Still detached-pending: probe cadence + claim suppression survive the
    // transient failure instead of dropping to the 15-min backstop unlinked.
    expect(asInternal(session).link).toBeUndefined()
    expect(asInternal(session).archive.detached).toBe(true)
    expect(asInternal(session).nextPollDelay(false)).toBe(15_000)
    await session.shutdown()
  })

  test("writes offline after an already-fired reconnect fallback", async () => {
    const client = { fail: async () => {} } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    let releasePresence!: () => void
    const blocked = new Promise<void>((resolve) => (releasePresence = resolve))
    ;(transport as unknown as { updatePresence: (body: Record<string, unknown>) => Promise<void> }).updatePresence =
      async (body) => {
        presence.push(body)
        if (body.status === "available") await blocked
      }
    const session = makeGraceSession({ client, transport, archiveGraceMs: 60_000 })
    ;(session as any).link = { rootStreamId: "stream_root" }
    ;(session as any).reconnectHandoff = true
    ;(session as any).resetReconnectHandoff()
    await Bun.sleep(0)

    const archived = asInternal(session).handleSessionArchived({
      runtimeSessionId: "rts-test",
      rootStreamId: "stream_root",
    })
    await Bun.sleep(0)
    expect(presence.map((body) => body.status)).toEqual(["available"])
    releasePresence()
    await archived

    expect(presence.map((body) => body.status)).toEqual(["available", "offline"])
    await session.shutdown()
  })

  test("should suppress queued archive offline when restore relinks first", async () => {
    const linked = gate()
    const client = {
      fail: async () => {},
      createSession: async () => {
        linked.open()
        return {
          linkId: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_root",
          runtimeSessionId: "rts-test",
          streamUrlPath: "/w/ws_1/s/stream_root",
        }
      },
      claim: async () => null,
    } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const blocked = gate()
    const settled: string[] = []
    let writes = 0
    ;(transport as unknown as { updatePresence: (body: Record<string, unknown>) => Promise<void> }).updatePresence =
      async (body) => {
        writes += 1
        if (writes === 1) await blocked.promise
        settled.push(String(body.status))
      }
    const session = makeGraceSession({ client, transport, archiveGraceMs: 60_000 })
    ;(session as any).link = { rootStreamId: "stream_root" }

    const staleAvailable = (session as any).syncPresence()
    await tick()
    const archived = asInternal(session).handleSessionArchived({
      runtimeSessionId: "rts-test",
      rootStreamId: "stream_root",
    })
    await tick()
    const restored = asInternal(session).handleSessionRestored({ runtimeSessionId: "rts-test" })
    await linked.promise
    await tick()

    blocked.open()
    await Promise.all([staleAvailable, archived, restored])
    expect(settled).toEqual(["available", "available"])
    expect(asInternal(session).archive.detached).toBe(false)
    await session.shutdown()
  })

  test("winds down (onArchived) when the grace expires without a restore", async () => {
    const client = { fail: async () => {} } as unknown as ThreaClient
    const { transport, presence } = makeFakeTransport()
    const archived: Array<{ rootStreamId: string }> = []
    const session = makeGraceSession({
      client,
      transport,
      archiveGraceMs: 10,
      onArchived: (payload) => void archived.push(payload),
    })

    await asInternal(session).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(archived).toEqual([{ rootStreamId: "stream_root" }])
    expect(presence.at(-1)?.status).toBe("offline")
  })

  test("ignores archive and restore events for a different runtime session (stale re-registration)", async () => {
    const { client } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const archived: unknown[] = []
    const session = makeSession(client, transport, { onArchived: (payload) => void archived.push(payload) })

    await asInternal(session).handleSessionArchived({
      runtimeSessionId: "rts-someone-else",
      rootStreamId: "stream_root",
    })
    await asInternal(session).handleSessionRestored({
      runtimeSessionId: "rts-someone-else",
      rootStreamId: "stream_root",
    })

    expect(archived).toEqual([])
    expect(presence).toEqual([])
    expect(asInternal(session).archive.detached).toBe(false)
  })
})

describe("RemoteSession.shutdown", () => {
  test("writes offline after an already-fired reconnect fallback", async () => {
    const { client } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    let releasePresence!: () => void
    const blocked = new Promise<void>((resolve) => (releasePresence = resolve))
    ;(transport as unknown as { updatePresence: (body: Record<string, unknown>) => Promise<void> }).updatePresence =
      async (body) => {
        presence.push(body)
        if (body.status === "available") await blocked
      }
    const session = makeSession(client, transport)
    ;(session as any).link = { rootStreamId: "stream_root" }
    ;(session as any).reconnectHandoff = true
    ;(session as any).resetReconnectHandoff()
    await Bun.sleep(0)

    const shutdown = session.shutdown()
    await Bun.sleep(0)
    expect(presence.map((body) => body.status)).toEqual(["available"])
    releasePresence()
    await shutdown

    expect(presence.map((body) => body.status)).toEqual(["available", "offline"])
  })

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
    ;(session as any).inflight
      .get("binv_a")
      .contributors.push(makeInvocation({ id: "binv_a_dependency", claimToken: "tok_a_dependency" }))

    await session.shutdown()

    expect(presence.at(-1)?.status).toBe("offline")
    expect(failed.map((entry) => entry.id).sort()).toEqual(["binv_a", "binv_a_dependency", "binv_b"])
    expect(failed.find((entry) => entry.id === "binv_a")?.body).toMatchObject({
      claimToken: "tok_a",
      errorMessage: "Test runtime shut down",
    })
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.size).toBe(0)
  })
})

describe("session control via the actuator", () => {
  test("keeps reconnect handoff through the complete local replacement bound", () => {
    expect(RECONNECT_HANDOFF_FALLBACK_MS).toBe(30_000)
  })

  test("routes an advertised command to runCommand and acks with its message", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const ran: Array<{ name: string; args: string; rootStreamId: string }> = []
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer", "model"],
        interrupt: () => true,
        runCommand: async (name, args, context) => {
          ran.push({ name, args, rootStreamId: context.rootStreamId })
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

    expect(ran).toEqual([{ name: "model", args: "opus", rootStreamId: "stream_root" }])
    expect(calls.complete[0]?.body).toMatchObject({
      finalMessageMarkdown: "Set model to `opus`.",
      metadata: {
        "remote.invocationId": "binv_cmd",
        "remote.sessionControl": "true",
      },
    })
  })

  test("closes a command that returns no message without posting one", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer", "spawn"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true }),
      },
    })
    const invocation = makeInvocation({
      id: "binv_spawn",
      trigger: "session-control",
      promptMarkdown: "/spawn claude parser",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_2", name: "spawn", args: "claude parser" } },
    })

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(invocation)

    expect(calls.complete[0]?.body).toEqual({
      instanceId: "rt-test",
      claimToken: invocation.claimToken,
      sourceRevision: invocation.sourceRevision,
      noResponse: true,
      metadata: {
        "remote.invocationId": "binv_spawn",
        "remote.sessionControl": "true",
      },
    })
  })

  test("refreshes hello with the current nonaccepting handoff state", () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    ;(session as any).link = { rootStreamId: "stream_root" }
    ;(session as any).reconnectHandoff = true
    ;(session as any).refreshHelloCapabilities()
    expect((session as any).hello).toMatchObject({ status: "busy", acceptingInvocations: false })
  })

  test("refreshes reconnect hello as offline while unlinked or stopped", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const unlinked = makeSession(client, transport)
    ;(unlinked as any).refreshHelloCapabilities()
    expect((unlinked as any).hello).toMatchObject({ status: "offline", acceptingInvocations: false })

    await unlinked.shutdown()
    ;(unlinked as any).refreshHelloCapabilities()
    expect((unlinked as any).hello).toMatchObject({ status: "offline", acceptingInvocations: false })
  })

  test("refreshes reconnect hello as offline while detached", async () => {
    const client = { fail: async () => {} } as unknown as ThreaClient
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport)
    ;(session as any).link = { rootStreamId: "stream_root" }

    await (session as any).handleSessionArchived({
      runtimeSessionId: "rts-test",
      rootStreamId: "stream_root",
    })
    ;(session as any).refreshHelloCapabilities()

    expect((session as any).hello).toMatchObject({ status: "offline", acceptingInvocations: false })
    await session.shutdown()
  })

  test("handoff fallback restores presence and drains only while linked and running", async () => {
    const { client } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const session = makeSession(client, transport)
    let drains = 0
    ;(session as any).link = { rootStreamId: "stream_root" }
    ;(session as any).reconnectHandoff = true
    ;(session as any).claimDrain = async () => {
      drains++
    }
    ;(session as any).resetReconnectHandoff()
    await Bun.sleep(0)
    expect({ presence: presence.at(-1), drains }).toMatchObject({
      presence: { status: "available", acceptingInvocations: true },
      drains: 1,
    })
    ;(session as any).stopped = true
    ;(session as any).reconnectHandoff = true
    ;(session as any).resetReconnectHandoff()
    await Bun.sleep(0)
    expect({ writes: presence.length, drains }).toEqual({ writes: 1, drains: 1 })
  })

  test("runs a post-ack action only after acknowledgement completes", async () => {
    const { client } = makeFakeClient()
    const { transport, presence } = makeFakeTransport()
    const order: string[] = []
    const complete = (client as unknown as { complete: (...args: unknown[]) => Promise<void> }).complete
    ;(client as unknown as { complete: (...args: unknown[]) => Promise<void> }).complete = async (...args) => {
      await complete(...args)
      order.push("ack")
    }
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["reconnect"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "accepted", afterAck: () => order.push("start") }),
      },
    })
    ;(session as any).link = { rootStreamId: "stream_root" }

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(
      makeInvocation({
        trigger: "session-control",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd", name: "reconnect", args: "" } },
      })
    )
    expect(order).toEqual(["ack", "start"])
    expect(presence.at(-1)).toMatchObject({ status: "busy", acceptingInvocations: false })
  })

  for (const lifecycle of ["shutdown", "archive"] as const) {
    test(`does not run a post-ack action when ack resolves after ${lifecycle}`, async () => {
      const { client } = makeFakeClient()
      let releaseAck!: () => void
      const ackBlocked = new Promise<void>((resolve) => (releaseAck = resolve))
      ;(client as unknown as { complete: () => Promise<void> }).complete = () => ackBlocked
      const { transport } = makeFakeTransport()
      let started = false
      const session = makeSession(client, transport, {
        sessionControl: {
          commands: ["reconnect"],
          interrupt: () => true,
          runCommand: async () => ({ ok: true, message: "accepted", afterAck: () => (started = true) }),
        },
      })
      ;(session as any).link = { rootStreamId: "stream_root" }
      const handling = (session as any).handleSessionControl(
        makeInvocation({
          trigger: "session-control",
          metadata: { command: { executionKind: "bot-runtime", id: "cmd", name: "reconnect", args: "" } },
        })
      )
      await Bun.sleep(0)

      if (lifecycle === "shutdown") await session.shutdown()
      else {
        await (session as any).handleSessionArchived({ runtimeSessionId: "rts-test", rootStreamId: "stream_root" })
      }
      releaseAck()
      await handling

      expect(started).toBe(false)
      if (lifecycle === "archive") await session.shutdown()
    })
  }

  test("runs the handoff reset once before restoring intake after a post-ack failure", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const order: string[] = []
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["reconnect"],
        interrupt: () => true,
        runCommand: async () => ({
          ok: true,
          message: "accepted",
          afterAck: () => {
            order.push("post-ack")
            throw new Error("launch failed")
          },
          onHandoffReset: () => order.push("reset"),
        }),
      },
    })
    ;(session as any).link = { rootStreamId: "stream_root" }
    ;(session as any).syncPresence = async () => order.push("presence")
    ;(session as any).claimDrain = async () => order.push("drain")

    await (session as any).handleSessionControl(
      makeInvocation({
        trigger: "session-control",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd", name: "reconnect", args: "" } },
      })
    )
    ;(session as any).resetReconnectHandoff()
    await Bun.sleep(0)

    expect(order).toEqual(["presence", "post-ack", "reset", "presence", "drain"])
  })

  test("logs a post-ack action error after preserving the successful acknowledgement", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const logs: string[] = []
    const session = new RemoteSession({
      config: makeConfig(),
      client,
      delegate: {
        deliverTurn: async () => {},
        sessionControl: {
          commands: ["reconnect"],
          interrupt: () => true,
          runCommand: async () => ({
            ok: true,
            message: "accepted",
            afterAck: () => {
              throw new Error("detached launch failed")
            },
          }),
        },
      },
      runtime: RUNTIME,
      transport,
      log: (message) => logs.push(message),
    })
    ;(session as any).link = { rootStreamId: "stream_root" }

    await (session as any).handleSessionControl(
      makeInvocation({
        trigger: "session-control",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd", name: "reconnect", args: "" } },
      })
    )
    expect({ completed: calls.complete.length, logs }).toEqual({
      completed: 1,
      logs: ["session-control post-ack action failed: detached launch failed"],
    })
  })

  test("does not run a post-ack action when sealed key-race fallback only closes silently", async () => {
    const { client, calls } = makeFakeClient()
    ;(client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }).complete =
      async (id, body) => {
        if (body.finalMessageMarkdown) {
          throw new ThreaApiError("plaintext rejected", 400, "E2E_STREAM_PLAINTEXT_UNSUPPORTED")
        }
        calls.complete.push({ id, body })
      }
    const { transport } = makeFakeTransport()
    let started = false
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["reconnect"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "accepted", afterAck: () => (started = true) }),
      },
    })
    ;(session as any).link = { rootStreamId: "stream_root" }
    ;(session as any).sealSessionControlAck = async () => undefined

    await (session as any).handleSessionControl(
      makeInvocation({
        trigger: "session-control",
        sealedAck: { keyWraps: [] },
        metadata: { command: { executionKind: "bot-runtime", id: "cmd", name: "reconnect", args: "" } },
      })
    )

    expect({ started, silentCloses: calls.complete.filter((call) => call.body.noResponse).length }).toEqual({
      started: false,
      silentCloses: 1,
    })
  })

  test("does not run a post-ack action when acknowledgement fails", async () => {
    const { client } = makeFakeClient()
    ;(client as unknown as { complete: () => Promise<void> }).complete = async () => {
      throw new Error("ack failed")
    }
    const { transport, presence } = makeFakeTransport()
    let started = false
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["reconnect"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "accepted", afterAck: () => (started = true) }),
      },
    })

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(
      makeInvocation({
        trigger: "session-control",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd", name: "reconnect", args: "" } },
      })
    )
    expect(started).toBe(false)
    expect(presence.at(-1)).toMatchObject({ status: "busy", acceptingInvocations: false })
  })

  test("preserves command metadata on a sealed acknowledgement", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["model"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "model changed" }),
      },
    })
    ;(session as any).sealSessionControlAck = async () => ({
      messageId: "msg_ack",
      ciphertext: "ciphertext",
      envelope: {},
    })
    const command = { executionKind: "bot-runtime", id: "cmd_sealed", name: "model", args: "opus" }
    await (session as any).handleSessionControl(
      makeInvocation({ id: "binv_sealed_ack", trigger: "session-control", sealedAck: {}, metadata: { command } })
    )

    expect(calls.complete[0]?.body).toMatchObject({
      sealedReply: { messageId: "msg_ack" },
      metadata: {
        "remote.invocationId": "binv_sealed_ack",
        "remote.sessionControl": "true",
      },
    })
  })

  test("treats a stale acknowledgement as terminal without falling through to fail", async () => {
    const { client, calls } = makeFakeClient()
    ;(client as unknown as { complete: () => Promise<void> }).complete = async () => {
      throw new ThreaApiError("stale", 409, "INVOCATION_INPUT_STALE")
    }
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["model"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "model changed" }),
      },
    })

    await (session as any).handleSessionControl(
      makeInvocation({
        id: "binv_stale_ack",
        trigger: "session-control",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd_stale", name: "model", args: "opus" } },
      })
    )

    expect(calls.fail).toEqual([])
  })

  test("cancellation while acknowledgement is awaited aborts the stale write and post-ack action", async () => {
    const command = makeInvocation({
      id: "binv_cancel_ack",
      trigger: "session-control",
      requiredCapability: "session-control",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_cancel", name: "reload", args: "" } },
    })
    const { session, client, fake, calls } = makeObservedControlSession([command], {
      sessionControl: {
        commands: ["reload"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "accepted", afterAck: () => actions.push("after") }),
      },
    })
    const actions: string[] = []
    let ackStarted = false
    ;(
      client as unknown as {
        complete: (id: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<void>
      }
    ).complete = async (_id, _body, signal) => {
      ackStarted = true
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    }
    const draining = (session as any).claimDrain()
    await waitUntil(() => ackStarted)
    await fake.observations.get("binv_cancel_ack")!.cancel()
    await draining

    expect({ actions, complete: calls.complete, fail: calls.fail }).toEqual({ actions: [], complete: [], fail: [] })
    await session.shutdown()
  })

  test("a restart while the actuator is awaited suppresses acknowledgement and post-ack work", async () => {
    const command = makeInvocation({
      id: "binv_restart_command",
      trigger: "session-control",
      requiredCapability: "session-control",
      sourceRevision: 1,
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_restart", name: "reload", args: "" } },
    })
    let actuatorStarted = false
    let releaseActuator!: () => void
    const actions: string[] = []
    const { session, fake, calls } = makeObservedControlSession([command], {
      sessionControl: {
        commands: ["reload"],
        interrupt: () => true,
        runCommand: async () => {
          actuatorStarted = true
          await new Promise<void>((resolve) => {
            releaseActuator = resolve
          })
          return { ok: true, message: "accepted", afterAck: () => actions.push("after") }
        },
      },
    })
    const draining = (session as any).claimDrain()
    await waitUntil(() => actuatorStarted)
    expect(
      await fake.observations.get("binv_restart_command")!.update(plaintextUpdate({ promptMarkdown: "/reload" }))
    ).toBe("restart-required")
    releaseActuator()
    await draining

    expect({ actions, complete: calls.complete, fail: calls.fail }).toEqual({ actions: [], complete: [], fail: [] })
    await session.shutdown()
  })

  test("a failed /key actuator calls /fail and never /complete", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["key"],
        interrupt: () => true,
        runCommand: async () => {
          throw new Error("tmux pane inspection failed")
        },
      },
    })
    const invocation = makeInvocation({
      id: "binv_key",
      trigger: "session-control",
      promptMarkdown: "/key enter",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_key", name: "key", args: "enter" } },
    })

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(invocation)

    expect(calls.complete).toEqual([])
    expect(calls.fail).toEqual([
      {
        id: "binv_key",
        body: {
          instanceId: "rt-test",
          claimToken: "tok",
          errorMessage: "tmux pane inspection failed",
        },
      },
    ])
  })

  test("a failed actuator command fails the invocation instead of completing it", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["kick"],
        interrupt: () => true,
        runCommand: async () => {
          throw new Error("harnessd could not find the runtime")
        },
      },
    })
    const invocation = makeInvocation({
      id: "binv_kick",
      trigger: "session-control",
      promptMarkdown: "/kick",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_kick", name: "kick", args: "" } },
    })

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(invocation)

    expect(calls.complete).toEqual([])
    expect(calls.fail).toEqual([
      {
        id: "binv_kick",
        body: {
          instanceId: "rt-test",
          claimToken: "tok",
          errorMessage: "harnessd could not find the runtime",
        },
      },
    ])
  })

  test("steer without native steer support interrupts and posts a supersede note carrying the steer text", async () => {
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

describe("steer into the running turn (native steer support)", () => {
  function makeSteerInvocation(args: string): ClaimedInvocation {
    return makeInvocation({
      id: "binv_steer",
      trigger: "session-control",
      promptMarkdown: args ? `/steer ${args}` : "/steer",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_2", name: "steer", args } },
    })
  }

  test("folds into the running turn: steer step on its trace, no interrupt, command closes immediately", async () => {
    const { client, calls } = makeFakeClient()
    const { transport, steps } = makeFakeTransport()
    const steered: string[] = []
    let interrupted = false
    const session = makeSession(client, transport, {
      deliverTurn: async () => {
        throw new Error("steer must not deliver a new turn")
      },
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => {
          interrupted = true
          return true
        },
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running", responseStreamId: "stream_turn" }))
    ;(client as unknown as { claim: () => Promise<null> }).claim = async () => null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation("look at the tests instead"))

    expect(interrupted).toBe(false)
    expect(steered).toEqual(["look at the tests instead"])
    // The running turn keeps its claim — it will answer the steer with its own reply.
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.has("binv_running")).toBe(true)
    expect(calls.complete.find((entry) => entry.id === "binv_running")).toBeUndefined()
    // The steer is recorded on the RUNNING invocation's trace.
    expect(steps).toEqual([
      { invocationId: "binv_running", frames: [{ stepType: "steer", content: "look at the tests instead" }] },
    ])
    // The /steer command itself closes right away, silently (the step is the signal).
    const steerClose = calls.complete.find((entry) => entry.id === "binv_steer")
    expect(steerClose?.body.noResponse).toBe(true)
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_running")
  })

  test("folds queued messages into the injected steer and closes them no-response", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const queued = [
      makeInvocation({ id: "binv_q1", promptMarkdown: "also bump the deps" }),
      makeInvocation({ id: "binv_q2", promptMarkdown: "and update the docs" }),
    ]
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () =>
      queued.shift() ?? null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation("the steer text"))

    expect(steered).toHaveLength(1)
    const combined = steered[0]!
    expect(combined.indexOf("also bump the deps")).toBeLessThan(combined.indexOf("and update the docs"))
    expect(combined.indexOf("and update the docs")).toBeLessThan(combined.indexOf("the steer text"))
    expect(calls.complete.filter((entry) => entry.id === "binv_q1" || entry.id === "binv_q2")).toEqual([])
    expect(await session.reply("binv_running", "done")).toEqual({ ok: true, message: "sent", closedTurn: true })
    const sweptCloses = calls.complete.filter((entry) => entry.id === "binv_q1" || entry.id === "binv_q2")
    expect(sweptCloses).toHaveLength(2)
    for (const close of sweptCloses) expect(close.body.noResponse).toBe(true)
  })

  test("acks without steering when there is no text and nothing queued", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<null> }).claim = async () => null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation(""))

    expect(steered).toEqual([])
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.has("binv_running")).toBe(true)
    const ack = calls.complete.find((entry) => entry.id === "binv_steer")
    expect(ack?.body.finalMessageMarkdown).toContain("Nothing to steer with")
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_running")
  })

  test("an empty composite steer closes silently when its message is already running", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_message", sourceMessageId: "msg_composite" }))
    ;(client as unknown as { claim: () => Promise<null> }).claim = async () => null
    const composite = makeSteerInvocation("")
    composite.sourceMessageId = "msg_composite"
    composite.metadata = { ...composite.metadata, steeredMessage: true }

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(composite)

    expect(steered).toEqual([])
    const close = calls.complete.find((entry) => entry.id === "binv_steer")
    expect(close?.body.noResponse).toBe(true)
    expect(close?.body.finalMessageMarkdown).toBeUndefined()
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_message")
  })

  test("empty steer still closes a swept foldless control command instead of stranding its claim", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    // A queued non-steer control command (double-command race): swept, contributes
    // no foldable part, and must still be closed on the empty-parts return.
    const queued = [
      makeInvocation({
        id: "binv_q_model",
        trigger: "session-control",
        promptMarkdown: "/model opus",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd_q", name: "model", args: "opus" } },
      }),
    ]
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer", "model"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () =>
      queued.shift() ?? null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation(""))

    expect(steered).toEqual([])
    const sweptClose = calls.complete.find((entry) => entry.id === "binv_q_model")
    expect(sweptClose?.body.noResponse).toBe(true)
    const ack = calls.complete.find((entry) => entry.id === "binv_steer")
    expect(ack?.body.finalMessageMarkdown).toContain("Nothing to steer with")
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_running")
  })

  test("a swept message cancelled during the steer step closes the remaining foldless command instead of steering empty text", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const message = makeInvocation({ id: "binv_q_msg", promptMarkdown: "fold me" })
    const queued = [
      makeInvocation({
        id: "binv_q_model",
        trigger: "session-control",
        promptMarkdown: "/model opus",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd_q", name: "model", args: "opus" } },
      }),
      message,
    ]
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer", "model"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    // The only foldable part is cancelled while the steer step is being recorded,
    // after the sweep already filtered parts once.
    ;(transport as unknown as { recordSteps: () => Promise<void> }).recordSteps = async () => {
      ;(session as unknown as { cancelledInvocations: WeakSet<ClaimedInvocation> }).cancelledInvocations.add(message)
    }
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () =>
      queued.shift() ?? null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation(""))

    expect({
      steered,
      sweptClose: calls.complete.find((entry) => entry.id === "binv_q_model")?.body.noResponse,
      ack: calls.complete.find((entry) => entry.id === "binv_steer")?.body.finalMessageMarkdown,
    }).toEqual({ steered: [], sweptClose: true, ack: expect.stringContaining("Nothing to steer with") })
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_running")
  })

  test("a swept message the intercept consumes is routed, not folded into the steer text", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const intercepted: string[] = []
    const queued = [
      makeInvocation({ id: "binv_verdict", promptMarkdown: "yes abcde" }),
      makeInvocation({ id: "binv_q1", promptMarkdown: "also bump the deps" }),
    ]
    const session = makeSession(client, transport, {
      interceptClaimed: async (invocation) => {
        if (invocation.promptMarkdown !== "yes abcde") return false
        intercepted.push(invocation.id)
        return true
      },
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () =>
      queued.shift() ?? null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation("the steer text"))

    expect(intercepted).toEqual(["binv_verdict"])
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain("also bump the deps")
    expect(steered[0]).toContain("the steer text")
    expect(steered[0]).not.toContain("yes abcde")
    const verdictClose = calls.complete.find((entry) => entry.id === "binv_verdict")
    expect(verdictClose?.body.noResponse).toBe(true)
    expect(calls.complete.some((entry) => entry.id === "binv_q1")).toBe(false)
    await session.reply("binv_running", "done")
    expect(calls.complete.find((entry) => entry.id === "binv_q1")?.body.noResponse).toBe(true)
  })

  test("an empty steer whose sweep only intercepts a reply acks the routing, not 'nothing to steer'", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const queued = [makeInvocation({ id: "binv_verdict", promptMarkdown: "yes abcde" })]
    const session = makeSession(client, transport, {
      interceptClaimed: async (invocation) => invocation.promptMarkdown === "yes abcde",
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () =>
      queued.shift() ?? null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation(""))

    expect(steered).toEqual([])
    const verdictClose = calls.complete.find((entry) => entry.id === "binv_verdict")
    expect(verdictClose?.body.noResponse).toBe(true)
    const ack = calls.complete.find((entry) => entry.id === "binv_steer")
    expect(ack?.body.finalMessageMarkdown).toContain("Routed your reply")
    expect(ack?.body.finalMessageMarkdown).not.toContain("Nothing to steer with")
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_running")
  })

  test("failed actuation leaves the running turn alone and reports the failure", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const failed: string[] = []
    ;(client as unknown as { fail: (id: string) => Promise<void> }).fail = async (id: string) => {
      failed.push(id)
    }
    const queued = [makeInvocation({ id: "binv_q1", promptMarkdown: "queued while busy" })]
    const session = makeSession(client, transport, {
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: () => false,
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    seedInflight(session, makeInvocation({ id: "binv_running" }))
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () =>
      queued.shift() ?? null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation("go left"))

    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.has("binv_running")).toBe(true)
    expect(calls.complete.find((entry) => entry.id === "binv_running")).toBeUndefined()
    // The swept message was claimed but never delivered — failed loudly, not silently closed.
    expect(failed).toEqual(["binv_q1"])
    const ack = calls.complete.find((entry) => entry.id === "binv_steer")
    expect(ack?.body.finalMessageMarkdown).toContain("Could not steer")
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_running")
  })

  test("steer with native support but no running turn delivers a fresh turn (interrupt path)", async () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const delivered: string[] = []
    const steered: string[] = []
    let interrupted = false
    const session = makeSession(client, transport, {
      deliverTurn: async (turn) => {
        delivered.push(turn.content)
      },
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => {
          interrupted = true
          return true
        },
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    ;(client as unknown as { claim: () => Promise<null> }).claim = async () => null

    await (
      session as unknown as { handleSessionControl: (inv: ClaimedInvocation) => Promise<void> }
    ).handleSessionControl(makeSteerInvocation("start with the readme"))

    // Idle session: nothing to fold into — the steer arrives as a normal turn.
    expect(steered).toEqual([])
    expect(interrupted).toBe(true)
    expect(delivered).toEqual(["start with the readme"])
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_steer")
  })
})

describe("claimDrain intercept routing", () => {
  test("an intercepted steer invocation closes silently — never actuated as steering text", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const steered: string[] = []
    const intercepted: string[] = []
    const queue = [
      makeInvocation({
        id: "binv_verdict",
        trigger: "session-control",
        promptMarkdown: "/steer yes abcde",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd_v", name: "steer", args: "yes abcde" } },
      }),
    ]
    const session = makeSession(client, transport, {
      interceptClaimed: async (invocation) => {
        intercepted.push(invocation.id)
        return true
      },
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => true,
        steer: (text) => {
          steered.push(text)
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () => queue.shift() ?? null

    await (session as unknown as { claimDrain: () => Promise<boolean> }).claimDrain()

    expect({
      intercepted,
      steered,
      verdictClose: calls.complete.find((entry) => entry.id === "binv_verdict")?.body.noResponse,
    }).toEqual({ intercepted: ["binv_verdict"], steered: [], verdictClose: true })
  })

  test("an intercepted ordinary message closes silently instead of becoming a turn", async () => {
    const { client, calls } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const delivered: string[] = []
    const queue = [
      makeInvocation({ id: "binv_verdict", promptMarkdown: "yes abcde" }),
      makeInvocation({ id: "binv_normal", promptMarkdown: "hello there" }),
    ]
    const session = makeSession(client, transport, {
      deliverTurn: async (turn) => {
        delivered.push(turn.invocationId)
      },
      interceptClaimed: async (invocation) => invocation.promptMarkdown === "yes abcde",
    })
    ;(client as unknown as { claim: () => Promise<ClaimedInvocation | null> }).claim = async () => queue.shift() ?? null

    await (session as unknown as { claimDrain: () => Promise<boolean> }).claimDrain()

    expect(delivered).toEqual(["binv_normal"])
    const verdictClose = calls.complete.find((entry) => entry.id === "binv_verdict")
    expect(verdictClose?.body.noResponse).toBe(true)
    ;(session as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_normal")
  })
})

describe("no-socket poll backoff", () => {
  test("pulls a parked socket backstop forward when the shared transport disconnects", () => {
    const { client } = makeFakeClient()
    const session = new RemoteSession({
      config: makeConfig(),
      client,
      delegate: { deliverTurn: async () => {} },
      runtime: RUNTIME,
    })
    const internal = session as unknown as {
      emptyNoSocketPolls: number
      pollTimer: ReturnType<typeof setTimeout> | undefined
      stopped: boolean
      transport: {
        callbacks: { onDisconnected?: () => void }
        disconnect: () => void
      }
    }
    internal.emptyNoSocketPolls = 5
    const parkedTimer = setTimeout(() => {}, 15 * 60 * 1000)
    internal.pollTimer = parkedTimer

    internal.transport.callbacks.onDisconnected?.()

    expect(internal.emptyNoSocketPolls).toBe(0)
    expect(internal.pollTimer).toBeDefined()
    expect(internal.pollTimer).not.toBe(parkedTimer)
    if (internal.pollTimer) clearTimeout(internal.pollTimer)
    internal.stopped = true
    internal.transport.disconnect()
  })

  test("doubles empty socketless ticks to the cap; claim, socket, or reconnect resets", () => {
    const { client } = makeFakeClient()
    const { transport } = makeFakeTransport()
    const session = makeSession(client, transport) as unknown as {
      nextPollDelay: (claimed: boolean) => number
    }

    expect(session.nextPollDelay(false)).toBe(3000)
    expect(session.nextPollDelay(false)).toBe(6000)
    expect(session.nextPollDelay(false)).toBe(12000)
    for (let i = 0; i < 10; i++) session.nextPollDelay(false)
    expect(session.nextPollDelay(false)).toBe(120_000)

    // Claimed work while socketless → back to the fast cadence.
    expect(session.nextPollDelay(true)).toBe(3000)
    expect(session.nextPollDelay(false)).toBe(3000)

    // Socket up → slow backstop, and the backoff restarts fresh on the next outage.
    for (let i = 0; i < 5; i++) session.nextPollDelay(false)
    ;(transport as unknown as { socketConnected: boolean }).socketConnected = true
    expect(session.nextPollDelay(false)).toBe(15 * 60 * 1000)
    ;(transport as unknown as { socketConnected: boolean }).socketConnected = false
    expect(session.nextPollDelay(false)).toBe(3000)
  })
})

describe("folding queued messages into one turn", () => {
  const asInternal = (session: RemoteSession) => session as unknown as { claimDrain: () => Promise<boolean> }

  function makeFoldSession(queue: ClaimedInvocation[], overrides: { deliverTurn?: () => Promise<void> } = {}) {
    const delivered: Array<{ invocationId: string; content: string }> = []
    const completed: Array<{ id: string; body: Record<string, unknown> }> = []
    const failed: Array<{ id: string; body: Record<string, unknown> }> = []
    const claims: Array<Record<string, unknown>> = []
    const interrupts: number[] = []
    const client = {
      claim: async (body: Record<string, unknown>) => {
        claims.push(body)
        const scope = body.responseStreamId
        const caps = (body.supportedCapabilities ?? []) as string[]
        // The server-side predicates, modelled: a claim only returns work whose
        // required capability was offered, and a scoped claim only returns an
        // invocation answering into that stream.
        const index = queue.findIndex(
          (item) => caps.includes(item.requiredCapability) && (!scope || item.responseStreamId === scope)
        )
        return index === -1 ? null : queue.splice(index, 1)[0]
      },
      complete: async (id: string, body: Record<string, unknown>) => {
        completed.push({ id, body })
      },
      fail: async (id: string, body: Record<string, unknown>) => {
        failed.push({ id, body })
      },
      sendMessage: async () => {},
    } as unknown as ThreaClient
    const fake = makeFakeTransport()
    const session = makeSession(client, fake.transport, {
      deliverTurn:
        overrides.deliverTurn ??
        (async (turn: { invocationId: string; content: string }) => {
          delivered.push({ invocationId: turn.invocationId, content: turn.content })
        }),
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => {
          interrupts.push(Date.now())
          return true
        },
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    return { session, delivered, completed, failed, claims, interrupts, observations: fake.observations }
  }

  test("N messages queued behind one become a single turn that sees all of them", async () => {
    // The lag this fixes: each queued message used to become its own turn, so
    // the reply to the first arrived after the user had sent three more.
    const { session, delivered, completed, observations } = makeFoldSession([
      makeInvocation({ id: "binv_1", promptMarkdown: "first" }),
      makeInvocation({ id: "binv_2", promptMarkdown: "second" }),
      makeInvocation({ id: "binv_3", promptMarkdown: "third" }),
    ])

    await asInternal(session).claimDrain()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.invocationId).toBe("binv_1")
    expect(delivered[0]?.content).toContain("Handle all of the following together (most recent last)")
    for (const text of ["first", "second", "third"]) expect(delivered[0]?.content).toContain(text)
    expect(completed).toEqual([])
    expect([observations.get("binv_2")?.unregistered, observations.get("binv_3")?.unregistered]).toEqual([false, false])
    expect(await session.reply("binv_1", "done")).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(completed.map((item) => item.id)).toEqual(["binv_1", "binv_2", "binv_3"])
    expect([observations.get("binv_2")?.unregistered, observations.get("binv_3")?.unregistered]).toEqual([true, true])
    await session.shutdown()
  })

  test("a failed owner reply keeps folded ownership through retry", async () => {
    const { session, completed, observations } = makeFoldSession([
      makeInvocation({ id: "binv_retry_owner", promptMarkdown: "owner" }),
      makeInvocation({ id: "binv_retry_dependency", promptMarkdown: "dependency" }),
    ])
    const internal = session as unknown as { client: ThreaClient }
    const complete = internal.client.complete.bind(internal.client)
    let failOwnerOnce = true
    ;(
      internal.client as unknown as { complete: (id: string, body: Record<string, unknown>) => Promise<void> }
    ).complete = async (id, body) => {
      if (id === "binv_retry_owner" && failOwnerOnce) {
        failOwnerOnce = false
        throw new Error("temporary completion outage")
      }
      await complete(id, body)
    }

    await asInternal(session).claimDrain()
    expect((await session.reply("binv_retry_owner", "done")).retryable).toBe(true)
    expect(completed).toEqual([])
    expect(observations.get("binv_retry_dependency")?.unregistered).toBe(false)

    expect(await session.reply("binv_retry_owner", "done")).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(completed.map((item) => item.id)).toEqual(["binv_retry_owner", "binv_retry_dependency"])
    expect(observations.get("binv_retry_dependency")?.unregistered).toBe(true)
    await session.shutdown()
  })

  test("a lone message is delivered verbatim, with no fold wrapper", async () => {
    const { session, delivered, completed } = makeFoldSession([
      makeInvocation({ id: "binv_1", promptMarkdown: "just the one" }),
    ])

    await asInternal(session).claimDrain()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.content).not.toContain("Handle all of the following together")
    expect(delivered[0]?.content).toContain("just the one")
    expect(completed).toEqual([])
    await session.shutdown()
  })

  test("a queued /stop is never folded as text — it stops the turn the fold started", async () => {
    const stop = makeInvocation({
      id: "binv_stop",
      promptMarkdown: "/stop",
      trigger: "session-control",
      requiredCapability: "session-control",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_1", name: "stop", args: "" } },
    })
    const { session, delivered, completed, interrupts } = makeFoldSession([
      makeInvocation({ id: "binv_1", promptMarkdown: "first" }),
      makeInvocation({ id: "binv_2", promptMarkdown: "second" }),
      stop,
    ])

    await asInternal(session).claimDrain()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.content).toContain("first")
    expect(delivered[0]?.content).toContain("second")
    expect(delivered[0]?.content).not.toContain("/stop")
    // The point of not folding it: it has to actually stop the turn the fold
    // just started. Asserting only on the prompt text proved nothing.
    expect(interrupts).toHaveLength(1)
    expect(completed.map((item) => item.id).sort()).toEqual(["binv_1", "binv_2", "binv_stop"])
    await session.shutdown()
  })

  test("the sweep is scoped to the primary's stream, so a thread message is never folded in", async () => {
    // `claimOne` is FIFO per bot and has no stream predicate of its own; without
    // the scope the sweep would fold a message belonging to another stream and
    // answer it in the primary's, closing it unanswered where it was asked.
    const { session, delivered, completed, claims } = makeFoldSession([
      makeInvocation({ id: "binv_root", promptMarkdown: "root question", responseStreamId: "stream_root" }),
      makeInvocation({ id: "binv_thread", promptMarkdown: "thread question", responseStreamId: "stream_thread" }),
    ])

    await asInternal(session).claimDrain()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.content).toContain("root question")
    expect(delivered[0]?.content).not.toContain("thread question")
    // Untouched: still queued, still answerable in its own stream.
    expect(completed).toEqual([])
    // First claim is the unscoped primary; the sweep that follows is scoped.
    // (The later busy claim stays unscoped on purpose — a /stop from any stream
    // still has to reach the session.)
    expect(claims[0]?.responseStreamId).toBeUndefined()
    expect(claims[1]?.responseStreamId).toBe("stream_root")
    await session.shutdown()
  })

  test("a failed delivery does not leave the session falsely busy", async () => {
    // No /stop in this queue on purpose: a queued stop clears `inflight` via
    // completeInterruptedTurns, which would mask the leak this pins.
    const { session, failed } = makeFoldSession(
      [
        makeInvocation({ id: "binv_1", promptMarkdown: "first" }),
        makeInvocation({ id: "binv_2", promptMarkdown: "second" }),
      ],
      {
        deliverTurn: async () => {
          throw new Error("pane is gone")
        },
      }
    )

    await asInternal(session).claimDrain()

    expect(failed.map((item) => item.id).sort()).toEqual(["binv_1", "binv_2"])
    // Left registered, the session reports busy — claiming session control only
    // — until the idle timeout fires on an already-terminal invocation.
    expect((session as unknown as { inflight: Map<string, unknown> }).inflight.size).toBe(0)
    await session.shutdown()
  })

  test("an archive landing mid-sweep leaves the folded messages claimed, not discarded", async () => {
    // The primary is left claimed for the restore to re-run; closing the folded
    // ones here would throw their content away for good.
    const { session, delivered, completed, failed } = makeFoldSession([
      makeInvocation({ id: "binv_1", promptMarkdown: "first" }),
      makeInvocation({ id: "binv_2", promptMarkdown: "second" }),
    ])
    const internal = session as unknown as {
      claimNext: (busy: boolean, scope?: string) => Promise<unknown>
      stopped: boolean
    }
    const realClaim = internal.claimNext.bind(session)
    internal.claimNext = async (busy: boolean, scope?: string) => {
      const claimed = await realClaim(busy, scope)
      // The session goes down while the sweep is awaiting its next claim —
      // same guard the archive path trips.
      internal.stopped = true
      return claimed
    }

    await asInternal(session).claimDrain()

    expect(delivered).toEqual([])
    expect(completed).toEqual([])
    expect(failed).toEqual([])
    await session.shutdown()
  })

  test("a delivery failure fails the messages loudly and still runs a swept /stop", async () => {
    const { session, failed, interrupts } = makeFoldSession(
      [
        makeInvocation({ id: "binv_1", promptMarkdown: "first" }),
        makeInvocation({ id: "binv_2", promptMarkdown: "second" }),
        makeInvocation({
          id: "binv_stop",
          promptMarkdown: "/stop",
          trigger: "session-control",
          requiredCapability: "session-control",
          metadata: { command: { executionKind: "bot-runtime", id: "cmd_1", name: "stop", args: "" } },
        }),
      ],
      {
        deliverTurn: async () => {
          throw new Error("pane is gone")
        },
      }
    )

    await asInternal(session).claimDrain()

    // Claimed but undeliverable must not vanish into a silent close.
    expect(failed.map((item) => item.id).sort()).toEqual(["binv_1", "binv_2"])
    expect(failed[0]?.body.errorMessage).toContain("pane is gone")
    // And the swept /stop still runs rather than hanging to its claim TTL.
    expect(interrupts).toHaveLength(1)
    await session.shutdown()
  })
})

function plaintextUpdate(overrides: Partial<InvocationInputUpdate> = {}): InvocationInputUpdate {
  return { sourceRevision: 2, delivery: "plaintext", promptMarkdown: "updated", attachmentRefs: [], ...overrides }
}

/** A native steer that parks until released, with the flag its callers wait on. */
function blockedSteer(interrupts: string[] = [], commands: string[] = ["steer"]) {
  let release!: () => void
  const state = { started: false }
  const actuator: SessionControlActuator = {
    commands,
    interrupt: () => {
      interrupts.push("interrupt")
      return true
    },
    steer: async () => {
      state.started = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return true
    },
    runCommand: async () => ({ ok: true, message: "ok" }),
  }
  return { actuator, started: () => state.started, release: () => release() }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}

function makeObservedControlSession(
  queue: ClaimedInvocation[],
  delegate: Partial<RemoteSessionDelegate> = {},
  runtime: RuntimeDescriptor = RUNTIME,
  onSync?: (params: ObserveClaimParams) => void | Promise<void>
) {
  const { client, calls } = makeFakeClient()
  ;(client as unknown as { claim: (body: Record<string, unknown>) => Promise<ClaimedInvocation | null> }).claim =
    async (body) => {
      const scope = body.responseStreamId
      const caps = (body.supportedCapabilities ?? []) as string[]
      const index = queue.findIndex(
        (item) => caps.includes(item.requiredCapability) && (!scope || item.responseStreamId === scope)
      )
      return index === -1 ? null : queue.splice(index, 1)[0]!
    }
  ;(client as unknown as { listStreamMessages: () => Promise<unknown[]> }).listStreamMessages = async () => []
  const fake = makeFakeTransport(onSync)
  const delivered: Array<{ invocationId: string; content: string }> = []
  const steered: string[] = []
  const interrupts: string[] = []
  const actuator: SessionControlActuator = {
    commands: ["stop", "steer"],
    interrupt: () => {
      interrupts.push("interrupt")
      return true
    },
    steer: async (text) => {
      steered.push(text)
      return true
    },
    runCommand: async () => ({ ok: true, message: "ok" }),
  }
  const session = new RemoteSession({
    config: makeConfig(),
    client,
    transport: fake.transport,
    runtime,
    delegate: {
      deliverTurn: async (turn) => void delivered.push({ invocationId: turn.invocationId, content: turn.content }),
      sessionControl: actuator,
      ...delegate,
    },
  })
  return { session, client, calls, fake, delivered, steered, interrupts, actuator }
}

describe("invocation source controls", () => {
  const claimDrain = (session: RemoteSession) =>
    (session as unknown as { claimDrain: () => Promise<boolean> }).claimDrain()

  test("publishes the capability-derived manifest on hello and every presence update", async () => {
    const runtime = { ...RUNTIME, manifest: { output: { reply: true, trace: false } } }
    const { session, fake } = makeObservedControlSession([], {}, runtime)
    const internal = session as unknown as {
      hello: BotRuntimeHello
      syncPresence: () => Promise<void>
    }
    expect(internal.hello.manifest).toEqual({ output: { reply: true, trace: false }, input: { updates: "live" } })

    await internal.syncPresence()

    expect(fake.presence.at(-1)?.manifest).toEqual(internal.hello.manifest)
    await session.shutdown()
  })

  test("installs a bootstrap-time update before any interceptor or runtime delivery sees the claim", async () => {
    const queue = [makeInvocation({ id: "binv_bootstrap_update", promptMarkdown: "old", sourceRevision: 1 })]
    let disposition: "applied" | "restart-required" | undefined
    const { session, fake, calls, delivered, steered } = makeObservedControlSession(queue, {}, RUNTIME, async () => {
      disposition = await fake.observations
        .get("binv_bootstrap_update")!
        .update(plaintextUpdate({ promptMarkdown: "canonical before start" }))
    })

    await claimDrain(session)
    await session.reply("binv_bootstrap_update", "done")

    expect({ disposition, delivered, steered, revision: calls.complete.at(-1)?.body.sourceRevision }).toEqual({
      disposition: "applied",
      delivered: [{ invocationId: "binv_bootstrap_update", content: "canonical before start" }],
      steered: [],
      revision: 2,
    })
    await session.shutdown()
  })

  test("authoritative claim loss during initial sync prevents all processing and terminal writes", async () => {
    const queue = [makeInvocation({ id: "binv_lost_before_start" })]
    const { session, fake, delivered, calls } = makeObservedControlSession(queue, {}, RUNTIME, async (params) =>
      params.callbacks.onClaimLost?.()
    )

    await claimDrain(session)

    expect(delivered).toEqual([])
    expect(calls.complete).toEqual([])
    expect(calls.fail).toEqual([])
    expect(fake.observations.get("binv_lost_before_start")?.disposed).toBe(true)
    expect(session.isInflight("binv_lost_before_start")).toBe(false)
    await session.shutdown()
  })

  test("observes before delivery, applies ordered live updates, and completes the latest revision", async () => {
    const queue = [makeInvocation({ id: "binv_live", promptMarkdown: "one", sourceRevision: 1 })]
    const { session, calls, fake, delivered, steered } = makeObservedControlSession(queue)

    await claimDrain(session)
    const observed = fake.observations.get("binv_live")!
    expect(delivered).toEqual([{ invocationId: "binv_live", content: "one" }])

    expect(await observed.update(plaintextUpdate({ promptMarkdown: "two" }))).toBe("applied")
    expect(await observed.update(plaintextUpdate({ sourceRevision: 3, promptMarkdown: "three" }))).toBe("applied")
    expect(steered).toEqual(["two", "three"])

    expect(await session.reply("binv_live", "done")).toEqual({ ok: true, message: "sent", closedTurn: true })
    expect(calls.complete.at(-1)?.body.sourceRevision).toBe(3)
    expect(observed.unregistered).toBe(true)
    await session.shutdown()
  })

  test("refreshes plaintext attachment discovery from the edited source before live steering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-input-update-"))
    const queue = [makeInvocation({ id: "binv_attach", promptMarkdown: "old", sourceRevision: 1 })]
    const { session, client, fake, steered } = makeObservedControlSession(queue)
    const cwdSpy = spyOn(process, "cwd").mockReturnValue(dir)
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("current attachment")) as unknown as typeof fetch
    )
    ;(client as unknown as { listStreamMessages: () => Promise<unknown[]> }).listStreamMessages = async () => [
      {
        id: "src",
        attachments: [{ id: "att_current", filename: "current.txt", mimeType: "text/plain", sizeBytes: 18 }],
      },
    ]
    ;(client as unknown as { getAttachmentDownloadUrl: (id: string) => Promise<string> }).getAttachmentDownloadUrl =
      async (id) => `https://signed.example/${id}`
    try {
      await claimDrain(session)
      expect(
        await fake.observations.get("binv_attach")!.update(plaintextUpdate({ promptMarkdown: "use the current file" }))
      ).toBe("applied")
      expect(steered.at(-1)).toContain("use the current file")
      expect(steered.at(-1)).toContain("current.txt")
    } finally {
      await session.shutdown()
      cwdSpy.mockRestore()
      fetchSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("keeps initial plaintext attachment hydration best-effort", async () => {
    const queue = [makeInvocation({ id: "binv_initial_attach", promptMarkdown: "keep going" })]
    const { session, client, delivered } = makeObservedControlSession(queue)
    ;(client as unknown as { listStreamMessages: () => Promise<unknown[]> }).listStreamMessages = async () => [
      {
        id: "src",
        attachments: [{ id: "att_missing", filename: "missing.txt", mimeType: "text/plain", sizeBytes: 1 }],
      },
    ]
    ;(client as unknown as { getAttachmentDownloadUrl: () => Promise<string> }).getAttachmentDownloadUrl = async () => {
      throw new Error("signed URL unavailable")
    }

    await claimDrain(session)

    expect(delivered).toEqual([{ invocationId: "binv_initial_attach", content: "keep going" }])
    await session.shutdown()
  })

  test("a failed plaintext file in a live rebuild rejects the whole update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-strict-update-"))
    const queue = [makeInvocation({ id: "binv_strict_attach", promptMarkdown: "old", sourceRevision: 1 })]
    const { session, client, fake, steered, interrupts } = makeObservedControlSession(queue)
    const cwdSpy = spyOn(process, "cwd").mockReturnValue(dir)
    let scans = 0
    ;(client as unknown as { listStreamMessages: () => Promise<unknown[]> }).listStreamMessages = async () => {
      scans++
      if (scans === 1) return []
      return [
        {
          id: "src",
          attachments: [
            { id: "att_ok", filename: "ok.txt", mimeType: "text/plain", sizeBytes: 2 },
            { id: "att_bad", filename: "bad.txt", mimeType: "text/plain", sizeBytes: 3 },
          ],
        },
      ]
    }
    ;(client as unknown as { getAttachmentDownloadUrl: (id: string) => Promise<string> }).getAttachmentDownloadUrl =
      async (id) => {
        if (id === "att_bad") throw new Error("per-file URL failure")
        return `https://signed.example/${id}`
      }
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("ok")) as unknown as typeof fetch
    )
    try {
      await claimDrain(session)
      const result = await fake.observations
        .get("binv_strict_attach")!
        .update(plaintextUpdate({ promptMarkdown: "new" }))

      expect({ result, steered, interrupts }).toEqual({
        result: "restart-required",
        steered: [],
        interrupts: ["interrupt"],
      })
    } finally {
      await session.shutdown()
      cwdSpy.mockRestore()
      fetchSpy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("abort during a live attachment rebuild prevents stale actuation", async () => {
    const queue = [makeInvocation({ id: "binv_abort_rebuild", sourceRevision: 1 })]
    const { session, client, fake, steered, interrupts } = makeObservedControlSession(queue)
    let scans = 0
    let rebuildStarted = false
    let releaseRebuild!: () => void
    ;(client as unknown as { listStreamMessages: () => Promise<unknown[]> }).listStreamMessages = async () => {
      scans++
      if (scans === 1) return []
      rebuildStarted = true
      await new Promise<void>((resolve) => {
        releaseRebuild = resolve
      })
      return []
    }
    await claimDrain(session)
    const controller = new AbortController()
    const updating = fake.observations
      .get("binv_abort_rebuild")!
      .update(plaintextUpdate({ promptMarkdown: "deleted input" }), controller.signal)
    await waitUntil(() => rebuildStarted)
    controller.abort()
    releaseRebuild()

    expect(await updating).toBe("restart-required")
    expect({ steered, interrupts, inflight: session.isInflight("binv_abort_rebuild") }).toEqual({
      steered: [],
      interrupts: ["interrupt"],
      inflight: false,
    })
    await session.shutdown()
  })

  test("abort while native steer is blocked interrupts synchronously and fences output", async () => {
    const queue = [makeInvocation({ id: "binv_abort_steer", sourceRevision: 1 })]
    const interrupts: string[] = []
    const blocked = blockedSteer(interrupts)
    const { session, fake, calls } = makeObservedControlSession(queue, { sessionControl: blocked.actuator })
    await claimDrain(session)
    const controller = new AbortController()
    const updating = fake.observations
      .get("binv_abort_steer")!
      .update(plaintextUpdate({ promptMarkdown: "deleted while steering" }), controller.signal)
    await waitUntil(blocked.started)
    controller.abort()
    expect(interrupts).toEqual(["interrupt"])
    expect(session.isInflight("binv_abort_steer")).toBe(false)
    blocked.release()

    expect({
      disposition: await updating,
      inflight: session.isInflight("binv_abort_steer"),
      complete: calls.complete,
    }).toEqual({ disposition: "restart-required", inflight: false, complete: [] })
    await session.shutdown()
  })

  test("pauses interim, final, and trace output while an authoritative update is being steered", async () => {
    const queue = [makeInvocation({ id: "binv_output_fence", sourceRevision: 1 })]
    const blocked = blockedSteer([], ["stop", "steer"])
    const { session, fake, calls } = makeObservedControlSession(queue, { sessionControl: blocked.actuator })
    await claimDrain(session)
    const updating = fake.observations.get("binv_output_fence")!.update(plaintextUpdate())
    await waitUntil(blocked.started)
    const stepCount = fake.steps.length

    expect({
      interim: (await session.sendInterim("binv_output_fence", "old interim")).retryable,
      final: (await session.reply("binv_output_fence", "old final")).retryable,
      trace: await session.recordSteps("binv_output_fence", [{ stepType: "thinking", content: "old trace" }]),
      steps: fake.steps.length,
      sendMessage: calls.sendMessage,
      complete: calls.complete,
    }).toEqual({ interim: true, final: true, trace: true, steps: stepCount, sendMessage: [], complete: [] })

    blocked.release()
    expect(await updating).toBe("applied")
    await session.shutdown()
  })

  test("an update that wins while a reply is preparing attachments fences the old completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "remote-reply-race-"))
    const file = join(dir, "old.txt")
    writeFileSync(file, "old output")
    const queue = [makeInvocation({ id: "binv_reply_race", sourceRevision: 1 })]
    const { session, client, fake, calls } = makeObservedControlSession(queue)
    let uploadStarted = false
    let releaseUpload!: () => void
    ;(client as unknown as { uploadAttachment: () => Promise<Record<string, unknown>> }).uploadAttachment =
      async () => {
        uploadStarted = true
        await new Promise<void>((resolve) => {
          releaseUpload = resolve
        })
        return { id: "att_old", filename: "old.txt", mimeType: "text/plain", sizeBytes: 10 }
      }
    try {
      await claimDrain(session)
      const replying = session.reply("binv_reply_race", `old answer\nTHREA_ATTACH: ${file}`)
      await waitUntil(() => uploadStarted)
      const observed = fake.observations.get("binv_reply_race")!
      expect(await observed.update(plaintextUpdate({ promptMarkdown: "edited while replying" }))).toBe(
        "restart-required"
      )
      releaseUpload()

      expect(await replying).toEqual({ ok: false, message: "Request binv_reply_race is closed; its source changed." })
      expect(calls.complete).toEqual([])
      // Keep observing until PR3 has sent restartRequiredRevision and delivers
      // the backend's authoritative cancellation; unregistering here would
      // abort that handshake.
      expect(observed.unregistered).toBe(false)
      await observed.cancel()
    } finally {
      await session.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an edit during attachment preparation requests restart and never delivers stale content", async () => {
    const queue = [makeInvocation({ id: "binv_prepare", promptMarkdown: "old", sourceRevision: 1 })]
    const { session, client, fake, delivered, calls } = makeObservedControlSession(queue)
    let releaseScan!: () => void
    let scanStarted = false
    ;(client as unknown as { listStreamMessages: () => Promise<unknown[]> }).listStreamMessages = async () => {
      scanStarted = true
      await new Promise<void>((resolve) => {
        releaseScan = resolve
      })
      return []
    }

    const draining = claimDrain(session)
    await waitUntil(() => scanStarted)
    const observed = fake.observations.get("binv_prepare")!
    expect(await observed.update(plaintextUpdate({ promptMarkdown: "new" }))).toBe("restart-required")
    releaseScan()
    await draining

    expect({ delivered, completed: calls.complete, failed: calls.fail }).toEqual({
      delivered: [],
      completed: [],
      failed: [],
    })
    await session.shutdown()
  })

  test("a failed folded no-response close falls back to failure and stops observation renewal", async () => {
    const queue = [
      makeInvocation({ id: "binv_fold_owner", promptMarkdown: "owner" }),
      makeInvocation({ id: "binv_fold_close", promptMarkdown: "folded" }),
    ]
    const { session, client, fake, calls } = makeObservedControlSession(queue)
    ;(client as unknown as { complete: (id: string) => Promise<void> }).complete = async (id) => {
      if (id === "binv_fold_close") throw new Error("completion transport unavailable")
    }

    await claimDrain(session)
    await session.reply("binv_fold_owner", "done")

    expect(calls.fail.map((call) => call.id)).toContain("binv_fold_close")
    expect(fake.observations.get("binv_fold_close")?.unregistered).toBe(true)
    await session.shutdown()
  })

  test("an edited folded claim interrupts and terminalizes its running owner before stale output", async () => {
    const queue = [
      makeInvocation({ id: "binv_fold_running", promptMarkdown: "owner", sourceRevision: 1 }),
      makeInvocation({ id: "binv_fold_dependency", promptMarkdown: "old folded", sourceRevision: 1 }),
    ]
    const { session, fake, calls, interrupts, delivered } = makeObservedControlSession(queue)

    await claimDrain(session)
    expect(calls.complete).toEqual([])
    expect(
      await fake.observations.get("binv_fold_dependency")!.update(plaintextUpdate({ promptMarkdown: "current folded" }))
    ).toBe("restart-required")
    await waitUntil(() => calls.fail.some((call) => call.id === "binv_fold_running"))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.content).toContain("old folded")
    expect(interrupts).toEqual(["interrupt"])
    expect(session.isInflight("binv_fold_running")).toBe(false)
    expect(calls.complete.some((call) => call.id === "binv_fold_dependency")).toBe(false)
    await session.shutdown()
  })

  test("a cancelled folded dependency fences its owner and siblings without leaving renewals", async () => {
    const queue = [
      makeInvocation({ id: "binv_cancel_owner", promptMarkdown: "owner" }),
      makeInvocation({ id: "binv_cancel_dependency", promptMarkdown: "dependency" }),
      makeInvocation({ id: "binv_cancel_sibling", promptMarkdown: "sibling" }),
    ]
    const { session, fake, calls, interrupts } = makeObservedControlSession(queue)
    await claimDrain(session)

    await fake.observations.get("binv_cancel_dependency")!.cancel()
    await waitUntil(() => calls.fail.length === 2)

    expect(calls.fail.map((call) => call.id).sort()).toEqual(["binv_cancel_owner", "binv_cancel_sibling"])
    expect(fake.observations.get("binv_cancel_sibling")?.disposed).toBe(true)
    expect(calls.fail.some((call) => call.id === "binv_cancel_dependency")).toBe(false)
    expect({ interrupts, inflight: session.isInflight("binv_cancel_owner") }).toEqual({
      interrupts: ["interrupt"],
      inflight: false,
    })
    await session.shutdown()
  })

  test("timeout closes folded contributors no-response with their owner", async () => {
    const queue = [
      makeInvocation({ id: "binv_timeout_owner", promptMarkdown: "owner" }),
      makeInvocation({ id: "binv_timeout_dependency", promptMarkdown: "dependency" }),
    ]
    const { session, calls, fake } = makeObservedControlSession(queue)
    await claimDrain(session)
    await fireIdleTimeout(session, "binv_timeout_owner")

    expect(calls.complete.map((call) => call.id)).toEqual(["binv_timeout_owner", "binv_timeout_dependency"])
    expect(calls.complete.find((call) => call.id === "binv_timeout_dependency")?.body.noResponse).toBe(true)
    expect(fake.observations.get("binv_timeout_dependency")?.unregistered).toBe(true)
    await session.shutdown()
  })

  test("a swept dependency cancelled while native steer is blocked fences the running owner and siblings", async () => {
    const queue = [makeInvocation({ id: "binv_native_owner", promptMarkdown: "owner" })]
    const interrupts: string[] = []
    const blocked = blockedSteer(interrupts)
    const { session, fake, calls } = makeObservedControlSession(queue, { sessionControl: blocked.actuator })
    await claimDrain(session)
    queue.push(
      makeInvocation({ id: "binv_native_dependency", promptMarkdown: "dependency" }),
      makeInvocation({ id: "binv_native_sibling", promptMarkdown: "sibling" })
    )
    const steering = (session as any).handleSessionControl(
      makeInvocation({
        id: "binv_native_command",
        trigger: "session-control",
        requiredCapability: "session-control",
        promptMarkdown: "/steer continue",
        metadata: { command: { executionKind: "bot-runtime", id: "cmd_native", name: "steer", args: "continue" } },
      })
    )
    await waitUntil(blocked.started)
    await fake.observations.get("binv_native_dependency")!.cancel()
    expect(session.isInflight("binv_native_owner")).toBe(false)
    blocked.release()
    await steering
    await waitUntil(() => calls.fail.length === 3)

    expect({
      failed: calls.fail.map((call) => call.id).sort(),
      siblingDisposed: fake.observations.get("binv_native_sibling")?.disposed,
      interrupts,
    }).toEqual({
      failed: ["binv_native_command", "binv_native_owner", "binv_native_sibling"],
      siblingDisposed: true,
      interrupts: ["interrupt"],
    })
    await session.shutdown()
  })

  test("interrupt/redelivery steer retains swept ownership until the combined reply", async () => {
    const queue = [makeInvocation({ id: "binv_interrupt_owner", promptMarkdown: "owner" })]
    const { session, calls, fake } = makeObservedControlSession(queue, {
      sessionControl: {
        commands: ["steer"],
        interrupt: () => true,
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    await claimDrain(session)
    queue.push(makeInvocation({ id: "binv_interrupt_dependency", promptMarkdown: "dependency" }))
    const command = makeInvocation({
      id: "binv_interrupt_command",
      trigger: "session-control",
      requiredCapability: "session-control",
      promptMarkdown: "/steer continue",
      metadata: { command: { executionKind: "bot-runtime", id: "cmd_interrupt", name: "steer", args: "continue" } },
    })

    await (session as any).handleSessionControl(command)

    expect(calls.complete.map((call) => call.id)).toEqual(["binv_interrupt_owner"])
    expect(fake.observations.get("binv_interrupt_dependency")?.unregistered).toBe(false)
    expect(await session.reply("binv_interrupt_command", "combined answer")).toEqual({
      ok: true,
      message: "sent",
      closedTurn: true,
    })
    expect(calls.complete.map((call) => call.id)).toEqual([
      "binv_interrupt_owner",
      "binv_interrupt_command",
      "binv_interrupt_dependency",
    ])
    expect(fake.observations.get("binv_interrupt_dependency")?.unregistered).toBe(true)
    await session.shutdown()
  })

  test("cancellation interrupts without terminal writes and drains a fresh replacement after callback return", async () => {
    const queue = [makeInvocation({ id: "binv_old", promptMarkdown: "old" })]
    const { session, fake, delivered, interrupts, calls } = makeObservedControlSession(queue)
    await claimDrain(session)
    await session.sendInterim("binv_old", "already posted")
    queue.push(makeInvocation({ id: "binv_new", promptMarkdown: "new" }))

    await fake.observations.get("binv_old")!.cancel()
    await waitUntil(() => delivered.some((turn) => turn.invocationId === "binv_new"))

    expect(interrupts).toEqual(["interrupt"])
    expect(calls.invocationMessage).toHaveLength(1)
    expect(calls.complete.some((call) => call.id === "binv_old")).toBe(false)
    expect(calls.fail.some((call) => call.id === "binv_old")).toBe(false)
    expect((await session.reply("binv_old", "late")).ok).toBe(false)
    await session.shutdown()
  })

  test("cancellation while an interceptor returns false prevents session-control actuation", async () => {
    const command = makeInvocation({
      id: "binv_command",
      trigger: "session-control",
      requiredCapability: "session-control",
      promptMarkdown: "/model opus",
      sourceRevision: 0,
      metadata: { command: { executionKind: "bot-runtime", name: "model", args: "opus" } },
    })
    let release!: () => void
    let entered = false
    const commands: string[] = []
    const { session, fake, calls } = makeObservedControlSession([command], {
      interceptClaimed: async () => {
        entered = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return false
      },
      sessionControl: {
        commands: ["model"],
        interrupt: () => true,
        runCommand: async (name) => {
          commands.push(name)
          return { ok: true, message: "ok" }
        },
      },
    })

    const draining = claimDrain(session)
    await waitUntil(() => entered)
    await fake.observations.get("binv_command")!.cancel()
    release()
    await draining

    expect({ commands, complete: calls.complete, fail: calls.fail }).toEqual({ commands: [], complete: [], fail: [] })
    await session.shutdown()
  })

  test("cancellation while an awaited runtime command is executing suppresses its acknowledgement", async () => {
    const command = makeInvocation({
      id: "binv_awaited_command",
      trigger: "session-control",
      requiredCapability: "session-control",
      sourceRevision: 1,
      metadata: { command: { executionKind: "bot-runtime", name: "model", args: "opus" } },
    })
    let entered = false
    let release!: () => void
    const { session, fake, calls } = makeObservedControlSession([command], {
      sessionControl: {
        commands: ["model"],
        interrupt: () => true,
        runCommand: async () => {
          entered = true
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { ok: true, message: "model changed" }
        },
      },
    })
    const draining = claimDrain(session)
    await waitUntil(() => entered)
    await fake.observations.get("binv_awaited_command")!.cancel()
    release()
    await draining

    expect(calls.complete).toEqual([])
    expect(calls.fail).toEqual([])
    await session.shutdown()
  })

  test("failed live actuation aborts local output and requests restart without advancing a completion", async () => {
    const queue = [makeInvocation({ id: "binv_restart", promptMarkdown: "old", sourceRevision: 1 })]
    const { session, fake, calls, interrupts } = makeObservedControlSession(queue, {
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => {
          interrupts.push("interrupt")
          return true
        },
        steer: async () => false,
        runCommand: async () => ({ ok: true, message: "ok" }),
      },
    })
    await claimDrain(session)
    const disposition = await fake.observations.get("binv_restart")!.update(plaintextUpdate({ promptMarkdown: "new" }))

    expect({
      disposition,
      interrupts,
      replied: (await session.reply("binv_restart", "old output")).ok,
      complete: calls.complete,
    }).toEqual({ disposition: "restart-required", interrupts: ["interrupt"], replied: false, complete: [] })
    await session.shutdown()
  })

  test("stale completion is terminal locally and never rearms old output", async () => {
    const queue = [makeInvocation({ id: "binv_stale", sourceRevision: 1 })]
    const { session, client, fake } = makeObservedControlSession(queue)
    ;(client as unknown as { complete: () => Promise<void> }).complete = async () => {
      throw new ThreaApiError("stale", 409, "INVOCATION_INPUT_STALE")
    }
    await claimDrain(session)
    const result = await session.reply("binv_stale", "captured old output")

    expect(result).toEqual({ ok: false, message: "Request binv_stale is closed; its source changed." })
    expect(session.isInflight("binv_stale")).toBe(false)
    expect(fake.observations.get("binv_stale")?.unregistered).toBe(true)
    expect((await session.reply("binv_stale", "retry")).retryable).not.toBe(true)
    await session.shutdown()
  })
})
