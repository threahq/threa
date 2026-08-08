import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/test"
import { DraftActionDrawer } from "./draft-action-drawer"
import type { DraftActionContext } from "./draft-actions"

const writeText = vi.fn(async () => {})
const onDelete = vi.fn()

function renderDrawer(overrides: Partial<DraftActionContext> = {}) {
  const context: DraftActionContext = {
    contentMarkdown: "**bold** body",
    contentStatus: "ready",
    href: "/w/ws_1/s/stream_1",
    isStashed: true,
    onDelete,
    ...overrides,
  }
  return render(
    <MemoryRouter>
      <DraftActionDrawer open onOpenChange={() => {}} context={context} label="General" preview="bold body" />
    </MemoryRouter>
  )
}

describe("DraftActionDrawer", () => {
  beforeEach(() => {
    writeText.mockClear()
    onDelete.mockClear()
    Object.assign(navigator, { clipboard: { writeText } })
  })

  it("offers restore, copy and delete", async () => {
    renderDrawer()

    expect(await screen.findByRole("link", { name: "Restore draft" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy as Markdown" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete draft" })).toBeInTheDocument()
  })

  it("copies the draft's markdown", async () => {
    renderDrawer()

    fireEvent.click(await screen.findByRole("button", { name: "Copy as Markdown" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("**bold** body"))
  })

  it("disables copy while a sealed draft is still decrypting", async () => {
    renderDrawer({ contentMarkdown: "", contentStatus: "decrypting" })

    expect(await screen.findByRole("button", { name: "Copy as Markdown" })).toBeDisabled()
    expect(writeText).not.toHaveBeenCalled()
  })

  it("delegates delete to the page's confirm flow", async () => {
    renderDrawer()

    fireEvent.click(await screen.findByRole("button", { name: "Delete draft" }))

    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
