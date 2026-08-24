import { describe, test, expect } from "bun:test"
import { asideDraftScope, asideDraftScopePrefix, isAsideDraftScope, parseAsideDraftScope } from "./api"

const ASIDE = "stream_01ASIDE"

describe("aside draft scopes", () => {
  test("round-trips an aside id and a draft id", () => {
    const scope = asideDraftScope(ASIDE, "draft_01ONE")

    expect(scope).toBe("aside:stream_01ASIDE:draft_01ONE")
    expect(parseAsideDraftScope(scope)).toEqual({ asideId: ASIDE, draftId: "draft_01ONE" })
    expect(isAsideDraftScope(scope)).toBe(true)
  })

  test("the list prefix is what every one of that aside's scopes starts with", () => {
    // The server lists an aside's drafts by this prefix, so it has to bound the
    // aside id — `aside:stream_01A:` must not be a prefix of `aside:stream_01AB:…`.
    const prefix = asideDraftScopePrefix(ASIDE)

    expect(asideDraftScope(ASIDE, "draft_01ONE").startsWith(prefix)).toBe(true)
    expect(asideDraftScope("stream_01ASIDEX", "draft_01ONE").startsWith(prefix)).toBe(false)
  })

  test("rejects everything that is not exactly one aside scope", () => {
    const rejected = [
      "stream:stream_01ASIDE",
      "thread:msg_01ONE",
      "aside:",
      "aside:stream_01ASIDE",
      "aside:stream_01ASIDE:",
      "aside::draft_01ONE",
      "aside:stream_01ASIDE:draft_01ONE:extra",
    ]

    expect(rejected.map(parseAsideDraftScope)).toEqual(rejected.map(() => null))
    expect(rejected.some(isAsideDraftScope)).toBe(false)
  })
})
