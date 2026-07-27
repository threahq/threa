import { describe, expect, it } from "bun:test"
import { decodeContextCursor, encodeContextCursor } from "./cursor"

describe("context cursor", () => {
  it("round-trips the keyset position", () => {
    const cursor = { occurredAt: new Date("2026-07-20T10:00:00.123Z"), id: "sctx_1" }
    expect(decodeContextCursor(encodeContextCursor(cursor))).toEqual(cursor)
  })

  it("passes an absent cursor through as absent", () => {
    expect(decodeContextCursor(undefined)).toBeUndefined()
  })

  it.each([
    ["no separator", Buffer.from("2026-07-20T10:00:00.000Z", "utf8").toString("base64url")],
    ["empty id", Buffer.from("2026-07-20T10:00:00.000Z|", "utf8").toString("base64url")],
    ["unparseable timestamp", Buffer.from("yesterday|sctx_1", "utf8").toString("base64url")],
    ["not base64 at all", "!!!!"],
  ])("rejects a malformed cursor (%s) with a 400", (_label, raw) => {
    expect(() => decodeContextCursor(raw)).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_CURSOR" }) as unknown as Error
    )
  })
})
