import { describe, it, expect } from "vitest"
import { computeTimelineHoles, holesSignature, type ContiguityCheckEvent } from "./contiguity"

function event(overrides: Partial<ContiguityCheckEvent> & { id: string; sequence: string }): ContiguityCheckEvent {
  return {
    eventType: "message_created",
    payload: { messageId: overrides.id },
    broadcastSequence: null,
    ...overrides,
  }
}

describe("computeTimelineHoles", () => {
  it("returns no holes for a contiguous broadcast chain", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({ id: "e2", sequence: "11", broadcastSequence: "6" }),
      event({ id: "e3", sequence: "14", broadcastSequence: "7" }),
    ]
    expect(computeTimelineHoles(events)).toEqual([])
  })

  it("detects a mid-window hole and anchors it on the row below", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({ id: "e2", sequence: "20", broadcastSequence: "8" }),
    ]
    expect(computeTimelineHoles(events)).toEqual([{ afterEventId: "e1", afterSequence: "10", missingCount: 2 }])
  })

  it("reports multiple distinct holes", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "1" }),
      event({ id: "e2", sequence: "12", broadcastSequence: "3" }),
      event({ id: "e3", sequence: "15", broadcastSequence: "4" }),
      event({ id: "e4", sequence: "19", broadcastSequence: "6" }),
    ]
    expect(computeTimelineHoles(events)).toEqual([
      { afterEventId: "e1", afterSequence: "10", missingCount: 1 },
      { afterEventId: "e3", afterSequence: "15", missingCount: 1 },
    ])
  })

  it("never flags rows without a broadcast sequence (other viewers' commands, pre-deploy cache)", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      // Own command event: consumes a global slot but no broadcast slot.
      event({ id: "cmd", sequence: "11", broadcastSequence: null, eventType: "command_dispatched" }),
      // Pre-deploy cached row: no stamp at all.
      event({ id: "old", sequence: "12", broadcastSequence: undefined }),
      event({ id: "e2", sequence: "13", broadcastSequence: "6" }),
    ]
    expect(computeTimelineHoles(events)).toEqual([])
  })

  it("skips pending and failed optimistic rows", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({ id: "tmp", sequence: "999", broadcastSequence: "999", _status: "pending" }),
      event({ id: "e2", sequence: "11", broadcastSequence: "6" }),
    ]
    expect(computeTimelineHoles(events)).toEqual([])
  })

  it("does not flag slots a move tombstone declares vacated", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({
        id: "tomb",
        sequence: "20",
        broadcastSequence: "9",
        eventType: "messages:moved",
        payload: { vacatedBroadcastSequences: ["6", "7", "8"] },
      }),
      event({ id: "e2", sequence: "21", broadcastSequence: "10" }),
    ]
    expect(computeTimelineHoles(events)).toEqual([])
  })

  it("still reports the real gap inside a partially vacated range", () => {
    const events = [
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({
        id: "tomb",
        sequence: "20",
        broadcastSequence: "9",
        eventType: "messages:moved",
        payload: { vacatedBroadcastSequences: ["6", "8"] },
      }),
    ]
    // Slot 7 is neither present nor vacated — a real missed event.
    expect(computeTimelineHoles(events)).toEqual([{ afterEventId: "e1", afterSequence: "10", missingCount: 1 }])
  })

  it("returns no holes for empty or single-row windows", () => {
    expect(computeTimelineHoles([])).toEqual([])
    expect(computeTimelineHoles([event({ id: "e1", sequence: "10", broadcastSequence: "5" })])).toEqual([])
  })
})

describe("holesSignature", () => {
  it("is stable for equal holes and distinguishes different ones", () => {
    const holes = computeTimelineHoles([
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({ id: "e2", sequence: "20", broadcastSequence: "8" }),
    ])
    const sameHoles = computeTimelineHoles([
      event({ id: "e1", sequence: "10", broadcastSequence: "5" }),
      event({ id: "e2", sequence: "20", broadcastSequence: "8" }),
    ])
    expect(holesSignature(holes)).toBe(holesSignature(sameHoles))
    expect(holesSignature([])).toBe("")
    expect(holesSignature(holes)).not.toBe(holesSignature([]))
  })
})
