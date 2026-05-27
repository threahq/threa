import { beforeEach, describe, expect, it } from "vitest"
import type { Label, LabelMember } from "@threa/types"
import { db } from "@/db"
import { reconcileLabels } from "./use-labels"

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

describe("reconcileLabels", () => {
  beforeEach(async () => {
    await db.labels.clear()
    await db.labelMemberships.clear()
  })

  it("inserts labels and memberships from the server response", async () => {
    await reconcileLabels(
      WORKSPACE_ID,
      [makeLabel({ id: "lbl_1", name: "First" }), makeLabel({ id: "lbl_2", name: "Second" })],
      [makeMember({ labelId: "lbl_1", userId: "user_other" })]
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

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_kept", name: "Kept" })], [])

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

    await reconcileLabels(WORKSPACE_ID, [], [])

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

    await reconcileLabels(WORKSPACE_ID, [makeLabel({ id: "lbl_local" })], [])

    const other = await db.labels.where("workspaceId").equals("ws_other").toArray()
    expect(other.map((l) => l.id)).toEqual(["lbl_other_ws"])
  })
})
