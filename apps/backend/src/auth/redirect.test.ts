import { describe, expect, test } from "bun:test"
import { decodeAndSanitizeRedirectState } from "@threahq/backend-common"

function encodeState(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64")
}

describe("decodeAndSanitizeRedirectState", () => {
  test("allows internal relative paths", () => {
    const state = encodeState("/workspaces/ws_123?tab=streams#latest")
    expect(decodeAndSanitizeRedirectState(state)).toBe("/workspaces/ws_123?tab=streams#latest")
  })

  test("falls back for external absolute URL", () => {
    const state = encodeState("https://evil.example/phish")
    expect(decodeAndSanitizeRedirectState(state)).toBe("/")
  })

  test("falls back for protocol-relative URL", () => {
    const state = encodeState("//evil.example/phish")
    expect(decodeAndSanitizeRedirectState(state)).toBe("/")
  })

  test("falls back for malformed or unsafe state", () => {
    expect(decodeAndSanitizeRedirectState("%%%")).toBe("/")
    expect(decodeAndSanitizeRedirectState(encodeState("/safe\nset-cookie"))).toBe("/")
  })
})
