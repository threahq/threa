import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, Fragment, createRef } from "react"
import { render, screen } from "@testing-library/react"
import * as streamContextListModule from "./stream-context-list"
import { chipsFromCounts, ContextTimeline, filterCategories, filterCount, parseFilter } from "./stream-context-chrome"
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

  it("spaces day markers by an explicit flag, not `:first-child`", () => {
    // virtua wraps every child in its own item element, so a `first:pt-0` class
    // would match EVERY marker and collapse the gap between all day groups —
    // invisible to jsdom (no CSS) and to the passthrough swap. Pin the classes.
    const seam = vi
      .spyOn(streamContextListModule, "StreamContextList")
      .mockImplementation(({ children }) => createElement(Fragment, null, children))

    render(<ContextTimeline items={items} renderItem={renderItem} scrollRef={createRef<HTMLDivElement>()} />)

    const markers = (seam.mock.calls[0]![0].children as { props: { className?: string } }[]).filter(
      (child) => typeof child.props.className === "string"
    )
    expect(markers.map((m) => m.props.className)).toEqual(["pt-0", "pt-3"])
  })

  it("renders every row unwindowed when no scroller is supplied", () => {
    const seam = vi.spyOn(streamContextListModule, "StreamContextList")

    render(<ContextTimeline items={items} renderItem={renderItem} />)

    expect(seam).not.toHaveBeenCalled()
    expect(screen.getByText("a")).toBeInTheDocument()
  })
})

describe("the Agent chip", () => {
  const counts = { link: 3, media: 0, file: 0, memo: 0, delegation: 2, follow_up: 4, thread: 0 }

  it("stands for both agent categories: one chip, their summed count, ahead of the per-category chips", () => {
    expect(chipsFromCounts(counts, 9)).toEqual([
      { value: "all", label: "All", count: 9 },
      { value: "agent", label: "Agent", count: 6 },
      { value: "link", label: "Links", count: 3 },
      { value: "delegation", label: "Delegations", count: 2 },
      { value: "follow_up", label: "Follow-ups", count: 4 },
    ])
  })

  it("is absent when neither agent category has rows", () => {
    const empty = { ...counts, delegation: 0, follow_up: 0 }

    expect(chipsFromCounts(empty, 3).map((chip) => chip.value)).toEqual(["all", "link"])
  })

  it("is addressable as ?context=agent and narrows to both categories", () => {
    expect({
      parsed: parseFilter("agent"),
      categories: filterCategories("agent"),
      singleCategory: filterCategories("follow_up"),
      all: filterCategories("all"),
      count: filterCount(counts, "agent", 9),
    }).toEqual({
      parsed: "agent",
      categories: ["follow_up", "delegation"],
      singleCategory: ["follow_up"],
      all: undefined,
      count: 6,
    })
  })
})
