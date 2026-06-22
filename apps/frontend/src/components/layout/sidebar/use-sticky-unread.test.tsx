import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { StreamTypes, Visibilities } from "@threa/types"
import { useStickyUnread } from "./use-sticky-unread"
import type { StreamItemData, UrgencyLevel } from "./types"

function item(id: string, urgency: UrgencyLevel = "quiet"): StreamItemData {
  return {
    id,
    workspaceId: "ws_1",
    type: StreamTypes.CHANNEL,
    displayName: id,
    slug: id,
    description: null,
    visibility: Visibilities.PRIVATE,
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    archivedAt: null,
    lastMessagePreview: null,
    urgency,
    section: "recent",
  }
}

/** getUnreadCount over a set of unread ids. */
function counts(unread: Set<string>) {
  return (id: string) => (unread.has(id) ? 1 : 0)
}

describe("useStickyUnread", () => {
  it("holds a stream that goes unread, and keeps it after it's read (sticky)", () => {
    const streams = [item("a", "activity"), item("b")]
    let unread = new Set(["a"])
    const { result, rerender } = renderHook(
      ({ u }: { u: Set<string> }) => useStickyUnread("ws_1", streams, counts(u), true),
      { initialProps: { u: unread } }
    )

    expect([...result.current.streamIds]).toEqual(["a"])
    expect(result.current.hasReadResidue).toBe(false)

    // a is read — it stays in the tray, now flagged as read residue.
    unread = new Set()
    rerender({ u: unread })
    expect([...result.current.streamIds]).toEqual(["a"])
    expect(result.current.hasReadResidue).toBe(true)

    // clearRead flushes the read member.
    act(() => result.current.clearRead())
    expect([...result.current.streamIds]).toEqual([])
  })

  it("excludes muted streams — quiet urgency never enters the tray even with unread", () => {
    const streams = [item("muted", "quiet")]
    const { result } = renderHook(() => useStickyUnread("ws_1", streams, counts(new Set(["muted"])), true))
    expect([...result.current.streamIds]).toEqual([])
  })

  it("holds nothing when disabled (no Unread section in the layout)", () => {
    const streams = [item("a", "activity")]
    const { result } = renderHook(() => useStickyUnread("ws_1", streams, counts(new Set(["a"])), false))
    expect([...result.current.streamIds]).toEqual([])
  })

  it("prunes a held stream once it no longer exists (archived/left)", () => {
    let streams = [item("a", "activity"), item("b", "activity")]
    const unread = new Set(["a", "b"])
    const { result, rerender } = renderHook(
      ({ s }: { s: StreamItemData[] }) => useStickyUnread("ws_1", s, counts(unread), true),
      { initialProps: { s: streams } }
    )
    expect([...result.current.streamIds].sort()).toEqual(["a", "b"])

    // b disappears from the stream list — it should drop out of the tray.
    streams = [item("a", "activity")]
    rerender({ s: streams })
    expect([...result.current.streamIds]).toEqual(["a"])
  })
})
