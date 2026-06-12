import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { BotChannelAccessRepository } from "../api-keys"
import { MessageRepository, type EventService, type Message } from "../messaging"
import { StreamMemberRepository, StreamRepository, type Stream } from "../streams"
import { UserRepository } from "../workspaces"
import { PersonaRepository, AgentSessionRepository } from "../agents"
import * as dbModule from "../../db"

// Phase 2.3d (N-4): the claim response carries an inline context handle — the
// last messages preceding the trigger from the invocation's own stream, so an
// external runner gets the conversation it was invoked into without a second
// round-trip. Scoping is per-location (INV-62): the invocation's stream IS the
// grant, with thread access resolving through the root — never the bot's
// standing channel grants and never a direct stream_members filter.

function createResponse() {
  const payloads: unknown[] = []
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock((body: unknown) => {
    payloads.push(body)
    return res
  }) as unknown as Response["json"]
  return { res, payloads }
}

function historyMessage(overrides: Partial<Message>): Message {
  return {
    id: "msg_x",
    streamId: "stream_thread",
    sequence: 1n,
    authorId: "usr_1",
    authorType: "user",
    contentJson: { type: "doc", content: [] },
    contentMarkdown: "hello",
    replyCount: 0,
    clientMessageId: null,
    sentVia: null,
    reactions: {},
    metadata: {},
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-06-12T08:00:00.000Z"),
    ciphertext: null,
    envelope: null,
    e2eVersion: null,
    ...overrides,
  } as Message
}

function arrangeClaim(params: { stream: Stream | null; surrounding?: Message[] }) {
  // The invocation lands in a thread; access resolves through the root channel.
  const invocation = {
    id: "binv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_channel",
    activeStreamId: "stream_thread",
    sourceMessageId: "msg_trigger",
    responseStreamId: "stream_thread",
    actorType: "bot" as const,
    actorId: "bot_1",
    trigger: "mention",
    requiredCapability: "mentionable",
    promptMarkdown: "@pi what's the tide tomorrow?",
    authorUserId: "usr_1",
    mentionedActorSlugs: ["pi"],
    status: "claimed",
    targetInstanceId: null,
    targetRuntimeSessionId: null,
    claimedByInstanceId: "inst_1",
    claimToken: "tok_1",
    claimExpiresAt: new Date("2026-06-12T09:01:00.000Z"),
    attempts: 1,
    errorMessage: null,
    metadata: {},
    createdAt: new Date("2026-06-12T09:00:00.000Z"),
    updatedAt: new Date("2026-06-12T09:00:00.000Z"),
    completedAt: null,
  }

  // Presence fan-out no-ops (no granted streams) so the claim path stays focused.
  spyOn(BotChannelAccessRepository, "getGrantedStreamIds").mockResolvedValue([])
  spyOn(BotRepository, "findById").mockResolvedValue({
    id: "bot_1",
    slug: "pi",
    name: "Pi",
    archivedAt: null,
  } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)
  spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(null as never)

  const findStream = spyOn(StreamRepository, "findById").mockResolvedValue(params.stream as never)
  const findSurrounding = spyOn(MessageRepository, "findSurrounding").mockResolvedValue(
    (params.surrounding ?? []) as never
  )
  const isMember = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false as never)
  spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", name: "Kris" }] as never)
  spyOn(BotRepository, "findByIds").mockResolvedValue([
    { id: "bot_1", name: "Pi" },
    { id: "bot_2", name: "Crab" },
  ] as never)
  spyOn(PersonaRepository, "findByIds").mockResolvedValue([] as never)

  const botRuntimeService = {
    claimNextInvocation: mock(() => Promise.resolve(invocation)),
    upsertPresenceFromBotKey: mock(() => Promise.resolve(null)),
  } as unknown as PublicApiDeps["botRuntimeService"]
  const isStreamAccessibleForBot = mock(() => Promise.resolve(true))
  const botChannelService = {
    isStreamAccessibleForBot,
  } as unknown as PublicApiDeps["botChannelService"]
  const eventService = {
    getLatestSequence: mock(() => Promise.resolve(7n)),
  } as unknown as EventService

  const handlers = createPublicApiHandlers({
    eventService,
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService,
    botRuntimeService,
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  })

  const req = {
    workspaceId: "ws_1",
    botApiKey: { botId: "bot_1" },
    body: { runtimeKind: "pi-local", instanceId: "inst_1", supportedCapabilities: ["mentionable"] },
  } as unknown as Request

  return { handlers, req, findStream, findSurrounding, isMember, isStreamAccessibleForBot }
}

const threadStream = {
  id: "stream_thread",
  workspaceId: "ws_1",
  type: "thread",
  rootStreamId: "stream_channel",
  visibility: "private",
} as unknown as Stream

describe("claimBotInvocation context handle", () => {
  afterEach(() => {
    mock.restore()
  })

  it("inlines prior messages oldest→newest with the trigger excluded and own-bot rows as assistant", async () => {
    const { handlers, req, findSurrounding } = arrangeClaim({
      stream: threadStream,
      surrounding: [
        historyMessage({
          id: "msg_1",
          sequence: 1n,
          authorId: "usr_1",
          authorType: "user",
          contentMarkdown: "when's high tide?",
          createdAt: new Date("2026-06-12T08:00:00.000Z"),
        }),
        historyMessage({
          id: "msg_2",
          sequence: 2n,
          authorId: "bot_1",
          authorType: "bot",
          contentMarkdown: "Around 14:00, checking.",
          createdAt: new Date("2026-06-12T08:01:00.000Z"),
        }),
        historyMessage({
          id: "msg_3",
          sequence: 3n,
          authorId: "bot_2",
          authorType: "bot",
          contentMarkdown: "I posted the charts.",
          createdAt: new Date("2026-06-12T08:02:00.000Z"),
        }),
        historyMessage({ id: "msg_trigger", sequence: 4n, contentMarkdown: "@pi what's the tide tomorrow?" }),
      ],
    })
    const { res, payloads } = createResponse()

    await handlers.claimBotInvocation(req, res)

    // The window mirrors the enclave's assignment cap (30 before the trigger).
    expect(findSurrounding.mock.calls[0]?.slice(1)).toEqual(["msg_trigger", "stream_thread", 30, 0])
    const data = (payloads[0] as { data: Record<string, unknown> }).data
    expect(data.context).toEqual({
      kind: "inline",
      messages: [
        {
          messageId: "msg_1",
          role: "user",
          authorId: "usr_1",
          authorType: "user",
          authorDisplayName: "Kris",
          contentMarkdown: "when's high tide?",
          createdAt: "2026-06-12T08:00:00.000Z",
        },
        {
          messageId: "msg_2",
          role: "assistant",
          authorId: "bot_1",
          authorType: "bot",
          authorDisplayName: "Pi",
          contentMarkdown: "Around 14:00, checking.",
          createdAt: "2026-06-12T08:01:00.000Z",
        },
        {
          // Another bot's message is conversational input, not this runner's own output.
          messageId: "msg_3",
          role: "user",
          authorId: "bot_2",
          authorType: "bot",
          authorDisplayName: "Crab",
          contentMarkdown: "I posted the charts.",
          createdAt: "2026-06-12T08:02:00.000Z",
        },
      ],
    })
  })

  it("hydrates a non-member thread inside a member channel without touching membership or standing grants (INV-62)", async () => {
    const { handlers, req, isMember, isStreamAccessibleForBot } = arrangeClaim({
      stream: threadStream,
      surrounding: [
        historyMessage({ id: "msg_1", contentMarkdown: "thread chatter" }),
        historyMessage({ id: "msg_trigger", sequence: 2n }),
      ],
    })
    const { res, payloads } = createResponse()

    await handlers.claimBotInvocation(req, res)

    const data = (payloads[0] as { data: Record<string, unknown> }).data
    const context = data.context as { messages: { messageId: string }[] }
    expect(context.messages.map((m) => m.messageId)).toEqual(["msg_1"])
    // The location is the grant: a stream_members or bot-channel-grant filter
    // would silently drop thread context (membership ≠ access).
    expect(isMember).not.toHaveBeenCalled()
    expect(isStreamAccessibleForBot).not.toHaveBeenCalled()
  })

  it("ships an explicitly empty inline handle when the trigger opens the conversation", async () => {
    const { handlers, req } = arrangeClaim({
      stream: threadStream,
      surrounding: [historyMessage({ id: "msg_trigger" })],
    })
    const { res, payloads } = createResponse()

    await handlers.claimBotInvocation(req, res)

    const data = (payloads[0] as { data: Record<string, unknown> }).data
    // Empty is a real answer ("nothing came before"), distinct from the
    // withheld/omitted field — the same dispatched-vs-empty distinction §1.1
    // demands of the receipt.
    expect(data.context).toEqual({ kind: "inline", messages: [] })
  })

  it("withholds context entirely for an E2E stream — no plaintext history leaves the enclave path", async () => {
    const { handlers, req, findSurrounding } = arrangeClaim({
      stream: { ...threadStream, e2eEnabled: true } as unknown as Stream,
    })
    const { res, payloads } = createResponse()

    await handlers.claimBotInvocation(req, res)

    const data = (payloads[0] as { data: Record<string, unknown> }).data
    expect(data.id).toBe("binv_1")
    expect("context" in data).toBe(false)
    expect(findSurrounding).not.toHaveBeenCalled()
  })

  it("withholds context when the stream row is gone or belongs to another workspace (INV-8)", async () => {
    const { handlers, req, findSurrounding } = arrangeClaim({
      stream: { ...threadStream, workspaceId: "ws_other" } as unknown as Stream,
    })
    const { res, payloads } = createResponse()

    await handlers.claimBotInvocation(req, res)

    const data = (payloads[0] as { data: Record<string, unknown> }).data
    expect("context" in data).toBe(false)
    expect(findSurrounding).not.toHaveBeenCalled()
  })
})
