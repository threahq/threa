import { describe, test, expect } from "bun:test"
import {
  EVENT_TYPES,
  TIMELINE_BROADCAST_EVENT_TYPES,
  COMMAND_EVENT_TYPES,
  AGENT_SESSION_EVENT_TYPES,
  type EventType,
} from "./constants"
import { STREAM_ROW_SPEC, BOARD_EVENT_ROW_TYPES } from "./stream-rows"

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
        "agent_session:deleted",
        "memos:captured",
        "agent:follow_up_scheduled",
      ])
    )
    // None of them are message bodies (those are `self-message`, handled directly).
    for (const type of BOARD_EVENT_ROW_TYPES) expect(STREAM_ROW_SPEC[type].authorGroupable).toBe(false)
  })
})
