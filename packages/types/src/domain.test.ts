import { describe, test, expect, spyOn } from "bun:test"
import { getAvatarUrl } from "./domain"

describe("getAvatarUrl", () => {
  test("constructs workspace-scoped URL for valid avatar key", () => {
    // Matches the serving route: GET /api/workspaces/:workspaceId/users/:userId/avatar/:file (routes.ts)
    expect(getAvatarUrl("ws_123", "avatars/ws_123/mem_456/1700000000000", 256)).toBe(
      "/api/workspaces/ws_123/users/mem_456/avatar/1700000000000.256.webp"
    )
    expect(getAvatarUrl("ws_123", "avatars/ws_123/mem_456/1700000000000", 64)).toBe(
      "/api/workspaces/ws_123/users/mem_456/avatar/1700000000000.64.webp"
    )
  })

  test("returns undefined for null/undefined", () => {
    expect(getAvatarUrl("ws_123", null, 256)).toBeUndefined()
    expect(getAvatarUrl("ws_123", undefined, 64)).toBeUndefined()
  })

  test("returns undefined and logs error on malformed avatar key (wrong segment count)", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    expect(getAvatarUrl("ws_123", "avatars/ws_123", 256)).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test("returns undefined and logs error on malformed avatar key (wrong prefix)", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    expect(getAvatarUrl("ws_123", "files/ws_123/mem_456/12345", 256)).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test("returns undefined and logs error on workspaceId mismatch", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    expect(getAvatarUrl("ws_999", "avatars/ws_123/mem_456/1700000000000", 256)).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
