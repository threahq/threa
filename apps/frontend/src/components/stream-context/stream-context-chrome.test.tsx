import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, Fragment, createRef } from "react"
import { render, screen } from "@testing-library/react"
import * as streamContextListModule from "./stream-context-list"
import { ContextTimeline } from "./stream-context-chrome"
import type { ContextItem } from "@/lib/stream-context/types"

/**
 * The windowing itself only works in a real browser (jsdom has zero-height
 * layout and a no-op ResizeObserver), so what these pin is the WIRING: given a
 * scroller the timeline must hand its rows to the virtualization seam, and
 * without one it must still render them. A regression here silently un-windows
 * the panel — hundreds of rows mounting at once — with every other test green,
 * because they all swap the seam for a passthrough.
 */
function item(key: string, occurredAt: string): ContextItem {
  return {
    key,
    category: "link",
    createdAt: occurredAt,
    sourceMessageId: `msg_${key}`,
    snippet: "",
    url: `https://example.com/${key}`,
    title: key,
    siteName: null,
    faviconUrl: null,
    imageUrl: null,
    previewKind: "generic",
    badge: null,
    refCount: 1,
  } as ContextItem
}

describe("ContextTimeline virtualization wiring", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const items = [item("a", "2026-07-20T10:00:00.000Z"), item("b", "2026-07-19T10:00:00.000Z")]
  const renderItem = (i: ContextItem) => <span key={i.key}>{i.key}</span>

  it("hands its rows to the virtualization seam when the panel supplies a scroller", () => {
    const seam = vi
      .spyOn(streamContextListModule, "StreamContextList")
      .mockImplementation(({ children }) => createElement(Fragment, null, children))
    const scrollRef = createRef<HTMLDivElement>()

    render(<ContextTimeline items={items} renderItem={renderItem} scrollRef={scrollRef} />)

    expect(seam).toHaveBeenCalled()
    expect(seam.mock.calls[0]![0].scrollRef).toBe(scrollRef)
    // The day markers ride the same flat child list as the rows — virtua windows
    // a flat list, so a marker must not wrap its group.
    expect(seam.mock.calls[0]![0].children).toHaveLength(4)
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("b")).toBeInTheDocument()
  })

  it("renders every row unwindowed when no scroller is supplied", () => {
    const seam = vi.spyOn(streamContextListModule, "StreamContextList")

    render(<ContextTimeline items={items} renderItem={renderItem} />)

    expect(seam).not.toHaveBeenCalled()
    expect(screen.getByText("a")).toBeInTheDocument()
  })
})
