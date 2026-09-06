import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_QUICK_LINKS,
  SIDEBAR_CONFIG_VERSION,
  type Activity,
  type StreamMember,
  type WorkspaceBootstrap,
} from "@threahq/types"
import type { Socket } from "socket.io-client"
import Dexie from "dexie"
import { db } from "@/db"
import { bumpAccountGeneration } from "@/db/event-writes"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { CatchUpBatch, LiveCommitBatch } from "./catch-up-batch"
import { registerWorkspaceSocketHandlers } from "./workspace-sync"

const WORKSPACE_ID = "ws_live"

const preview = {
  authorId: "member_2",
  authorType: "user" as const,
  content: "hello from the server",
  createdAt: "2026-08-04T10:00:00.000Z",
}

function makeBootstrap(overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  return {
    workspace: {
      id: WORKSPACE_ID,
      name: "Test",
      slug: "test",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    users: [],
    streams: [],
    streamMemberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
    labels: [],
    labelAssignments: [],
    emojis: [],
    emojiWeights: {},
    commands: [],
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    mutedStreamIds: [],
    featureFlags: { workspace: {}, user: {} },
    sidebarConfig: DEFAULT_SIDEBAR_CONFIG,
    userPreferences: {
      workspaceId: WORKSPACE_ID,
      userId: "user_1",
      theme: "system",
      messageSendMode: "enter",
      messageDisplay: "default",
      accessibility: {
        fontSize: "medium",
        fontFamily: "default",
        reducedMotion: false,
        highContrast: false,
      },
      keyboardShortcuts: {},
      quickLinks: DEFAULT_QUICK_LINKS,
      sidebarConfigVersion: SIDEBAR_CONFIG_VERSION,
    },
    ...overrides,
  } as unknown as WorkspaceBootstrap
}

function workspaceUser() {
  return {
    id: "member_1",
    workspaceId: WORKSPACE_ID,
    workosUserId: "workos_1",
    email: "a@b.c",
    name: "A",
    slug: "a",
    role: "member",
    avatarUrl: null,
    createdAt: new Date().toISOString(),
  } as never
}

function membership(streamId: string): StreamMember {
  return {
    id: `mem_${streamId}`,
    streamId,
    userId: "member_1",
    role: "member",
    joinedAt: new Date().toISOString(),
  } as unknown as StreamMember
}

function activityRow(id: string, streamId: string): Activity {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    userId: "member_1",
    activityType: "message",
    streamId,
    messageId: `msg_${id}`,
    actorId: "member_2",
    actorType: "user",
    context: {},
    readAt: null,
    createdAt: "2026-08-04T09:00:00.000Z",
    isSelf: false,
    emoji: null,
  } as unknown as Activity
}

function createTestSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => unknown>>()
  const socket = {
    on(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return this
    },
    off(event: string, handler: (payload: unknown) => void) {
      handlers.get(event)?.delete(handler)
      return this
    },
  } as unknown as Socket
  return {
    socket,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.forEach((handler) => handler(payload))
    },
  }
}

function activity(streamId: string, messageOrdinal: number) {
  return {
    workspaceId: WORKSPACE_ID,
    streamId,
    authorId: "member_2",
    sequence: String(messageOrdinal),
    messageOrdinal,
    lastMessagePreview: { ...preview, content: `message ${messageOrdinal}` },
  }
}

async function seedFixture(queryClient: QueryClient, streamIds: string[]) {
  const unreadActivities = streamIds.map((streamId, index) => activityRow(`act_${index}`, streamId))
  queryClient.setQueryData(
    workspaceKeys.bootstrap(WORKSPACE_ID),
    makeBootstrap({
      users: [workspaceUser()],
      streams: streamIds.map(
        (id) => ({ id, workspaceId: WORKSPACE_ID, rootStreamId: id, lastMessagePreview: null }) as never
      ),
      streamMemberships: streamIds.map(membership),
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: Object.fromEntries(streamIds.map((id) => [id, 1])),
      unreadActivityCount: streamIds.length,
      unreadActivities,
      messageCounts: Object.fromEntries(streamIds.map((id) => [id, 5])),
    })
  )

  const now = Date.now()
  for (const streamId of streamIds) {
    await db.streams.put({
      id: streamId,
      workspaceId: WORKSPACE_ID,
      rootStreamId: streamId,
      lastMessagePreview: null,
      _cachedAt: now,
    } as never)
  }
  await db.unreadState.put({
    id: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: Object.fromEntries(streamIds.map((id) => [id, 1])),
    unreadActivityCount: streamIds.length,
    unreadActivities,
    latestOrdinals: Object.fromEntries(streamIds.map((id) => [id, 5])),
    mutedStreamIds: [],
    counterTouchedAt: {},
    _cachedAt: now,
  } as never)
}

type Harness = {
  emit: (event: string, payload: unknown) => void
  cleanup: () => void
  liveBatch: LiveCommitBatch
  setCatchUpBatch: (batch: CatchUpBatch | null) => void
}

/** Registers the workspace handlers exactly as the SyncEngine does. `coalesced`
 *  false withholds the batch — the per-event path handlers built without an
 *  engine still take, and the baseline the folded arm is compared against. */
async function register(queryClient: QueryClient, coalesced: boolean): Promise<Harness> {
  const liveBatch = new LiveCommitBatch(queryClient, WORKSPACE_ID)
  let catchUpBatch: CatchUpBatch | null = null
  const { socket, emit } = createTestSocket()
  const cleanup = registerWorkspaceSocketHandlers(socket, WORKSPACE_ID, queryClient, {
    getCurrentStreamId: () => undefined,
    getCurrentUser: () => ({ id: "workos_1" }),
    subscribeStream: vi.fn(),
    getCatchUpBatch: () => catchUpBatch,
    getLiveCommitBatch: () => (coalesced ? liveBatch : null),
  })
  return {
    emit,
    cleanup: () => {
      cleanup()
      liveBatch.destroy()
    },
    liveBatch,
    setCatchUpBatch: (batch) => {
      catchUpBatch = batch
    },
  }
}

/** Resolve every scheduled microtask flush and its awaited IDB work. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function bootstrapOf(queryClient: QueryClient): WorkspaceBootstrap | undefined {
  return queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(WORKSPACE_ID))
}

describe("LiveCommitBatch", () => {
  beforeEach(async () => {
    await Promise.all([db.streams.clear(), db.unreadState.clear()])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("one stream:activity commits one transaction and one cache publication", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const transaction = vi.spyOn(Dexie.prototype, "transaction")
    const setQueryData = vi.spyOn(queryClient, "setQueryData")
    const harness = await register(queryClient, true)

    harness.emit("stream:activity", activity("stream_1", 6))
    await settle()

    expect({
      transactions: transaction.mock.calls.length,
      publications: setQueryData.mock.calls.length,
      unread: bootstrapOf(queryClient)?.unreadCounts.stream_1,
      // The coalesced arm's own composition: the counter fold and the preview
      // land in the SAME bootstrap replacement, so the cache-side preview must
      // advance too, not just db.streams.
      cachePreview: bootstrapOf(queryClient)?.streams.find((s) => s.id === "stream_1")?.lastMessagePreview?.content,
      idbPreview: (await db.streams.get("stream_1"))?.lastMessagePreview?.content,
    }).toEqual({
      transactions: 1,
      publications: 1,
      unread: 1,
      cachePreview: "message 6",
      idbPreview: "message 6",
    })

    harness.cleanup()
  })

  it("five activities in one task fold into one flush", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const transaction = vi.spyOn(Dexie.prototype, "transaction")
    const setQueryData = vi.spyOn(queryClient, "setQueryData")
    const harness = await register(queryClient, true)

    for (let ordinal = 6; ordinal <= 10; ordinal += 1) harness.emit("stream:activity", activity("stream_1", ordinal))
    await settle()

    expect({
      transactions: transaction.mock.calls.length,
      publications: setQueryData.mock.calls.length,
      unread: bootstrapOf(queryClient)?.unreadCounts.stream_1,
      preview: (await db.streams.get("stream_1"))?.lastMessagePreview?.content,
      cachePreview: bootstrapOf(queryClient)?.streams.find((s) => s.id === "stream_1")?.lastMessagePreview?.content,
      ordinal: (await db.unreadState.get(WORKSPACE_ID))?.latestOrdinals?.stream_1,
    }).toEqual({
      transactions: 1,
      publications: 1,
      unread: 5,
      preview: "message 10",
      cachePreview: "message 10",
      ordinal: 10,
    })

    harness.cleanup()
  })

  it("the counter value after a fold equals the value the per-event path settles on", async () => {
    const ordinals = [6, 7, 8]

    const coalescedClient = new QueryClient()
    await seedFixture(coalescedClient, ["stream_1", "stream_2"])
    const coalescedHarness = await register(coalescedClient, true)
    for (const ordinal of ordinals) {
      coalescedHarness.emit("stream:activity", activity("stream_1", ordinal))
      coalescedHarness.emit("stream:activity", activity("stream_2", ordinal))
    }
    await settle()
    const coalescedState = await db.unreadState.get(WORKSPACE_ID)
    const coalescedBootstrap = bootstrapOf(coalescedClient)
    coalescedHarness.cleanup()

    await db.streams.clear()
    await db.unreadState.clear()

    const immediateClient = new QueryClient()
    await seedFixture(immediateClient, ["stream_1", "stream_2"])
    const immediateHarness = await register(immediateClient, false)
    for (const ordinal of ordinals) {
      immediateHarness.emit("stream:activity", activity("stream_1", ordinal))
      immediateHarness.emit("stream:activity", activity("stream_2", ordinal))
    }
    await settle()
    const immediateState = await db.unreadState.get(WORKSPACE_ID)
    const immediateBootstrap = bootstrapOf(immediateClient)
    immediateHarness.cleanup()

    const idbSlice = (state: typeof coalescedState) => ({
      unreadCounts: state?.unreadCounts,
      mentionCounts: state?.mentionCounts,
      activityCounts: state?.activityCounts,
      unreadActivityCount: state?.unreadActivityCount,
      latestOrdinals: state?.latestOrdinals,
    })
    const bootstrapSlice = (bootstrap: WorkspaceBootstrap | undefined) => ({
      unreadCounts: bootstrap?.unreadCounts,
      mentionCounts: bootstrap?.mentionCounts,
      activityCounts: bootstrap?.activityCounts,
      unreadActivityCount: bootstrap?.unreadActivityCount,
      messageCounts: bootstrap?.messageCounts,
    })

    expect({ idb: idbSlice(coalescedState), bootstrap: bootstrapSlice(coalescedBootstrap) }).toEqual({
      idb: idbSlice(immediateState),
      bootstrap: bootstrapSlice(immediateBootstrap),
    })
    expect(coalescedState?.unreadCounts.stream_1).toBe(3)
  })

  it("a failed flush publishes nothing", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)
    const before = bootstrapOf(queryClient)
    vi.spyOn(Dexie.prototype, "transaction").mockRejectedValue(new Error("QuotaExceeded") as never)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    harness.emit("stream:activity", activity("stream_1", 6))
    await settle()

    expect({
      bootstrapUnchanged: bootstrapOf(queryClient) === before,
      unread: bootstrapOf(queryClient)?.unreadCounts.stream_1,
      logged: consoleError.mock.calls.length,
    }).toEqual({ bootstrapUnchanged: true, unread: undefined, logged: 1 })

    harness.cleanup()
  })

  it("a throwing publish does not poison the chain — the next activity still commits and publishes", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    // A mutator dereferencing an unexpected bootstrap shape throws out of the
    // single setQueryData — i.e. out of publish(), past commit()'s try.
    vi.spyOn(queryClient, "setQueryData").mockImplementationOnce(() => {
      throw new TypeError("bad bootstrap shape")
    })

    harness.emit("stream:activity", activity("stream_1", 6))
    await settle()

    harness.emit("stream:activity", activity("stream_1", 7))
    await settle()

    expect({
      unread: bootstrapOf(queryClient)?.unreadCounts.stream_1,
      cachePreview: bootstrapOf(queryClient)?.streams.find((s) => s.id === "stream_1")?.lastMessagePreview?.content,
      idbPreview: (await db.streams.get("stream_1"))?.lastMessagePreview?.content,
      ordinal: (await db.unreadState.get(WORKSPACE_ID))?.latestOrdinals?.stream_1,
      logged: consoleError.mock.calls.length,
    }).toEqual({ unread: 2, cachePreview: "message 7", idbPreview: "message 7", ordinal: 7, logged: 1 })

    harness.cleanup()
  })

  it("a failed flush reports the failure so the engine can reseed", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const onFlushFailed = vi.fn()
    const batch = new LiveCommitBatch(queryClient, WORKSPACE_ID, onFlushFailed)
    vi.spyOn(Dexie.prototype, "transaction").mockRejectedValue(new Error("QuotaExceeded") as never)
    vi.spyOn(console, "error").mockImplementation(() => {})

    batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 3 } }))
    await settle()

    expect(onFlushFailed).toHaveBeenCalledTimes(1)
    batch.destroy()
  })

  it("a preview-only failed flush does not ask the engine to reseed", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const onFlushFailed = vi.fn()
    const batch = new LiveCommitBatch(queryClient, WORKSPACE_ID, onFlushFailed)
    vi.spyOn(Dexie.prototype, "transaction").mockRejectedValue(new Error("QuotaExceeded") as never)
    vi.spyOn(console, "error").mockImplementation(() => {})

    batch.setStreamPreview("stream_1", { ...preview, content: "message 6" })
    await settle()

    expect(onFlushFailed).not.toHaveBeenCalled()
    batch.destroy()
  })

  it("consecutive failing flushes request exactly one reseed until one succeeds", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const onFlushFailed = vi.fn()
    const batch = new LiveCommitBatch(queryClient, WORKSPACE_ID, onFlushFailed)
    const transaction = vi.spyOn(Dexie.prototype, "transaction").mockRejectedValue(new Error("QuotaExceeded") as never)
    vi.spyOn(console, "error").mockImplementation(() => {})

    for (let ordinal = 6; ordinal <= 8; ordinal += 1) {
      batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: ordinal } }))
      await settle()
    }
    const afterThreeFailures = onFlushFailed.mock.calls.length

    transaction.mockRestore()
    batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 9 } }))
    await settle()

    vi.spyOn(Dexie.prototype, "transaction").mockRejectedValue(new Error("QuotaExceeded") as never)
    batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 10 } }))
    await settle()

    expect({ afterThreeFailures, total: onFlushFailed.mock.calls.length }).toEqual({
      afterThreeFailures: 1,
      total: 2,
    })
    batch.destroy()
  })

  it("the activity path's stream.idbTransaction count falls from two to one", async () => {
    const counts = async (coalesced: boolean): Promise<number> => {
      const queryClient = new QueryClient()
      await seedFixture(queryClient, ["stream_1"])
      const harness = await register(queryClient, coalesced)
      const capture = new PerfCapture()
      armPerfCapture(capture)

      harness.emit("stream:activity", activity("stream_1", 6))
      await settle()

      armPerfCapture(NO_CAPTURE)
      harness.cleanup()
      return capture.snapshot().filter((sample) => sample.name === "stream.idbTransaction").length
    }

    expect({ off: await counts(false), on: await counts(true) }).toEqual({ off: 2, on: 1 })
  })

  it("the fold has its own mark: stream.activityApply stays one handler sample per event with or without the batch", async () => {
    const marks = async (coalesced: boolean) => {
      const queryClient = new QueryClient()
      await seedFixture(queryClient, ["stream_1"])
      const harness = await register(queryClient, coalesced)
      const capture = new PerfCapture()
      armPerfCapture(capture)

      for (const ordinal of [6, 7, 8]) harness.emit("stream:activity", activity("stream_1", ordinal))
      await settle()

      armPerfCapture(NO_CAPTURE)
      harness.cleanup()
      const of = (name: string) => capture.snapshot().filter((sample) => sample.name === name)
      return { apply: of("stream.activityApply").length, fold: of("stream.liveCommitFold").length }
    }

    // One handler sample per event in each arm — the same population, so the
    // arms are readable against each other. The fold's persist-and-publish is a
    // separate name emitted once per flush, and only when the flag is armed.
    expect({ off: await marks(false), on: await marks(true) }).toEqual({
      off: { apply: 3, fold: 0 },
      on: { apply: 3, fold: 1 },
    })
  })

  it("the fold's own mark carries a duration", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)
    const capture = new PerfCapture()
    armPerfCapture(capture)

    harness.emit("stream:activity", activity("stream_1", 6))
    const beforeFlush = capture.snapshot().filter((sample) => sample.name === "stream.liveCommitFold").length
    await settle()
    const samples = capture.snapshot().filter((sample) => sample.name === "stream.liveCommitFold")

    armPerfCapture(NO_CAPTURE)
    expect({ beforeFlush, afterFlush: samples.length, valued: typeof samples.at(-1)?.value }).toEqual({
      beforeFlush: 0,
      afterFlush: 1,
      valued: "number",
    })

    harness.cleanup()
  })

  it("a read_all delivered after a held activity in the same drain does not leave the activity behind", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)

    // One drain, delivery order preserved: the mention lands, then the user's
    // other device marks everything read. Routed around the batch, read-all's
    // transaction opens at handler time and drops nothing (the row is still
    // buffered), so the mention is resurrected and then sticks.
    harness.emit("activity:created", {
      workspaceId: WORKSPACE_ID,
      targetUserId: "member_1",
      activity: {
        id: "act_new",
        activityType: "mention",
        streamId: "stream_1",
        messageId: "msg_new",
        actorId: "member_2",
        actorType: "user",
        context: {},
        createdAt: "2026-08-04T10:00:00.000Z",
        isSelf: false,
        emoji: null,
      },
    })
    harness.emit("stream:read_all", {
      workspaceId: WORKSPACE_ID,
      authorId: "member_1",
      streamIds: ["stream_1"],
      reads: [{ streamId: "stream_1", lastReadOrdinal: 5 }],
    })
    await settle()

    expect({
      idb: (await db.unreadState.get(WORKSPACE_ID))?.unreadActivities?.map((row) => row.id),
      cache: bootstrapOf(queryClient)?.unreadActivities?.map((row) => row.id),
    }).toEqual({ idb: [], cache: [] })

    harness.cleanup()
  })

  it("a publish failure reseeds like a persist failure, once per successful commit", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const onFlushFailed = vi.fn()
    const batch = new LiveCommitBatch(queryClient, WORKSPACE_ID, onFlushFailed)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const setQueryData = vi.spyOn(queryClient, "setQueryData").mockImplementationOnce(() => {
      throw new TypeError("bad bootstrap shape")
    })

    batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 3 } }))
    await settle()
    const afterFirst = onFlushFailed.mock.calls.length

    // A successful commit clears the latch, so a later publish failure reseeds again.
    batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 4 } }))
    await settle()
    setQueryData.mockImplementationOnce(() => {
      throw new TypeError("bad bootstrap shape")
    })
    batch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 5 } }))
    await settle()

    expect({ afterFirst, total: onFlushFailed.mock.calls.length }).toEqual({ afterFirst: 1, total: 2 })
    batch.destroy()
  })

  it("a fold buffered before an account switch writes nothing after it", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)
    const before = bootstrapOf(queryClient)

    harness.emit("stream:activity", activity("stream_1", 6))
    // What flushModuleStoreCaches does on a switch, before `db` is repointed.
    bumpAccountGeneration()
    await settle()

    expect({
      bootstrapUnchanged: bootstrapOf(queryClient) === before,
      idbOrdinal: (await db.unreadState.get(WORKSPACE_ID))?.latestOrdinals?.stream_1,
      preview: (await db.streams.get("stream_1"))?.lastMessagePreview,
    }).toEqual({ bootstrapUnchanged: true, idbOrdinal: 5, preview: null })

    harness.cleanup()
  })

  it("a catch-up window opening flushes the live batch first", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)

    // A live activity buffered in the same task the catch-up window opens in.
    harness.emit("stream:activity", activity("stream_1", 6))

    // What SyncEngine.performActiveCatchUp does before installing the batch.
    await harness.liveBatch.flush()
    const afterLiveFlush = (await db.unreadState.get(WORKSPACE_ID))?.latestOrdinals?.stream_1

    const catchUpBatch = new CatchUpBatch(queryClient, WORKSPACE_ID)
    harness.setCatchUpBatch(catchUpBatch)
    harness.emit("stream:activity", activity("stream_1", 7))
    await catchUpBatch.flush()
    harness.setCatchUpBatch(null)
    await settle()

    expect({
      afterLiveFlush,
      ordinal: (await db.unreadState.get(WORKSPACE_ID))?.latestOrdinals?.stream_1,
      unread: (await db.unreadState.get(WORKSPACE_ID))?.unreadCounts.stream_1,
      preview: (await db.streams.get("stream_1"))?.lastMessagePreview?.content,
    }).toEqual({ afterLiveFlush: 6, ordinal: 7, unread: 2, preview: "message 7" })

    harness.cleanup()
  })

  it("an activity for a stream with no bootstrap cache invalidates rather than dropping", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)

    // The counter arm reads the bootstrap synchronously in the handler, so drive
    // the batch directly for the case where the cache is gone by flush time.
    harness.liveBatch.applyCounter((state) => ({ ...state, unreadCounts: { ...state.unreadCounts, stream_1: 9 } }))
    queryClient.removeQueries({ queryKey: workspaceKeys.bootstrap(WORKSPACE_ID) })
    await settle()

    expect(
      invalidateQueries.mock.calls.some(
        (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(workspaceKeys.bootstrap(WORKSPACE_ID))
      )
    ).toBe(true)
    expect((await db.unreadState.get(WORKSPACE_ID))?.unreadCounts.stream_1).toBe(9)

    harness.cleanup()
  })

  it("a flush scheduled before teardown does not write afterwards", async () => {
    const queryClient = new QueryClient()
    await seedFixture(queryClient, ["stream_1"])
    const harness = await register(queryClient, true)
    const before = bootstrapOf(queryClient)

    harness.emit("stream:activity", activity("stream_1", 6))
    harness.liveBatch.destroy()
    await settle()

    expect({
      bootstrapUnchanged: bootstrapOf(queryClient) === before,
      idbOrdinal: (await db.unreadState.get(WORKSPACE_ID))?.latestOrdinals?.stream_1,
      preview: (await db.streams.get("stream_1"))?.lastMessagePreview,
    }).toEqual({ bootstrapUnchanged: true, idbOrdinal: 5, preview: null })

    harness.cleanup()
  })
})
