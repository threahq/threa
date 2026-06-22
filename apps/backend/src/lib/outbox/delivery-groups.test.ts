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

describe("resolveDeliveryGroups — enclave re-wrap nudges", () => {
  it("routes the socket nudge to the owner only — only they can re-wrap", () => {
    const groups = resolveDeliveryGroups(
      event("enclave:rewrap_needed", { workspaceId: "ws_1", targetUserId: "usr_owner", rootStreamId: "stream_1" })
    )
    expect(groups).toEqual([userGroup("usr_owner")])
    expect(groups).not.toContain("workspace")
  })

  it("keeps the web-push nudge off the wire (null) — it's the push handler's, never a broadcast", () => {
    const groups = resolveDeliveryGroups(
      event("enclave:rewrap_nudge", { workspaceId: "ws_1", targetUserId: "usr_owner", rootStreamId: "stream_1" })
    )
    // Null = not broadcast and not sync-logged (it would otherwise fall through
    // to the workspace-wide default and leak a per-owner signal to everyone).
    expect(groups).toBeNull()
  })
})

describe("resolveDeliveryGroups — label assignments", () => {
  // Labels are owner-scoped, so an assignment routes only to the owning actor's
  // user group — never a stream group, even when the labeled resource is a
  // shared channel. The chip is the actor's own organizational layer.
  it("routes a label assignment to its owner's user group, not a stream", () => {
    const groups = resolveDeliveryGroups(
      event("label:assigned", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        assignment: { labelId: "label_1", resourceType: LabelableResourceTypes.STREAM, resourceId: "stream_1" },
      })
    )
    expect(groups).toEqual([userGroup("usr_1")])
  })

  it("routes a label unassignment to its owner's user group", () => {
    const groups = resolveDeliveryGroups(
      event("label:unassigned", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        labelId: "label_1",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: "stream_1",
        userId: "usr_1",
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

describe("resolveDeliveryGroups — stream archive lifecycle", () => {
  it("routes stream:archived to the root room and every descendant thread room", () => {
    const groups = resolveDeliveryGroups(
      event("stream:archived", {
        workspaceId: "ws_1",
        streamId: "stream_root",
        stream: { id: "stream_root" },
        threadStreamIds: ["stream_thread_a", "stream_thread_b"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_root"), streamGroup("stream_thread_a"), streamGroup("stream_thread_b")])
  })

  it("routes stream:unarchived to the root room and every descendant thread room", () => {
    const groups = resolveDeliveryGroups(
      event("stream:unarchived", {
        workspaceId: "ws_1",
        streamId: "stream_root",
        stream: { id: "stream_root" },
        threadStreamIds: ["stream_thread_a"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_root"), streamGroup("stream_thread_a")])
  })

  it("routes to the root room only when there are no descendant threads", () => {
    const groups = resolveDeliveryGroups(
      event("stream:archived", { workspaceId: "ws_1", streamId: "stream_root", stream: { id: "stream_root" } })
    )
    expect(groups).toEqual([streamGroup("stream_root")])
  })

  it("does not duplicate the root room when a thread id equals the root id (defensive)", () => {
    const groups = resolveDeliveryGroups(
      event("stream:archived", {
        workspaceId: "ws_1",
        streamId: "stream_root",
        stream: { id: "stream_root" },
        threadStreamIds: ["stream_root"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_root")])
  })
})
