import { describe, expect, it, vi } from "vitest"
import { onRequest, shouldServeSpaForStaticMiss } from "../functions/[[path]].js"

function requestFor(pathname: string, init?: RequestInit): Request {
  return new Request(`https://app.threa.io${pathname}`, {
    headers: { accept: "text/html", ...init?.headers },
    ...init,
  })
}

function response(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe("SPA fallback function", () => {
  it("serves the React shell for any extensionless HTML navigation after static assets miss", async () => {
    const shell = response("app shell")
    const notFound = response("not found", 404)
    const assetsFetch = vi.fn(async (request: Request) => {
      return new URL(request.url).pathname === "/" ? shell : notFound
    })

    const result = await onRequest({
      request: requestFor("/w/ws_123/s/stream_123"),
      env: { ASSETS: { fetch: assetsFetch } },
      next: vi.fn(),
    })

    expect(await result.text()).toBe("app shell")
    expect(assetsFetch).toHaveBeenCalledTimes(2)
    expect(new URL((assetsFetch.mock.calls[1]?.[0] as Request).url).pathname).toBe("/")
  })

  it("does not need an allow-list update when a new extensionless route is added", async () => {
    const shell = response("app shell")
    const assetsFetch = vi.fn(async (request: Request) => {
      return new URL(request.url).pathname === "/" ? shell : response("not found", 404)
    })

    const result = await onRequest({
      request: requestFor("/future-route/deep/link"),
      env: { ASSETS: { fetch: assetsFetch } },
      next: vi.fn(),
    })

    expect(await result.text()).toBe("app shell")
  })

  it("returns existing static files before considering SPA fallback", async () => {
    const recover = response("recover page")
    const assetsFetch = vi.fn(async (request: Request) => {
      return new URL(request.url).pathname === "/recover" ? recover : response("app shell")
    })

    const result = await onRequest({
      request: requestFor("/recover"),
      env: { ASSETS: { fetch: assetsFetch } },
      next: vi.fn(),
    })

    expect(await result.text()).toBe("recover page")
    expect(assetsFetch).toHaveBeenCalledOnce()
  })

  it("does not serve the React shell for missing files or non-HTML requests", async () => {
    expect(shouldServeSpaForStaticMiss(requestFor("/assets/workspace-layout-old.js"))).toBe(false)
    expect(shouldServeSpaForStaticMiss(requestFor("/api/auth/me", { headers: { accept: "application/json" } }))).toBe(
      false
    )
    expect(shouldServeSpaForStaticMiss(requestFor("/favicon.ico"))).toBe(false)
  })

  it("lets non-GET/HEAD requests fall through", async () => {
    const next = vi.fn(async () => response("next"))
    const result = await onRequest({
      request: requestFor("/share", { method: "POST" }),
      env: { ASSETS: { fetch: vi.fn() } },
      next,
    })

    expect(await result.text()).toBe("next")
    expect(next).toHaveBeenCalledOnce()
  })
})
