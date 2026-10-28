import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import type { DocBacklinksResponse } from "@threahq/types"
import { docsApi } from "@/api/docs"
import * as contextsModule from "@/contexts"
import { takeBlockFocus } from "@/lib/docs/block-focus"
import { spyOnExport } from "@/test"
import * as workspaceStore from "@/stores/workspace-store"
import { DocBacklinks } from "./doc-backlinks"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_target"

const STREAMS: Record<string, { id: string; type: string; slug?: string; displayName: string | null }> = {
  stream_plan: { id: "stream_plan", type: "doc", displayName: "Launch plan" },
  stream_eng: { id: "stream_eng", type: "channel", slug: "engineering", displayName: null },
}

function mount(response: DocBacklinksResponse) {
  vi.spyOn(docsApi, "listBacklinks").mockResolvedValue(response)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocBacklinks workspaceId={WORKSPACE_ID} docId={DOC_ID} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("DocBacklinks", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "usePanel").mockReturnValue({
      getPanelUrl: (panelId: string) => `/w/${WORKSPACE_ID}?panel=${panelId}`,
    } as unknown as ReturnType<typeof contextsModule.usePanel>)
    spyOnExport(workspaceStore, "useWorkspaceStream").mockReturnValue(((
      _workspaceId: string | undefined,
      streamId: string | undefined,
      pick: (row: workspaceStore.CachedStream) => unknown
    ) => {
      const row = streamId ? STREAMS[streamId] : undefined
      return row ? pick(row as unknown as workspaceStore.CachedStream) : undefined
    }) as never)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    takeBlockFocus("stream_plan")
  })

  it("should render nothing when no doc links here", async () => {
    const { container } = mount({ backlinks: [] })
    await waitFor(() => expect(docsApi.listBacklinks).toHaveBeenCalledWith(WORKSPACE_ID, DOC_ID))
    expect(container.innerHTML).toBe("")
  })

  it("should list the live title and host name linking to the panel when a doc links here", async () => {
    mount({
      backlinks: [
        { docId: "stream_plan", title: "Old plan", hostStreamId: "stream_eng", blockIds: ["blk_a", "blk_b"] },
      ],
    })
    const link = await screen.findByRole("link", { name: /Launch plan/ })
    expect({
      heading: screen.getByRole("heading", { name: "Linked from" }) !== null,
      href: link.getAttribute("href"),
      host: screen.getByText(/engineering/).textContent,
    }).toEqual({ heading: true, href: `/w/${WORKSPACE_ID}?panel=stream_plan`, host: "#engineering" })
  })

  it("should request focus on the first linking block when a row is clicked", async () => {
    mount({
      backlinks: [{ docId: "stream_plan", title: null, hostStreamId: "stream_gone", blockIds: ["blk_a", "blk_b"] }],
    })
    await userEvent.click(await screen.findByRole("link", { name: /Launch plan/ }))
    expect(takeBlockFocus("stream_plan")).toBe("blk_a")
  })
})
