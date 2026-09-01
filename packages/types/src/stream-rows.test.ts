import { describe, test, expect } from "bun:test"
import {
  EVENT_TYPES,
  TIMELINE_BROADCAST_EVENT_TYPES,
  COMMAND_EVENT_TYPES,
  AGENT_SESSION_EVENT_TYPES,
  type EventType,
} from "./constants"
import { STREAM_ROW_SPEC, BOARD_EVENT_ROW_TYPES, THREAD_ANCHORABLE_EVENT_TYPES } from "./stream-rows"

function typesWhere(predicate: (type: EventType) => boolean): Set<EventType> {
  return new Set(EVENT_TYPES.filter(predicate))
}

/**
 * These assertions freeze the spec against the scattered constant sets it will
 * eventually replace. If a future event type declares a treatment that disagrees
 * with the live wiring, one of these fails — the spec cannot silently drift from
 * reality, and the follow-up that derives-and-deletes the literals stays safe.
 */
describe("STREAM_ROW_SPEC", () => {
  test("has exactly one entry per EVENT_TYPE", () => {
    expect(new Set(Object.keys(STREAM_ROW_SPEC))).toEqual(new Set(EVENT_TYPES))
  })

  test("broadcastSlot mirrors TIMELINE_BROADCAST_EVENT_TYPES (INV-61)", () => {
    expect(typesWhere((t) => STREAM_ROW_SPEC[t].broadcastSlot)).toEqual(new Set(TIMELINE_BROADCAST_EVENT_TYPES))
  })

  test("grouping:'command' mirrors COMMAND_EVENT_TYPES", () => {
    expect(typesWhere((t) => STREAM_ROW_SPEC[t].grouping === "command")).toEqual(new Set(COMMAND_EVENT_TYPES))
  })

  test("grouping:'session' mirrors AGENT_SESSION_EVENT_TYPES", () => {
    expect(typesWhere((t) => STREAM_ROW_SPEC[t].grouping === "session")).toEqual(new Set(AGENT_SESSION_EVENT_TYPES))
  })

  test("authorGroupable mirrors the message body types", () => {
    expect(typesWhere((t) => STREAM_ROW_SPEC[t].authorGroupable)).toEqual(
      new Set<EventType>(["message_created", "companion_response"])
    )
  })

  test("only member messages bump conversation activity", () => {
    // Render-only rows (agent sessions, memo captures, follow-ups) must never move
    // a card in the board's activity order or perturb its frozen stable view.
    expect(typesWhere((t) => STREAM_ROW_SPEC[t].bumps)).toEqual(new Set<EventType>(["message_created"]))
  })

  test("threadable is exactly the message body plus the turned-on cards", () => {
    // The v1 set the substrate ships: a thread may anchor on a message, a
    // delegation card, a subagent card, or a call card — nothing else.
    expect(typesWhere((t) => STREAM_ROW_SPEC[t].threadable)).toEqual(
      new Set<EventType>(["message_created", "delegation:created", "subagent:created", "call_started"])
    )
  })

  test("THREAD_ANCHORABLE_EVENT_TYPES derives from the threadable flag", () => {
    expect(new Set(THREAD_ANCHORABLE_EVENT_TYPES)).toEqual(
      new Set<EventType>(["message_created", "delegation:created", "subagent:created", "call_started"])
    )
    // Every anchorable card is a standalone row — a patch/grouped row has no
    // card to hang a thread under.
    for (const type of THREAD_ANCHORABLE_EVENT_TYPES) expect(STREAM_ROW_SPEC[type].rendersAsOwnRow).toBe(true)
  })

  test("every read-blocking type renders as its own row", () => {
    // The read frontier advances through visible rows only, so a read-blocking
    // type that renders no row of its own could never be passed: the gate would
    // point at an index the viewport can never reach and auto-read would wedge
    // permanently (the regression class behind #1895).
    for (const type of EVENT_TYPES) {
      const spec = STREAM_ROW_SPEC[type]
      if (spec.readBlocking) expect(spec.rendersAsOwnRow).toBe(true)
    }
  })

  test("a grouped or patched row is never also its own standalone row", () => {
    for (const type of EVENT_TYPES) {
      const spec = STREAM_ROW_SPEC[type]
      if (spec.grouping !== null || spec.patchesRow) expect(spec.rendersAsOwnRow).toBe(false)
    }
  })

  test("BOARD_EVENT_ROW_TYPES are exactly the conversation-referring non-message rows", () => {
    expect(new Set(BOARD_EVENT_ROW_TYPES)).toEqual(
      new Set<EventType>([
        "agent_session:started",
        "agent_session:completed",
        "agent_session:failed",
        "agent_session:interrupted",
        "agent_session:deleted",
        "memos:captured",
        "agent:follow_up_scheduled",
        "delegation:created",
        "command_dispatched",
        "command_completed",
        "command_failed",
        "aside:anchored",
      ])
    )
    // None of them are message bodies (those are `self-message`, handled directly).
    for (const type of BOARD_EVENT_ROW_TYPES) expect(STREAM_ROW_SPEC[type].authorGroupable).toBe(false)
  })
})
