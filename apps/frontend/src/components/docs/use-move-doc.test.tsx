import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WORKSPACE_PERMISSION_SCOPES, type DocMovePreviewResponse } from "@threahq/types"
import * as workspacesModule from "@/hooks/use-workspaces"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"
import * as manageChannelsModule from "@/lib/use-can-manage-channels"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { createMockStream } from "@/test/fixtures"
import { docsApi } from "@/api/docs"
import { useMoveDoc } from "./use-move-doc"

const DOC: NonNullable<Parameters<typeof useMoveDoc>[1]> = {
  id: "stream_doc",
  createdBy: "usr_creator",
  parentStreamId: "stream_host",
  archivedAt: null,
}

function renderMoveDoc(viewer: { userId: string; admin: boolean }, canMove = true) {
  vi.spyOn(currentUserModule, "useCurrentWorkspaceUserId").mockReturnValue(viewer.userId)
  vi.spyOn(workspacesModule, "useViewerPermissions").mockReturnValue(
    viewer.admin ? [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN] : []
  )
  vi.spyOn(manageChannelsModule, "useCanManageChannels").mockReturnValue(true)
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(({ doc }) => useMoveDoc("ws_1", doc, canMove), { wrapper, initialProps: { doc: DOC } })
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
      picked = result.current.pick({ toStreamId: "stream_target" })
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

  it("allows top-level sources and keeps the previewed source when the doc changes before confirmation", async () => {
    const preview = vi.spyOn(docsApi, "previewMove").mockResolvedValue({ losing: 1, gaining: 0 })
    const move = vi.spyOn(docsApi, "move").mockResolvedValue({ stream: { id: "stream_doc" } as never })
    const { result, rerender } = renderMoveDoc({ userId: "usr_creator", admin: false })

    await act(async () => result.current.pick({ toStreamId: null, visibility: "public" }))
    rerender({ doc: { ...DOC, parentStreamId: "stream_changed" } })
    await act(async () => result.current.confirm())

    expect(preview).toHaveBeenCalledWith("ws_1", "stream_doc", { toStreamId: null, visibility: "public" })
    expect(move).toHaveBeenCalledWith("ws_1", "stream_doc", {
      fromStreamId: "stream_host",
      toStreamId: null,
      visibility: "public",
    })
  })

  it("allows moving a top-level doc to a host", () => {
    const { result, rerender } = renderMoveDoc({ userId: "usr_creator", admin: false })
    rerender({ doc: { ...DOC, parentStreamId: null } })
    expect(result.current).toMatchObject({ enabled: true, canLift: false })
  })

  it("sends a null source when moving a top-level doc into a host", async () => {
    const move = vi.spyOn(docsApi, "move").mockResolvedValue({ stream: { id: "stream_doc" } as never })
    vi.spyOn(docsApi, "previewMove").mockResolvedValue({ losing: 0, gaining: 0 })
    const { result, rerender } = renderMoveDoc({ userId: "usr_creator", admin: false })
    rerender({ doc: { ...DOC, parentStreamId: null } })

    await act(async () => result.current.pick({ toStreamId: "stream_target" }))

    expect(move).toHaveBeenCalledWith("ws_1", "stream_doc", {
      fromStreamId: null,
      toStreamId: "stream_target",
    })
  })

  it("excludes itself and known nested descendants from move targets", () => {
    const root = createMockStream({ id: "stream_doc", type: "doc" })
    const child = createMockStream({
      id: "stream_child",
      type: "doc",
      parentStreamId: root.id,
      rootStreamId: root.id,
    })
    const grandchild = createMockStream({
      id: "stream_grandchild",
      type: "doc",
      parentStreamId: child.id,
      rootStreamId: root.id,
    })
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([root, child, grandchild] as never)
    const { result } = renderMoveDoc({ userId: "usr_creator", admin: false })

    expect({
      self: result.current.isTarget(root as never),
      child: result.current.isTarget(child as never),
      grandchild: result.current.isTarget(grandchild as never),
      otherHost: result.current.isTarget(createMockStream({ id: "stream_host2", type: "channel" }) as never),
    }).toEqual({ self: false, child: false, grandchild: false, otherHost: true })
  })
})
