import { describe, expect, test } from "bun:test"

import { parseSharedMessageSlotKey, sharedMessageSlotKey, type SharedMessageRef } from "./slots"

describe("sharedMessageSlotKey", () => {
  test("an unpinned reference keeps the legacy bare key", () => {
    expect(sharedMessageSlotKey("msg_1")).toBe("shared:msg_1")
    expect(sharedMessageSlotKey("msg_1", null)).toBe("shared:msg_1")
    expect(sharedMessageSlotKey("msg_1", null, { from: 2, to: 5 })).toBe("shared:msg_1")
  })

  test("a pinned reference carries the revision, and the span when ranged", () => {
    expect(sharedMessageSlotKey("msg_1", 2)).toBe("shared:msg_1@2")
    expect(sharedMessageSlotKey("msg_1", 2, null)).toBe("shared:msg_1@2")
    expect(sharedMessageSlotKey("msg_1", 2, { from: 3, to: 11 })).toBe("shared:msg_1@2:3-11")
  })

  test("pins that differ in revision or span get distinct keys", () => {
    const keys = new Set([
      sharedMessageSlotKey("msg_1"),
      sharedMessageSlotKey("msg_1", 1),
      sharedMessageSlotKey("msg_1", 2),
      sharedMessageSlotKey("msg_1", 2, { from: 0, to: 4 }),
      sharedMessageSlotKey("msg_1", 2, { from: 0, to: 5 }),
    ])
    expect(keys.size).toBe(5)
  })
})

describe("parseSharedMessageSlotKey", () => {
  const refs: SharedMessageRef[] = [
    { messageId: "msg_1", version: null, range: null },
    { messageId: "msg_1", version: 3, range: null },
    { messageId: "msg_1", version: 3, range: { from: 4, to: 19 } },
  ]

  test("round-trips every key shape the builder emits", () => {
    for (const ref of refs) {
      expect(parseSharedMessageSlotKey(sharedMessageSlotKey(ref.messageId, ref.version, ref.range))).toEqual(ref)
    }
  })

  test("returns null for a key from another slot space", () => {
    expect(parseSharedMessageSlotKey("memo:memo_1")).toBeNull()
    expect(parseSharedMessageSlotKey("msg_1")).toBeNull()
    expect(parseSharedMessageSlotKey("shared:msg_1@x")).toBeNull()
  })
})
