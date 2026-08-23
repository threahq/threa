import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import { LabelableResourceTypes, type Label, type LabelAssignment } from "@threa/types"
import { db } from "@/db"
import * as contextsModule from "@/contexts"
import {
  labelKeys,
  reconcileLabels,
  selectLabelStreams,
  selectLabeledStreamIds,
  useLabelsSync,
  type CachedLabelAssignment,
} from "./use-labels"
import type { CachedStream } from "@/db"

const WORKSPACE_ID = "ws_test"

function makeLabel(overrides: Partial<Label> & { id: string }): Label {
  const now = new Date().toISOString()
  return {
    workspaceId: WORKSPACE_ID,
    creatorActorType: "user",
    creatorUserId: "user_me",
    name: "Sample",
    slug: "sample",
    color: "#3A91C7",
    emoji: null,
    description: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  }
}

function makeAssignment(
  overrides: Partial<LabelAssignment> & { labelId: string; resourceId: string }
): LabelAssignment {
  return {
    workspaceId: WORKSPACE_ID,
    resourceType: "stream",
    actorType: "user",
    userId: "user_me",
    assignedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("reconcileLabels", () => {
  beforeEach(async () => {
    await db.labels.clear()
    await db.labelAssignments.clear()
  })

  it("inserts labels from the server response", async () => {
    await reconcileLabels(
      WORKSPACE_ID,
      [makeLabel({ id: "lbl_1", name: "First" }), makeLabel({ id: "lbl_2", name: "Second" })],
      []
    )

    const labels = await db.labels.where("workspaceId").equals(WORKSPACE_ID).toArray()
    expect(labels.map((l) => l.id).sort()).toEqual(["lbl_1", "lbl_2"])
  })

  it("deletes cached labels missing from the server response", async () => {
    await db.labels.put({
      ...makeLabel({ id: "lbl_stale", name: "Stale" }),
      _cachedAt: Date.now() - 60_000,
    })

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_kept", name: "Kept" })], [])

    const labels = await db.labels.where("workspaceId").equals(WORKSPACE_ID).toArray()
    expect(labels.map((l) => l.id)).toEqual(["lbl_kept"])
  })

  it("preserves a row written after the fetch started (socket race)", async () => {
    const fetchStartedAt = Date.now()
    // A `label:*` socket handler wrote this row while the HTTP snapshot was in
    // flight, so the snapshot can't know about it — its _cachedAt is newer than
    // the fetch start and it must survive the prune.
    await db.labels.put({ ...makeLabel({ id: "lbl_socket", name: "Socket" }), _cachedAt: fetchStartedAt + 5_000 })

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_snapshot" })], [], fetchStartedAt)

    const labels = await db.labels.where("workspaceId").equals(WORKSPACE_ID).toArray()
    expect(labels.map((l) => l.id).sort()).toEqual(["lbl_snapshot", "lbl_socket"])
  })

  it("only touches the targeted workspace", async () => {
    // Seed an unrelated workspace's row — it should survive reconciliation
    // for WORKSPACE_ID.
    await db.labels.put({
      ...makeLabel({ id: "lbl_other_ws", workspaceId: "ws_other" }),
      _cachedAt: Date.now(),
    })

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_local" })], [])

    const other = await db.labels.where("workspaceId").equals("ws_other").toArray()
    expect(other.map((l) => l.id)).toEqual(["lbl_other_ws"])
  })

  it("upserts assignments and prunes ones missing from the server response", async () => {
    // A stale assignment cached from before — the server no longer reports it.
    await db.labelAssignments.put({
      id: `${WORKSPACE_ID}:stream:strm_stale:lbl_1:user_me`,
      workspaceId: WORKSPACE_ID,
      labelId: "lbl_1",
      resourceType: "stream",
      resourceId: "strm_stale",
      userId: "user_me",
      assignedAt: new Date().toISOString(),
      _cachedAt: Date.now() - 60_000,
    })

    await reconcileLabels(
      WORKSPACE_ID,
      [makeLabel({ id: "lbl_1" })],
      [makeAssignment({ labelId: "lbl_1", resourceId: "strm_live" })]
    )

    const assignments = await db.labelAssignments.where("workspaceId").equals(WORKSPACE_ID).toArray()
    expect(assignments.map((a) => a.resourceId)).toEqual(["strm_live"])
    expect(assignments[0].id).toBe(`${WORKSPACE_ID}:stream:strm_live:lbl_1:user_me`)
  })
})

function cachedAssignment(
  labelId: string,
  resourceId: string,
  overrides: Partial<CachedLabelAssignment> = {}
): CachedLabelAssignment {
  return {
    id: `${WORKSPACE_ID}:${LabelableResourceTypes.STREAM}:${resourceId}:${labelId}:user_me`,
    workspaceId: WORKSPACE_ID,
    labelId,
    resourceType: LabelableResourceTypes.STREAM,
    resourceId,
    userId: "user_me",
    assignedAt: "2026-01-01T00:00:00.000Z",
    _cachedAt: 0,
    ...overrides,
  }
}

function cachedStream(id: string, overrides: Partial<CachedStream> = {}): CachedStream {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    type: "scratchpad",
    displayName: id,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_me",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    lastMessagePreview: null,
    _cachedAt: 0,
    ...overrides,
  }
}

describe("selectLabelStreams", () => {
  it("returns the streams carrying the label, newest activity first", () => {
    const assignments = [cachedAssignment("label_a", "stream_old"), cachedAssignment("label_a", "stream_new")]
    const streams = [
      cachedStream("stream_old", {
        lastMessagePreview: {
          authorId: "user_me",
          authorType: "user",
          content: "x",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      }),
      cachedStream("stream_new", {
        lastMessagePreview: {
          authorId: "user_me",
          authorType: "user",
          content: "y",
          createdAt: "2026-03-01T00:00:00.000Z",
        },
      }),
    ]

    expect(selectLabelStreams(assignments, streams, "label_a").map((s) => s.id)).toEqual(["stream_new", "stream_old"])
  })

  it("includes threads — a labeled thread is just a stream of type thread", () => {
    const assignments = [cachedAssignment("label_a", "thread_1")]
    const streams = [cachedStream("thread_1", { type: "thread", displayName: "A thread" })]

    expect(selectLabelStreams(assignments, streams, "label_a")).toEqual([streams[0]])
  })

  it("ignores assignments for other labels, other resource types, and archived streams", () => {
    const assignments = [
      cachedAssignment("label_a", "stream_keep"),
      cachedAssignment("label_b", "stream_other_label"),
      cachedAssignment("label_a", "stream_archived"),
      cachedAssignment("label_a", "msg_1", { resourceType: "message" as CachedLabelAssignment["resourceType"] }),
    ]
    const streams = [
      cachedStream("stream_keep"),
      cachedStream("stream_other_label"),
      cachedStream("stream_archived", { archivedAt: "2026-02-01T00:00:00.000Z" }),
    ]

    expect(selectLabelStreams(assignments, streams, "label_a").map((s) => s.id)).toEqual(["stream_keep"])
  })

  it("never lists an aside under a label (asides are reachable by anchor row only)", () => {
    const assignments = [cachedAssignment("label_a", "stream_keep"), cachedAssignment("label_a", "stream_aside")]
    const streams = [cachedStream("stream_keep"), cachedStream("stream_aside", { type: "aside" })]

    expect(selectLabelStreams(assignments, streams, "label_a").map((s) => s.id)).toEqual(["stream_keep"])
  })

  it("returns an empty list when nothing carries the label", () => {
    expect(
      selectLabelStreams([cachedAssignment("label_a", "stream_1")], [cachedStream("stream_1")], "label_z")
    ).toEqual([])
  })
})

describe("selectLabeledStreamIds", () => {
  it("returns null when no labels are selected — no filter, not an empty match", () => {
    expect(selectLabeledStreamIds([cachedAssignment("label_a", "stream_1")], [])).toBeNull()
  })

  it("collects the stream ids for any of the selected labels", () => {
    const assignments = [
      cachedAssignment("label_a", "stream_1"),
      cachedAssignment("label_b", "stream_2"),
      cachedAssignment("label_c", "stream_3"),
    ]
    expect(selectLabeledStreamIds(assignments, ["label_a", "label_b"])).toEqual(new Set(["stream_1", "stream_2"]))
  })

  it("ignores non-stream assignments and returns an empty set when nothing matches", () => {
    const assignments = [
      cachedAssignment("label_a", "msg_1", { resourceType: "message" as CachedLabelAssignment["resourceType"] }),
    ]
    expect(selectLabeledStreamIds(assignments, ["label_a"])).toEqual(new Set())
  })
})

describe("useLabelsSync refetchOnReconnect", () => {
  let listFn: ReturnType<typeof vi.fn>
  const response = { labels: [], assignments: [] }

  beforeEach(async () => {
    vi.restoreAllMocks()
    onlineManager.setOnline(true)
    await Promise.all([db.labels.clear(), db.labelAssignments.clear()])
    listFn = vi.fn().mockResolvedValue(response)
    vi.spyOn(contextsModule, "useLabelService").mockReturnValue({
      list: listFn,
    } as unknown as contextsModule.LabelService)
  })

  it("does not refetch on the online flip even when invalidated while offline", async () => {
    // With staleTime Infinity, a reconnect refetch only ever fires for an
    // invalidated query, so invalidated-while-offline is the one state where
    // `refetchOnReconnect: true` and `false` behave differently on the online
    // flip. Pin that the flip does not refetch: reconnect healing for labels
    // is the engine's bootstrap reconcile plus catch-up replay through the
    // gate-registered workspace-sync handlers, not this query.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    renderHook(() => useLabelsSync(WORKSPACE_ID), { wrapper })
    // Wait for the fetch to SETTLE (not just for listFn to be called) — a
    // success landing after the invalidation would reset isInvalidated and
    // make the assertion pass for the wrong reason.
    await waitFor(() => expect(queryClient.getQueryData(labelKeys.list(WORKSPACE_ID))).toEqual(response))

    await act(async () => {
      onlineManager.setOnline(false)
      await queryClient.invalidateQueries({ queryKey: labelKeys.list(WORKSPACE_ID), refetchType: "none" })
    })

    await act(async () => {
      onlineManager.setOnline(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(listFn).toHaveBeenCalledTimes(1)
  })
})
