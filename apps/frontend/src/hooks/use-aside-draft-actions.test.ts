import { describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { toast } from "sonner"
import type { JSONContent } from "@threa/types"
import type { DraftComposerState } from "./use-draft-composer"
import { useAsideDraftActions } from "./use-aside-draft-actions"

const CONTENT: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
}

function composerStub(overrides: Partial<DraftComposerState> = {}): DraftComposerState {
  const pendingAttachments = overrides.pendingAttachments ?? []
  return {
    content: CONTENT,
    pendingAttachments,
    getPendingAttachmentsSnapshot: () => pendingAttachments,
    isUploading: false,
    flushDraft: vi.fn(async () => {}),
    clearDraft: vi.fn(async () => {}),
    releaseAttachments: vi.fn(),
    ...overrides,
  } as unknown as DraftComposerState
}

const FILE = { id: "attach_1", filename: "brief.pdf", mimeType: "application/pdf", sizeBytes: 1200 }

describe("useAsideDraftActions", () => {
  it("delivers the draft once when send is pressed twice before the hand-off resolves", async () => {
    let deliver: (ok: boolean) => void = () => {}
    const onSendToComposer = vi.fn(() => new Promise<boolean>((resolve) => (deliver = resolve)))
    const onDone = vi.fn()
    const { result } = renderHook(() => useAsideDraftActions(composerStub(), { onSendToComposer, onDone }))

    let first: Promise<void> = Promise.resolve()
    await act(async () => {
      first = result.current.send()
      void result.current.send()
    })
    expect({ calls: onSendToComposer.mock.calls.length, busy: result.current.busy }).toEqual({ calls: 1, busy: true })

    await act(async () => {
      deliver(true)
      await first
    })
    expect({ sent: onSendToComposer.mock.calls, done: onDone.mock.calls }).toEqual({
      sent: [[{ content: CONTENT.content, attachments: [] }]],
      done: [[]],
    })
  })

  it("says so and keeps the draft when the flush or the hand-off throws", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")
    const onDone = vi.fn()
    const flushDraft = vi.fn(async () => {
      throw new Error("offline")
    })
    const { result } = renderHook(() =>
      useAsideDraftActions(composerStub({ flushDraft }), { onSendToComposer: vi.fn(async () => true), onDone })
    )

    await act(async () => {
      await result.current.send()
    })

    expect({ toasts: error.mock.calls, done: onDone.mock.calls, busy: result.current.busy }).toEqual({
      toasts: [["Couldn't hand this draft to the composer."]],
      done: [],
      busy: false,
    })
  })

  it("refuses to delete the draft while its hand-off is in flight", async () => {
    const clearDraft = vi.fn(async () => {})
    const onSendToComposer = vi.fn(() => new Promise<boolean>(() => {}))
    const { result } = renderHook(() =>
      useAsideDraftActions(composerStub({ clearDraft }), { onSendToComposer, onDone: vi.fn() })
    )

    await act(async () => {
      void result.current.send()
    })
    await act(async () => {
      await result.current.remove()
    })
    expect(clearDraft).not.toHaveBeenCalled()
  })

  it("keeps the draft and says so when the composer refuses it", async () => {
    const onDone = vi.fn()
    const { result } = renderHook(() =>
      useAsideDraftActions(composerStub(), { onSendToComposer: vi.fn(async () => false), onDone })
    )

    await act(async () => {
      await result.current.send()
    })
    expect({ done: onDone.mock.calls.length, busy: result.current.busy }).toEqual({ done: 0, busy: false })
  })

  it("moves uploaded files with the text: hands them over, then lets go of them once delivered", async () => {
    const onSendToComposer = vi.fn(async () => true)
    const composer = composerStub({
      pendingAttachments: [
        { ...FILE, status: "uploaded" },
        { id: "attach_2", filename: "x.png", mimeType: "image/png", sizeBytes: 10, status: "error" },
      ] as never,
    })
    const { result } = renderHook(() => useAsideDraftActions(composer, { onSendToComposer, onDone: vi.fn() }))

    await act(async () => {
      await result.current.send()
    })

    expect({
      sent: onSendToComposer.mock.calls,
      released: (composer.releaseAttachments as ReturnType<typeof vi.fn>).mock.calls,
    }).toEqual({
      sent: [[{ content: CONTENT.content, attachments: [FILE] }]],
      released: [[]],
    })
  })

  it("keeps its files when the hand-off is refused, and holds while one is still uploading", async () => {
    const refused = composerStub({ pendingAttachments: [{ ...FILE, status: "uploaded" }] as never })
    const { result } = renderHook(() =>
      useAsideDraftActions(refused, { onSendToComposer: vi.fn(async () => false), onDone: vi.fn() })
    )
    await act(async () => {
      await result.current.send()
    })
    expect(refused.releaseAttachments).not.toHaveBeenCalled()

    const uploading = composerStub({
      isUploading: true,
      pendingAttachments: [{ ...FILE, status: "uploading" }] as never,
    })
    const onSendToComposer = vi.fn(async () => true)
    const held = renderHook(() => useAsideDraftActions(uploading, { onSendToComposer, onDone: vi.fn() }))
    expect(held.result.current.canSend).toBe(false)
    await act(async () => {
      await held.result.current.send()
    })
    expect(onSendToComposer).not.toHaveBeenCalled()
  })

  it("does nothing for an empty draft", async () => {
    const onSendToComposer = vi.fn(async () => true)
    const empty = composerStub({ content: { type: "doc", content: [{ type: "paragraph" }] } })
    const { result } = renderHook(() => useAsideDraftActions(empty, { onSendToComposer, onDone: vi.fn() }))

    expect(result.current.canSend).toBe(false)
    await act(async () => {
      await result.current.send()
    })
    expect(onSendToComposer).not.toHaveBeenCalled()
  })
})
