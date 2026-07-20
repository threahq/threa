import { describe, expect, it, spyOn, afterEach } from "bun:test"
import type { Request, Response } from "express"
import { createWorkspaceHandlers } from "./handlers"
import { SyncLogRepository } from "../sync"
import { BotRepository } from "../public-api"
import { AgentSessionRepository } from "../agents"

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
    json: (body: any) => {
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

  it("includes archived roots from the service in the bootstrap payload", async () => {
    spyOn(SyncLogRepository, "getHeadAndRetainedFrom").mockResolvedValue({
      head: 0n,
      retainedFrom: 0n,
    } as never)
    spyOn(BotRepository, "listVisibleTo").mockResolvedValue([] as never)
    spyOn(AgentSessionRepository, "listRunningByWorkspace").mockResolvedValue([] as never)

    const archivedChannel = { id: "stream_arch", workspaceId: "ws_1", type: "channel", archivedAt: new Date() }
    // Archived DMs are absent from dmPeers, so the handler must bake the
    // viewer-dependent name onto the row itself.
    const archivedDm = { id: "stream_dm", workspaceId: "ws_1", type: "dm", displayName: null, archivedAt: new Date() }
    const handlers = createWorkspaceHandlers(makeDeps([archivedChannel, archivedDm]))
    const { req, res, getJson } = makeReqRes()

    await handlers.bootstrap(req, res)

    expect(getJson().data.archivedStreams).toEqual([archivedChannel, { ...archivedDm, displayName: "Peer Name" }])
    // Active streams list stays a separate contract (empty here).
    expect(getJson().data.streams).toEqual([])
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
