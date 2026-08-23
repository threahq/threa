import { afterEach, describe, expect, it, vi } from "vitest"
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
const queued = (delivered: boolean | Promise<boolean>) => ({ delivered: Promise.resolve(delivered) })

afterEach(() => vi.restoreAllMocks())

describe("useAsideDraftActions", () => {
  it("delivers the draft once when send is pressed twice before the hand-off resolves", async () => {
    let deliver: (queued: { delivered: Promise<boolean> } | null) => void = () => {}
    const onSendToComposer = vi.fn(
      () => new Promise<{ delivered: Promise<boolean> } | null>((resolve) => (deliver = resolve))
    )
    const onDone = vi.fn()
    const { result } = renderHook(() => useAsideDraftActions(composerStub(), { onSendToComposer, onDone }))

    let first: Promise<void> = Promise.resolve()
    await act(async () => {
      first = result.current.send()
      void result.current.send()
    })
    expect({ calls: onSendToComposer.mock.calls.length, busy: result.current.busy }).toEqual({ calls: 1, busy: true })

    await act(async () => {
      deliver(queued(true))
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
      useAsideDraftActions(composerStub({ flushDraft }), {
        onSendToComposer: vi.fn(async () => queued(true)),
        onDone,
      })
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
    let deliver: (queued: { delivered: Promise<boolean> } | null) => void = () => {}
    const onSendToComposer = vi.fn(
      () => new Promise<{ delivered: Promise<boolean> } | null>((resolve) => (deliver = resolve))
    )
    const clearDraft = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useAsideDraftActions(composerStub({ clearDraft }), { onSendToComposer, onDone: vi.fn() })
    )

    let sending: Promise<void> = Promise.resolve()
    await act(async () => {
      sending = result.current.send()
      await result.current.remove()
    })
    expect(clearDraft).not.toHaveBeenCalled()
    await act(async () => {
      deliver(queued(true))
      await sending
    })
  })

  it("keeps the draft and says so when the composer refuses it", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")
    const onDone = vi.fn()
    const { result } = renderHook(() =>
      useAsideDraftActions(composerStub(), { onSendToComposer: vi.fn(async () => null), onDone })
    )

    await act(async () => {
      await result.current.send()
    })
    expect({ toasts: error.mock.calls, done: onDone.mock.calls }).toEqual({
      toasts: [["Couldn't hand this draft to the composer."]],
      done: [],
    })
  })

  it("moves uploaded files with the text: hands them over and lets go of exactly those once the destination has them", async () => {
    const onSendToComposer = vi.fn(async () => queued(true))
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
      released: [[[FILE.id]]],
    })
  })

  it("keeps its files when the destination could not persist them, and says so", async () => {
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")
    const composer = composerStub({ pendingAttachments: [{ ...FILE, status: "uploaded" }] as never })
    const { result } = renderHook(() =>
      useAsideDraftActions(composer, { onSendToComposer: vi.fn(async () => queued(false)), onDone: vi.fn() })
    )
    await act(async () => {
      await result.current.send()
    })
    expect({
      released: (composer.releaseAttachments as ReturnType<typeof vi.fn>).mock.calls,
      toasts: error.mock.calls,
    }).toEqual({
      released: [],
      toasts: [["The composer didn't confirm it has the files; this draft keeps them."]],
    })
  })

  it("holds while a file is still uploading", async () => {
    const uploading = composerStub({
      isUploading: true,
      pendingAttachments: [{ ...FILE, status: "uploading" }] as never,
    })
    const onSendToComposer = vi.fn(async () => queued(true))
    const { result } = renderHook(() => useAsideDraftActions(uploading, { onSendToComposer, onDone: vi.fn() }))
    expect(result.current.canSend).toBe(false)
    await act(async () => {
      await result.current.send()
    })
    expect(onSendToComposer).not.toHaveBeenCalled()
  })

  it("does nothing for an empty draft", async () => {
    const onSendToComposer = vi.fn(async () => queued(true))
    const empty = composerStub({ content: { type: "doc", content: [{ type: "paragraph" }] } })
    const { result } = renderHook(() => useAsideDraftActions(empty, { onSendToComposer, onDone: vi.fn() }))

    expect(result.current.canSend).toBe(false)
    await act(async () => {
      await result.current.send()
    })
    expect(onSendToComposer).not.toHaveBeenCalled()
  })
})
