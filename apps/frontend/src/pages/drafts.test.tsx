import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, userEvent, within } from "@/test"
import { DraftsPage } from "./drafts"
import { SidebarProvider } from "@/contexts"
import * as hooksModule from "@/hooks"
import type { UnifiedDraft } from "@/hooks"

const WS = "ws_1"

function draft(overrides: Partial<UnifiedDraft> & { id: string; displayName: string }): UnifiedDraft {
  return {
    type: "channel",
    streamId: `stream_${overrides.id}`,
    preview: "some text",
    attachmentCount: 0,
    updatedAt: 0,
    href: `/w/${WS}/s/stream_${overrides.id}`,
    groupLabel: overrides.displayName,
    isStashed: false,
    ...overrides,
  }
}

const deleteDraft = vi.fn(async (_id: string) => {})

function mockDrafts(drafts: UnifiedDraft[]) {
  vi.spyOn(hooksModule, "useAllDrafts").mockReturnValue({
    drafts,
    draftCount: drafts.length,
    deleteDraft,
  } as unknown as ReturnType<typeof hooksModule.useAllDrafts>)
}

function renderPage() {
  return render(
    <SidebarProvider>
      <MemoryRouter initialEntries={[`/w/${WS}/drafts`]}>
        <Routes>
          <Route path="/w/:workspaceId/drafts" element={<DraftsPage />} />
        </Routes>
      </MemoryRouter>
    </SidebarProvider>
  )
}

describe("DraftsPage batch delete", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    deleteDraft.mockClear()
    mockDrafts([
      draft({ id: "a", displayName: "Alpha" }),
      draft({ id: "b", displayName: "Bravo" }),
      draft({ id: "c", displayName: "Charlie" }),
    ])
  })

  it("hides the Select control when there are no drafts", () => {
    mockDrafts([])
    renderPage()
    expect(screen.queryByRole("button", { name: "Select drafts" })).not.toBeInTheDocument()
  })

  it("enters batch mode, selects rows by tapping, and reflects the count", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    // Rows are now toggles (no navigation): tap two of them.
    await userEvent.click(screen.getByRole("option", { name: /Alpha/ }))
    await userEvent.click(screen.getByRole("option", { name: /Charlie/ }))

    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("option", { name: /Charlie/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("option", { name: /Bravo/ })).toHaveAttribute("aria-selected", "false")
  })

  it("toggles a row selection with the keyboard (Enter)", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    const row = screen.getByRole("option", { name: /Alpha/ })
    row.focus()
    await userEvent.keyboard("{Enter}")

    expect(row).toHaveAttribute("aria-selected", "true")
  })

  it("moves focus between rows with arrow keys and toggles the focused row", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    const alpha = screen.getByRole("option", { name: /Alpha/ })
    const bravo = screen.getByRole("option", { name: /Bravo/ })
    alpha.focus()

    await userEvent.keyboard("{ArrowDown}")
    expect(bravo).toHaveFocus()

    await userEvent.keyboard("{Enter}")
    // Enter acts on the focused (Bravo) row, not the originally-focused Alpha.
    expect(bravo).toHaveAttribute("aria-selected", "true")
    expect(alpha).toHaveAttribute("aria-selected", "false")
  })

  it("select-all then delete confirms with the batch count and removes every draft", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    await userEvent.click(screen.getByRole("button", { name: "Select all" }))
    await userEvent.click(screen.getByRole("button", { name: "Delete selected drafts" }))

    // Confirmation carries the count, not a singular string.
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Delete 3 drafts?")).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }))

    expect(deleteDraft).toHaveBeenCalledTimes(3)
    expect(deleteDraft.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b", "c"])
    // Batch mode exits after the delete — the Select control returns.
    expect(await screen.findByRole("button", { name: "Select drafts" })).toBeInTheDocument()
  })

  it("leaves batch mode via Cancel without deleting anything", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    await userEvent.click(screen.getByRole("option", { name: /Alpha/ }))
    await userEvent.click(screen.getByRole("button", { name: "Cancel selection" }))

    expect(deleteDraft).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Select drafts" })).toBeInTheDocument()
  })

  it("Escape while the confirm dialog is open dismisses only the dialog, keeping the selection", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    await userEvent.click(screen.getByRole("button", { name: "Select all" }))
    await userEvent.click(screen.getByRole("button", { name: "Delete selected drafts" }))
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument()

    await userEvent.keyboard("{Escape}")

    // Dialog gone, but still in batch mode with the selection intact.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel selection" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute("aria-selected", "true")
    expect(deleteDraft).not.toHaveBeenCalled()
  })

  it("exits batch mode on Escape from anywhere", async () => {
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    expect(screen.getByRole("button", { name: "Cancel selection" })).toBeInTheDocument()

    await userEvent.keyboard("{Escape}")

    expect(screen.getByRole("button", { name: "Select drafts" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel selection" })).not.toBeInTheDocument()
  })
})
