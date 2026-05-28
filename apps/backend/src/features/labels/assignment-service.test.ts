import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { LabelableResourceTypes, Visibilities, type Label, type LabelAssignment } from "@threa/types"
import { LabelAssignmentService } from "./assignment-service"
import { LabelRepository, LabelAssignmentRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
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

  it("assigns a public label and emits label:assigned to the assigning user", async () => {
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
        targetUserId: USER_ID,
        assignment: expect.objectContaining({ labelId: LABEL_ID, resourceId: RESOURCE_ID }),
      })
    )
  })

  it("assigns the user's own private label", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(
      fakeLabel({ visibility: Visibilities.PRIVATE, creatorUserId: USER_ID })
    )
    spyOn(LabelAssignmentRepository, "assign").mockResolvedValue(fakeAssignment())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.assign(assignParams)

    expect(outboxSpy).toHaveBeenCalledWith(expect.anything(), "label:assigned", expect.anything())
  })
})

describe("LabelAssignmentService.unassign", () => {
  afterEach(() => mock.restore())

  it("emits label:unassigned when a row was removed", async () => {
    const service = setupService()
    spyOn(LabelAssignmentRepository, "unassign").mockResolvedValue(true)
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.unassign(assignParams)

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:unassigned",
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        targetUserId: USER_ID,
        labelId: LABEL_ID,
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
        userId: USER_ID,
      })
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
