import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { LabelActorTypes, type Label } from "@threahq/types"
import { LabelService } from "./service"
import { LabelRepository, LabelAssignmentRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const USER_ACTOR = { type: LabelActorTypes.USER, id: USER_ID } as const
const LABEL_ID = "label_1"
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

function setupService() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  return new LabelService({ pool: {} as any })
}

describe("LabelService.archive", () => {
  afterEach(() => mock.restore())

  it("deletes assignments and emits label:deleted to the owner", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    spyOn(LabelRepository, "archive").mockResolvedValue(true)
    const assignmentCleanup = spyOn(LabelAssignmentRepository, "deleteAllForLabel").mockResolvedValue(undefined)
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.archive({ workspaceId: WORKSPACE_ID, actor: USER_ACTOR, labelId: LABEL_ID })

    expect(assignmentCleanup).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, LABEL_ID)
    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "label:deleted",
      expect.objectContaining({ labelId: LABEL_ID, targetUserId: USER_ID })
    )
  })

  it("does not touch assignments when the archive is a no-op (already archived)", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    spyOn(LabelRepository, "archive").mockResolvedValue(false)
    const assignmentCleanup = spyOn(LabelAssignmentRepository, "deleteAllForLabel").mockResolvedValue(undefined)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.archive({ workspaceId: WORKSPACE_ID, actor: USER_ACTOR, labelId: LABEL_ID })

    expect(assignmentCleanup).not.toHaveBeenCalled()
  })

  it("rejects archiving someone else's label", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel({ creatorUserId: "usr_other" }))
    const archive = spyOn(LabelRepository, "archive").mockResolvedValue(true)

    await expect(service.archive({ workspaceId: WORKSPACE_ID, actor: USER_ACTOR, labelId: LABEL_ID })).rejects.toThrow()
    expect(archive).not.toHaveBeenCalled()
  })
})

describe("LabelService.create", () => {
  afterEach(() => mock.restore())

  it("inserts the label and emits label:created to the owner only", async () => {
    const service = setupService()
    spyOn(LabelRepository, "slugExists").mockResolvedValue(false)
    spyOn(LabelRepository, "insert").mockResolvedValue(fakeLabel())
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.create({
      workspaceId: WORKSPACE_ID,
      actor: USER_ACTOR,
      name: "Priority",
      color: "#ff0000",
      emoji: null,
      description: null,
    })

    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "label:created",
      expect.objectContaining({ targetUserId: USER_ID, label: expect.objectContaining({ id: LABEL_ID }) })
    )
  })
})

describe("LabelService.upsertByName", () => {
  afterEach(() => mock.restore())

  it("emits label:created when a new label is born", async () => {
    const service = setupService()
    spyOn(LabelRepository, "upsertByName").mockResolvedValue({ label: fakeLabel(), inserted: true })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.upsertByName({ workspaceId: WORKSPACE_ID, actor: USER_ACTOR, name: "Priority" })

    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "label:created",
      expect.objectContaining({ targetUserId: USER_ID })
    )
  })

  it("emits label:updated when an existing label is matched", async () => {
    const service = setupService()
    spyOn(LabelRepository, "upsertByName").mockResolvedValue({ label: fakeLabel(), inserted: false })
    const outbox = spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.upsertByName({ workspaceId: WORKSPACE_ID, actor: USER_ACTOR, name: "Priority" })

    expect(outbox).toHaveBeenCalledWith(
      expect.anything(),
      "label:updated",
      expect.objectContaining({ targetUserId: USER_ID })
    )
  })

  it("only overwrites appearance fields the caller provided", async () => {
    const service = setupService()
    const upsert = spyOn(LabelRepository, "upsertByName").mockResolvedValue({ label: fakeLabel(), inserted: false })
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.upsertByName({ workspaceId: WORKSPACE_ID, actor: USER_ACTOR, name: "Priority", color: "#00ff00" })

    expect(upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ overwriteColor: true, overwriteEmoji: false, overwriteDescription: false })
    )
  })
})
