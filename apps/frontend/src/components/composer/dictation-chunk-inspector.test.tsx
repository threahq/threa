import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"
import type { DictationChunkRecord } from "@/hooks/use-voice-dictation"
import { DictationChunkInspector, HOVER_CLOSE_GRACE_MS } from "./dictation-chunk-inspector"

function makeChunks(overrides: Partial<DictationChunkRecord> = {}): Map<string, DictationChunkRecord> {
  return new Map([
    [
      "chunk-1",
      {
        raw: "helo wrld",
        polished: "Hello world",
        currentlyShowing: "polished" as const,
        locked: false,
        ...overrides,
      },
    ],
  ])
}

/** Mounts the inspector plus a decoration-style chunk element it can anchor to. */
function setup(chunks = makeChunks()) {
  const chunkEl = document.createElement("span")
  chunkEl.dataset.chunkId = "chunk-1"
  chunkEl.textContent = "Hello world"
  document.body.appendChild(chunkEl)

  const onToggle = vi.fn()
  render(<DictationChunkInspector chunks={chunks} onToggle={onToggle} />)
  return { chunkEl, onToggle }
}

function hoverChunk(chunkEl: HTMLElement) {
  fireEvent.pointerOver(chunkEl, { pointerType: "mouse" })
}

describe("DictationChunkInspector hover lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.querySelectorAll("[data-chunk-id]").forEach((el) => el.remove())
  })

  it("opens on hover and shows both versions", () => {
    const { chunkEl } = setup()
    hoverChunk(chunkEl)

    const popover = screen.getByRole("dialog", { name: "Dictation polish comparison" })
    expect(popover).toHaveTextContent("Hello world")
    expect(popover).toHaveTextContent("helo wrld")
  })

  it("stays open while the cursor crosses the gap to the popover", () => {
    const { chunkEl } = setup()
    hoverChunk(chunkEl)

    // Cursor leaves the chunk into the gap between chunk and popover
    // (relatedTarget is neither the chunk nor the popover).
    fireEvent.pointerOut(chunkEl, { pointerType: "mouse", relatedTarget: document.body })

    // Still open during the grace window...
    const popover = screen.getByRole("dialog", { name: "Dictation polish comparison" })

    // ...and landing on the popover cancels the pending close for good.
    fireEvent.pointerOver(popover, { pointerType: "mouse" })
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS * 2)
    })

    expect(screen.getByRole("dialog", { name: "Dictation polish comparison" })).toBeInTheDocument()
  })

  it("closes after the grace period when the cursor leaves for good", () => {
    const { chunkEl } = setup()
    hoverChunk(chunkEl)
    fireEvent.pointerOut(chunkEl, { pointerType: "mouse", relatedTarget: document.body })

    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS + 1)
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("closes after leaving the popover itself", () => {
    const { chunkEl } = setup()
    hoverChunk(chunkEl)
    const popover = screen.getByRole("dialog", { name: "Dictation polish comparison" })

    fireEvent.pointerOut(chunkEl, { pointerType: "mouse", relatedTarget: popover })
    fireEvent.pointerOver(popover, { pointerType: "mouse" })
    fireEvent.pointerOut(popover, { pointerType: "mouse", relatedTarget: document.body })

    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS + 1)
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("keeps the popover interactive: Switch stays clickable after crossing the gap", () => {
    const { chunkEl, onToggle } = setup()
    hoverChunk(chunkEl)
    fireEvent.pointerOut(chunkEl, { pointerType: "mouse", relatedTarget: document.body })

    const popover = screen.getByRole("dialog", { name: "Dictation polish comparison" })
    fireEvent.pointerOver(popover, { pointerType: "mouse" })
    fireEvent.click(screen.getByRole("button", { name: "Show original" }))

    expect(onToggle).toHaveBeenCalledTimes(1)
    // The popover stays open after the flip so the user can read the swap.
    expect(screen.getByRole("dialog", { name: "Dictation polish comparison" })).toBeInTheDocument()
  })
})
