import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { WORKSPACE_PERMISSION_SCOPES, WORKSPACE_ROLE_SLUGS, type User, type WorkspaceBootstrap } from "@threahq/types"
import * as workspacesModule from "@/hooks/use-workspaces"
import { useCanManageChannels } from "./use-can-manage-channels"

function canManage(bootstrap: Pick<WorkspaceBootstrap, "viewerPermissions"> | null, viewerRole: string | null) {
  vi.spyOn(workspacesModule, "useViewerPermissions").mockReturnValue(bootstrap?.viewerPermissions)
  vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(
    viewerRole === null ? null : ({ id: "usr_1", role: viewerRole } as User)
  )
  return renderHook(() => useCanManageChannels("ws_1")).result.current
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useCanManageChannels", () => {
  it("should answer from the cached viewer role until the bootstrap loads, and from the bootstrap after", () => {
    const browse = { viewerPermissions: [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE] }
    expect({
      memberBeforeBootstrap: canManage(null, WORKSPACE_ROLE_SLUGS.MEMBER),
      guestBeforeBootstrap: canManage(null, WORKSPACE_ROLE_SLUGS.GUEST),
      unknownViewerBeforeBootstrap: canManage(null, null),
      bootstrapWithBrowseOverGuestRow: canManage(browse, WORKSPACE_ROLE_SLUGS.GUEST),
      bootstrapWithoutBrowseOverMemberRow: canManage({ viewerPermissions: [] }, WORKSPACE_ROLE_SLUGS.MEMBER),
    }).toEqual({
      memberBeforeBootstrap: true,
      guestBeforeBootstrap: false,
      unknownViewerBeforeBootstrap: false,
      bootstrapWithBrowseOverGuestRow: true,
      bootstrapWithoutBrowseOverMemberRow: false,
    })
  })
})
