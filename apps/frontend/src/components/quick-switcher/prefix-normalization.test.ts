/**
 * Regression tests for prefix handling in the quick switcher.
 *
 * The palette has two modes: stream search (no prefix) and the command
 * palette (">" prefix). Message search lives in its own surface (sidebar
 * panel / search page) and is reached via the "Search messages" command —
 * "?" has no special meaning here anymore.
 */
import { describe, it, expect } from "vitest"
import { deriveMode, getDisplayQuery } from "./quick-switcher"

describe("mode prefix normalization", () => {
  describe("deriveMode", () => {
    it("should detect command mode from >", () => {
      expect(deriveMode("> command")).toBe("command")
      expect(deriveMode(">command")).toBe("command")
    })

    it("should treat ? as plain stream-search text", () => {
      expect(deriveMode("? hello")).toBe("stream")
      expect(deriveMode("?hello")).toBe("stream")
    })

    it("should default to stream mode", () => {
      expect(deriveMode("hello")).toBe("stream")
      expect(deriveMode("")).toBe("stream")
    })
  })

  describe("getDisplayQuery", () => {
    it("should strip > prefix in command mode", () => {
      expect(getDisplayQuery("> command", "command")).toBe("command")
      expect(getDisplayQuery(">command", "command")).toBe("command")
    })

    it("should return unchanged in stream mode", () => {
      expect(getDisplayQuery("hello", "stream")).toBe("hello")
      expect(getDisplayQuery("? hello", "stream")).toBe("? hello")
    })
  })
})
