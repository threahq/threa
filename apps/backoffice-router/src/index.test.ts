import { describe, test, expect, mock, beforeEach } from "bun:test"
import { ORIGINAL_HOST_HEADER } from "@threa/types"
import worker from "./index"

interface EnvOverrides {
  CONTROL_PLANE_URL?: string
  PAGES_PROJECT?: string
}

function makeEnv(overrides: EnvOverrides = {}) {
  return {
    CONTROL_PLANE_URL: "http://control-plane.internal:3003",
    ...overrides,
  } as unknown as {
    CONTROL_PLANE_URL: string
    PAGES_PROJECT?: string
  }
}

function makeRequest(path: string, init: RequestInit = {}) {
  return new Request(`http://admin.threa.io${path}`, init)
}

function mockFetchFn(response: Response = new Response("ok")) {
  const fn = mock(() => Promise.resolve(response))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fn as any
  return fn
}

function getProxiedUrl(fn: ReturnType<typeof mock>): string {
  return (fn.mock.calls[0] as unknown as [string, ...unknown[]])[0]
}

function getProxiedInit(fn: ReturnType<typeof mock>): RequestInit {
  return (fn.mock.calls[0] as unknown as [string, RequestInit])[1]
}

describe("backoffice-router", () => {
  beforeEach(() => {
    // Reset fetch between tests so a leaked mock from one case can't leak into another.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.fetch = (() => Promise.resolve(new Response("default"))) as any
  })

  describe("health check", () => {
    test("GET /readyz returns 200 OK", async () => {
      const res = await worker.fetch(makeRequest("/readyz"), makeEnv())
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("OK")
    })

    test("POST /readyz falls through (readyz is GET-only)", async () => {
      const res = await worker.fetch(makeRequest("/readyz", { method: "POST" }), makeEnv())
      expect(res.status).toBe(404)
    })
  })

  describe("control-plane routes", () => {
    test("GET /api/backoffice/me proxies to control-plane", async () => {
      const fetchMock = mockFetchFn(new Response('{"email":"x@example.com"}', { status: 200 }))
      const res = await worker.fetch(makeRequest("/api/backoffice/me"), makeEnv())
      expect(res.status).toBe(200)
      expect(getProxiedUrl(fetchMock)).toBe("http://control-plane.internal:3003/api/backoffice/me")
    })

    test("POST /api/backoffice/workspace-owner-invitations proxies method and body", async () => {
      const fetchMock = mockFetchFn(new Response("{}", { status: 201 }))
      await worker.fetch(
        makeRequest("/api/backoffice/workspace-owner-invitations", {
          method: "POST",
          body: '{"email":"new@example.com"}',
          headers: { "content-type": "application/json" },
        }),
        makeEnv()
      )
      const init = getProxiedInit(fetchMock)
      expect(init.method).toBe("POST")
    })

    test("proxied request includes X-Forwarded-Host and X-Forwarded-Proto", async () => {
      const fetchMock = mockFetchFn()
      await worker.fetch(makeRequest("/api/backoffice/me"), makeEnv())
      const init = getProxiedInit(fetchMock)
      const headers = new Headers(init.headers)
      expect(headers.get("X-Forwarded-Host")).toBe("admin.threa.io")
      expect(headers.get("X-Forwarded-Proto")).toBe("http")
    })

    test("proxied request mirrors the client host onto the Railway-safe custom header", async () => {
      const fetchMock = mockFetchFn()
      await worker.fetch(makeRequest("/api/backoffice/me"), makeEnv())
      const headers = new Headers(getProxiedInit(fetchMock).headers)
      // Railway overwrites X-Forwarded-Host with its own ingress host, so the
      // control-plane reads the original client host from this custom header.
      expect(headers.get(ORIGINAL_HOST_HEADER)).toBe("admin.threa.io")
    })

    test("client-supplied custom host header cannot spoof the original host", async () => {
      const fetchMock = mockFetchFn()
      await worker.fetch(
        makeRequest("/api/backoffice/me", { headers: { [ORIGINAL_HOST_HEADER]: "evil.example" } }),
        makeEnv()
      )
      const headers = new Headers(getProxiedInit(fetchMock).headers)
      expect(headers.get(ORIGINAL_HOST_HEADER)).toBe("admin.threa.io")
    })

    test("proxied request strips client-supplied X-Forwarded-For", async () => {
      const fetchMock = mockFetchFn()
      await worker.fetch(makeRequest("/api/backoffice/me", { headers: { "X-Forwarded-For": "1.2.3.4" } }), makeEnv())
      const headers = new Headers(getProxiedInit(fetchMock).headers)
      expect(headers.get("X-Forwarded-For")).toBeNull()
    })

    test("proxied request uses CF-Connecting-IP as X-Forwarded-For when present", async () => {
      const fetchMock = mockFetchFn()
      await worker.fetch(
        makeRequest("/api/backoffice/me", {
          headers: { "CF-Connecting-IP": "9.9.9.9", "X-Forwarded-For": "1.2.3.4" },
        }),
        makeEnv()
      )
      const headers = new Headers(getProxiedInit(fetchMock).headers)
      expect(headers.get("X-Forwarded-For")).toBe("9.9.9.9")
    })

    test("/test-auth-login proxies to control-plane (stub dev)", async () => {
      const fetchMock = mockFetchFn(new Response("<html/>", { status: 200 }))
      const res = await worker.fetch(makeRequest("/test-auth-login"), makeEnv())
      expect(res.status).toBe(200)
      expect(getProxiedUrl(fetchMock)).toBe("http://control-plane.internal:3003/test-auth-login")
    })

    test("control-plane failure returns 502", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.fetch = mock(() => Promise.reject(new Error("boom"))) as any
      const res = await worker.fetch(makeRequest("/api/backoffice/me"), makeEnv())
      expect(res.status).toBe(502)
    })
  })

  describe("pages proxy", () => {
    test("non-API request proxies to CF Pages when PAGES_PROJECT is set", async () => {
      const fetchMock = mockFetchFn(new Response("<html/>", { status: 200 }))
      const res = await worker.fetch(makeRequest("/"), makeEnv({ PAGES_PROJECT: "threa-backoffice" }))
      expect(res.status).toBe(200)
      expect(getProxiedUrl(fetchMock)).toBe("https://threa-backoffice.pages.dev/")
    })

    test("deep link proxies to CF Pages with full path", async () => {
      const fetchMock = mockFetchFn(new Response("<html/>", { status: 200 }))
      await worker.fetch(makeRequest("/invites/workspace-owners"), makeEnv({ PAGES_PROJECT: "threa-backoffice" }))
      expect(getProxiedUrl(fetchMock)).toBe("https://threa-backoffice.pages.dev/invites/workspace-owners")
    })

    test("non-API returns 404 when PAGES_PROJECT is not set", async () => {
      const res = await worker.fetch(makeRequest("/some-page"), makeEnv())
      expect(res.status).toBe(404)
    })
  })
})
