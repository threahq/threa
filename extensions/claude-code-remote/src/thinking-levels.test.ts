import { describe, expect, it } from "bun:test"
import { THINKING_LEVELS } from "./thinking-levels"

describe("THINKING_LEVELS", () => {
  it("matches the /effort levels Claude Code accepts", () => {
    expect([...THINKING_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode"])
  })
})
