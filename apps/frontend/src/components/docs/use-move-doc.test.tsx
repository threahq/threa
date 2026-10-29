import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WORKSPACE_PERMISSION_SCOPES, type DocMovePreviewResponse } from "@threahq/types"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"
import { docsApi } from "@/api/docs"
import { useMoveDoc } from "./use-move-doc"

const DOC = { id: "stream_doc", createdBy: "usr_creator", parentStreamId: "stream_host", archivedAt: null }

function renderMoveDoc(viewer: { userId: string; admin: boolean }, canMove = true) {
  vi.spyOn(currentUserModule, "useCurrentWorkspaceUserId").mockReturnValue(viewer.userId)
  vi.spyOn(workspacesModule, "useViewerPermissions").mockReturnValue(
    viewer.admin ? [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN] : []
  )
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useMoveDoc("ws_1", DOC, canMove), { wrapper })
}

afterEach(() => vi.restoreAllMocks())

describe("useMoveDoc", () => {
  it("offers the move to the doc's creator and to admins, while the pane allows it", () => {
    const enabled = (viewer: { userId: string; admin: boolean }, canMove?: boolean) =>
      renderMoveDoc(viewer, canMove).result.current.enabled
    expect({
      nonAdminCreator: enabled({ userId: "usr_creator", admin: false }),
      nonAdminOther: enabled({ userId: "usr_other", admin: false }),
      adminOther: enabled({ userId: "usr_other", admin: true }),
      creatorWhenPaneForbids: enabled({ userId: "usr_creator", admin: false }, false),
    }).toEqual({ nonAdminCreator: true, nonAdminOther: false, adminOther: true, creatorWhenPaneForbids: false })
  })

  it("drops a preview that resolves after reset, without moving or asking", async () => {
    let resolvePreview: (preview: DocMovePreviewResponse) => void = () => {}
    vi.spyOn(docsApi, "previewMove").mockReturnValue(new Promise((resolve) => (resolvePreview = resolve)))
    const move = vi.spyOn(docsApi, "move")
    const { result } = renderMoveDoc({ userId: "usr_creator", admin: false })

    let picked: Promise<boolean> = Promise.resolve(true)
    act(() => {
      picked = result.current.pick("stream_target")
    })
    const busyWhilePreviewing = result.current.busy
    act(() => result.current.reset())
    await act(async () => {
      resolvePreview({ losing: 0, gaining: 0 } as DocMovePreviewResponse)
      await picked
    })

    expect({
      busyWhilePreviewing,
      picked: await picked,
      moved: move.mock.calls.length,
      pending: result.current.pending,
      busy: result.current.busy,
    }).toEqual({ busyWhilePreviewing: true, picked: false, moved: 0, pending: null, busy: false })
  })
})
