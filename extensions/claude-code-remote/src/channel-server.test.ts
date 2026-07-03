import { describe, expect, test } from "bun:test"
import { buildInstructions, parsePermissionVerdict } from "./channel-server"

describe("parsePermissionVerdict", () => {
  test("parses allow/deny in long and short forms", () => {
    expect(parsePermissionVerdict("yes abcde")).toEqual({ behavior: "allow", requestId: "abcde" })
    expect(parsePermissionVerdict("y abcde")).toEqual({ behavior: "allow", requestId: "abcde" })
    expect(parsePermissionVerdict("no abcde")).toEqual({ behavior: "deny", requestId: "abcde" })
    expect(parsePermissionVerdict("n abcde")).toEqual({ behavior: "deny", requestId: "abcde" })
  })

  test("tolerates surrounding whitespace and autocorrect caps", () => {
    expect(parsePermissionVerdict("  YES ABCDE  ")).toEqual({ behavior: "allow", requestId: "abcde" })
  })

  test("rejects ids using 'l' (outside Claude Code's id alphabet)", () => {
    expect(parsePermissionVerdict("yes ablde")).toBeNull()
  })

  test("rejects ordinary chat that isn't a verdict", () => {
    expect(parsePermissionVerdict("yes please do it")).toBeNull()
    expect(parsePermissionVerdict("approve it")).toBeNull()
    expect(parsePermissionVerdict("yes")).toBeNull()
  })
})

describe("buildInstructions", () => {
  test("always tells Claude to reply with the invocation_id", () => {
    const text = buildInstructions(false)
    expect(text).toContain("reply")
    expect(text).toContain("invocation_id")
  })

  test("documents both the send and reply tools", () => {
    const text = buildInstructions(false)
    expect(text).toContain("`send`")
    expect(text).toContain("`reply`")
    expect(text).toContain("invocation_id")
  })

  test("mentions permission forwarding only when relay is enabled", () => {
    expect(buildInstructions(true).toLowerCase()).toContain("approv")
    expect(buildInstructions(false).toLowerCase()).not.toContain("approv")
  })
})
