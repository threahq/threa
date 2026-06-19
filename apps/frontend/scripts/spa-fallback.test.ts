import { describe, expect, it } from "vitest"
import { shouldServeSpa } from "../functions/[[path]].js"

describe("SPA fallback function", () => {
  it("serves the React shell for app routes that need deep-link reloads", () => {
    expect(shouldServeSpa("/login")).toBe(true)
    expect(shouldServeSpa("/workspaces")).toBe(true)
    expect(shouldServeSpa("/workspaces/")).toBe(true)
    expect(shouldServeSpa("/w/ws_123")).toBe(true)
    expect(shouldServeSpa("/w/ws_123/s/stream_123")).toBe(true)
    expect(shouldServeSpa("/join/invite_123")).toBe(true)
  })

  it("does not serve the React shell for assets, API routes, or unknown paths", () => {
    expect(shouldServeSpa("/assets/workspace-layout-old.js")).toBe(false)
    expect(shouldServeSpa("/api/auth/me")).toBe(false)
    expect(shouldServeSpa("/recover")).toBe(false)
    expect(shouldServeSpa("/not-a-route")).toBe(false)
  })
})
