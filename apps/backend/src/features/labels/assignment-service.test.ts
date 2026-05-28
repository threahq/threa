import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { LabelableResourceTypes, Visibilities, type Label, type LabelAssignment, type Visibility } from "@threa/types"
import { LabelAssignmentService } from "./assignment-service"
import { LabelRepository, LabelAssignmentRepository, type VisibleAssignmentCandidate } from "./repository"
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

function fakeCandidate(
  overrides: Partial<LabelAssignment> & { labelVisibility?: Visibility } = {}
): VisibleAssignmentCandidate {
  const { labelVisibility = Visibilities.PUBLIC, ...rest } = overrides
  return { ...fakeAssignment(rest), labelVisibility }
}

function stripVisibility(candidate: VisibleAssignmentCandidate): LabelAssignment {
  const { labelVisibility: _labelVisibility, ...assignment } = candidate
  return assignment
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
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set([RESOURCE_ID]))

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
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set([RESOURCE_ID]))

    await service.assign(assignParams)

    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:assigned",
      expect.objectContaining({ targetUserId: USER_ID })
    )
  })

  it("throws 404 without writing or emitting when the caller cannot access the target stream", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    const assignSpy = spyOn(LabelAssignmentRepository, "assign").mockResolvedValue(fakeAssignment())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set())

    await expect(service.assign(assignParams)).rejects.toMatchObject({ status: 404 })
    expect(assignSpy).not.toHaveBeenCalled()
    expect(outboxSpy).not.toHaveBeenCalled()
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

  it("returns the viewer's own private rows without an access query", async () => {
    const service = setupService()
    const ownPrivate = fakeCandidate({ labelVisibility: Visibilities.PRIVATE, userId: USER_ID })
    spyOn(LabelAssignmentRepository, "listVisibleCandidates").mockResolvedValue([ownPrivate])
    const accessSpy = spyOn(streamsBarrel, "listAccessibleStreamIds")

    const result = await service.listForViewer(WORKSPACE_ID, USER_ID)

    expect(result).toEqual([stripVisibility(ownPrivate)])
    expect(accessSpy).not.toHaveBeenCalled()
  })

  it("access-filters every public stream row, including the viewer's own", async () => {
    const service = setupService()
    // A public label the viewer applied to a channel they can no longer reach.
    const ownPublicHidden = fakeCandidate({ userId: USER_ID, resourceId: "stream_own_hidden" })
    const ownPrivate = fakeCandidate({
      labelVisibility: Visibilities.PRIVATE,
      userId: USER_ID,
      resourceId: "stream_private",
    })
    const otherVisible = fakeCandidate({ userId: OTHER_USER_ID, resourceId: "stream_visible" })
    const otherHidden = fakeCandidate({ userId: OTHER_USER_ID, resourceId: "stream_hidden" })
    spyOn(LabelAssignmentRepository, "listVisibleCandidates").mockResolvedValue([
      ownPublicHidden,
      ownPrivate,
      otherVisible,
      otherHidden,
    ])
    const accessSpy = spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set(["stream_visible"]))

    const result = await service.listForViewer(WORKSPACE_ID, USER_ID)

    // Own private row kept unconditionally; own public row on the unreachable
    // stream is dropped just like another user's hidden row.
    expect(result).toEqual([stripVisibility(ownPrivate), stripVisibility(otherVisible)])
    expect(accessSpy).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, USER_ID, [
      "stream_own_hidden",
      "stream_visible",
      "stream_hidden",
    ])
  })
})
