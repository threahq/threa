import { beforeEach, describe, expect, it } from "vitest"
import { LabelableResourceTypes, type Label, type LabelAssignment, type LabelMember } from "@threa/types"
import { db } from "@/db"
import { reconcileLabels, selectLabelStreams, type CachedLabelAssignment } from "./use-labels"
import type { CachedStream } from "@/db"

const WORKSPACE_ID = "ws_test"

function makeLabel(overrides: Partial<Label> & { id: string }): Label {
  const now = new Date().toISOString()
  return {
    workspaceId: WORKSPACE_ID,
    visibility: "private",
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

function makeMember(overrides: Partial<LabelMember> & { labelId: string; userId: string }): LabelMember {
  return {
    workspaceId: WORKSPACE_ID,
    joinedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeAssignment(
  overrides: Partial<LabelAssignment> & { labelId: string; resourceId: string }
): LabelAssignment {
  return {
    workspaceId: WORKSPACE_ID,
    resourceType: "stream",
    userId: "user_me",
    assignedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("reconcileLabels", () => {
  beforeEach(async () => {
    await db.labels.clear()
    await db.labelMemberships.clear()
    await db.labelAssignments.clear()
  })

  it("inserts labels and memberships from the server response", async () => {
    await reconcileLabels(
      WORKSPACE_ID,
      [makeLabel({ id: "lbl_1", name: "First" }), makeLabel({ id: "lbl_2", name: "Second" })],
      [makeMember({ labelId: "lbl_1", userId: "user_other" })],
      []
    )

    const labels = await db.labels.where("workspaceId").equals(WORKSPACE_ID).toArray()
    const memberships = await db.labelMemberships.where("workspaceId").equals(WORKSPACE_ID).toArray()

    expect(labels.map((l) => l.id).sort()).toEqual(["lbl_1", "lbl_2"])
    expect(memberships).toHaveLength(1)
    expect(memberships[0].id).toBe(`${WORKSPACE_ID}:lbl_1:user_other`)
  })

  it("deletes cached labels missing from the server response", async () => {
    await db.labels.put({
      ...makeLabel({ id: "lbl_stale", name: "Stale" }),
      _cachedAt: Date.now() - 60_000,
    })

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_kept", name: "Kept" })], [], [])

    const labels = await db.labels.where("workspaceId").equals(WORKSPACE_ID).toArray()
    expect(labels.map((l) => l.id)).toEqual(["lbl_kept"])
  })

  it("cascades membership deletion when a label is pruned", async () => {
    await db.labels.put({
      ...makeLabel({ id: "lbl_stale" }),
      _cachedAt: Date.now() - 60_000,
    })
    await db.labelMemberships.put({
      id: `${WORKSPACE_ID}:lbl_stale:user_other`,
      workspaceId: WORKSPACE_ID,
      labelId: "lbl_stale",
      userId: "user_other",
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now() - 60_000,
    })

    await reconcileLabels(WORKSPACE_ID, [], [], [])

    const labels = await db.labels.where("workspaceId").equals(WORKSPACE_ID).count()
    const memberships = await db.labelMemberships.where("workspaceId").equals(WORKSPACE_ID).count()
    expect(labels).toBe(0)
    expect(memberships).toBe(0)
  })

  it("only touches the targeted workspace", async () => {
    // Seed an unrelated workspace's row — it should survive reconciliation
    // for WORKSPACE_ID.
    await db.labels.put({
      ...makeLabel({ id: "lbl_other_ws", workspaceId: "ws_other" }),
      _cachedAt: Date.now(),
    })

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_local" })], [], [])

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
      [],
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

  it("returns an empty list when nothing carries the label", () => {
    expect(
      selectLabelStreams([cachedAssignment("label_a", "stream_1")], [cachedStream("stream_1")], "label_z")
    ).toEqual([])
  })
})
