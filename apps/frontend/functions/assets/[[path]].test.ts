import { describe, it, expect } from "vitest"
import { onRequest } from "./[[path]]"

function context(next: Response) {
  return {
    request: new Request("https://app.threa.io/assets/workspace-layout-AbC123.js"),
    next: async () => next,
  }
}

describe("assets onRequest", () => {
  it("converts the SPA html fallback (missing chunk) into a no-store 404", async () => {
    const fallback = new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
    })

    const res = await onRequest(context(fallback))

    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("content-type")).toContain("text/plain")
  })

  it("passes a real JS asset through untouched, immutable header intact", async () => {
    const asset = new Response("export const x = 1", {
      status: 200,
      headers: { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" },
    })

    const res = await onRequest(context(asset))

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("immutable")
    expect(await res.text()).toBe("export const x = 1")
  })

  it("passes a real CSS asset through untouched", async () => {
    const asset = new Response("body{}", {
      status: 200,
      headers: { "content-type": "text/css" },
    })

    const res = await onRequest(context(asset))

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/css")
  })
})
