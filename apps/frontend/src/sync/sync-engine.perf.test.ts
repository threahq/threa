import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SyncCatchUpResponse } from "@threa/types"
import { db } from "@/db"
import { NO_CAPTURE, PerfCapture, armPerfCapture, getPerfCapture } from "@/lib/perf/capture"
import { resetApplyWindow } from "@/stores/apply-window"
import { resetRevealGate } from "./reveal-gate"
import { SyncEngine } from "./sync-engine"
import { asSocket, makeDeps, MockSocket } from "@/test/fixtures/sync-engine"

function makeActiveDeps(catchUp: ReturnType<typeof vi.fn>) {
  return {
    ...makeDeps(),
    syncService: { catchUp: catchUp as (...args: unknown[]) => Promise<SyncCatchUpResponse> },
  }
}

function emptyPage(head: string): SyncCatchUpResponse {
  return { entries: [], head }
}

function userAddedEntry(syncId: string, userId: string): SyncCatchUpResponse["entries"][number] {
  return {
    syncId,
    eventType: "workspace_user:added",
    payload: { workspaceId: "ws_1", user: { id: userId, workspaceId: "ws_1", name: `User ${userId}` } },
    createdAt: new Date().toISOString(),
  }
}

/** The small-gap replay fixture: three missed entries, per-entry replay, no collapse. */
function smallGapEngine() {
  const smallPage = Array.from({ length: 3 }, (_, i) => userAddedEntry(String(11 + i), `small_user_${i}`))
  const catchUp = vi.fn().mockResolvedValueOnce({ entries: smallPage, head: "13" }).mockResolvedValue(emptyPage("13"))
  return new SyncEngine(makeActiveDeps(catchUp))
}

beforeEach(async () => {
  resetRevealGate()
  resetApplyWindow()
  await Promise.all([
    db.workspaces.clear(),
    db.syncCursors.clear(),
    db.workspaceUsers.clear(),
    db.unreadState.clear(),
    db.streams.clear(),
  ])
  await db.syncCursors.put({ key: "ws_1:sync-log", cursor: "10", updatedAt: Date.now() })
})

afterEach(() => {
  armPerfCapture(NO_CAPTURE)
})

describe("catch-up replay instrumentation", () => {
  it("records one apply mark per replayed entry", async () => {
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const engine = smallGapEngine()

    await engine.onConnect(asSocket(new MockSocket()))
    await vi.waitFor(async () => expect(await db.workspaceUsers.get("small_user_2")).toBeDefined())

    const names = capture.snapshot().map((s) => s.name)
    expect(names.filter((n) => n === "catchup.entryApply")).toHaveLength(3)
    expect(names.filter((n) => n === "catchup.serialReplay")).toHaveLength(1)
    expect(names).not.toContain("catchup.collapse")
    engine.destroy()
  })

  it("leaves the capture empty when unarmed, with the replay itself unchanged", async () => {
    const engine = smallGapEngine()

    await engine.onConnect(asSocket(new MockSocket()))
    await vi.waitFor(async () => expect(await db.workspaceUsers.get("small_user_2")).toBeDefined())

    expect(engine.getSyncCursor()).toBe("13")
    expect(getPerfCapture()).toBe(NO_CAPTURE)
    expect(getPerfCapture().snapshot()).toEqual([])
    engine.destroy()
  })
})
