import { describe, expect, it } from "vitest"
import { resolveInternalAppPath } from "./internal-url"

describe("resolveInternalAppPath", () => {
  const origin = window.location.origin

  it("returns the router path for a same-origin absolute URL", () => {
    expect(resolveInternalAppPath(`${origin}/w/ws_1/s/stream_2?m=msg_3`)).toBe("/w/ws_1/s/stream_2?m=msg_3")
  })

  it("preserves the hash on a same-origin URL", () => {
    expect(resolveInternalAppPath(`${origin}/w/ws_1/memory?memo=memo_9#section`)).toBe(
      "/w/ws_1/memory?memo=memo_9#section"
    )
  })

  it("treats a relative href as same-origin", () => {
    expect(resolveInternalAppPath("/w/ws_1/s/stream_2")).toBe("/w/ws_1/s/stream_2")
  })

  it("returns null for an external origin", () => {
    expect(resolveInternalAppPath("https://github.com/acme/repo/pull/42")).toBeNull()
  })

  it("returns null for a non-http scheme (opaque origin never matches ours)", () => {
    expect(resolveInternalAppPath("mailto:hi@example.com")).toBeNull()
    expect(resolveInternalAppPath("javascript:alert(1)")).toBeNull()
  })
})
