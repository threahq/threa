import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PoolClient } from "pg"
import { Visibilities, type Label } from "@threa/types"
import { LabelService } from "./service"
import { LabelRepository, LabelMemberRepository, LabelAssignmentRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"

const WORKSPACE_ID = "ws_1"
const USER_ID = "usr_1"
const LABEL_ID = "label_1"
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

function setupService() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
  return new LabelService({ pool: {} as any })
}

describe("LabelService.archive", () => {
  afterEach(() => mock.restore())

  it("deletes assignments alongside memberships so no resource keeps a chip for a dead label", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    spyOn(LabelRepository, "archive").mockResolvedValue(true)
    spyOn(LabelMemberRepository, "deleteAllForLabel").mockResolvedValue(undefined)
    const assignmentCleanup = spyOn(LabelAssignmentRepository, "deleteAllForLabel").mockResolvedValue(undefined)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.archive({ workspaceId: WORKSPACE_ID, userId: USER_ID, labelId: LABEL_ID })

    expect(assignmentCleanup).toHaveBeenCalledWith(expect.anything(), WORKSPACE_ID, LABEL_ID)
  })

  it("does not touch assignments when the archive is a no-op (already archived)", async () => {
    const service = setupService()
    spyOn(LabelRepository, "findById").mockResolvedValue(fakeLabel())
    spyOn(LabelRepository, "archive").mockResolvedValue(false)
    const assignmentCleanup = spyOn(LabelAssignmentRepository, "deleteAllForLabel").mockResolvedValue(undefined)
    spyOn(OutboxRepository, "insert").mockResolvedValue({} as any)

    await service.archive({ workspaceId: WORKSPACE_ID, userId: USER_ID, labelId: LABEL_ID })

    expect(assignmentCleanup).not.toHaveBeenCalled()
  })
})
