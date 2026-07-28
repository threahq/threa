import { describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useConversationUnreadMarker } from "./use-conversation-unread-marker"
import type { RowReadState } from "@/components/timeline/read-frontier-context"
import type { RenderableMessage } from "@/components/message/message-item"

const ROOT_STREAM_ID = "stream_1"

function makeRow(id: string, authorId: string): RenderableMessage {
  return {
    id,
    streamId: ROOT_STREAM_ID,
    authorId,
    authorType: "user",
    contentMarkdown: id,
    reactions: {},
    createdAt: "2026-06-22T12:00:00.000Z",
  }
}

function stateFrom(byId: Record<string, RowReadState>) {
  return (_streamId: string, messageId: string) => byId[messageId] ?? "read"
}

function mountMarker(opts: {
  rows: RenderableMessage[]
  byId: Record<string, RowReadState>
  conversationId?: string
  readStateResolved?: boolean
}) {
  return renderHook(
    (props: { rows: RenderableMessage[]; byId: Record<string, RowReadState>; conversationId: string }) =>
      useConversationUnreadMarker({
        conversationId: props.conversationId,
        rows: props.rows,
        rootStreamId: ROOT_STREAM_ID,
        rowState: stateFrom(props.byId),
        currentUserId: "usr_me",
        readStateResolved: opts.readStateResolved ?? true,
      }),
    { initialProps: { rows: opts.rows, byId: opts.byId, conversationId: opts.conversationId ?? "conv_1" } }
  )
}

describe("useConversationUnreadMarker", () => {
  it("anchors on the first unread row from another author", () => {
    const rows = [makeRow("msg_1", "usr_other"), makeRow("msg_2", "usr_other"), makeRow("msg_3", "usr_other")]
    const { result } = mountMarker({ rows, byId: { msg_1: "read", msg_2: "unread", msg_3: "unread" } })
    expect({ markerMessageId: result.current.markerMessageId, unreadCount: result.current.unreadCount }).toEqual({
      markerMessageId: "msg_2",
      unreadCount: 2,
    })
  })

  it("skips the viewer's own rows when choosing the marker", () => {
    const rows = [makeRow("msg_1", "usr_me"), makeRow("msg_2", "usr_other")]
    const { result } = mountMarker({ rows, byId: { msg_1: "unread", msg_2: "unread" } })
    expect(result.current.markerMessageId).toBe("msg_2")
  })

  it("does not anchor on an ungated row", () => {
    const rows = [makeRow("msg_1", "usr_other"), makeRow("msg_2", "usr_other")]
    const { result } = mountMarker({ rows, byId: { msg_1: "ungated", msg_2: "ungated" } })
    expect(result.current.markerMessageId).toBeNull()
  })

  it("holds the latched marker after the rows become read", () => {
    // The R6 shape at hook level: auto-read clears the live unread the moment
    // the panel paints; a marker that moved or vanished then would leave the
    // divider drawn somewhere the user was never taken to.
    const rows = [makeRow("msg_1", "usr_other"), makeRow("msg_2", "usr_other")]
    const { result, rerender } = mountMarker({ rows, byId: { msg_1: "unread", msg_2: "unread" } })
    expect(result.current.markerMessageId).toBe("msg_1")

    rerender({ rows, byId: { msg_1: "read", msg_2: "read" }, conversationId: "conv_1" })
    expect({
      markerMessageId: result.current.markerMessageId,
      unreadCount: result.current.unreadCount,
      isDimmed: result.current.isDimmed,
    }).toEqual({ markerMessageId: "msg_1", unreadCount: 0, isDimmed: true })
  })

  it("re-latches when the hook is recycled onto another conversation", () => {
    const first = [makeRow("msg_1", "usr_other")]
    const second = [makeRow("msg_9", "usr_other")]
    const { result, rerender } = mountMarker({ rows: first, byId: { msg_1: "unread" } })
    expect(result.current.markerMessageId).toBe("msg_1")

    rerender({ rows: second, byId: { msg_9: "unread" }, conversationId: "conv_2" })
    expect(result.current.markerMessageId).toBe("msg_9")
  })

  it("clears a dismissal when the conversation changes, so a revisit with fresh unread marks again", () => {
    const first = [makeRow("msg_1", "usr_other")]
    const second = [makeRow("msg_9", "usr_other")]
    const { result, rerender } = mountMarker({ rows: first, byId: { msg_1: "unread" } })
    act(() => result.current.dismiss())
    expect(result.current.markerMessageId).toBeNull()

    rerender({ rows: second, byId: { msg_9: "read" }, conversationId: "conv_2" })
    // Back on A, which has picked up a new reply while we were away.
    const revisited = [makeRow("msg_1", "usr_other"), makeRow("msg_2", "usr_other")]
    rerender({ rows: revisited, byId: { msg_1: "read", msg_2: "unread" }, conversationId: "conv_1" })
    expect(result.current.markerMessageId).toBe("msg_2")
  })

  it("keeps a settled divider dimmed when a later message arrives unread", () => {
    const rows = [makeRow("msg_1", "usr_other")]
    const { result, rerender } = mountMarker({ rows, byId: { msg_1: "unread" } })
    expect(result.current.isDimmed).toBe(false)

    rerender({ rows, byId: { msg_1: "read" }, conversationId: "conv_1" })
    expect(result.current.isDimmed).toBe(true)

    const grown = [...rows, makeRow("msg_2", "usr_other")]
    rerender({ rows: grown, byId: { msg_1: "read", msg_2: "unread" }, conversationId: "conv_1" })
    expect({ isDimmed: result.current.isDimmed, unreadCount: result.current.unreadCount }).toEqual({
      isDimmed: true,
      unreadCount: 1,
    })
  })

  it("latches nothing until the read state resolves, then latches on the first decidable render", () => {
    const rows = [makeRow("msg_1", "usr_other"), makeRow("msg_2", "usr_other")]
    const { result, rerender } = renderHook(
      (props: { readStateResolved: boolean }) =>
        useConversationUnreadMarker({
          conversationId: "conv_1",
          rows,
          rootStreamId: ROOT_STREAM_ID,
          rowState: stateFrom({ msg_1: "unread", msg_2: "unread" }),
          currentUserId: "usr_me",
          readStateResolved: props.readStateResolved,
        }),
      { initialProps: { readStateResolved: false } }
    )
    expect(result.current.markerMessageId).toBeNull()

    rerender({ readStateResolved: true })
    expect(result.current.markerMessageId).toBe("msg_1")
  })

  it("never latches a marker on a message with no rendered row", () => {
    // A message inside a depth-collapsed spanning subtree has no row: a divider
    // there draws nothing and the open-at-marker scroll has no target.
    const rows = [makeRow("msg_hidden", "usr_other"), makeRow("msg_2", "usr_other")]
    const rendered = new Set(["msg_2"])
    const mount = (byId: Record<string, RowReadState>) =>
      renderHook(() =>
        useConversationUnreadMarker({
          conversationId: "conv_1",
          rows,
          rootStreamId: ROOT_STREAM_ID,
          rowState: stateFrom(byId),
          currentUserId: "usr_me",
          readStateResolved: true,
          renderedMessageIds: rendered,
        })
      )
    // The unrendered row is skipped; the marker moves to the next drawn row.
    expect(mount({ msg_hidden: "unread", msg_2: "unread" }).result.current.markerMessageId).toBe("msg_2")
    // Only the unrendered row is unread → nothing latches at all.
    expect(mount({ msg_hidden: "unread", msg_2: "read" }).result.current.markerMessageId).toBeNull()
  })

  it("counts only unread, non-own rows at or after the marker", () => {
    const rows = [
      makeRow("msg_1", "usr_other"),
      makeRow("msg_2", "usr_other"),
      makeRow("msg_3", "usr_me"),
      makeRow("msg_4", "usr_other"),
    ]
    const { result } = mountMarker({
      rows,
      byId: { msg_1: "unread", msg_2: "read", msg_3: "unread", msg_4: "unread" },
    })
    expect({ markerMessageId: result.current.markerMessageId, unreadCount: result.current.unreadCount }).toEqual({
      markerMessageId: "msg_1",
      unreadCount: 2,
    })
  })
})
