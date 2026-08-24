import { describe, expect, it, beforeEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { resetDraftStoreCache, seedDraftCache } from "@/stores/draft-store"
import { asideDraftScope } from "@/lib/drafts/aside-scope"
import { AsideDraftDock } from "./aside-draft-dock"

const ASIDE = "stream_aside"

type SeededDraft = Parameters<typeof seedDraftCache>[1]["drafts"][number]

function draftRow(id: string, scope: string, text: string, clientUpdatedAt: number): SeededDraft {
  return {
    id,
    workspaceId: "ws_1",
    scope,
    contentJson: text
      ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
      : { type: "doc", content: [{ type: "paragraph" }] },
    attachments: [],
    clientUpdatedAt,
  } as SeededDraft
}

function seed(drafts: SeededDraft[]): void {
  seedDraftCache("ws_1", { scratchpads: [], drafts, loaded: [] })
}

beforeEach(() => {
  resetDraftStoreCache()
})

describe("AsideDraftDock", () => {
  it("lists this aside's drafts newest first and nothing from elsewhere", async () => {
    seed([
      draftRow("draft_a", asideDraftScope(ASIDE, "draft_a"), "older thought", 1),
      draftRow("draft_b", asideDraftScope(ASIDE, "draft_b"), "newer thought", 2),
      draftRow("draft_c", asideDraftScope("stream_other_aside", "draft_c"), "another aside", 3),
      draftRow("draft_d", "stream:stream_host", "the host's own draft", 4),
    ])

    render(<AsideDraftDock workspaceId="ws_1" asideId={ASIDE} onOpenDraft={vi.fn()} openScope={null} />)

    await waitFor(() => expect(screen.getByText("Drafts · 2")).toBeInTheDocument())
    const rows = screen.getAllByRole("button").filter((button) => button.hasAttribute("data-draft-scope"))
    // Each row reads "<preview> <age>"; order is what this asserts.
    expect(rows.map((row) => row.getAttribute("data-draft-scope"))).toEqual([
      asideDraftScope(ASIDE, "draft_b"),
      asideDraftScope(ASIDE, "draft_a"),
    ])
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("newer thought"),
      expect.stringContaining("older thought"),
    ])
    expect(screen.queryByText("another aside")).toBeNull()
    expect(screen.queryByText("the host's own draft")).toBeNull()
  })

  it("opens a fresh scope for a new draft, and the tapped scope for an existing one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const onOpenDraft = vi.fn()
    seed([draftRow("draft_a", asideDraftScope(ASIDE, "draft_a"), "a thought", 1)])

    render(<AsideDraftDock workspaceId="ws_1" asideId={ASIDE} onOpenDraft={onOpenDraft} openScope={null} />)
    await waitFor(() => expect(screen.getByText("a thought")).toBeInTheDocument())

    await user.click(screen.getByText("a thought"))
    expect(onOpenDraft).toHaveBeenLastCalledWith(asideDraftScope(ASIDE, "draft_a"))

    await user.click(screen.getByText("New draft"))
    expect(onOpenDraft).toHaveBeenLastCalledWith(
      expect.stringMatching(/^aside:stream_aside:draft_[0-9A-HJKMNP-TV-Z]{26}$/)
    )
  })

  it("shows an empty draft by state rather than as a blank row", async () => {
    seed([draftRow("draft_a", asideDraftScope(ASIDE, "draft_a"), "", 1)])

    render(<AsideDraftDock workspaceId="ws_1" asideId={ASIDE} onOpenDraft={vi.fn()} openScope={null} />)

    await waitFor(() => expect(screen.getByText("Empty draft")).toBeInTheDocument())
  })
})
