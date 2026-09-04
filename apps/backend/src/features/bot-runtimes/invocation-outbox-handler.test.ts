import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes, E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threa/types"
import { BotInvocationOutboxHandler } from "./invocation-outbox-handler"
import { resolveCanonicalInvocationRoutes } from "./invocation-route-resolver"
import { BotRuntimeService } from "./service"
import {
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
} from "./repository"
import { createStreamReadOnlyError, StreamRepository } from "../streams"
import * as streamsModule from "../streams"
import { BotRepository } from "../public-api/bot-repository"
import { EventService, type InvocationSourceState } from "../messaging"
import { E2eStreamActorsRepository, E2eStreamsRepository } from "../e2e-streams"
import * as e2eStreams from "../e2e-streams"

const pool = {} as Pool

const docWithText = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

const docWithMention = (id: string, slug: string) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id, slug, mentionType: "bot" } },
        { type: "text", text: " hi" },
      ],
    },
  ],
})

function source(overrides: Partial<InvocationSourceState> = {}): InvocationSourceState {
  return {
    workspaceId: "ws_1",
    streamId: "stream_1",
    revision: 2,
    deleted: false,
    contentJson: docWithText("hello"),
    contentMarkdown: "hello",
    ciphertext: null,
    envelope: null,
    authorId: "usr_1",
    authorType: AuthorTypes.USER,
    ...overrides,
  }
}

const channel = {
  id: "stream_1",
  workspaceId: "ws_1",
  archivedAt: null,
  rootStreamId: null,
  type: "channel",
  e2eEnabled: false,
}

const scratchpad = { ...channel, type: "scratchpad" }
const activeBot = {
  id: "bot_1",
  slug: "scout",
  name: "Scout",
  archivedAt: null,
  traits: ["active-scratchpad"],
}

beforeEach(() => {
  spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
  spyOn(streamsModule, "projectStreamForBot").mockImplementation((async (
    _db: unknown,
    params: { stream: unknown }
  ) => ({
    ...(params.stream as object),
    readOnly: false,
    readOnlyReason: null,
  })) as never)
})

afterEach(() => mock.restore())

describe("resolveCanonicalInvocationRoutes", () => {
  it("selects mentioned bots by resolved id and preserves display slugs", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(channel as never)
    const findInvocable = spyOn(BotRepository, "findInvocableByIds").mockResolvedValue([
      { id: "bot_1", slug: "аріадна", archivedAt: null, traits: ["mentionable"] },
    ] as never)

    const routes = await resolveCanonicalInvocationRoutes(
      pool,
      source({ contentJson: docWithMention("bot_1", "аріадна"), contentMarkdown: "@аріадна hi" })
    )

    expect(findInvocable).toHaveBeenCalledWith(pool, "ws_1", "usr_1", ["bot_1"])
    expect(routes).toEqual([
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "mention",
        mentionedActorSlugs: ["аріадна"],
        promptMarkdown: "@аріадна hi",
      }),
    ])
  })

  it("drops a mentioned bot that can no longer write to the stream", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(channel as never)
    spyOn(BotRepository, "findInvocableByIds").mockResolvedValue([
      { id: "bot_1", slug: "scout", archivedAt: null, traits: ["mentionable"] },
    ] as never)
    const project = spyOn(streamsModule, "projectStreamForBot").mockResolvedValue({
      ...channel,
      readOnly: true,
      readOnlyReason: "not_a_member",
    } as never)

    const routes = await resolveCanonicalInvocationRoutes(
      pool,
      source({ contentJson: docWithMention("bot_1", "scout"), contentMarkdown: "@scout hi" })
    )

    expect(project).toHaveBeenCalledWith(pool, { workspaceId: "ws_1", stream: channel, botId: "bot_1" })
    expect(routes).toEqual([])
  })

  it("drops the active bot and its missing-link notice when the stream is not writable for it", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(scratchpad as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(streamsModule, "projectStreamForBot").mockResolvedValue(null as never)
    const findLink = spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream")

    const routes = await resolveCanonicalInvocationRoutes(pool, source())

    expect({ routes, linkLookups: findLink.mock.calls.length }).toEqual({ routes: [], linkLookups: 0 })
  })

  it("ignores unresolved mention ids and @-shaped plain text", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(channel as never)
    const findInvocable = spyOn(BotRepository, "findInvocableByIds").mockResolvedValue([] as never)

    const unresolved = await resolveCanonicalInvocationRoutes(
      pool,
      source({ contentJson: docWithMention("scout", "scout"), contentMarkdown: "@scout hi" })
    )
    const plain = await resolveCanonicalInvocationRoutes(
      pool,
      source({ contentJson: docWithText("ping @scout"), contentMarkdown: "ping @scout" })
    )

    expect({ unresolved, plain, invocableLookups: findInvocable.mock.calls.length }).toEqual({
      unresolved: [],
      plain: [],
      invocableLookups: 0,
    })
  })

  it("keeps E2E content server-blind and denies dispatch before session-link lookup", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(scratchpad as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([])
    const findLink = spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream")

    const routes = await resolveCanonicalInvocationRoutes(
      pool,
      source({
        contentJson: docWithText(E2E_PLACEHOLDER_CONTENT_MARKDOWN),
        contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      })
    )

    expect({ routes, linkLookups: findLink.mock.calls.length }).toEqual({ routes: [], linkLookups: 0 })
  })

  it("preserves required-link notices and link-free runtime routing", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(scratchpad as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null)
    const instances = spyOn(BotRuntimeInstanceRepository, "findLatestForBots")

    instances.mockResolvedValue(new Map([["bot_1", { runtimeKind: "pi-local" }]]) as never)
    const required = await resolveCanonicalInvocationRoutes(pool, source())
    instances.mockResolvedValue(new Map([["bot_1", { runtimeKind: "openclaw" }]]) as never)
    const linkFree = await resolveCanonicalInvocationRoutes(pool, source())

    expect(required).toEqual([
      expect.objectContaining({ actorId: "bot_1", missingLinkNotice: expect.stringContaining("not linked") }),
    ])
    expect(linkFree).toEqual([
      expect.objectContaining({
        actorId: "bot_1",
        trigger: "active-scratchpad",
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        missingLinkNotice: null,
      }),
    ])
  })

  it("targets a thread link and falls back to the root link", async () => {
    const thread = { ...scratchpad, id: "stream_thread", rootStreamId: "stream_root", type: "thread" }
    const root = { ...scratchpad, id: "stream_root" }
    spyOn(StreamRepository, "findByIdForWorkspace").mockImplementation(
      async (_db, id) => (id === "stream_thread" ? thread : root) as never
    )
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    const findLink = spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ instanceId: "inst_1", runtimeSessionId: "runtime_1" } as never)

    const routes = await resolveCanonicalInvocationRoutes(pool, source({ streamId: "stream_thread" }))

    expect(findLink.mock.calls.map((call) => call[1])).toEqual([
      { workspaceId: "ws_1", botId: "bot_1", rootStreamId: "stream_root", activeStreamId: "stream_thread" },
      { workspaceId: "ws_1", botId: "bot_1", rootStreamId: "stream_root", activeStreamId: "stream_root" },
    ])
    expect(routes).toEqual([
      expect.objectContaining({
        rootStreamId: "stream_root",
        activeStreamId: "stream_thread",
        responseStreamId: "stream_thread",
        targetInstanceId: "inst_1",
        targetRuntimeSessionId: "runtime_1",
      }),
    ])
  })

  it("suppresses active routing for another mentioned actor but allows the explicitly mentioned active bot", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(scratchpad as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null)
    spyOn(BotRuntimeInstanceRepository, "findLatestForBots").mockResolvedValue(
      new Map([["bot_1", { runtimeKind: "openclaw" }]]) as never
    )
    spyOn(BotRepository, "findInvocableByIds").mockImplementation(
      async (_db, _workspaceId, _authorId, ids) =>
        (ids.includes("bot_2")
          ? [{ id: "bot_2", slug: "other", archivedAt: null, traits: ["mentionable"] }]
          : [activeBot]) as never
    )

    const other = await resolveCanonicalInvocationRoutes(
      pool,
      source({ contentJson: docWithMention("bot_2", "other"), contentMarkdown: "@other hi" })
    )
    const explicit = await resolveCanonicalInvocationRoutes(
      pool,
      source({ contentJson: docWithMention("bot_1", "scout"), contentMarkdown: "@scout hi" })
    )

    expect(other).toEqual([expect.objectContaining({ actorId: "bot_2", trigger: "mention" })])
    expect(explicit).toEqual([expect.objectContaining({ actorId: "bot_1", trigger: "active-scratchpad" })])
  })

  it("preserves the non-user wrapper and never parses non-user mentions", async () => {
    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(scratchpad as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null)
    spyOn(BotRuntimeInstanceRepository, "findLatestForBots").mockResolvedValue(
      new Map([["bot_1", { runtimeKind: "openclaw" }]]) as never
    )
    const findInvocable = spyOn(BotRepository, "findInvocableByIds")

    const routes = await resolveCanonicalInvocationRoutes(
      pool,
      source({
        authorType: AuthorTypes.PERSONA,
        authorId: "persona_1",
        contentJson: docWithMention("bot_2", "other"),
        contentMarkdown: "@other status",
      })
    )

    expect(findInvocable).not.toHaveBeenCalled()
    expect(routes[0]?.promptMarkdown).toBe(
      "A non-user message was posted in your active Threa scratchpad.\n" +
        "Use the stream context to decide whether a reply is useful. If no reply is needed, respond exactly: THREA_NO_RESPONSE\n\n" +
        "@other status"
    )
  })

  it("ignores system messages and allows the sealed verdict", async () => {
    expect(await resolveCanonicalInvocationRoutes(pool, source({ authorType: AuthorTypes.SYSTEM }))).toEqual([])

    spyOn(StreamRepository, "findByIdForWorkspace").mockResolvedValue(scratchpad as never)
    spyOn(StreamActiveActorRepository, "findByRootStream").mockResolvedValue({
      actorType: "bot",
      actorId: "bot_1",
    } as never)
    spyOn(BotRepository, "findById").mockResolvedValue(activeBot as never)
    spyOn(BotRuntimeSessionLinkRepository, "findActiveByStream").mockResolvedValue(null)
    spyOn(BotRuntimeInstanceRepository, "findLatestForBots").mockResolvedValue(
      new Map([["bot_1", { runtimeKind: "openclaw" }]]) as never
    )
    spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
      streamIsE2e: true,
      actorHasGrant: true,
      externalSealedDelivery: true,
    })

    expect(await resolveCanonicalInvocationRoutes(pool, source())).toEqual([
      expect.objectContaining({ actorId: "bot_1", trigger: "active-scratchpad" }),
    ])
  })
})

describe("BotInvocationOutboxHandler canonical reconciliation", () => {
  const createdPayload = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    event: {
      id: "evt_1",
      sequence: "1",
      actorType: "user",
      actorId: "usr_1",
      payload: { messageId: "msg_1", contentMarkdown: "stale", contentJson: docWithText("stale") },
    },
  }

  it("passes only source identity so an old payload cannot stamp stale content", async () => {
    const reconcile = spyOn(BotRuntimeService.prototype, "reconcileInvocationSource").mockResolvedValue([])
    const handler = new BotInvocationOutboxHandler(pool)

    await (handler as unknown as { processMessageMutation(payload: unknown): Promise<void> }).processMessageMutation(
      createdPayload
    )

    expect(reconcile).toHaveBeenCalledWith({ workspaceId: "ws_1", sourceMessageId: "msg_1" })
  })

  it("posts missing-link notices only after reconciliation with an idempotent source key", async () => {
    spyOn(BotRuntimeService.prototype, "reconcileInvocationSource").mockResolvedValue([
      { botId: "bot_1", streamId: "stream_1", rootStreamId: "stream_root", contentMarkdown: "Link Scout" },
    ])
    const createMessage = spyOn(EventService.prototype, "createGeneratedMessage").mockResolvedValue(undefined as never)
    const handler = new BotInvocationOutboxHandler(pool)

    await (handler as unknown as { processMessageMutation(payload: unknown): Promise<void> }).processMessageMutation(
      createdPayload
    )

    expect(createMessage).toHaveBeenCalledWith(
      { kind: "bot", botId: "bot_1" },
      expect.objectContaining({
        contentMarkdown: "Link Scout",
        clientMessageId: "bot-runtime-unlinked:stream_root:msg_1",
      })
    )
  })

  it("swallows a notice the bot can no longer post (authority changed after reconciliation)", async () => {
    spyOn(BotRuntimeService.prototype, "reconcileInvocationSource").mockResolvedValue([
      { botId: "bot_1", streamId: "stream_1", rootStreamId: "stream_root", contentMarkdown: "Link Scout" },
    ])
    spyOn(EventService.prototype, "createGeneratedMessage").mockRejectedValue(createStreamReadOnlyError("not_a_member"))
    const handler = new BotInvocationOutboxHandler(pool)

    await expect(
      (handler as unknown as { processMessageMutation(payload: unknown): Promise<void> }).processMessageMutation(
        createdPayload
      )
    ).resolves.toBeUndefined()
  })

  it("routes deletion through the same canonical reconciliation service", async () => {
    const reconcile = spyOn(BotRuntimeService.prototype, "reconcileInvocationSource").mockResolvedValue([])
    const handler = new BotInvocationOutboxHandler(pool)

    await (handler as unknown as { processMessageDeleted(payload: unknown): Promise<void> }).processMessageDeleted({
      workspaceId: "ws_1",
      messageId: "msg_1",
    })

    expect(reconcile).toHaveBeenCalledWith({ workspaceId: "ws_1", sourceMessageId: "msg_1" })
  })

  it("repairs a migration-cancelled session if an old replica starts it after startup", async () => {
    const repair = spyOn(BotRuntimeService.prototype, "repairDeletedSourceSession").mockResolvedValue(true)
    const handler = new BotInvocationOutboxHandler(pool)

    await (
      handler as unknown as { processAgentSessionStarted(payload: unknown): Promise<void> }
    ).processAgentSessionStarted({
      workspaceId: "ws_1",
      event: { payload: { sessionId: "binv_late" } },
    })

    expect(repair).toHaveBeenCalledWith({ workspaceId: "ws_1", sessionId: "binv_late" })
  })
})

describe("BotInvocationOutboxHandler stream lifecycle", () => {
  it("ends and restores runtime session links", async () => {
    const end = spyOn(BotRuntimeService.prototype, "endSessionsForArchivedStream").mockResolvedValue(1)
    const restore = spyOn(BotRuntimeService.prototype, "restoreSessionsForUnarchivedStream").mockResolvedValue(1)
    const handler = new BotInvocationOutboxHandler(pool)
    const privateHandler = handler as unknown as {
      processStreamArchived(payload: unknown): Promise<void>
      processStreamUnarchived(payload: unknown): Promise<void>
    }

    await privateHandler.processStreamArchived({ workspaceId: "ws_1", streamId: "stream_root" })
    await privateHandler.processStreamUnarchived({ workspaceId: "ws_1", streamId: "stream_root" })

    expect({ end: end.mock.calls[0]?.[0], restore: restore.mock.calls[0]?.[0] }).toEqual({
      end: { workspaceId: "ws_1", rootStreamId: "stream_root" },
      restore: { workspaceId: "ws_1", rootStreamId: "stream_root" },
    })
  })
})
