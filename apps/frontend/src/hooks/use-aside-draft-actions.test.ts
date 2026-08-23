import { describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import type { DraftComposerState } from "./use-draft-composer"
import { useAsideDraftActions } from "./use-aside-draft-actions"

const CONTENT: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
}

function composerStub(overrides: Partial<DraftComposerState> = {}): DraftComposerState {
  return {
    content: CONTENT,
    flushDraft: vi.fn(async () => {}),
    clearDraft: vi.fn(async () => {}),
    ...overrides,
  } as unknown as DraftComposerState
}

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
    expect({ calls: onSendToComposer.mock.calls.length, done: onDone.mock.calls.length }).toEqual({ calls: 1, done: 1 })
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
