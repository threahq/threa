import { describe, expect, it } from "bun:test"
import { WORKSPACE_PERMISSION_SCOPES, LabelableResourceTypes } from "@threa/types"
import {
  resolveDeliveryGroups,
  permissionGroupsForRole,
  permissionGroup,
  streamGroup,
  userGroup,
} from "./delivery-groups"
import type { OutboxEvent, OutboxEventType } from "./repository"

function event<T extends OutboxEventType>(eventType: T, payload: Record<string, unknown>): OutboxEvent<T> {
  return { id: 1n, eventType, payload, createdAt: new Date() } as unknown as OutboxEvent<T>
}

const MEMBERS_WRITE_GROUP = permissionGroup(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)

describe("permissionGroup", () => {
  it("names the members:write delivery group on the wire", () => {
    // Pins the group string format once; other suites derive via the helper.
    expect(MEMBERS_WRITE_GROUP).toBe("permission:members:write")
  })
})

describe("resolveDeliveryGroups — invitation events", () => {
  const invitationEvents = [
    "invitation:sent",
    "invitation:accepted",
    "invitation:revoked",
    "invitation:link-created",
    "invitation:link-claimed",
  ] as const

  for (const eventType of invitationEvents) {
    it(`scopes ${eventType} to members:write, never the workspace`, () => {
      const groups = resolveDeliveryGroups(event(eventType, { workspaceId: "ws_1", invitationId: "inv_1" }))
      expect(groups).toEqual([MEMBERS_WRITE_GROUP])
      expect(groups).not.toContain("workspace")
    })
  }
})

describe("resolveDeliveryGroups — label assignments", () => {
  // A public-label assignment (no targetUserId) on a stream routes to that
  // stream's group, so it lands in the sync log under `stream:<id>` and the
  // public-root catch-up leg replays it to non-members — the same reach a
  // message has. This is the routing half of that guarantee; the catch-up half
  // (a non-member of a public channel receives the assignment) is covered in
  // tests/integration/sync-catch-up.test.ts. Together they let the client drop
  // the out-of-band label reconcile the reconnect path used to need.
  it("scopes a public stream-label assignment to the stream group", () => {
    const groups = resolveDeliveryGroups(
      event("label:assigned", {
        workspaceId: "ws_1",
        targetUserId: null,
        assignment: { labelId: "label_1", resourceType: LabelableResourceTypes.STREAM, resourceId: "stream_1" },
      })
    )
    expect(groups).toEqual([streamGroup("stream_1")])
  })

  it("scopes a public stream-label unassignment to the stream group", () => {
    const groups = resolveDeliveryGroups(
      event("label:unassigned", {
        workspaceId: "ws_1",
        targetUserId: null,
        labelId: "label_1",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: "stream_1",
        userId: "usr_1",
      })
    )
    expect(groups).toEqual([streamGroup("stream_1")])
  })

  it("routes a private-label assignment to its owner's user group, not a stream", () => {
    const groups = resolveDeliveryGroups(
      event("label:assigned", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        assignment: { labelId: "label_1", resourceType: LabelableResourceTypes.STREAM, resourceId: "stream_1" },
      })
    )
    expect(groups).toEqual([userGroup("usr_1")])
  })
})

describe("permissionGroupsForRole", () => {
  it("grants the members:write delivery group to admins and owners", () => {
    expect(permissionGroupsForRole("admin")).toEqual([MEMBERS_WRITE_GROUP])
    expect(permissionGroupsForRole("owner")).toEqual([MEMBERS_WRITE_GROUP])
  })

  it("grants no permission delivery groups to plain members", () => {
    expect(permissionGroupsForRole("member")).toEqual([])
  })
})
