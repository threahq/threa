import { describe, expect, it } from "bun:test"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import { resolveDeliveryGroups, permissionGroupsForRole, permissionGroup } from "./delivery-groups"
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

describe("permissionGroupsForRole", () => {
  it("grants the members:write delivery group to admins and owners", () => {
    expect(permissionGroupsForRole("admin")).toEqual([MEMBERS_WRITE_GROUP])
    expect(permissionGroupsForRole("owner")).toEqual([MEMBERS_WRITE_GROUP])
  })

  it("grants no permission delivery groups to plain members", () => {
    expect(permissionGroupsForRole("member")).toEqual([])
  })
})
