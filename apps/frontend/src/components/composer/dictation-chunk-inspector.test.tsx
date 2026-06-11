import { useState } from "react"
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

/** Appends a decoration-style chunk element the inspector can anchor to. */
function appendChunkEl() {
  const chunkEl = document.createElement("span")
  chunkEl.dataset.chunkId = "chunk-1"
  chunkEl.textContent = "Hello world"
  document.body.appendChild(chunkEl)
  return chunkEl
}

/** Mounts the inspector plus a chunk element it can anchor to. */
function setup(chunks = makeChunks()) {
  const chunkEl = appendChunkEl()
  const onToggle = vi.fn()
  render(<DictationChunkInspector chunks={chunks} onToggle={onToggle} />)
  return { chunkEl, onToggle }
}

/**
 * Harness that mimics the dictation hook's session toggle: onToggle flips
 * which version every chunk shows, so the test can assert the user-visible
 * label swap instead of inspecting the mock.
 */
function ToggleHarness() {
  const [showing, setShowing] = useState<"polished" | "raw">("polished")
  return (
    <DictationChunkInspector
      chunks={makeChunks({ currentlyShowing: showing })}
      onToggle={() => setShowing((prev) => (prev === "polished" ? "raw" : "polished"))}
    />
  )
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

  it("ignores pointerout from unrelated elements: the grace timer is not restarted", () => {
    const { chunkEl } = setup()
    const elsewhere = document.createElement("div")
    document.body.appendChild(elsewhere)

    hoverChunk(chunkEl)
    fireEvent.pointerOut(chunkEl, { pointerType: "mouse", relatedTarget: document.body })

    // Mid-grace, the cursor crosses other UI on the page. Those departures
    // must not reschedule the close, or the popover would stay open for as
    // long as the mouse keeps moving.
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS / 2)
    })
    fireEvent.pointerOut(elsewhere, { pointerType: "mouse", relatedTarget: document.body })
    act(() => {
      vi.advanceTimersByTime(HOVER_CLOSE_GRACE_MS / 2 + 1)
    })

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    elsewhere.remove()
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
    const chunkEl = appendChunkEl()
    render(<ToggleHarness />)
    hoverChunk(chunkEl)
    fireEvent.pointerOut(chunkEl, { pointerType: "mouse", relatedTarget: document.body })

    const popover = screen.getByRole("dialog", { name: "Dictation polish comparison" })
    fireEvent.pointerOver(popover, { pointerType: "mouse" })
    fireEvent.click(screen.getByRole("button", { name: "Show original" }))

    // The popover stays open after the flip so the user can read the swap,
    // and the switch label reflects that the editor now shows the raw take.
    expect(screen.getByRole("dialog", { name: "Dictation polish comparison" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show polished" })).toBeInTheDocument()
  })
})
