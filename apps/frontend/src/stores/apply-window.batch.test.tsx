import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { render, screen, act, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { db } from "@/db"
import { useLiveSavedCount } from "@/hooks/use-saved"
import { beginApplyWindow, endApplyWindow, resetApplyWindow } from "./apply-window"

// End-to-end proof of the apply-window "one settle" guarantee: mount a REAL
// component that renders through a gated store hook (the saved-reminder badge,
// `useLiveSavedCount` → `useBatchedValue`) and drive real IndexedDB writes. While
// the window is open the rendered value must NOT change per write; it settles
// once when the window closes. This is the user-visible behavior the catch-up
// work exists to deliver ("batch always, never singular"), verified against the
// actual hook + Dexie liveQuery rather than the gate primitives in isolation.

const WS = "ws_batch_test"

async function putFiredSaved(id: string): Promise<void> {
  const now = Date.now()
  await db.savedMessages.put({
    id,
    workspaceId: WS,
    userId: "usr_me",
    messageId: `msg_${id}`,
    streamId: "stream_1",
    conversationId: null,
    status: "saved",
    title: null,
    note: null,
    remindAt: null,
    reminderSentAt: null,
    savedAt: new Date(now).toISOString(),
    statusChangedAt: new Date(now).toISOString(),
    message: null,
    unavailableReason: null,
    _savedAtMs: now,
    _statusChangedAtMs: now,
    // >= 1 so the badge's range query ([ws+saved+_reminderFiredAtMs] in [1, ∞)) counts it.
    _reminderFiredAtMs: now,
    _cachedAt: now,
  })
}

function SavedBadge(): React.ReactElement {
  return createElement("span", { "data-testid": "count" }, String(useLiveSavedCount(WS)))
}

describe("apply-window one-settle (real component through useLiveSavedCount)", () => {
  beforeEach(async () => {
    resetApplyWindow()
    await db.savedMessages.clear()
  })

  afterEach(() => {
    resetApplyWindow()
  })

  it("updates immediately when no window is open (control)", async () => {
    await putFiredSaved("a")
    render(createElement(SavedBadge))
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"))

    await act(async () => {
      await putFiredSaved("b")
    })
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"))
  })

  it("holds the badge steady during an apply window, then settles once on close", async () => {
    await putFiredSaved("a")
    render(createElement(SavedBadge))
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("1"))

    act(() => beginApplyWindow())

    // Two writes land while the window is open. The liveQuery observes them
    // (the wait below gives it time to fire), but the gate must keep the
    // rendered value frozen at the pre-window value.
    await act(async () => {
      await putFiredSaved("b")
      await putFiredSaved("c")
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(screen.getByTestId("count").textContent).toBe("1")

    // Closing releases to the final value in one settle — not 1→2→3.
    act(() => endApplyWindow())
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("3"))
  })
})
