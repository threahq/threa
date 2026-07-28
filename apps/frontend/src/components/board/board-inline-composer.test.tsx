import { describe, it, expect, vi, beforeEach } from "vitest"
import { useState, type ReactElement, type ReactNode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InlineComposerForm } from "./board-inline-composer"
import { FloatingComposerAnchorProvider, FLOATING_COMPOSER_HEIGHT_VAR } from "@/components/composer"
import { spyOnExport } from "@/test"
import * as composerModule from "@/components/composer"
import * as usePointerModule from "@/hooks/use-pointer"
import * as inputModeModule from "@/hooks/use-input-mode"
import * as hooksModule from "@/hooks"
import * as contextsModule from "@/contexts"
import * as mentionablesModule from "@/hooks/use-mentionables"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as streamStoreModule from "@/stores/stream-store"
import * as draftMessageModule from "@/hooks/use-draft-message"
import type { MessageComposerProps } from "@/components/composer"
import type { JSONContent } from "@threa/types"

// The behavior under test is the floating-anchor layer (portal placement,
// slot exclusivity, close semantics, height publication) — not editor
// mechanics — so the heavy tiptap editor is swapped for a marker div.
const EditorStub = (props: MessageComposerProps) => (
  <div
    data-testid="editor-stub"
    data-expanded={String(!!props.expanded)}
    data-has-stash={String(!!props.stashedDraftsTrigger && !!props.stashedDraftsTriggerFab && !!props.onStashDraft)}
    data-has-schedule={String(!!props.scheduledMessagesTrigger && !!props.scheduledMessagesTriggerFab)}
  >
    {props.placeholder}
    {props.onExpandClick && (
      <button type="button" onClick={props.onExpandClick}>
        Expand
      </button>
    )}
  </div>
)

const EMPTY_DOC: JSONContent = { type: "doc", content: [] }

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

function stashComposerStub() {
  return {
    drafts: [],
    handleStashDraft: vi.fn().mockResolvedValue(undefined),
    handleRestoreStashed: vi.fn().mockResolvedValue(undefined),
    handleDeleteStashed: vi.fn().mockResolvedValue(undefined),
  }
}

let flushDraft: ReturnType<typeof vi.fn>
let composerStub: ReturnType<typeof draftComposerStub>
let stashStub: ReturnType<typeof stashComposerStub>
let scheduleMutateAsync: ReturnType<typeof vi.fn>
// vi.fn wrapper so tests can read the props the form rendered the editor with.
let editorSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  editorSpy = vi.fn(EditorStub)
  spyOnExport(composerModule, "MessageComposer").mockReturnValue(editorSpy as never)
  const stub = draftComposerStub()
  composerStub = stub
  flushDraft = stub.flushDraft
  spyOnExport(hooksModule, "useDraftComposer").mockReturnValue((() => stub) as never)
  // `useStashComposer` reaches for `useSearchParams` (the `?stash=` deep-link
  // restore) and `useScheduleMessage` for the query client / sync engine — both
  // out of scope here, so they're stubbed like the draft composer above.
  stashStub = stashComposerStub()
  const stash = stashStub
  spyOnExport(hooksModule, "useStashComposer").mockReturnValue((() => stash) as never)
  scheduleMutateAsync = vi.fn().mockResolvedValue(undefined)
  spyOnExport(hooksModule, "useScheduleMessage").mockReturnValue((() => ({
    mutateAsync: scheduleMutateAsync,
  })) as never)
  // Default to desktop/fine so `floating` is off; tests that exercise the mobile
  // portal opt in per-test. The gate reads the shared `useIsMobileOrCoarse`
  // predicate (the panel full-screen breadth), so drive that boundary directly.
  vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
  // Pinned per-test: the live hook keeps module-level state, so a touch test
  // would otherwise bleed into every case after it.
  vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("mouse")
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
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
    render(<Anchored>{form()}</Anchored>)

    const anchor = screen.getByTestId("anchor")
    const editor = screen.getByTestId("editor-stub")
    expect(anchor.contains(editor)).toBe(false)
    expect(screen.getByTestId("in-place").contains(editor)).toBe(true)
    expect(screen.queryByRole("button", { name: "Close composer" })).toBeNull()
  })

  it("portals into the anchor's floating shell on mobile and publishes its height", async () => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
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
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    const onClose = vi.fn()
    render(<Anchored>{form({ onClose })}</Anchored>)

    await userEvent.click(await screen.findByRole("button", { name: "Close composer" }))
    expect(onClose).toHaveBeenCalled()
    expect(flushDraft).toHaveBeenCalled()
  })

  it("collapses the previous composer when a second one claims the slot", async () => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
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
    await waitFor(() => expect(closeFirst).toHaveBeenCalled())
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

describe("InlineComposerForm mobile-breadth + docked gate", () => {
  it("a coarse-pointer device ≥640px floats into the anchor — no mid-flow editor", async () => {
    // The mid-screen bug: the panel full-screens on the `useIsMobileOrCoarse`
    // breadth (coarse pointer OR narrow viewport), but the form used to float on
    // bare `useIsMobile`, so a coarse tablet rendered the editor mid-flow. The
    // gate now shares the panel's predicate; `use-pointer.test` guards that a
    // wide coarse device makes that predicate true.
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    render(<Anchored>{form()}</Anchored>)

    const anchor = screen.getByTestId("anchor")
    await waitFor(() => expect(anchor.contains(screen.getByTestId("editor-stub"))).toBe(true))
    expect(screen.getByTestId("in-place").querySelector("[data-floating-composer-marker]")).not.toBeNull()
  })

  it("docked: renders in place on every device — never floats, even on a coarse phone", () => {
    // The panel footer IS the dock; suppressing the floating path keeps the
    // composer bar there instead of portaling it to a separate pill.
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    render(<Anchored>{form({ docked: true })}</Anchored>)

    const anchor = screen.getByTestId("anchor")
    const editor = screen.getByTestId("editor-stub")
    expect(anchor.contains(editor)).toBe(false)
    expect(screen.getByTestId("in-place").contains(editor)).toBe(true)
    expect(screen.queryByRole("button", { name: "Close composer" })).toBeNull()
  })
})

describe("InlineComposerForm armed reply-target strip", () => {
  beforeEach(() => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
  })

  it("shows the dismissible 'Replying in <title>' strip when armed", () => {
    render(
      <Anchored>
        {form({
          docked: true,
          replyTarget: { title: "GPU budget", moveDraftToKey: "board:reply:c", onCancel: vi.fn() },
        })}
      </Anchored>
    )
    const strip = screen.getByTestId("conversation-reply-strip")
    expect(strip.textContent).toContain("Replying in")
    expect(strip.textContent).toContain("GPU budget")
    expect(screen.getByRole("button", { name: "Cancel reply in conversation" })).toBeTruthy()
  })

  it("× relocates the draft (live content included) to the root scope, then disarms", async () => {
    const relocateSpy = vi.fn().mockResolvedValue(undefined)
    spyOnExport(draftMessageModule, "relocateLoadedDraft").mockReturnValue(relocateSpy as never)
    const onCancel = vi.fn()
    render(
      <Anchored>
        {form({
          docked: true,
          draftKey: "board:branch-reply:conv_b",
          replyTarget: { title: "Sub-topic", moveDraftToKey: "board:reply:conv_root", onCancel },
        })}
      </Anchored>
    )

    await userEvent.click(screen.getByRole("button", { name: "Cancel reply in conversation" }))

    expect(relocateSpy).toHaveBeenCalledWith(
      "ws_1",
      "board:branch-reply:conv_b",
      "board:reply:conv_root",
      expect.anything()
    )
    // Flush must precede the relocate: it clears the armed typing debounce
    // (bound to the branch scope) that would otherwise fire after the move and
    // mint a fresh draft under the vacated scope.
    expect(flushDraft).toHaveBeenCalled()
    expect(flushDraft.mock.invocationCallOrder[0]).toBeLessThan(relocateSpy.mock.invocationCallOrder[0])
    await waitFor(() => expect(onCancel).toHaveBeenCalled())
  })
})

describe("InlineComposerForm fullscreen expand", () => {
  it("desktop: an expand button opens the same draft in the fullscreen editor", async () => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
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
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(true)
    render(<Anchored>{form()}</Anchored>)
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull()
  })
})

describe("InlineComposerForm restore-on-mount", () => {
  beforeEach(() => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
  })

  it("checks out the advertised stash row once the composer loads", async () => {
    render(<Anchored>{form({ restoreStashedIdOnMount: "draft_adv" })}</Anchored>)
    await waitFor(() => expect(stashStub.handleRestoreStashed).toHaveBeenCalledWith("draft_adv"))
    expect(stashStub.handleRestoreStashed).toHaveBeenCalledTimes(1)
  })

  it("does nothing without a restore id", async () => {
    render(<Anchored>{form()}</Anchored>)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stashStub.handleRestoreStashed).not.toHaveBeenCalled()
  })
})

describe("InlineComposerForm refocus-after-send", () => {
  const lastComposerProps = (): MessageComposerProps => editorSpy.mock.calls.at(-1)![0] as MessageComposerProps

  beforeEach(() => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
    composerStub.canSend = true
  })

  it("returns focus to the resting bar when the user is driving with a mouse/keyboard", async () => {
    const onClose = vi.fn()
    render(<Anchored>{form({ onClose })}</Anchored>)

    lastComposerProps().onSubmit()

    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ refocus: true }))
  })

  it("declines the refocus on a touch send — the resting button inherits :focus-visible from the editor, painting a ring no finger navigated to", async () => {
    vi.spyOn(inputModeModule, "useInputMode").mockReturnValue("touch")
    const onClose = vi.fn()
    render(<Anchored>{form({ onClose })}</Anchored>)

    lastComposerProps().onSubmit()

    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ refocus: false }))
  })
})

describe("InlineComposerForm stash + schedule", () => {
  beforeEach(() => {
    vi.spyOn(usePointerModule, "useIsMobileOrCoarse").mockReturnValue(false)
  })

  /** The MessageComposer props the form last rendered with. */
  const lastComposerProps = (): MessageComposerProps => editorSpy.mock.calls.at(-1)![0] as MessageComposerProps

  it("always wires the stash pile; the schedule picker only with a declared target", () => {
    const { rerender } = render(<Anchored>{form()}</Anchored>)
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-has-stash", "true")
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-has-schedule", "false")

    rerender(<Anchored>{form({ scheduleTarget: { streamId: "stream_1", conversationId: "conv_1" } })}</Anchored>)
    expect(screen.getByTestId("editor-stub")).toHaveAttribute("data-has-schedule", "true")
  })

  it("scheduling routes to the schedule mutation with the existing-conversation directive and closes", async () => {
    composerStub.canSend = true
    const onClose = vi.fn()
    render(<Anchored>{form({ scheduleTarget: { streamId: "stream_1", conversationId: "conv_1" }, onClose })}</Anchored>)

    const trigger = lastComposerProps().scheduledMessagesTrigger as ReactElement<{
      onSchedule: (when: Date) => Promise<void>
    }>
    const when = new Date("2030-01-02T10:00:00.000Z")
    await trigger.props.onSchedule(when)

    expect(scheduleMutateAsync).toHaveBeenCalledWith({
      streamId: "stream_1",
      contentJson: EMPTY_DOC,
      attachmentIds: undefined,
      scheduledFor: when.toISOString(),
      conversation: { intent: "existing", conversationId: "conv_1" },
    })
    expect(composerStub.resolveDraft).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith({ refocus: true })
  })

  it("restores the content and stays open when scheduling fails", async () => {
    const typedDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }
    composerStub.canSend = true
    composerStub.content = typedDoc
    scheduleMutateAsync.mockRejectedValueOnce(new Error("offline"))
    const onClose = vi.fn()
    render(<Anchored>{form({ scheduleTarget: { streamId: "stream_1", conversationId: "conv_1" }, onClose })}</Anchored>)

    const trigger = lastComposerProps().scheduledMessagesTrigger as ReactElement<{
      onSchedule: (when: Date) => Promise<void>
    }>
    await trigger.props.onSchedule(new Date("2030-01-02T10:00:00.000Z"))

    // Cleared up front, restored on failure — nothing typed is lost.
    expect(composerStub.setContent).toHaveBeenLastCalledWith(typedDoc)
    expect(onClose).not.toHaveBeenCalled()
    expect(composerStub.resolveDraft).not.toHaveBeenCalled()
  })

  it("blocks scheduling into an E2E host with the reject message", async () => {
    composerStub.canSend = true
    vi.spyOn(streamStoreModule, "useStreamFromStore").mockReturnValue({ e2eEnabled: true } as never)
    render(
      <Anchored>
        {form({ scheduleTarget: { streamId: "stream_1", conversationId: "conv_1" }, rejectE2e: "No E2E here" })}
      </Anchored>
    )

    const trigger = lastComposerProps().scheduledMessagesTrigger as ReactElement<{
      onSchedule: (when: Date) => Promise<void>
    }>
    await trigger.props.onSchedule(new Date("2030-01-02T10:00:00.000Z"))

    expect(scheduleMutateAsync).not.toHaveBeenCalled()
  })
})
