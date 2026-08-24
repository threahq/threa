import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import { spyOnExport } from "@/test"
import * as actorsModule from "./use-actors"
import { useAsideAnchor } from "./use-aside-anchor"

const HOST = "stream_host"
const ANCHOR = "msg_anchor_1"

async function seedAnchorMessage(overrides: { streamId?: string; messageId?: string; createdAt?: string } = {}) {
  await db.events.put({
    id: `evt_${overrides.messageId ?? ANCHOR}_${overrides.streamId ?? HOST}`,
    workspaceId: "ws_1",
    streamId: overrides.streamId ?? HOST,
    sequence: "1",
    _sequenceNum: 1,
    eventType: "message_created",
    payload: { messageId: overrides.messageId ?? ANCHOR, contentMarkdown: "Churn hit 34% in Q2." },
    actorId: "usr_dana",
    actorType: "user",
    createdAt: overrides.createdAt ?? "2026-08-24T09:44:00.000Z",
    _cachedAt: Date.now(),
  } as never)
}

beforeEach(async () => {
  await db.events.clear()
  spyOnExport(actorsModule, "useActors").mockReturnValue((() => ({
    getActorName: (id: string) => (id === "usr_dana" ? "Dana Whitfield" : id),
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

  it("stays null with no anchor id and with an uncached anchor", async () => {
    const withoutAnchor = renderHook(() => useAsideAnchor("ws_1", HOST, null))
    expect(withoutAnchor.result.current).toBeNull()

    const uncached = renderHook(() => useAsideAnchor("ws_1", HOST, "msg_never_seen"))
    await waitFor(() => expect(uncached.result.current).toBeNull())
  })
})
