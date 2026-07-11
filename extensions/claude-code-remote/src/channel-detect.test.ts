import { describe, expect, test } from "bun:test"
import { isChannelLaunch, readParentCommand } from "./channel-detect"

// Real launch shapes captured from running sessions (spawn.sh and harnessd).
const SPAWN_SH_CMD =
  "/Users/kris/.local/bin/claude --name threa.channel-gate-scratchpad --dangerously-load-development-channels server:threa --dangerously-skip-permissions"
const HARNESSD_CMD =
  "/Users/kris/.local/bin/claude --name threa.background-uploads --mcp-config /Users/kris/.threa/harnessd/mcp/background-uploads.json --dangerously-load-development-channels server:threa --dangerously-skip-permissions"

describe("isChannelLaunch", () => {
  test("recognizes both real spawn paths", () => {
    expect(isChannelLaunch(SPAWN_SH_CMD, "threa")).toBe(true)
    expect(isChannelLaunch(HARNESSD_CMD, "threa")).toBe(true)
  })

  test("rejects a plain claude launch", () => {
    expect(isChannelLaunch("/Users/kris/.local/bin/claude --dangerously-skip-permissions", "threa")).toBe(false)
    expect(isChannelLaunch("", "threa")).toBe(false)
  })

  test("rejects a dev-channel launch for a different server", () => {
    expect(isChannelLaunch("claude --dangerously-load-development-channels server:other", "threa")).toBe(false)
  })

  test("requires an exact server name, not a prefix", () => {
    expect(isChannelLaunch("claude --dangerously-load-development-channels server:threa2", "threa")).toBe(false)
  })

  test("accepts flag=value and comma-separated channel lists", () => {
    expect(isChannelLaunch("claude --dangerously-load-development-channels=server:threa", "threa")).toBe(true)
    expect(isChannelLaunch("claude --dangerously-load-development-channels server:other,server:threa", "threa")).toBe(
      true
    )
  })
})

describe("readParentCommand", () => {
  test("reads a live process's command line", () => {
    expect(readParentCommand(process.pid)).toContain("bun")
  })

  test("returns empty for a dead pid instead of throwing", () => {
    // PID beyond macOS/Linux defaults — ps errors, we degrade to "".
    expect(readParentCommand(99999999)).toBe("")
  })
})
