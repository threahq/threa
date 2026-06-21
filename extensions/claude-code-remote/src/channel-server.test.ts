import { describe, expect, test } from "bun:test"
import { ChannelServer, buildInstructions, formatInvocationContent, parsePermissionVerdict } from "./channel-server"
import type { ThreaChannelConfig } from "./config"
import type { ClaimedInvocation, ThreaClient } from "./threa-client"

function makeConfig(overrides?: Partial<ThreaChannelConfig>): ThreaChannelConfig {
  return {
    baseUrl: "https://app.threa.io",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    displayName: "Claude Code - test",
    instanceId: "cc-test",
    runtimeSessionId: "ccs-test",
    permissionRelay: false,
    pollMs: 3000,
    idleTimeoutMs: 3_600_000,
    ...overrides,
  }
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
    upsertPresence: async () => undefined,
    uploadAttachment: async () => {
      throw new Error("unexpected upload in test")
    },
  }
  return { client: client as unknown as ThreaClient, calls }
}

/** Seed an in-flight turn the way handleClaimed would, with a harmless deadline timer. */
function seedInflight(server: ChannelServer, invocation: ClaimedInvocation, sentCount = 0): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(server as any).inflight.set(invocation.id, { invocation, deadline: setTimeout(() => {}, 1e9), sentCount })
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
    runtimeSessionId: "ccs_1",
    metadata: {},
    ...partial,
  }
}

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
})

describe("ChannelServer.handleSend", () => {
  test("posts an interim message to the turn's stream and keeps the request open", async () => {
    const { client, calls } = makeFakeClient()
    const server = new ChannelServer(makeConfig(), client)
    const invocation = makeInvocation({ id: "binv_send", responseStreamId: "stream_turn" })
    seedInflight(server, invocation)

    const res = await (server as unknown as { handleSend: (id: string, text: string) => Promise<unknown> }).handleSend(
      invocation.id,
      "halfway there"
    )

    expect(res).toEqual({ content: [{ type: "text", text: "sent" }] })
    expect(calls.sendMessage[0]).toEqual({
      streamId: "stream_turn",
      body: {
        content: "halfway there",
        clientMessageId: "ccsend-binv_send-1",
        metadata: { "cc.channel.invocationId": "binv_send", "cc.channel.interim": "true" },
      },
    })
    // The turn is not completed, and the send is counted toward the idle-timeout policy.
    expect(calls.complete).toEqual([])
    expect(
      (server as unknown as { inflight: Map<string, { sentCount: number }> }).inflight.get("binv_send")?.sentCount
    ).toBe(1)
    ;(server as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_send")
  })

  test("errors without posting when the invocation is not open", async () => {
    const { client, calls } = makeFakeClient()
    const server = new ChannelServer(makeConfig(), client)

    const res = (await (
      server as unknown as { handleSend: (id: string, text: string) => Promise<{ isError?: boolean }> }
    ).handleSend("binv_missing", "hi")) as { isError?: boolean }

    expect(res.isError).toBe(true)
    expect(calls.sendMessage).toEqual([])
  })

  test("reports a closed turn when the idle timeout fires mid-send", async () => {
    const { client, calls } = makeFakeClient()
    const server = new ChannelServer(makeConfig(), client)
    const invocation = makeInvocation({ id: "binv_race", responseStreamId: "stream_turn" })
    seedInflight(server, invocation)

    // Simulate onReplyTimeout firing during the post: the entry is removed from
    // the in-flight map while sendMessage is in flight.
    ;(client as unknown as { sendMessage: (s: string, b: Record<string, unknown>) => Promise<void> }).sendMessage =
      async (streamId, body) => {
        ;(server as unknown as { clearInflight: (id: string) => void }).clearInflight("binv_race")
        calls.sendMessage.push({ streamId, body })
      }

    const res = (await (
      server as unknown as {
        handleSend: (id: string, text: string) => Promise<{ isError?: boolean; content: { text: string }[] }>
      }
    ).handleSend("binv_race", "progress")) as { isError?: boolean; content: { text: string }[] }

    // The message still posted (it can't be un-posted), but the result is not a
    // clean "sent" — it tells Claude the turn already closed.
    expect(calls.sendMessage[0]?.streamId).toBe("stream_turn")
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain("already closed")
  })
})

describe("ChannelServer.onReplyTimeout", () => {
  test("posts the no-reply notice when the turn sent nothing", async () => {
    const { client, calls } = makeFakeClient()
    const server = new ChannelServer(makeConfig(), client)
    seedInflight(server, makeInvocation({ id: "binv_silent" }), 0)

    await (server as unknown as { onReplyTimeout: (id: string) => Promise<void> }).onReplyTimeout("binv_silent")

    expect(calls.complete[0]?.body.finalMessageMarkdown).toContain("without sending a reply")
    expect(calls.complete[0]?.body.noResponse).toBeUndefined()
    expect((server as unknown as { inflight: Map<string, unknown> }).inflight.has("binv_silent")).toBe(false)
  })

  test("closes silently when the turn already sent interim messages", async () => {
    const { client, calls } = makeFakeClient()
    const server = new ChannelServer(makeConfig(), client)
    seedInflight(server, makeInvocation({ id: "binv_progress" }), 2)

    await (server as unknown as { onReplyTimeout: (id: string) => Promise<void> }).onReplyTimeout("binv_progress")

    expect(calls.complete[0]?.body.noResponse).toBe(true)
    expect(calls.complete[0]?.body.finalMessageMarkdown).toBeUndefined()
  })
})
