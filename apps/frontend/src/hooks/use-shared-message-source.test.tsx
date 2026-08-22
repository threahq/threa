import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { sharedMessageSlotKey, type AttachmentSummary } from "@threa/types"
import { SlotsProvider } from "@/components/slots/context"
import { useSharedMessageSource } from "./use-shared-message-source"
import { db } from "@/db"

async function clearEvents() {
  await db.events.clear()
}

/** A legacy pointer: no revision, no span. */
function unpinned(messageId: string) {
  return useSharedMessageSource({ messageId, streamId: "stream_src", version: null, range: null })
}

/**
 * Fake-timer scope: only the threshold tests below switch to fake timers,
 * and they do so WITHOUT `shouldAdvanceTime: true`. With shouldAdvanceTime,
 * `renderHook` itself consumes real-time wall ticks (5–50ms on CI), the
 * fake clock auto-advances by the same amount, and a subsequent
 * `vi.advanceTimersByTime(299)` ends up at ~319ms — past the 300ms
 * SKELETON_DELAY_MS threshold — so the timer fires early and the
 * "showSkeleton: false" assertion flakes. Manual control only.
 *
 * The IDB-fallback test below stays on real timers because it relies on
 * `useLiveQuery` resolving via Dexie's microtask scheduling, which doesn't
 * play well with fake timers.
 */

describe("useSharedMessageSource", () => {
  beforeEach(async () => {
    await clearEvents()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await clearEvents()
  })

  it("resolves from the server hydration map when present", () => {
    const { result } = renderHook(() => unpinned("msg_1"), {
      wrapper: ({ children }) => (
        <SlotsProvider
          map={{
            [sharedMessageSlotKey("msg_1")]: {
              type: "sharedMessage",
              state: "ok",
              messageId: "msg_1",
              streamId: "stream_src",
              authorId: "usr_1",
              authorName: "Ada",
              authorType: "user",
              contentJson: { type: "doc", content: [] },
              contentMarkdown: "hello from hydration",
              editedAt: null,
              createdAt: "2026-04-23T10:00:00Z",
              attachments: [],
            },
          }}
        >
          {children}
        </SlotsProvider>
      ),
    })

    expect(result.current).toEqual({
      status: "resolved",
      contentMarkdown: "hello from hydration",
      authorId: "usr_1",
      actorType: "user",
      authorName: "Ada",
      editedAt: null,
      attachments: [],
      version: null,
      currentRevision: null,
      range: null,
    })
  })

  it("returns deleted / missing tombstones from hydration", () => {
    const { result, rerender } = renderHook(({ id }) => unpinned(id), {
      initialProps: { id: "msg_del" },
      wrapper: ({ children }) => (
        <SlotsProvider
          map={{
            [sharedMessageSlotKey("msg_del")]: {
              type: "sharedMessage",
              state: "deleted",
              messageId: "msg_del",
              deletedAt: "2026-04-23T10:00:00Z",
            },
            [sharedMessageSlotKey("msg_missing")]: {
              type: "sharedMessage",
              state: "missing",
              messageId: "msg_missing",
            },
          }}
        >
          {children}
        </SlotsProvider>
      ),
    })

    expect(result.current).toEqual({ status: "deleted" })

    rerender({ id: "msg_missing" })
    expect(result.current).toEqual({ status: "missing" })
  })

  it("maps private hydration state to a privacy placeholder source", () => {
    const { result } = renderHook(() => unpinned("msg_p"), {
      wrapper: ({ children }) => (
        <SlotsProvider
          map={{
            [sharedMessageSlotKey("msg_p")]: {
              type: "sharedMessage",
              state: "private",
              messageId: "msg_p",
              sourceStreamKind: "channel",
              sourceVisibility: "private",
            },
          }}
        >
          {children}
        </SlotsProvider>
      ),
    })

    expect(result.current).toEqual({
      status: "private",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    })
  })

  it("maps truncated hydration state to a navigable placeholder source", () => {
    const { result } = renderHook(() => unpinned("msg_t"), {
      wrapper: ({ children }) => (
        <SlotsProvider
          map={{
            [sharedMessageSlotKey("msg_t")]: {
              type: "sharedMessage",
              state: "truncated",
              messageId: "msg_t",
              streamId: "stream_deep",
            },
          }}
        >
          {children}
        </SlotsProvider>
      ),
    })

    expect(result.current).toEqual({
      status: "truncated",
      streamId: "stream_deep",
      messageId: "msg_t",
    })
  })

  it("falls back to the local IDB event cache when hydration is absent", async () => {
    await db.events.put({
      id: "evt_cached",
      workspaceId: "ws_1",
      streamId: "stream_src",
      sequence: "1",
      _sequenceNum: 1,
      eventType: "message_created",
      payload: { messageId: "msg_cached", contentMarkdown: "local snippet" },
      actorId: "usr_42",
      actorType: "user",
      createdAt: "2026-04-23T10:00:00Z",
      _cachedAt: Date.now(),
    })

    const { result } = renderHook(() => unpinned("msg_cached"))

    await waitFor(() => {
      expect(result.current.status).toBe("resolved")
    })
    expect(result.current).toMatchObject({
      status: "resolved",
      contentMarkdown: "local snippet",
      authorId: "usr_42",
      actorType: "user",
    })
  })

  it("stays blank for the first 300ms then surfaces a skeleton hint", () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => unpinned("msg_absent"))

    expect(result.current).toEqual({ status: "pending", showSkeleton: false })

    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(result.current).toEqual({ status: "pending", showSkeleton: false })

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toEqual({ status: "pending", showSkeleton: true })
  })

  it("resets the skeleton state when the pointer identity changes", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ id }) => unpinned(id), {
      initialProps: { id: "msg_a" },
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current).toEqual({ status: "pending", showSkeleton: true })

    rerender({ id: "msg_b" })
    // New pointer must re-enter the pre-threshold blank state rather than
    // inheriting the previous skeleton.
    expect(result.current).toEqual({ status: "pending", showSkeleton: false })
  })
})

const BODY_JSON = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello there, " },
        { type: "text", text: "this", marks: [{ type: "bold" }] },
        { type: "text", text: " is the body." },
      ],
    },
  ],
}
/** "this is" — starts inside the bold mark and runs past it. */
const SPAN = { from: 14, to: 21 }

describe("useSharedMessageSource — pinned references", () => {
  beforeEach(async () => {
    await clearEvents()
  })

  afterEach(async () => {
    await clearEvents()
  })

  it("reads the slot its own pin keys, not the whole-message one", () => {
    const { result } = renderHook(
      () => useSharedMessageSource({ messageId: "msg_1", streamId: "stream_src", version: 2, range: SPAN }),
      {
        wrapper: ({ children }) => (
          <SlotsProvider
            map={{
              [sharedMessageSlotKey("msg_1")]: {
                type: "sharedMessage",
                state: "ok",
                messageId: "msg_1",
                streamId: "stream_src",
                authorId: "usr_1",
                authorName: "Ada",
                authorType: "user",
                contentJson: {},
                contentMarkdown: "the whole message as it reads now",
                editedAt: null,
                createdAt: "2026-04-23T10:00:00Z",
                attachments: [],
              },
              [sharedMessageSlotKey("msg_1", 2, SPAN)]: {
                type: "sharedMessage",
                state: "ok",
                messageId: "msg_1",
                streamId: "stream_src",
                authorId: "usr_1",
                authorName: "Ada",
                authorType: "user",
                contentJson: {},
                contentMarkdown: "**this** is",
                editedAt: null,
                createdAt: "2026-04-23T10:00:00Z",
                attachments: [{ id: "att_1", fileName: "plan.png" } as unknown as AttachmentSummary],
                version: 2,
                currentRevision: 3,
                range: SPAN,
              },
            }}
          >
            {children}
          </SlotsProvider>
        ),
      }
    )

    expect(result.current).toEqual({
      status: "resolved",
      contentMarkdown: "**this** is",
      authorId: "usr_1",
      actorType: "user",
      authorName: "Ada",
      editedAt: null,
      // A ranged reference is a span of text, never the message's files.
      attachments: [],
      version: 2,
      currentRevision: 3,
      range: SPAN,
    })
  })

  it("keeps a cached event out of a pointer pinned to a different revision", async () => {
    await db.events.put({
      id: "evt_v3",
      workspaceId: "ws_1",
      streamId: "stream_src",
      sequence: "1",
      _sequenceNum: 1,
      eventType: "message_created",
      payload: { messageId: "msg_edited", contentMarkdown: "the edited body", revision: 3 },
      actorId: "usr_42",
      actorType: "user",
      createdAt: "2026-04-23T10:00:00Z",
      _cachedAt: Date.now(),
    })

    const { result, rerender } = renderHook(
      ({ version }) =>
        useSharedMessageSource({ messageId: "msg_edited", streamId: "stream_src", version, range: null }),
      { initialProps: { version: 3 } }
    )

    // The cache does answer this pointer: it holds exactly revision 3.
    await waitFor(() => expect(result.current.status).toBe("resolved"))

    // The same cache must not answer a pointer pinned to revision 2 — showing
    // v3's text there is the silent rewrite the pin exists to prevent.
    rerender({ version: 2 })
    expect(result.current.status).toBe("pending")
  })

  it("slices the cached event itself for a ranged pointer at the cached revision", async () => {
    await db.events.put({
      id: "evt_v2",
      workspaceId: "ws_1",
      streamId: "stream_src",
      sequence: "2",
      _sequenceNum: 2,
      eventType: "message_created",
      payload: {
        messageId: "msg_span",
        contentMarkdown: "Hello there, **this** is the body.",
        contentJson: BODY_JSON,
        revision: 2,
      },
      actorId: "usr_42",
      actorType: "user",
      createdAt: "2026-04-23T10:00:00Z",
      _cachedAt: Date.now(),
    })

    const { result } = renderHook(() =>
      useSharedMessageSource({ messageId: "msg_span", streamId: "stream_src", version: 2, range: SPAN })
    )

    await waitFor(() => expect(result.current.status).toBe("resolved"))
    expect(result.current).toMatchObject({
      status: "resolved",
      contentMarkdown: "**this** is",
      version: 2,
      currentRevision: 2,
      range: SPAN,
      attachments: [],
    })
  })
})
