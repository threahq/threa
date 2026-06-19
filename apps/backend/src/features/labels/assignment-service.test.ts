import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { LabelActorTypes, LabelableResourceTypes, type Label, type LabelAssignment } from "@threa/types"
import { LabelAssignmentService } from "./assignment-service"
import { LabelService } from "./service"
import { LabelRepository, LabelAssignmentRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as streamsBarrel from "../streams"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const USER_ACTOR = { type: LabelActorTypes.USER, id: USER_ID } as const
const OTHER_USER_ID = "usr_2"
const LABEL_ID = "label_1"
const RESOURCE_ID = "stream_1"
const NOW = "2026-05-28T12:00:00.000Z"

function fakeLabel(overrides: Partial<Label> = {}): Label {
  return {
    id: LABEL_ID,
    workspaceId: WORKSPACE_ID,
    creatorActorType: LabelActorTypes.USER,
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
    actorType: LabelActorTypes.USER,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    assignedAt: NOW,
    ...overrides,
  }
}

function setupService() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  const labelService = new LabelService({ pool: {} as any })
  return new LabelAssignmentService({ pool: {} as any, labelService, botChannelService: {} as any })
}

const assignParams = {
  workspaceId: WORKSPACE_ID,
  actor: USER_ACTOR,
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

  it("throws 404 when applying someone else's label", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel({ creatorUserId: OTHER_USER_ID }))

    await expect(service.assign(assignParams)).rejects.toMatchObject({ status: 404 })
  })

  it("assigns the actor's own label and routes the event to their user room", async () => {
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
        targetUserId: USER_ID,
        assignment: expect.objectContaining({ labelId: LABEL_ID, resourceId: RESOURCE_ID }),
      })
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

  it("gates a bot's assign through a single isStreamAccessibleForBot point query, not the bulk fetch", async () => {
    const BOT_ID = "bot_1"
    const isStreamAccessibleForBot = mock(() => Promise.resolve(false))
    const getAccessibleStreamIdsForBot = mock(() => Promise.resolve([] as string[]))
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const service = new LabelAssignmentService({
      pool: {} as any,
      labelService: new LabelService({ pool: {} as any }),
      botChannelService: { isStreamAccessibleForBot, getAccessibleStreamIdsForBot } as any,
    })
    spyOn(LabelRepository, "findById").mockResolvedValue(
      fakeLabel({ creatorActorType: LabelActorTypes.BOT, creatorUserId: BOT_ID })
    )
    const assignSpy = spyOn(LabelAssignmentRepository, "assign").mockResolvedValue(fakeAssignment())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await expect(
      service.assign({ ...assignParams, actor: { type: LabelActorTypes.BOT, id: BOT_ID } })
    ).rejects.toMatchObject({ status: 404 })

    expect(isStreamAccessibleForBot).toHaveBeenCalledWith(WORKSPACE_ID, BOT_ID, RESOURCE_ID)
    // The write gate must not fall back to the unbounded all-streams fetch.
    expect(getAccessibleStreamIdsForBot).not.toHaveBeenCalled()
    expect(assignSpy).not.toHaveBeenCalled()
    expect(outboxSpy).not.toHaveBeenCalled()
  })
})

describe("LabelAssignmentService.assignByName", () => {
  afterEach(() => mock.restore())

  it("upserts the actor's label by name, assigns it, and returns both", async () => {
    const service = setupService()
    const upsert = spyOn(LabelService.prototype, "upsertByNameWithin").mockResolvedValue({
      label: fakeLabel(),
      inserted: true,
    })
    spyOn(LabelAssignmentRepository, "assign").mockResolvedValue(fakeAssignment())
    const outboxSpy = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set([RESOURCE_ID]))

    const result = await service.assignByName({
      workspaceId: WORKSPACE_ID,
      actor: USER_ACTOR,
      name: "Priority",
      resourceType: LabelableResourceTypes.STREAM,
      resourceId: RESOURCE_ID,
    })

    expect(upsert).toHaveBeenCalled()
    expect(result.label.id).toBe(LABEL_ID)
    expect(result.assignment.resourceId).toBe(RESOURCE_ID)
    expect(outboxSpy).toHaveBeenCalledWith(
      expect.anything(),
      "label:assigned",
      expect.objectContaining({ targetUserId: USER_ID })
    )
  })

  it("does not upsert or assign when the caller cannot reach the resource", async () => {
    const service = setupService()
    const upsert = spyOn(LabelService.prototype, "upsertByNameWithin")
    const assignSpy = spyOn(LabelAssignmentRepository, "assign")
    spyOn(streamsBarrel, "listAccessibleStreamIds").mockResolvedValue(new Set())

    await expect(
      service.assignByName({
        workspaceId: WORKSPACE_ID,
        actor: USER_ACTOR,
        name: "Priority",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(upsert).not.toHaveBeenCalled()
    expect(assignSpy).not.toHaveBeenCalled()
  })
})

describe("LabelAssignmentService.unassign", () => {
  afterEach(() => mock.restore())

  it("emits label:unassigned to the actor's user room", async () => {
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

describe("LabelAssignmentService.unassignByName", () => {
  afterEach(() => mock.restore())

  it("resolves the actor's label by name then removes its assignment", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findByOwnerSlug").mockResolvedValue(fakeLabel())
    const unassign = spyOn(LabelAssignmentRepository, "unassign").mockResolvedValue(true)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.unassignByName({
      workspaceId: WORKSPACE_ID,
      actor: USER_ACTOR,
      name: "Priority",
      resourceType: LabelableResourceTypes.STREAM,
      resourceId: RESOURCE_ID,
    })

    expect(unassign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ labelId: LABEL_ID }))
  })

  it("throws 404 when the actor has no label with that name", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findByOwnerSlug").mockResolvedValue(null)

    await expect(
      service.unassignByName({
        workspaceId: WORKSPACE_ID,
        actor: USER_ACTOR,
        name: "Nope",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it("rejects a blank name before falling back to the default slug", async () => {
    const service = setupService()
    const lookup = spyOn(LabelRepository, "findByOwnerSlug")

    await expect(
      service.unassignByName({
        workspaceId: WORKSPACE_ID,
        actor: USER_ACTOR,
        name: "   ",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: RESOURCE_ID,
      })
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("LabelAssignmentService.listForViewer", () => {
  afterEach(() => mock.restore())

  it("returns the user's own rows without an access query", async () => {
    const service = setupService()
    const own = fakeAssignment({ userId: USER_ID })
    spyOn(LabelAssignmentRepository, "listForActor").mockResolvedValue([own])
    const accessSpy = spyOn(streamsBarrel, "listAccessibleStreamIds")

    const result = await service.listForViewer(WORKSPACE_ID, USER_ACTOR)

    expect(result).toEqual([own])
    expect(accessSpy).not.toHaveBeenCalled()
  })

  it("gates a bot's own rows through its channel grants", async () => {
    const BOT_ID = "bot_1"
    const botActor = { type: LabelActorTypes.BOT, id: BOT_ID } as const
    const botChannelService = {
      getAccessibleStreamIdsForBot: mock(() => Promise.resolve(["stream_granted"])),
    }
    spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
    const service = new LabelAssignmentService({
      pool: {} as any,
      labelService: new LabelService({ pool: {} as any }),
      botChannelService: botChannelService as any,
    })

    const granted = fakeAssignment({ userId: BOT_ID, resourceId: "stream_granted" })
    const revoked = fakeAssignment({ userId: BOT_ID, resourceId: "stream_revoked" })
    spyOn(LabelAssignmentRepository, "listForActor").mockResolvedValue([granted, revoked])
    const userAccessSpy = spyOn(streamsBarrel, "listAccessibleStreamIds")

    const result = await service.listForViewer(WORKSPACE_ID, botActor)

    expect(result).toEqual([granted])
    expect(botChannelService.getAccessibleStreamIdsForBot).toHaveBeenCalledWith(WORKSPACE_ID, BOT_ID)
    expect(userAccessSpy).not.toHaveBeenCalled()
  })
})
