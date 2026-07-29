import { describe, expect, it } from "bun:test"
import { decodeKeysetCursor, encodeKeysetCursor } from "./keyset-cursor"

describe("keyset cursor", () => {
  it("survives a microsecond-bearing timestamp byte for byte", () => {
    const cursor = { at: "2026-07-20T10:00:00.123456Z", id: "sctx_1" }

    expect(decodeKeysetCursor(encodeKeysetCursor(cursor))).toEqual(cursor)
  })

  it("passes an absent cursor through as absent", () => {
    expect(decodeKeysetCursor(undefined)).toBeUndefined()
  })

  it.each([
    ["no separator", Buffer.from("2026-07-20T10:00:00.123456Z", "utf8").toString("base64url")],
    ["empty id", Buffer.from("2026-07-20T10:00:00.123456Z|", "utf8").toString("base64url")],
    ["empty timestamp", Buffer.from("|sctx_1", "utf8").toString("base64url")],
    ["unparseable timestamp", Buffer.from("yesterday|sctx_1", "utf8").toString("base64url")],
    ["not base64 at all", "!!!!"],
  ])("rejects a malformed cursor (%s) with a 400", (_label, raw) => {
    expect(() => decodeKeysetCursor(raw)).toThrow(
      expect.objectContaining({ status: 400, code: "INVALID_CURSOR" }) as unknown as Error
    )
  })
})
