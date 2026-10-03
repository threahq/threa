import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { OutboxEvent } from "../../lib/outbox"
import type { ControlPlaneClient } from "../../lib/control-plane-client"
import { UserRepository } from "../workspaces"
import { InvitationRepository, type Invitation } from "./repository"
import { InvitationShadowSyncHandler } from "./shadow-sync-outbox-handler"

const root: Invitation = {
  id: "inv_root",
  workspaceId: "ws_1",
  kind: "link",
  email: null,
  role: "member",
  invitedBy: "usr_admin",
  workosInvitationId: null,
  tokenHash: "hash",
  note: null,
  status: "pending",
  createdAt: new Date(),
  expiresAt: null,
  acceptedAt: null,
  revokedAt: null,
  parentLinkId: null,
  maxUses: 2,
  useCount: 0,
  acceptedWorkosUserId: null,
  acceptanceConsumesCapacity: null,
  revision: 1,
}
const child: Invitation = {
  ...root,
  id: "inv_child",
  email: "new@example.com",
  tokenHash: null,
  parentLinkId: root.id,
  maxUses: null,
  status: "accepted",
  acceptedAt: new Date(),
  acceptedWorkosUserId: "workos_1",
}

class TestHandler extends InvitationShadowSyncHandler {
  process(event: OutboxEvent) {
    return this.processEvent(event)
  }
}

const controlPlane = {
  createInvitationShadow: mock(() => Promise.resolve()),
  notifyInvitationLinkClaimed: mock(() => Promise.resolve()),
  acknowledgeInvitationAccepted: mock((_ack: unknown) => Promise.resolve()),
  updateInvitationLinkShadow: mock(() => Promise.resolve()),
  revokeInvitationShadow: mock(() => Promise.resolve()),
}
const findById = spyOn(InvitationRepository, "findById")
const isMember = spyOn(UserRepository, "isMember")
const handler = new TestHandler({} as Pool, controlPlane as unknown as ControlPlaneClient, "local")

function event(eventType: string, payload: Record<string, unknown>): OutboxEvent {
  return { id: 1n, eventType, payload, createdAt: new Date() } as unknown as OutboxEvent
}

function lookups() {
  return findById.mock.calls.map((call) => call.slice(1))
}

beforeEach(() => {
  findById.mockReset().mockImplementation(async (_db, _workspaceId, id) => (id === root.id ? root : child))
  isMember.mockReset().mockResolvedValue(true)
  for (const call of Object.values(controlPlane)) call.mockClear()
})

afterAll(() => {
  mock.restore()
})

describe("InvitationShadowSyncHandler", () => {
  test("should look up a sent invitation in the workspace the event names", async () => {
    await handler.process(
      event("invitation:sent", {
        workspaceId: "ws_1",
        invitationId: "inv_child",
        email: "new@example.com",
        role: "member",
      })
    )

    expect(lookups()).toEqual([["ws_1", "inv_child"]])
  })

  test("should look up a created link in the workspace the event names", async () => {
    await handler.process(
      event("invitation:link-created", {
        workspaceId: "ws_1",
        invitationId: "inv_root",
        parentInvitationId: "inv_root",
        tokenHash: "hash",
        role: "member",
      })
    )

    expect(lookups()).toEqual([["ws_1", "inv_root"]])
  })

  test("should look up both the root and the parent of a claim in the workspace the event names", async () => {
    await handler.process(
      event("invitation:link-claimed", {
        workspaceId: "ws_1",
        invitationId: "inv_root",
        email: "new@example.com",
        role: "member",
      })
    )
    await handler.process(
      event("invitation:link-claimed", {
        workspaceId: "ws_1",
        invitationId: "inv_child",
        parentInvitationId: "inv_root",
        email: "new@example.com",
        role: "member",
      })
    )

    expect(lookups()).toEqual([
      ["ws_1", "inv_root"],
      ["ws_1", "inv_root"],
    ])
  })

  test("should look up and acknowledge an accepted invitation in the workspace the event names", async () => {
    await handler.process(
      event("invitation:accepted", {
        workspaceId: "ws_1",
        invitationId: "inv_child",
        email: "new@example.com",
        workosUserId: "workos_1",
        userName: "New User",
      })
    )

    expect({
      lookups: lookups(),
      memberChecks: isMember.mock.calls.map((call) => call.slice(1)),
      acknowledged: controlPlane.acknowledgeInvitationAccepted.mock.calls,
    }).toEqual({
      lookups: [
        ["ws_1", "inv_child"],
        ["ws_1", "inv_root"],
      ],
      memberChecks: [["ws_1", "workos_1"]],
      acknowledged: [
        [
          {
            invitationId: "inv_child",
            workspaceId: "ws_1",
            email: "new@example.com",
            workosUserId: "workos_1",
            parentInvitationId: "inv_root",
            expiresAt: null,
            maxUses: 2,
            useCount: 0,
            revision: 1,
            status: "pending",
          },
        ],
      ],
    })
  })

  test("should look up a revoked invitation in the workspace the event names", async () => {
    await handler.process(event("invitation:revoked", { workspaceId: "ws_1", invitationId: "inv_child" }))

    expect(lookups()).toEqual([["ws_1", "inv_child"]])
  })
})
