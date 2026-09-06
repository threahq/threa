import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Server } from "socket.io"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { BotChannelAccessRepository } from "../api-keys"
import { MessageRepository, type EventService } from "../messaging"
import { StreamRepository } from "../streams"
import { StreamEventRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { AgentSessionRepository } from "../agents"
import { UserRepository } from "../workspaces"
import * as e2eStreams from "../e2e-streams"
import * as dbModule from "../../db"

/**
 * A `/spawn` brief answers inside a thread, so nobody watching the scratchpad
 * root sees the session's own stream events. The claim has to announce itself to
 * the parent room keyed on the thread's anchor, or the row Kris typed into stays
 * dark until he opens the thread.
 */

const THREAD = {
  id: "stream_thread",
  workspaceId: "ws_1",
  type: "thread",
  parentStreamId: "stream_root",
  parentAnchorId: "msg_spawn",
  rootStreamId: "stream_root",
}

const ROOT = {
  id: "stream_root",
  workspaceId: "ws_1",
  type: "scratchpad",
  parentStreamId: null,
  parentAnchorId: null,
  rootStreamId: null,
}

function recordingIo() {
  const emits: Array<{ room: string; event: string; payload: unknown }> = []
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emits.push({ room, event, payload })
      },
      to: (other: string) => ({
        emit: (event: string, payload: unknown) => {
          emits.push({ room, event, payload })
          emits.push({ room: other, event, payload })
        },
      }),
    }),
  } as unknown as Server
  return { io, emits }
}

function arrangeClaim(params: { responseStream: typeof THREAD | typeof ROOT; inserted: boolean }) {
  const invocation = {
    id: "binv_1",
    workspaceId: "ws_1",
    rootStreamId: "stream_root",
    activeStreamId: "stream_root",
    sourceMessageId: "msg_spawn",
    responseStreamId: params.responseStream.id,
    actorType: "bot" as const,
    actorId: "bot_1",
    trigger: "brief",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "ship the thing",
    authorUserId: "usr_1",
    mentionedActorSlugs: [],
    status: "claimed",
    targetInstanceId: "inst_1",
    targetRuntimeSessionId: "rts_1",
    claimedByInstanceId: "inst_1",
    claimedRuntimeSessionId: "rts_1",
    claimToken: "tok_1",
    claimedSourceMessageRevision: 0,
    claimExpiresAt: new Date("2026-09-06T09:01:00.000Z"),
    attempts: 1,
    errorMessage: null,
    metadata: {},
    createdAt: new Date("2026-09-06T09:00:00.000Z"),
    updatedAt: new Date("2026-09-06T09:00:00.000Z"),
    completedAt: null,
  }

  spyOn(BotChannelAccessRepository, "getGrantedStreamIds").mockResolvedValue([])
  spyOn(BotRepository, "findById").mockResolvedValue({
    id: "bot_1",
    slug: "claude",
    name: "Claude Channel",
    archivedAt: null,
  } as never)
  spyOn(dbModule, "withTransaction").mockImplementation(((_pool: unknown, fn: (c: unknown) => unknown) =>
    fn({})) as never)
  spyOn(AgentSessionRepository, "insertRunningOrSkip").mockResolvedValue(
    (params.inserted ? { id: "binv_1", createdAt: new Date("2026-09-06T09:00:00.000Z") } : null) as never
  )
  spyOn(StreamEventRepository, "insert").mockResolvedValue({ id: "event_1" } as never)
  spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)
  spyOn(e2eStreams, "resolveSealingContext").mockResolvedValue({
    streamIsE2e: false,
    actorHasGrant: false,
    externalSealedDelivery: false,
  })
  spyOn(StreamRepository, "findById").mockImplementation((async (_db: unknown, id: string) =>
    id === THREAD.id ? THREAD : ROOT) as never)
  spyOn(MessageRepository, "findSurrounding").mockResolvedValue([] as never)
  spyOn(UserRepository, "findByIds").mockResolvedValue([] as never)
  spyOn(BotRepository, "findByIds").mockResolvedValue([] as never)

  const { io, emits } = recordingIo()
  const handlers = createPublicApiHandlers({
    eventService: { getLatestSequence: mock(() => Promise.resolve(7n)) } as unknown as EventService,
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {
      claimNextInvocation: mock(() => Promise.resolve(invocation)),
      findActiveClaimForUpdate: mock(() => Promise.resolve(invocation)),
    } as unknown as PublicApiDeps["botRuntimeService"],
    botRuntimeWriteOps: {
      touchPresence: mock(() => Promise.resolve()),
    } as unknown as PublicApiDeps["botRuntimeWriteOps"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io,
  })

  const req = {
    workspaceId: "ws_1",
    botApiKey: { botId: "bot_1" },
    body: { runtimeKind: "openclaw", instanceId: "inst_1", supportedCapabilities: ["active-scratchpad"] },
  } as unknown as Request
  const res = { locals: {} as Record<string, unknown> } as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock(() => res) as unknown as Response["json"]

  return { handlers, req, res, emits }
}

const activityStarted = (emits: Array<{ room: string; event: string; payload: unknown }>) =>
  emits.filter((e) => e.event === "agent_session:activity_started")

describe("claimBotInvocation thread activity indicator", () => {
  afterEach(() => {
    mock.restore()
  })

  it("announces a thread session to the parent room, keyed on the thread's anchor", async () => {
    const { handlers, req, res, emits } = arrangeClaim({ responseStream: THREAD, inserted: true })

    await handlers.claimBotInvocation(req, res)

    expect(activityStarted(emits)).toEqual([
      {
        room: "ws:ws_1:stream:stream_root",
        event: "agent_session:activity_started",
        payload: {
          sessionId: "binv_1",
          triggerMessageId: "msg_spawn",
          personaName: "Claude Channel",
          threadStreamId: "stream_thread",
          parentMessageId: "msg_spawn",
        },
      },
    ])
  })

  it("stays quiet when the claim did not insert the session (replayed claim)", async () => {
    const { handlers, req, res, emits } = arrangeClaim({ responseStream: THREAD, inserted: false })

    await handlers.claimBotInvocation(req, res)

    expect(activityStarted(emits)).toEqual([])
  })

  it("stays quiet for a session answering in a root stream", async () => {
    const { handlers, req, res, emits } = arrangeClaim({ responseStream: ROOT, inserted: true })

    await handlers.claimBotInvocation(req, res)

    expect(activityStarted(emits)).toEqual([])
  })
})
