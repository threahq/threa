import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useConversationAutoRead } from "./use-conversation-auto-read"
import * as autoMarkModule from "@/hooks/use-auto-mark-as-read"
import type { RowReadState } from "@/components/timeline/read-frontier-context"
import type { RenderableMessage } from "@/components/message/message-item"

const ROOT = "stream_root"

function msg(id: string, minute: number, sequence?: string): RenderableMessage {
  return {
    id,
    streamId: ROOT,
    sequence,
    authorId: "usr_other",
    authorType: "user",
    contentMarkdown: `body ${id}`,
    reactions: {},
    createdAt: `2026-07-01T12:${String(minute).padStart(2, "0")}:00.000Z`,
  }
}

/** A fresh function per call — the hook's pin effect keys on `rowState` identity,
 * exactly as the production controller hands out a new callback when the
 * overlay/watermark caches change. */
function makeRowState(states: Record<string, RowReadState>) {
  return (_streamId: string, messageId: string): RowReadState => states[messageId] ?? "ungated"
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed = new Set<Element>()
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element) {
    this.observed.add(el)
  }
  unobserve(el: Element) {
    this.observed.delete(el)
  }
  disconnect() {
    this.observed.clear()
  }
  fire(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    this.callback(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}

let container: HTMLDivElement
const rowEls = new Map<string, HTMLElement>()
let attention = true

function addRow(id: string) {
  const el = document.createElement("div")
  el.dataset.messageRow = ""
  el.dataset.messageId = id
  container.appendChild(el)
  rowEls.set(id, el)
}

function io(): FakeIntersectionObserver {
  const instance = FakeIntersectionObserver.instances.at(-1)
  if (!instance) throw new Error("no IntersectionObserver constructed")
  return instance
}

function enter(...ids: string[]) {
  act(() => {
    io().fire(ids.map((id) => ({ target: rowEls.get(id)!, isIntersecting: true })))
  })
}

function leave(...ids: string[]) {
  act(() => {
    io().fire(ids.map((id) => ({ target: rowEls.get(id)!, isIntersecting: false })))
  })
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/** Dwell (1s) + trailing debounce (2s), with margin. */
function settle() {
  advance(1_100)
  advance(2_100)
}

const markRead = vi.fn<(messageId: string) => Promise<void>>()

/** Captures the pin the hook registers, standing in for the controller's
 * `setExplicitUnreadListener`; tests invoke it to simulate the menu action. */
let explicitUnreadPin: (() => void) | null = null
const registerExplicitUnread = (listener: (() => void) | null) => {
  explicitUnreadPin = listener
}

/** Mutable raw read truth per stream, standing in for the controller's
 * `getReadTruth`; the hook's cross-device pin arm diffs this — never derived
 * row state. Tests mutate it then rerender to deliver the change. */
let readTruth: Record<string, { lastReadSequence: string | null; readMessageIds: string[] }> = {}
const getReadTruth = (streamId: string) => readTruth[streamId] ?? { lastReadSequence: null, readMessageIds: [] }

function mount(messages: RenderableMessage[], states: Record<string, RowReadState>) {
  const containerRef = { current: container }
  return renderHook(
    (props: { messages: RenderableMessage[]; rowState: ReturnType<typeof makeRowState> }) =>
      useConversationAutoRead({
        containerRef,
        messages: props.messages,
        rootStreamId: ROOT,
        rowState: props.rowState,
        markRead,
        registerExplicitUnread,
        getReadTruth,
      }),
    { initialProps: { messages, rowState: makeRowState(states) } }
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  FakeIntersectionObserver.instances = []
  rowEls.clear()
  attention = true
  explicitUnreadPin = null
  readTruth = {}
  markRead.mockReset()
  markRead.mockResolvedValue(undefined)
  vi.spyOn(autoMarkModule, "useAutoReadAttention").mockImplementation(() => attention)
  container = document.createElement("div")
  document.body.appendChild(container)
})

afterEach(() => {
  container.remove()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("useConversationAutoRead", () => {
  it("marks through the newest seen row after dwell + debounce", () => {
    const messages = [msg("m_a", 0), msg("m_b", 1), msg("m_c", 2)]
    messages.forEach((m) => addRow(m.id))
    mount(messages, { m_a: "unread", m_b: "unread", m_c: "unread" })

    enter("m_a", "m_b", "m_c")
    settle()

    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith("m_c")
  })

  it("marks only through the furthest row that actually dwelled", () => {
    const messages = [msg("m_a", 0), msg("m_b", 1)]
    messages.forEach((m) => addRow(m.id))
    mount(messages, { m_a: "unread", m_b: "unread" })

    enter("m_a")
    settle()

    expect(markRead).toHaveBeenCalledWith("m_a")
  })

  it("a scroll-past that leaves before the dwell completes does not mark", () => {
    const messages = [msg("m_a", 0)]
    addRow("m_a")
    mount(messages, { m_a: "unread" })

    enter("m_a")
    advance(500)
    leave("m_a")
    advance(10_000)

    expect(markRead).not.toHaveBeenCalled()
  })

  it("does not fire when everything at/below the target is already read", () => {
    const messages = [msg("m_a", 0), msg("m_b", 1)]
    messages.forEach((m) => addRow(m.id))
    mount(messages, { m_a: "read", m_b: "read" })

    enter("m_a", "m_b")
    settle()

    expect(markRead).not.toHaveBeenCalled()
  })

  it("never targets an optimistic temp_ row and ignores rendered rows outside the eligible run", () => {
    // temp_ is filtered from eligibility; m_x is in the DOM (e.g. a trailing
    // preview past a collapsed gap) but not in `messages`, so it is not observed.
    const messages = [msg("m_a", 0), msg("temp_b", 1)]
    addRow("m_a")
    addRow("temp_b")
    addRow("m_x")
    mount(messages, { m_a: "unread", temp_b: "unread", m_x: "unread" })

    expect(io().observed.has(rowEls.get("temp_b")!)).toBe(false)
    expect(io().observed.has(rowEls.get("m_x")!)).toBe(false)

    enter("m_a")
    settle()

    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith("m_a")
  })

  it("only observes message rows — an editor node carrying an eligible data-message-id is not observed", () => {
    // A quote-reply/in-app-link node in the card's composer renders
    // data-message-id for an eligible row; without the data-message-row scope it
    // would dwell beside the cursor and mark rows never on screen.
    const messages = [msg("m_a", 0)]
    addRow("m_a")
    const quoteNode = document.createElement("span")
    quoteNode.dataset.messageId = "m_a"
    container.appendChild(quoteNode)
    mount(messages, { m_a: "unread" })

    expect(io().observed.has(rowEls.get("m_a")!)).toBe(true)
    expect(io().observed.has(quoteNode)).toBe(false)
  })

  it("pins on a raw watermark regression (cross-device mark-unread): no re-mark on screen, resumes after leave + re-enter", () => {
    const messages = [msg("m_a", 0, "1"), msg("m_b", 1, "2"), msg("m_c", 2, "3")]
    messages.forEach((m) => addRow(m.id))
    readTruth[ROOT] = { lastReadSequence: "0", readMessageIds: [] }
    const { rerender } = mount(messages, { m_a: "unread", m_b: "unread", m_c: "unread" })

    enter("m_a", "m_b", "m_c")
    settle()
    expect(markRead).toHaveBeenCalledTimes(1)

    // The mark lands and compacts: watermark at m_c, everything read.
    readTruth[ROOT] = { lastReadSequence: "3", readMessageIds: [] }
    rerender({ messages, rowState: makeRowState({ m_a: "read", m_b: "read", m_c: "read" }) })
    // Another device marks unread from m_b: the watermark REGRESSES to just
    // before it, and the exposed rows derive unread.
    readTruth[ROOT] = { lastReadSequence: "1", readMessageIds: [] }
    rerender({ messages, rowState: makeRowState({ m_a: "read", m_b: "unread", m_c: "unread" }) })

    // Rows are still on screen — pinned, nothing re-marks.
    advance(10_000)
    expect(markRead).toHaveBeenCalledTimes(1)

    // A new unread reply dwelling while pinned must NOT cutoff-mark over the
    // explicit unread.
    const withNew = [...messages, msg("m_d", 3, "4")]
    addRow("m_d")
    rerender({
      messages: withNew,
      rowState: makeRowState({ m_a: "read", m_b: "unread", m_c: "unread", m_d: "unread" }),
    })
    enter("m_d")
    advance(10_000)
    expect(markRead).toHaveBeenCalledTimes(1)

    // Leaving releases the pin row-by-row; coming back re-reads deliberately.
    leave("m_a", "m_b", "m_c", "m_d")
    enter("m_a", "m_b", "m_c", "m_d")
    settle()
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenLastCalledWith("m_d")
  })

  it("pins on an overlay drop without watermark advance (mark-unread above the watermark)", () => {
    const messages = [msg("m_a", 0, "5"), msg("m_b", 1, "6")]
    messages.forEach((m) => addRow(m.id))
    // Both rows read via the sparse overlay, watermark below them.
    readTruth[ROOT] = { lastReadSequence: "4", readMessageIds: ["m_a", "m_b"] }
    const { rerender } = mount(messages, { m_a: "read", m_b: "read" })

    // Another device marks m_b unread: its id drops from the overlay, the
    // watermark does not move.
    readTruth[ROOT] = { lastReadSequence: "4", readMessageIds: ["m_a"] }
    rerender({ messages, rowState: makeRowState({ m_a: "read", m_b: "unread" }) })

    enter("m_a", "m_b")
    advance(10_000)
    expect(markRead).not.toHaveBeenCalled()
  })

  it("does not pin on derived-state flapping while raw read truth is unchanged (staging board-wedge regression)", () => {
    // The dogfood failure: a count leaving zero (own send) re-derives rows
    // from a stale frontier — read → unread with NO change to the watermark
    // or overlay. Auto-read must keep working, not wedge.
    const messages = [msg("m_a", 0, "1"), msg("m_b", 1, "2")]
    messages.forEach((m) => addRow(m.id))
    readTruth[ROOT] = { lastReadSequence: "0", readMessageIds: [] }
    const { rerender } = mount(messages, { m_a: "read", m_b: "read" })

    rerender({ messages, rowState: makeRowState({ m_a: "unread", m_b: "unread" }) })

    enter("m_a", "m_b")
    settle()
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith("m_b")
  })

  it("does not pin when compaction drops overlay ids while advancing the watermark", () => {
    const messages = [msg("m_a", 0, "5"), msg("m_b", 1, "6")]
    messages.forEach((m) => addRow(m.id))
    readTruth[ROOT] = { lastReadSequence: "4", readMessageIds: ["m_a"] }
    const { rerender } = mount(messages, { m_a: "read", m_b: "unread" })

    // Compaction: the overlay id is absorbed, the watermark advances past it.
    readTruth[ROOT] = { lastReadSequence: "5", readMessageIds: [] }
    rerender({ messages, rowState: makeRowState({ m_a: "read", m_b: "unread" }) })

    enter("m_a", "m_b")
    settle()
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith("m_b")
  })

  it("pins synchronously when the menu mark-unread fires, cancelling a pending debounce", () => {
    const messages = [msg("m_a", 0), msg("m_b", 1)]
    messages.forEach((m) => addRow(m.id))
    mount(messages, { m_a: "read", m_b: "unread" })

    enter("m_a", "m_b")
    advance(1_100) // dwell done, debounce pending
    // The user marks m_a unread; the controller invokes the registered pin
    // before its request departs — the pending debounce must not fire.
    act(() => explicitUnreadPin!())
    advance(10_000)
    expect(markRead).not.toHaveBeenCalled()

    // Leave-and-return releases the pin and re-reads deliberately.
    leave("m_a", "m_b")
    enter("m_a", "m_b")
    settle()
    expect(markRead).toHaveBeenCalledWith("m_b")
  })

  it("pins on a regression that lands while attention is off, so refocus does not undo it", () => {
    const messages = [msg("m_a", 0, "1"), msg("m_b", 1, "2")]
    messages.forEach((m) => addRow(m.id))
    readTruth[ROOT] = { lastReadSequence: "0", readMessageIds: [] }
    const { rerender } = mount(messages, { m_a: "unread", m_b: "unread" })

    enter("m_a", "m_b")
    settle()
    expect(markRead).toHaveBeenCalledTimes(1)
    readTruth[ROOT] = { lastReadSequence: "2", readMessageIds: [] }
    rerender({ messages, rowState: makeRowState({ m_a: "read", m_b: "read" }) })

    // Attention drops (observer torn down), then another device marks unread
    // from m_a — the watermark regresses.
    attention = false
    rerender({ messages, rowState: makeRowState({ m_a: "read", m_b: "read" }) })
    readTruth[ROOT] = { lastReadSequence: "0", readMessageIds: [] }
    rerender({ messages, rowState: makeRowState({ m_a: "unread", m_b: "unread" }) })

    // Refocus: the rebuilt observer's initial entries report the rows still on
    // screen — they must stay pinned, not dwell into a re-mark.
    attention = true
    rerender({ messages, rowState: makeRowState({ m_a: "unread", m_b: "unread" }) })
    enter("m_a", "m_b")
    advance(10_000)
    expect(markRead).toHaveBeenCalledTimes(1)

    leave("m_a", "m_b")
    enter("m_a", "m_b")
    settle()
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenLastCalledWith("m_b")
  })

  it("does not observe at all while the viewer's attention is off the page", () => {
    attention = false
    const messages = [msg("m_a", 0)]
    addRow("m_a")
    const { rerender } = mount(messages, { m_a: "unread" })

    expect(FakeIntersectionObserver.instances).toHaveLength(0)

    // Attention returns → the observer arms and dwell proceeds normally.
    attention = true
    rerender({ messages, rowState: makeRowState({ m_a: "unread" }) })
    enter("m_a")
    settle()
    expect(markRead).toHaveBeenCalledWith("m_a")
  })

  it("flushes a pending debounce on unmount so a seen row is not lost", () => {
    const messages = [msg("m_a", 0)]
    addRow("m_a")
    const { unmount } = mount(messages, { m_a: "unread" })

    enter("m_a")
    advance(1_100) // dwell done, debounce still pending
    expect(markRead).not.toHaveBeenCalled()

    act(() => unmount())
    expect(markRead).toHaveBeenCalledWith("m_a")
  })

  it("releases the dedup after a failed mark so a later evaluation retries", async () => {
    markRead.mockRejectedValueOnce(new Error("offline"))
    const messages = [msg("m_a", 0), msg("m_b", 1)]
    messages.forEach((m) => addRow(m.id))
    mount(messages, { m_a: "unread", m_b: "unread" })

    enter("m_a")
    settle()
    expect(markRead).toHaveBeenCalledTimes(1)
    await act(async () => {}) // let the rejection settle and clear the dedup

    enter("m_b")
    settle()
    expect(markRead).toHaveBeenCalledTimes(2)
    expect(markRead).toHaveBeenLastCalledWith("m_b")
  })
})
