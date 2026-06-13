import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { PlatformAdminService } from "./service"
import { PlatformAdminAccessRepository } from "./repository"

const WORKSPACE_ID = "ws_1"
const WORKOS_USER_ID = "workos_user_1"

describe("PlatformAdminService.applySync", () => {
  afterEach(() => mock.restore())

  it("forwards a grant snapshot to the mirror row", async () => {
    const setAccess = spyOn(PlatformAdminAccessRepository, "setAccess").mockResolvedValue()
    const service = new PlatformAdminService({} as any)

    await service.applySync({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID, isPlatformAdmin: true })

    expect(setAccess).toHaveBeenCalledWith({}, WORKSPACE_ID, WORKOS_USER_ID, true)
  })

  it("forwards a revoke snapshot so the mirror row is deleted", async () => {
    const setAccess = spyOn(PlatformAdminAccessRepository, "setAccess").mockResolvedValue()
    const service = new PlatformAdminService({} as any)

    await service.applySync({ workspaceId: WORKSPACE_ID, workosUserId: WORKOS_USER_ID, isPlatformAdmin: false })

    expect(setAccess).toHaveBeenCalledWith({}, WORKSPACE_ID, WORKOS_USER_ID, false)
  })
})

describe("PlatformAdminService.hasAccess", () => {
  afterEach(() => mock.restore())

  it("reads the mirror row for the workspace user", async () => {
    spyOn(PlatformAdminAccessRepository, "hasAccess").mockResolvedValue(true)
    const service = new PlatformAdminService({} as any)

    expect(await service.hasAccess(WORKSPACE_ID, WORKOS_USER_ID)).toBe(true)
  })
})
