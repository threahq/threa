import { describe, it, expect, vi, beforeEach } from "vitest"
import { useState, type ReactNode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InlineComposerForm } from "./board-inline-composer"
import { FloatingComposerAnchorProvider, FLOATING_COMPOSER_HEIGHT_VAR } from "@/components/composer"
import { spyOnExport } from "@/test"
import * as composerModule from "@/components/composer"
import * as useMobileModule from "@/hooks/use-mobile"
import * as hooksModule from "@/hooks"
import * as contextsModule from "@/contexts"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as streamStoreModule from "@/stores/stream-store"
import type { MessageComposerProps } from "@/components/composer"

// The behavior under test is the floating-anchor layer (portal placement,
// slot exclusivity, close semantics, height publication) — not editor
// mechanics — so the heavy tiptap editor is swapped for a marker div.
const EditorStub = (props: MessageComposerProps) => (
  <div data-testid="editor-stub" data-expanded={String(!!props.expanded)}>
    {props.placeholder}
    {props.onExpandClick && (
      <button type="button" onClick={props.onExpandClick}>
        Expand
      </button>
    )}
  </div>
)

const EMPTY_DOC = { type: "doc", content: [] }

function draftComposerStub() {
  return {
    content: EMPTY_DOC,
    isLoaded: true,
    setContent: vi.fn(),
    canSend: false,
    pendingAttachments: [],
    getPendingAttachmentsSnapshot: () => [],
    setIsSending: vi.fn(),
    resolveDraft: vi.fn().mockResolvedValue(undefined),
    clearAttachments: vi.fn(),
    handleContentChange: vi.fn(),
    handleRemoveAttachment: vi.fn(),
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(),
    uploadFile: vi.fn(),
    imageCount: 0,
    isSending: false,
    hasFailed: false,
    flushDraft: vi.fn().mockResolvedValue(undefined),
  }
}

let flushDraft: ReturnType<typeof vi.fn>

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  spyOnExport(composerModule, "MessageComposer").mockReturnValue(EditorStub as never)
  const stub = draftComposerStub()
  flushDraft = stub.flushDraft
  spyOnExport(hooksModule, "useDraftComposer").mockReturnValue((() => stub) as never)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({ preferences: undefined } as never)
  vi.spyOn(mentionablesModule, "useMentionStreamContext").mockReturnValue(undefined as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue(undefined as never)
})

/** Anchor container + provider, the shape the board page / panel supply. */
function Anchored({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  return (
    <div>
      <div data-testid="anchor" ref={setEl} />
      <div data-testid="in-place">
        <FloatingComposerAnchorProvider el={el}>{children}</FloatingComposerAnchorProvider>
      </div>
    </div>
  )
}

function form(overrides: Partial<Parameters<typeof InlineComposerForm>[0]> = {}) {
  return (
    <InlineComposerForm
      workspaceId="ws_1"
      streamId="stream_1"
      memoAnchorStreamId="stream_1"
      draftKey="board:test"
      placeholder="Write a reply…"
      onSubmit={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
      {...overrides}
    />
  )
}

describe("InlineComposerForm floating anchor (mobile)", () => {
  it("renders in place on desktop even when an anchor exists", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    render(<Anchored>{form()}</Anchored>)

    const anchor = screen.getByTestId("anchor")
    const editor = screen.getByTestId("editor-stub")
    expect(anchor.contains(editor)).toBe(false)
    expect(screen.getByTestId("in-place").contains(editor)).toBe(true)
    expect(screen.queryByRole("button", { name: "Close composer" })).toBeNull()
  })

  it("portals into the anchor's floating shell on mobile and publishes its height", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const { unmount } = render(<Anchored>{form({ contextChip: "Replying in GPU budget" })}</Anchored>)

    const anchor = screen.getByTestId("anchor")
    await waitFor(() => expect(anchor.contains(screen.getByTestId("editor-stub"))).toBe(true))
    // The target chip travels with the floating form (the pill is far from the card).
    expect(anchor.textContent).toContain("Replying in GPU budget")
    // The in-place marker stands in for the portaled form as the scroll target.
    expect(screen.getByTestId("in-place").querySelector("[data-floating-composer-marker]")).not.toBeNull()
    // Height published for the scroller's bottom reservation; cleared on close.
    expect(anchor.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR)).not.toBe("")
    unmount()
    expect(anchor.style.getPropertyValue(FLOATING_COMPOSER_HEIGHT_VAR)).toBe("")
  })

  it("dismisses via the close button, flushing the draft", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const onClose = vi.fn()
    render(<Anchored>{form({ onClose })}</Anchored>)

    await userEvent.click(await screen.findByRole("button", { name: "Close composer" }))
    expect(onClose).toHaveBeenCalledWith({ hadContent: false })
    expect(flushDraft).toHaveBeenCalled()
  })

  it("collapses the previous composer when a second one claims the slot", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const closeFirst = vi.fn()
    const closeSecond = vi.fn()
    const { rerender } = render(<Anchored>{form({ onClose: closeFirst, placeholder: "First" })}</Anchored>)
    await screen.findByText("First")
    expect(closeFirst).not.toHaveBeenCalled()

    rerender(
      <Anchored>
        {form({ onClose: closeFirst, placeholder: "First" })}
        {form({ onClose: closeSecond, placeholder: "Second" })}
      </Anchored>
    )
    await waitFor(() => expect(closeFirst).toHaveBeenCalledWith({ hadContent: false }))
    expect(closeSecond).not.toHaveBeenCalled()
    await screen.findByText("Second")

    // The render gate, not just the close callback, enforces exclusivity: the
    // superseded form is still mounted here (onClose is a spy, nothing unmounted
    // it), yet only the claimant's pill exists in the anchor — two pills can
    // never stack during a hand-off.
    const anchor = screen.getByTestId("anchor")
    const pills = anchor.querySelectorAll('[data-testid="editor-stub"]')
    expect(pills).toHaveLength(1)
    expect(pills[0]?.textContent).toBe("Second")
  })
})

describe("InlineComposerForm fullscreen expand", () => {
  it("desktop: an expand button opens the same draft in the fullscreen editor", async () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    render(<Anchored>{form()}</Anchored>)

    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-expanded", "false")

    await userEvent.click(screen.getByRole("button", { name: "Expand" }))

    // The inline form is replaced by the expanded one — same draft, one editor
    // mounted at a time, not two competing instances of the same content.
    const stubs = await screen.findAllByTestId("editor-stub")
    expect(stubs).toHaveLength(1)
    expect(stubs[0]).toHaveAttribute("data-expanded", "true")
  })

  it("mobile: no expand affordance — the floating pill has its own height-publish lifecycle", () => {
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    render(<Anchored>{form()}</Anchored>)
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull()
  })
})
