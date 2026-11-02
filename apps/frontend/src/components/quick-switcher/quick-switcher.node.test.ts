import { describe, it, expect } from "vitest"
import { deriveMode, getDisplayQuery } from "./quick-switcher"

describe("QuickSwitcher mode detection", () => {
  describe("deriveMode", () => {
    it("should return 'stream' for empty query", () => {
      expect(deriveMode("")).toBe("stream")
    })

    it("should return 'stream' for regular text", () => {
      expect(deriveMode("general")).toBe("stream")
      expect(deriveMode("my channel")).toBe("stream")
    })

    it("should return 'command' for queries starting with >", () => {
      expect(deriveMode(">")).toBe("command")
      expect(deriveMode(">new")).toBe("command")
      expect(deriveMode("> create channel")).toBe("command")
    })

    it("should treat ? as plain stream-search text (message search left the palette)", () => {
      expect(deriveMode("?")).toBe("stream")
      expect(deriveMode("?error")).toBe("stream")
      expect(deriveMode("? find logs")).toBe("stream")
    })

    it("should only check first character for mode", () => {
      expect(deriveMode("text > with arrow")).toBe("stream")
      expect(deriveMode("text ? with question")).toBe("stream")
    })
  })

  describe("getDisplayQuery", () => {
    describe("stream mode", () => {
      it("should return query as-is", () => {
        expect(getDisplayQuery("general", "stream")).toBe("general")
        expect(getDisplayQuery("", "stream")).toBe("")
      })
    })

    describe("command mode", () => {
      it("should strip leading > and whitespace", () => {
        expect(getDisplayQuery(">new", "command")).toBe("new")
        expect(getDisplayQuery("> new", "command")).toBe("new")
        expect(getDisplayQuery(">  new channel", "command")).toBe("new channel")
      })

      it("should return empty string for just >", () => {
        expect(getDisplayQuery(">", "command")).toBe("")
        expect(getDisplayQuery("> ", "command")).toBe("")
      })

      it("should not strip if no > prefix", () => {
        expect(getDisplayQuery("new", "command")).toBe("new")
      })
    })
  })
})
