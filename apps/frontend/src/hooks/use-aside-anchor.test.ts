import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import { spyOnExport } from "@/test"
import * as actorsModule from "./use-actors"
import { formatTime } from "@/lib/dates"
import { useAsideAnchor } from "./use-aside-anchor"

const HOST = "stream_host"
const ANCHOR = "msg_anchor_1"

async function seedAnchorMessage(
  overrides: {
    workspaceId?: string
    streamId?: string
    messageId?: string
    actorId?: string
    contentMarkdown?: string
    createdAt?: string
  } = {}
) {
  await db.events.put({
    id: `evt_${overrides.workspaceId ?? "ws_1"}_${overrides.messageId ?? ANCHOR}_${overrides.streamId ?? HOST}`,
    workspaceId: overrides.workspaceId ?? "ws_1",
    streamId: overrides.streamId ?? HOST,
    sequence: "1",
    _sequenceNum: 1,
    eventType: "message_created",
    payload: {
      messageId: overrides.messageId ?? ANCHOR,
      contentMarkdown: overrides.contentMarkdown ?? "Churn hit 34% in Q2.",
    },
    actorId: overrides.actorId ?? "usr_dana",
    actorType: "user",
    createdAt: overrides.createdAt ?? "2026-08-24T09:44:00.000Z",
    _cachedAt: Date.now(),
  } as never)
}

beforeEach(async () => {
  await db.events.clear()
  spyOnExport(actorsModule, "useActors").mockReturnValue((() => ({
    getActorName: (id: string) => ({ usr_dana: "Dana Whitfield", usr_priya: "Priya Nair" })[id] ?? id,
  })) as never)
})

afterEach(() => vi.restoreAllMocks())

describe("useAsideAnchor", () => {
  it("names the author and send time of the anchored message from the local cache", async () => {
    await seedAnchorMessage()

    const { result } = renderHook(() => useAsideAnchor("ws_1", HOST, ANCHOR))

    // The whole point of the hook: without this, the anchor line silently
    // degrades to "Anchored in {stream}" forever and nothing fails (INV-11).
    await waitFor(() => expect(result.current).toEqual({ author: "Dana Whitfield", at: expect.any(String) }))
  })

  it("stays null for an anchor cached under a different stream, so the line never mis-attributes", async () => {
    await seedAnchorMessage({ streamId: "stream_elsewhere" })

    const { result } = renderHook(() => useAsideAnchor("ws_1", HOST, ANCHOR))

    await waitFor(() => expect(db.events.count()).resolves.toBe(1))
    expect(result.current).toBeNull()
  })

  it("resolves the anchor from the viewed workspace when another workspace caches the same message and stream ids", async () => {
    await seedAnchorMessage({ createdAt: "2026-08-24T09:44:00.000Z" })
    await seedAnchorMessage({
      workspaceId: "ws_2",
      actorId: "usr_priya",
      contentMarkdown: "Retention is flat.",
      createdAt: "2026-08-24T11:30:00.000Z",
    })

    const { result } = renderHook(() => useAsideAnchor("ws_2", HOST, ANCHOR))

    await waitFor(() =>
      expect(result.current).toEqual({ author: "Priya Nair", at: formatTime(new Date("2026-08-24T11:30:00.000Z")) })
    )
  })

  it("stays null with no anchor id and with an uncached anchor", async () => {
    const withoutAnchor = renderHook(() => useAsideAnchor("ws_1", HOST, null))
    expect(withoutAnchor.result.current).toBeNull()

    const uncached = renderHook(() => useAsideAnchor("ws_1", HOST, "msg_never_seen"))
    await waitFor(() => expect(uncached.result.current).toBeNull())
  })
})
