import { describe, test, expect } from "bun:test"
import { ORIGINAL_HOST_HEADER } from "@threa/types"
import { TestClient, loginAs } from "../client"

describe("Auth", () => {
  test("GET /api/auth/me returns 401 without session", async () => {
    const client = new TestClient()
    const res = await client.get("/api/auth/me")
    expect(res.status).toBe(401)
  })

  test("POST /api/dev/login sets session cookie and returns user", async () => {
    const client = new TestClient()
    const user = await loginAs(client, "auth-test@example.com", "Auth Tester")

    expect(user.id).toBeTruthy()
    expect(user.email).toBe("auth-test@example.com")
  })

  test("GET /api/auth/me returns user after login", async () => {
    const client = new TestClient()
    await loginAs(client, "me-test@example.com", "Me Tester")

    const res = await client.get<{ id: string; email: string; name: string }>("/api/auth/me")
    expect(res.status).toBe(200)
    expect(res.data.email).toBe("me-test@example.com")
    expect(res.data.name).toBe("Me Tester")
  })

  test("GET /api/auth/logout clears session", async () => {
    const client = new TestClient()
    await loginAs(client, "logout-test@example.com", "Logout Tester")

    // Verify logged in
    const meRes = await client.get("/api/auth/me")
    expect(meRes.status).toBe(200)

    // Logout (returns redirect)
    const logoutRes = await client.get("/api/auth/logout")
    expect(logoutRes.status).toBe(302)

    // Session should be cleared — me should fail
    const afterRes = await client.get("/api/auth/me")
    expect(afterRes.status).toBe(401)
  })

  test("GET /readyz returns ok", async () => {
    const client = new TestClient()
    const res = await client.get<{ status: string }>("/readyz")
    expect(res.status).toBe(200)
    expect(res.data.status).toBe("ok")
  })

  test("GET /api/regions returns available regions", async () => {
    const client = new TestClient()
    const res = await client.get<{ regions: string[] }>("/api/regions")
    expect(res.status).toBe(200)
    expect(res.data.regions).toContain("local")
  })

  test("POST /test-auth-login redirects with session cookie", async () => {
    const client = new TestClient()
    const res = await client.post("/test-auth-login", { email: "stub-login@example.com", name: "Stub User" })
    // Stub login redirects to / after setting cookie
    expect(res.status).toBe(302)

    // Session should be set — me should work
    const meRes = await client.get<{ email: string }>("/api/auth/me")
    expect(meRes.status).toBe(200)
    expect(meRes.data.email).toBe("stub-login@example.com")
  })

  describe("per-host redirect URI override", () => {
    test("GET /api/auth/login uses dedicated redirect URI when forwarded host matches", async () => {
      const client = new TestClient()
      const res = await client.request("GET", "/api/auth/login?redirect_to=%2F", undefined, {
        "X-Forwarded-Host": "admin.threa.io",
      })
      expect(res.status).toBe(302)
      const location = res.headers.get("location")
      expect(location).toBeTruthy()

      // Stub builds `/test-auth-login?state=<b64>&redirect_uri=<uri>`.
      // We only need a URL-lax parse for the query string.
      const url = new URL(location!, "http://localhost")
      expect(url.pathname).toBe("/test-auth-login")
      expect(url.searchParams.get("redirect_uri")).toBe("https://admin.threa.io/api/auth/callback")

      const state = url.searchParams.get("state")
      expect(state).toBeTruthy()
      const decoded = Buffer.from(state!, "base64").toString("utf-8")
      expect(decoded).toBe("admin.threa.io|/")
    })

    test("GET /api/auth/login uses dedicated redirect URI from the custom host header", async () => {
      // Railway overwrites X-Forwarded-Host before the control-plane sees it, so
      // in production the routers carry the real client host on ORIGINAL_HOST_HEADER.
      const client = new TestClient()
      const res = await client.request("GET", "/api/auth/login?redirect_to=%2Fworkspaces", undefined, {
        [ORIGINAL_HOST_HEADER]: "admin.threa.io",
      })
      expect(res.status).toBe(302)
      const url = new URL(res.headers.get("location")!, "http://localhost")
      expect(url.searchParams.get("redirect_uri")).toBe("https://admin.threa.io/api/auth/callback")
      const decoded = Buffer.from(url.searchParams.get("state")!, "base64").toString("utf-8")
      expect(decoded).toBe("admin.threa.io|/workspaces")
    })

    test("GET /api/auth/login prefers the custom host header over X-Forwarded-Host", async () => {
      // X-Forwarded-Host carries Railway's (untrusted) ingress host in prod; the
      // custom header is the source of truth and must win.
      const client = new TestClient()
      const res = await client.request("GET", "/api/auth/login?redirect_to=%2F", undefined, {
        [ORIGINAL_HOST_HEADER]: "admin.threa.io",
        "X-Forwarded-Host": "control-plane.up.railway.app",
      })
      expect(res.status).toBe(302)
      const url = new URL(res.headers.get("location")!, "http://localhost")
      expect(url.searchParams.get("redirect_uri")).toBe("https://admin.threa.io/api/auth/callback")
    })

    test("GET /api/auth/login does NOT override redirect URI for unrelated forwarded hosts", async () => {
      const client = new TestClient()
      const res = await client.request("GET", "/api/auth/login", undefined, {
        "X-Forwarded-Host": "unrelated.example.com",
      })
      expect(res.status).toBe(302)
      const location = res.headers.get("location")
      const url = new URL(location!, "http://localhost")
      expect(url.searchParams.get("redirect_uri")).toBeNull()
    })

    test("GET /api/auth/login with no forwarded host does not set redirect URI", async () => {
      const client = new TestClient()
      const res = await client.get("/api/auth/login")
      expect(res.status).toBe(302)
      const location = res.headers.get("location")
      const url = new URL(location!, "http://localhost")
      expect(url.searchParams.get("redirect_uri")).toBeNull()
    })

    test("GET /api/auth/logout passes dedicated host as returnTo to WorkOS", async () => {
      // The stub's getLogoutUrl encodes returnTo as ?return_to= so we can
      // assert on it here; the real WorkosAuthService forwards it to the
      // WorkOS SDK's session.getLogoutUrl().
      const client = new TestClient()
      await loginAs(client, "logout-dedicated@example.com", "Logout Dedicated")

      const res = await client.request("GET", "/api/auth/logout", undefined, {
        "X-Forwarded-Host": "admin.threa.io",
      })
      expect(res.status).toBe(302)
      const location = res.headers.get("location")!
      const url = new URL(location, "http://localhost")
      expect(url.pathname).toBe("/test-logged-out")
      expect(url.searchParams.get("return_to")).toBe("https://admin.threa.io")
    })

    test("GET /api/auth/logout without a forwarded host uses the default returnTo", async () => {
      const client = new TestClient()
      await loginAs(client, "logout-default@example.com", "Logout Default")

      const res = await client.get("/api/auth/logout")
      expect(res.status).toBe(302)
      const location = res.headers.get("location")!
      const url = new URL(location, "http://localhost")
      expect(url.searchParams.get("return_to")).toBeNull()
    })

    test("GET /api/auth/logout with an unrelated forwarded host uses the default returnTo", async () => {
      const client = new TestClient()
      await loginAs(client, "logout-unrelated@example.com", "Logout Unrelated")

      const res = await client.request("GET", "/api/auth/logout", undefined, {
        "X-Forwarded-Host": "unrelated.example.com",
      })
      expect(res.status).toBe(302)
      const location = res.headers.get("location")!
      const url = new URL(location, "http://localhost")
      expect(url.searchParams.get("return_to")).toBeNull()
    })
  })
})
