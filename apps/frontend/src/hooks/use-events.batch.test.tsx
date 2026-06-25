import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { db, sequenceToNum, type CachedEvent } from "@/db"
import { useStreamEvents } from "@/stores/stream-store"
import { useBatchedValue } from "@/stores/apply-window"
import { beginApplyWindow, endApplyWindow, resetApplyWindow } from "@/stores/apply-window"

// End-to-end proof that the timeline's rendered window coalesces through the
// apply window the same way every other IDB-backed surface does. `useEvents`
// returns `useBatchedValue(renderableEvents)` where `renderableEvents` derives
// from the `useStreamEvents` liveQuery over `db.events`; this mounts that exact
// composition against real Dexie writes. While a sync catch-up replay holds the
// apply window open, the rendered window must NOT page forward per replayed
// entry — it stays on the cached tail and settles once when the window closes,
// so the cold open shows cached content immediately and then a single jump to
// the settled tail rather than a multi-step walk through cache pages.

const WORKSPACE_ID = "ws_batch"
const STREAM_ID = "stream_batch"

function makeEvent(sequence: string): CachedEvent {
  const sequenceNum = sequenceToNum(sequence)
  return {
    id: `evt_${sequence}`,
    workspaceId: WORKSPACE_ID,
    streamId: STREAM_ID,
    sequence,
    _sequenceNum: sequenceNum,
    eventType: "message_created",
    payload: { messageId: `evt_${sequence}`, contentMarkdown: sequence },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date(2026, 0, 1, 0, 0, sequenceNum).toISOString(),
    _cachedAt: Date.now(),
  }
}

// Mirror of the production composition in `useEvents`: the liveQuery read held
// through the apply-window batcher. Renders the rendered sequences (not a bare
// count) so assertions prove WHICH events are visible — that the held window
// keeps exactly the pre-window tail and the later entries are withheld until
// close, not merely that some number of rows changed (INV-23).
function TimelineSeqs(): React.ReactElement {
  const events = useBatchedValue(useStreamEvents(STREAM_ID) ?? [])
  return createElement("span", { "data-testid": "seqs" }, events.map((e) => e.sequence).join(","))
}

describe("timeline events coalesce through the apply window", () => {
  beforeEach(async () => {
    resetApplyWindow()
    await db.events.clear()
  })

  afterEach(() => {
    resetApplyWindow()
  })

  it("updates per write when no window is open (control)", async () => {
    await db.events.put(makeEvent("1"))
    render(createElement(TimelineSeqs))
    await waitFor(() => expect(screen.getByTestId("seqs").textContent).toBe("1"))

    await act(async () => {
      await db.events.put(makeEvent("2"))
    })
    await waitFor(() => expect(screen.getByTestId("seqs").textContent).toBe("1,2"))
  })

  it("holds the cached window steady during a catch-up replay, then settles once on close", async () => {
    await db.events.put(makeEvent("1"))
    render(createElement(TimelineSeqs))
    await waitFor(() => expect(screen.getByTestId("seqs").textContent).toBe("1"))

    // A sync catch-up opens the apply window and replays missed messages,
    // writing them to db.events one entry at a time.
    act(() => beginApplyWindow())
    await act(async () => {
      await db.events.put(makeEvent("2"))
      await db.events.put(makeEvent("3"))
      await db.events.put(makeEvent("4"))
    })
    // The liveQuery observes the writes (this wait gives it time to fire), but
    // the rendered window must stay frozen on exactly the pre-window tail —
    // events 2/3/4 are withheld, no per-entry forward walk.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.getByTestId("seqs").textContent).toBe("1")

    // Closing releases the settled tail in one update — straight to 1,2,3,4,
    // never through an intermediate 1,2 / 1,2,3.
    act(() => endApplyWindow())
    await waitFor(() => expect(screen.getByTestId("seqs").textContent).toBe("1,2,3,4"))
  })
})
