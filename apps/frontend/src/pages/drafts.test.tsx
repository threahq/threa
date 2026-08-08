import { MemoryRouter, Route, Routes } from "react-router-dom"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { toast } from "sonner"
import { act, fireEvent, render, screen, userEvent, within, waitFor } from "@/test"
import * as touchCapableModule from "@/hooks/use-touch-capable"
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
    contentMarkdown: "some text",
    contentStatus: "ready" as const,
    attachmentCount: 0,
    updatedAt: 0,
    href: `/w/${WS}/s/stream_${overrides.id}`,
    groupLabel: overrides.displayName,
    isStashed: false,
    putAway: false,
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
          {/* Any navigation away renders this, so a test can assert a click did
              NOT route without reaching for a navigate spy. */}
          <Route path="*" element={<div data-testid="navigated-away" />} />
        </Routes>
      </MemoryRouter>
    </SidebarProvider>
  )
}

describe("DraftsPage batch delete", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    deleteDraft.mockReset()
    deleteDraft.mockResolvedValue(undefined)
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

  it("arrow nav follows visual render order when a group owns non-adjacent rows", async () => {
    // Recency order interleaves group "Stream A" (rows 0 and 2) around "Stream B"
    // (row 1); rows render grouped, so visually A-one is above A-two above Bravo.
    mockDrafts([
      draft({ id: "a1", displayName: "Alpha one", groupLabel: "Stream A" }),
      draft({ id: "b", displayName: "Bravo", groupLabel: "Stream B" }),
      draft({ id: "a2", displayName: "Alpha two", groupLabel: "Stream A" }),
    ])
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    const aOne = screen.getByRole("option", { name: /Alpha one/ })
    const aTwo = screen.getByRole("option", { name: /Alpha two/ })
    aOne.focus()

    // Down goes to the next row on screen (Alpha two, same group), not the
    // next flat index (Bravo).
    await userEvent.keyboard("{ArrowDown}")
    expect(aTwo).toHaveFocus()
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

  it("reports the count of drafts that failed to delete", async () => {
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "err")
    deleteDraft.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("boom")
    })
    renderPage()

    await userEvent.click(screen.getByRole("button", { name: "Select drafts" }))
    await userEvent.click(screen.getByRole("button", { name: "Select all" }))
    await userEvent.click(screen.getByRole("button", { name: "Delete selected drafts" }))
    const dialog = await screen.findByRole("alertdialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }))

    // Every draft is still attempted (allSettled); the toast reports the real
    // failed count, not a generic message.
    expect(deleteDraft).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("Failed to delete 1 of 3 drafts"))
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

describe("DraftsPage row context menu", () => {
  const writeText = vi.fn(async () => {})

  beforeEach(() => {
    vi.restoreAllMocks()
    deleteDraft.mockReset()
    deleteDraft.mockResolvedValue(undefined)
    writeText.mockClear()
    Object.assign(navigator, { clipboard: { writeText } })
  })

  async function openMenu(name: RegExp) {
    await userEvent.click(screen.getByRole("button", { name }))
  }

  it("exposes copy, open and delete for a readable draft", async () => {
    mockDrafts([draft({ id: "a", displayName: "Alpha", contentMarkdown: "**bold** body" })])
    renderPage()

    await openMenu(/Draft actions: Alpha/)

    expect(await screen.findByRole("menuitem", { name: "Open draft" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Copy as Markdown" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Delete draft" })).toBeInTheDocument()
  })

  it("copies the draft's markdown", async () => {
    mockDrafts([draft({ id: "a", displayName: "Alpha", contentMarkdown: "**bold** body" })])
    renderPage()

    await openMenu(/Draft actions: Alpha/)
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy as Markdown" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("**bold** body"))
  })

  it("copies the draft as plain text", async () => {
    mockDrafts([draft({ id: "a", displayName: "Alpha", contentMarkdown: "**bold** body" })])
    renderPage()

    await openMenu(/Draft actions: Alpha/)
    // The copy pair is a split group: the alternatives live behind the chevron.
    await userEvent.click(await screen.findByRole("menuitem", { name: "Other copy" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy as Plain text" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("bold body"))
  })

  it("disables copy for a sealed draft that has not decrypted", async () => {
    mockDrafts([
      draft({
        id: "a",
        displayName: "Alpha",
        preview: "Decrypting…",
        contentMarkdown: "",
        contentStatus: "decrypting",
      }),
    ])
    renderPage()

    await openMenu(/Draft actions: Alpha/)

    expect(await screen.findByRole("menuitem", { name: "Copy as Markdown" })).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }))
    expect(writeText).not.toHaveBeenCalled()
  })

  it("routes Delete through the confirm dialog", async () => {
    mockDrafts([draft({ id: "a", displayName: "Alpha" })])
    renderPage()

    await openMenu(/Draft actions: Alpha/)
    await userEvent.click(await screen.findByRole("menuitem", { name: "Delete draft" }))

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument()
    expect(deleteDraft).not.toHaveBeenCalled()

    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /delete/i }))
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("a"))
  })

  it("keeps the row's own open path", async () => {
    mockDrafts([draft({ id: "a", displayName: "Alpha" })])
    renderPage()

    expect(screen.getByRole("option", { name: /Alpha/ })).toHaveAttribute("href", `/w/${WS}/s/stream_a`)
  })
})

describe("DraftsPage touch long-press", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockDrafts([draft({ id: "a", displayName: "Alpha" })])
    vi.spyOn(touchCapableModule, "useTouchCapable").mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  // The row IS an <a href>, so a defer-to-interactive-elements guard would match
  // the row itself via closest() and refuse every touch — the whole mobile half
  // of this surface would be dead with nothing failing.
  it("opens the action drawer from a long press on a row that navigates", () => {
    vi.useFakeTimers()
    renderPage()

    const row = screen.getByRole("option", { name: /Alpha/i })
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(600))

    expect(screen.queryByRole("button", { name: /Copy as Markdown/i })).toBeNull()
    fireEvent.touchEnd(row)
    expect(screen.getByRole("button", { name: /Copy as Markdown/i })).toBeInTheDocument()
  })

  it("does not navigate on the click that follows the hold", () => {
    vi.useFakeTimers()
    renderPage()

    const row = screen.getByRole("option", { name: /Alpha/i })
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(600))
    fireEvent.touchEnd(row)
    fireEvent.click(row)

    expect(screen.queryByTestId("navigated-away")).toBeNull()
  })
})

describe("put-away annotation (durable stash, chunk 4)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    deleteDraft.mockReset()
    deleteDraft.mockResolvedValue(undefined)
  })

  it("labels a deliberately put-away row 'Stashed' and leaves a merely-roamed row unlabeled", () => {
    mockDrafts([
      draft({ id: "a", displayName: "Alpha", isStashed: true, putAway: true, preview: "put away body" }),
      draft({ id: "b", displayName: "Bravo", isStashed: true, putAway: false, preview: "roamed body" }),
    ])
    renderPage()

    // The put-away row carries the annotation; the roamed control row does not
    // — the two device-local/durable notions must not be conflated.
    expect(screen.getByText("Stashed")).toBeInTheDocument()
    const roamedRow = screen.getByText("roamed body").closest("a, button, li")
    expect(roamedRow?.textContent).not.toContain("Stashed")
  })

  it("keeps the active preview when a durable marker remains on a locally loaded row", () => {
    mockDrafts([
      draft({ id: "c", displayName: "Charlie", isStashed: false, putAway: true, preview: "active-looking body" }),
    ])
    renderPage()

    // A cross-device marker can coexist briefly with this device's pointer. The
    // local loaded state wins: hiding this preview would leave an apparently
    // active-looking row with a "Stashed" caption (and its preview discarded)
    // until another sync transition happens.
    expect(screen.getByText("active-looking body")).toBeInTheDocument()
    expect(screen.queryByText("Stashed")).not.toBeInTheDocument()
  })
})
