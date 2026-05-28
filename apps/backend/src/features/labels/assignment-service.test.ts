import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { LabelableResourceTypes, Visibilities, type Label, type LabelAssignment } from "@threa/types"
import { LabelAssignmentService } from "./assignment-service"
import { LabelRepository, LabelAssignmentRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as streamsBarrel from "../streams"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const OTHER_USER_ID = "usr_2"
const LABEL_ID = "label_1"
const RESOURCE_ID = "stream_1"
const NOW = "2026-05-28T12:00:00.000Z"

function fakeLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: LABEL_ID,
    workspaceId: WORKSPACE_ID,
    visibility: Visibilities.PUBLIC,
    creatorUserId: USER_ID,
    name: "Priority",
    slug: "priority",
    color: "#ff0000",
    emoji: null,
    description: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  }
}

function fakeAssignment(overrides: Partial<LabelAssignment> = {}): LabelAssignment {
  return {
    labelId: LABEL_ID,
    resourceType: LabelableResourceTypes.STREAM,
    resourceId: RESOURCE_ID,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    assignedAt: NOW,
    ...overrides,
  }
}

function setupService() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  return new LabelAssignmentService({ pool: {} as any })
}

const assignParams = {
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  labelId: LABEL_ID,
  resourceType: LabelableResourceTypes.STREAM,
  resourceId: RESOURCE_ID,
}

describe("LabelAssignmentService.assign", () => {
  afterEach(() => mock.restore())

  it("throws 404 when the label is missing", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(null)

    await expect(service.assign(assignParams)).rejects.toMatchObject({ status: 404 })
  })

  it("throws 404 when the label is archived", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel({ archivedAt: NOW }))

    await expect(service.assign(assignParams)).rejects.toMatchObject({ status: 404 })
  })

  it("throws 404 when applying someone else's private label", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(
      fakeLabel({ visibility: Visibilities.PRIVATE, creatorUserId: OTHER_USER_ID })
    )

    await expect(service.assign(assignParams)).rejects.toMatchObject({ status: 404 })
  })

  it("assigns a public label and fans out to the shared pool (null targetUserId)", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    spyOn(LabelAssignmentRepository, "assign").mockResolvedValue(fakeAssignment())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    const result = await service.assign(assignParams)

    expect(result).toMatchObject({ labelId: LABEL_ID, resourceId: RESOURCE_ID, userId: USER_ID })
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:assigned",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        targetUserId: null,
        assignment: expect.objectContaining({ labelId: LABEL_ID, resourceId: RESOURCE_ID }),
      })
    )
  })

  it("assigns the user's own private label and routes to the creator's user room", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(
      fakeLabel({ visibility: Visibilities.PRIVATE, creatorUserId: USER_ID })
    )
    spyOn(LabelAssignmentRepository, "assign").mockResolvedValue(fakeAssignment())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.assign(assignParams)

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:assigned",
      expect.objectContaining({ targetUserId: USER_ID })
    )
  })
})

describe("LabelAssignmentService.unassign", () => {
  afterEach(() => mock.restore())

  it("emits label:unassigned to the shared pool for a public label (null targetUserId)", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "unassign").mockResolvedValue(true)
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.unassign(assignParams)

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:unassigned",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        targetUserId: null,
        labelId: LABEL_ID,
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
        userId: USER_ID,
      })
    )
  })

  it("emits label:unassigned to the user room for a private label", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "unassign").mockResolvedValue(true)
    spyOn(LabelRepository, "findById").mockResolvedValue(
      fakeLabel({ visibility: Visibilities.PRIVATE, creatorUserId: USER_ID })
    )
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.unassign(assignParams)

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:unassigned",
      expect.objectContaining({ targetUserId: USER_ID })
    )
  })

  it("does not emit when no row was removed (idempotent unassign)", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "unassign").mockResolvedValue(false)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.unassign(assignParams)

    expect(outboxSpy).not.toHaveBeenCalled()
  })
})

describe("LabelAssignmentService.listForViewer", () => {
  afterEach(() => mock.restore())

  it("returns the viewer's own rows without an access query when there are no other-user public rows", async () => {
    const service = setupService()
    const own = fakeAssignment({ userId: USER_ID })
    spyOn(LabelAssignmentRepository, "listVisibleCandidates").mockResolvedValue([own])
    const accessSpy = spyOn(streamsBarrel, "listAccessibleStreamIds")

    const result = await service.listForViewer(WORKSPACE_ID, USER_ID)

    expect(result).toEqual([own])
    expect(accessSpy).not.toHaveBeenCalled()
  })

  it("includes other users' public stream rows only for accessible streams", async () => {
    const service = setupService()
    const own = fakeAssignment({ userId: USER_ID, resourceId: "stream_own" })
    const visiblePublic = fakeAssignment({ userId: OTHER_USER_ID, resourceId: "stream_visible" })
    const hiddenPublic = fakeAssignment({ userId: OTHER_USER_ID, resourceId: "stream_hidden" })
    spyOn(LabelAssignmentRepository, "listVisibleCandidates").mockResolvedValue([own, visiblePublic, hiddenPublic])
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set(["stream_visible"]))

    const result = await service.listForViewer(WORKSPACE_ID, USER_ID)

    expect(result).toEqual([own, visiblePublic])
  })
})
