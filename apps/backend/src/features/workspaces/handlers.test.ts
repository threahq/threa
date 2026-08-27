import { describe, expect, it, spyOn, afterEach } from "bun:test"
import type { Request, Response } from "express"
import { createWorkspaceHandlers } from "./handlers"
import { SyncLogRepository } from "../sync"
import { BotRepository } from "../public-api"
import { AgentSessionRepository, PersonaRepository } from "../agents"
import * as Streams from "../streams"

// Bootstrap pulls from ~17 injected services plus three module-static repos.
// Following INV-48 the statics are stubbed via `spyOn` against the namespace
// import; the injected services are minimal benign stubs. The point of this
// test is the new `archivedStreams` field: the handler must call
// `streamService.listArchivedRoots` and surface the result in `data`.

function makeStreamService(archivedStreams: unknown[]) {
  return {
    listWithPreviews: async () => [],
    listDmPeers: async () => [],
    // Mirrors the real resolver's contract: DM rows get a viewer-dependent
    // displayName baked on; everything else passes through.
    resolveDmDisplayNames: async (streams: Array<{ type?: string; displayName?: string | null }>) =>
      streams.map((s) => (s.type === "dm" ? { ...s, displayName: "Peer Name" } : s)),
    getMembershipsBatch: async () => [],
    // Default: no read-state rows — every stream resolves as never-read.
    getEffectiveReadState: async (_userId: string, streamIds: string[]) =>
      new Map(streamIds.map((streamId) => [streamId, { streamId, lastReadEventId: null, lastReadAt: null }])),
    getUnreadCounts: async () => new Map(),
    getReadOverlayForMember: async () => new Map(),
    getSequencesByEventIds: async () => new Map(),
    listArchivedRoots: async () => archivedStreams,
  }
}

function makeDeps(archivedStreams: unknown[]) {
  const streamService = makeStreamService(archivedStreams)
  return {
    workspaceService: {
      getWorkspaceById: async () => ({ id: "ws_1", name: "WS" }),
      getUsers: async () => [],
      getPersonasForWorkspace: async () => [],
      getEmojiWeights: async () => ({}),
    },
    streamService,
    userPreferencesService: { getPreferences: async () => ({}) },
    workspaceSettingsService: { getSettings: async () => ({}) },
    featureFlagService: { getFlagLayers: async () => ({ workspace: {}, user: {} }) },
    platformAdminService: { hasAccess: async () => false },
    sidebarConfigService: { getConfig: async () => ({}) },
    boardViewService: { list: async () => [] },
    invitationService: { listInvitations: async () => [] },
    workspaceIntegrationService: { getAvailableToolCategories: async () => [] },
    commandAvailabilityService: { listWorkspaceCommands: () => [] },
    avatarService: {},
    labelService: { listForActor: async () => [] },
    labelAssignmentService: { listForViewer: async () => [] },
    workosOrgService: {},
    pool: {} as import("pg").Pool,
    // activityService intentionally omitted — bootstrap treats it as optional.
  } as unknown as Parameters<typeof createWorkspaceHandlers>[0]
}

function makeReqRes() {
  const req = {
    user: { id: "usr_1", workosUserId: "wos_1", role: "member" },
    authUser: { permissions: [] },
    workspaceId: "ws_1",
  } as unknown as Request

  let jsonBody: any
  const res = {
    locals: {},
    type: () => res,
    send: (body: string) => {
      jsonBody = JSON.parse(body)
      return res
    },
    json: (body: unknown) => {
      jsonBody = body
      return res
    },
    status: () => res,
  } as unknown as Response

  return { req, res, getJson: () => jsonBody }
}

describe("workspace bootstrap handler", () => {
  afterEach(() => {
    // Bun restores spies at file teardown; nothing per-test to reset here.
  })

  it("returns the viewer's accessible running agent sessions without archived or internal roots", async () => {
    spyOn(AgentSessionRepository, "listRunningByWorkspace").mockResolvedValue([
      {
        sessionId: "session_persona",
        streamId: "stream_thread",
        rootStreamId: "stream_public",
        personaId: "persona_1",
        startedAt: new Date("2026-08-27T11:00:00.000Z"),
      },
      {
        sessionId: "session_archived",
        streamId: "stream_archived",
        rootStreamId: "stream_archived",
        personaId: "bot_1",
        startedAt: new Date("2026-08-27T11:01:00.000Z"),
      },
      {
        sessionId: "session_internal",
        streamId: "stream_internal",
        rootStreamId: "stream_internal",
        personaId: "persona_1",
        startedAt: new Date("2026-08-27T11:02:00.000Z"),
      },
    ] as never)
    spyOn(Streams, "listAccessibleStreamIds").mockResolvedValue(
      new Set(["stream_public", "stream_archived", "stream_internal"])
    )
    spyOn(Streams.StreamRepository, "findByIdsInWorkspace").mockResolvedValue([
      { id: "stream_public", archivedAt: null, purpose: null },
      { id: "stream_archived", archivedAt: new Date(), purpose: null },
      { id: "stream_internal", archivedAt: null, purpose: "persona_test" },
    ] as never)
    spyOn(PersonaRepository, "findByIds").mockResolvedValue([{ id: "persona_1", name: "Ariadne" }] as never)
    spyOn(BotRepository, "findByIds").mockResolvedValue([{ id: "bot_1", name: "Remote" }] as never)

    const handlers = createWorkspaceHandlers(makeDeps([]))
    const { req, res, getJson } = makeReqRes()
    await handlers.activeAgentSessions(req, res)

    expect(getJson()).toEqual({
      activeAgentSessions: [
        {
          sessionId: "session_persona",
          streamId: "stream_thread",
          rootStreamId: "stream_public",
          personaName: "Ariadne",
          startedAt: "2026-08-27T11:00:00.000Z",
        },
      ],
    })
  })

  it("includes archived roots from the service in the bootstrap payload", async () => {
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({
      head: 0n,
      retainedFrom: 0n,
    } as never)
    spyOn(BotRepository, "listVisibleTo").mockResolvedValue([] as never)
    spyOn(AgentSessionRepository, "listRunningByWorkspace").mockResolvedValue([] as never)

    const archivedAt = new Date()
    const archivedChannel = { id: "stream_arch", workspaceId: "ws_1", type: "channel", archivedAt }
    // Archived DMs are absent from dmPeers, so the handler must bake the
    // viewer-dependent name onto the row itself.
    const archivedDm = { id: "stream_dm", workspaceId: "ws_1", type: "dm", displayName: null, archivedAt }
    const handlers = createWorkspaceHandlers(makeDeps([archivedChannel, archivedDm]))
    const { req, res, getJson } = makeReqRes()

    await handlers.bootstrap(req, res)

    expect(getJson().data.archivedStreams).toEqual([
      { ...archivedChannel, archivedAt: archivedAt.toISOString() },
      { ...archivedDm, archivedAt: archivedAt.toISOString(), displayName: "Peer Name" },
    ])
    // Active streams list stays a separate contract (empty here).
    expect(getJson().data.streams).toEqual([])
  })

  it("derives unread, watermark sequences, and the streamReadState map from the effective frontier", async () => {
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({ head: 0n, retainedFrom: 0n } as never)
    spyOn(BotRepository, "listVisibleTo").mockResolvedValue([] as never)
    spyOn(AgentSessionRepository, "listRunningByWorkspace").mockResolvedValue([] as never)

    const deps = makeDeps([])
    const streamService = (deps as any).streamService
    const memberships = [
      {
        streamId: "stream_a",
        memberId: "usr_1",
        notificationLevel: null,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        streamId: "stream_b",
        memberId: "usr_1",
        notificationLevel: null,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        streamId: "stream_c",
        memberId: "usr_1",
        notificationLevel: null,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]
    streamService.listWithPreviews = async () => memberships.map((m: any) => ({ id: m.streamId, type: "channel" }))
    streamService.getMembershipsBatch = async () => memberships
    // stream_read_state is the sole source: stream_a has an explicit NULL
    // watermark (unread-to-zero), stream_b and stream_c have real frontiers.
    streamService.getEffectiveReadState = async () =>
      new Map([
        ["stream_a", { streamId: "stream_a", lastReadEventId: null, lastReadAt: new Date("2026-02-01T00:00:00.000Z") }],
        [
          "stream_b",
          { streamId: "stream_b", lastReadEventId: "evt_rs_b", lastReadAt: new Date("2026-02-02T00:00:00.000Z") },
        ],
        [
          "stream_c",
          { streamId: "stream_c", lastReadEventId: "evt_m_c", lastReadAt: new Date("2026-01-03T00:00:00.000Z") },
        ],
      ])
    const unreadArgs: unknown[] = []
    streamService.getUnreadCounts = async (arg: unknown) => {
      unreadArgs.push(arg)
      return new Map()
    }
    streamService.getSequencesByEventIds = async (ids: string[]) => new Map(ids.map((id) => [id, `seq_of_${id}`]))

    const handlers = createWorkspaceHandlers(deps)
    const { req, res, getJson } = makeReqRes()
    await handlers.bootstrap(req, res)

    // Unread counts source from the effective frontier, not raw membership.
    expect(unreadArgs[0]).toEqual([
      { streamId: "stream_a", memberId: "usr_1", lastReadEventId: null },
      { streamId: "stream_b", memberId: "usr_1", lastReadEventId: "evt_rs_b" },
      { streamId: "stream_c", memberId: "usr_1", lastReadEventId: "evt_m_c" },
    ])

    // Every member stream gets an entry; a present NULL is an authoritative
    // explicit frontier (not "no data").
    expect(getJson().data.streamReadState).toEqual({
      stream_a: { lastReadEventId: null, lastReadSequence: null, lastReadAt: "2026-02-01T00:00:00.000Z" },
      stream_b: {
        lastReadEventId: "evt_rs_b",
        lastReadSequence: "seq_of_evt_rs_b",
        lastReadAt: "2026-02-02T00:00:00.000Z",
      },
      stream_c: {
        lastReadEventId: "evt_m_c",
        lastReadSequence: "seq_of_evt_m_c",
        lastReadAt: "2026-01-03T00:00:00.000Z",
      },
    })

    // Memberships carry participation only — no watermark fields.
    const serialized = getJson().data.streamMemberships
    expect(serialized.find((m: any) => m.streamId === "stream_b")).toEqual({
      streamId: "stream_b",
      memberId: "usr_1",
      notificationLevel: null,
      joinedAt: "2026-01-01T00:00:00.000Z",
    })
  })

  it("emits the viewer's feature-flag layers, not a resolved map", async () => {
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({ head: 0n, retainedFrom: 0n } as never)
    spyOn(BotRepository, "listVisibleTo").mockResolvedValue([] as never)
    spyOn(AgentSessionRepository, "listRunningByWorkspace").mockResolvedValue([] as never)

    const deps = makeDeps([])
    // Override the default empty-layers mock so the assertion has something to bite on.
    ;(deps as any).featureFlagService.getFlagLayers = async () => ({
      workspace: { calls: "off" },
      user: { newComposer: "on" },
    })
    const handlers = createWorkspaceHandlers(deps)
    const { req, res, getJson } = makeReqRes()

    await handlers.bootstrap(req, res)

    expect(getJson().data.featureFlags).toEqual({ workspace: { calls: "off" }, user: { newComposer: "on" } })
  })
})
