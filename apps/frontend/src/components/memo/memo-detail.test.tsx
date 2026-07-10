import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, userEvent, waitFor } from "@/test"
import * as relativeTimeModule from "@/components/relative-time"
import { MemoDetailContent, type MemoEditControls } from "./memo-detail"
import type { MemoExplorerDetail } from "@/api"

function buildDetail(overrides: Partial<MemoExplorerDetail["memo"]> = {}): MemoExplorerDetail {
  return {
    memo: {
      id: "memo_1",
      workspaceId: "ws_1",
      memoType: "message",
      sourceMessageId: "msg_1",
      sourceConversationId: null,
      title: "Launch decision",
      abstract: "Approved launch plan",
      keyPoints: ["ship on Friday"],
      sourceMessageIds: [],
      participantIds: [],
      knowledgeType: "decision",
      tags: ["launch"],
      parentMemoId: null,
      status: "active",
      version: 1,
      revisionReason: null,
      authoredByKind: "pipeline",
      sourceSessionId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      ...overrides,
    },
    distance: 0,
    sourceStream: null,
    rootStream: null,
    sourceMessages: [],
    successorMemoId: null,
    capturedByPersonaName: null,
  }
}

function buildControls(overrides: Partial<MemoEditControls> = {}): MemoEditControls {
  return {
    onSave: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onUnarchive: vi.fn().mockResolvedValue(undefined),
    isMutating: false,
    ...overrides,
  }
}

function renderDetail(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

describe("MemoDetailContent edit controls (roadmap 6.1)", () => {
  beforeEach(() => {
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(() => <span>just now</span>)
  })

  it("has no edit affordances without the edit prop (read-only preview surfaces)", () => {
    renderDetail(<MemoDetailContent data={buildDetail()} workspaceId="ws_1" isLoading={false} />)
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument()
  })

  it("saves edited fields through onSave", async () => {
    const user = userEvent.setup()
    const controls = buildControls()
    renderDetail(<MemoDetailContent data={buildDetail()} workspaceId="ws_1" isLoading={false} edit={controls} />)

    await user.click(screen.getByRole("button", { name: /edit/i }))

    const titleInput = screen.getByDisplayValue("Launch decision")
    await user.clear(titleInput)
    await user.type(titleInput, "Launch decision v2")
    await user.click(screen.getByRole("button", { name: /save/i }))

    // Only the changed field is sent — untouched fields are omitted so they
    // aren't re-embedded/overwritten.
    await waitFor(() => expect(controls.onSave).toHaveBeenCalledTimes(1))
    expect(controls.onSave).toHaveBeenCalledWith({ title: "Launch decision v2" })
  })

  it("keeps Save disabled when nothing changed", async () => {
    const user = userEvent.setup()
    const controls = buildControls()
    renderDetail(<MemoDetailContent data={buildDetail()} workspaceId="ws_1" isLoading={false} edit={controls} />)

    await user.click(screen.getByRole("button", { name: /edit/i }))
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled()
    expect(controls.onSave).not.toHaveBeenCalled()
  })

  it("archives an active memo and offers Restore on an archived one", async () => {
    const user = userEvent.setup()
    const controls = buildControls()
    const { rerender } = renderDetail(
      <MemoDetailContent data={buildDetail()} workspaceId="ws_1" isLoading={false} edit={controls} />
    )

    await user.click(screen.getByRole("button", { name: /^archive$/i }))
    expect(controls.onArchive).toHaveBeenCalledTimes(1)

    rerender(
      <MemoryRouter>
        <MemoDetailContent
          data={buildDetail({ status: "archived" })}
          workspaceId="ws_1"
          isLoading={false}
          edit={controls}
        />
      </MemoryRouter>
    )

    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /restore/i }))
    expect(controls.onUnarchive).toHaveBeenCalledTimes(1)
  })

  it("offers neither Archive nor Restore on a superseded memo (can't resurrect it)", () => {
    const controls = buildControls()
    renderDetail(
      <MemoDetailContent
        data={buildDetail({ status: "superseded" })}
        workspaceId="ws_1"
        isLoading={false}
        edit={controls}
      />
    )
    expect(screen.queryByRole("button", { name: /archive/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument()
  })

  it("copies the memo's resource URL and confirms in place with a checkmark (INV-63/21: no toast, same footprint)", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })

    renderDetail(<MemoDetailContent data={buildDetail()} workspaceId="ws_1" isLoading={false} />)

    // Accessible name is the visible label until it confirms — a superset on
    // copy keeps voice control / WCAG 2.5.3 intact.
    await user.click(screen.getByRole("button", { name: "Copy link" }))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain("/w/ws_1/memory?memo=memo_1")
    // Same button, relabeled — the checkmark confirmation replaces the toast.
    await screen.findByRole("button", { name: "Copy link, copied" })
  })

  it("links a superseded memo to its successor", () => {
    const detail = { ...buildDetail({ status: "superseded" }), successorMemoId: "memo_2" }
    renderDetail(<MemoDetailContent data={detail} workspaceId="ws_1" isLoading={false} />)
    const link = screen.getByRole("link", { name: /replaced by a newer memo/i })
    expect(link).toHaveAttribute("href", expect.stringContaining("memo=memo_2"))
  })
})

describe("MemoDetailContent agent provenance (roadmap 6.6)", () => {
  beforeEach(() => {
    vi.spyOn(relativeTimeModule, "RelativeTime").mockImplementation(() => <span>just now</span>)
  })

  it("flags an agent-authored memo with the capturing persona's name", () => {
    const detail = {
      ...buildDetail({ authoredByKind: "agent", sourceSessionId: "agsess_1" }),
      capturedByPersonaName: "Ariadne",
    }
    renderDetail(<MemoDetailContent data={detail} workspaceId="ws_1" isLoading={false} />)
    expect(screen.getByText("Captured by Ariadne")).toBeInTheDocument()
    expect(screen.getByText(/written by Ariadne from its own session work/i)).toBeInTheDocument()
  })

  it("falls back to a generic label when the persona is unresolvable", () => {
    const detail = buildDetail({ authoredByKind: "agent", sourceSessionId: "agsess_gone" })
    renderDetail(<MemoDetailContent data={detail} workspaceId="ws_1" isLoading={false} />)
    expect(screen.getByText("AI-captured")).toBeInTheDocument()
    expect(screen.getByText(/written by an AI agent from its own session work/i)).toBeInTheDocument()
  })

  it("shows no provenance flag on a pipeline-authored memo", () => {
    renderDetail(<MemoDetailContent data={buildDetail()} workspaceId="ws_1" isLoading={false} />)
    expect(screen.queryByText(/AI-captured|Captured by/)).not.toBeInTheDocument()
    expect(screen.queryByText(/written by .* session work/i)).not.toBeInTheDocument()
  })
})
