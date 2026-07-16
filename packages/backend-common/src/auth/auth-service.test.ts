import { describe, expect, test } from "bun:test"
import { WorkosAuthService } from "./auth-service"

const CONFIG = {
  apiKey: "sk_test",
  clientId: "client_test",
  redirectUri: "https://app.test/callback",
  cookiePassword: "x".repeat(32),
}

interface FakeSession {
  authenticate: () => Promise<unknown>
  refresh: () => Promise<unknown>
}

/** Service whose loadSealedSession returns the given fake session (no WorkOS network). */
function makeService(session: FakeSession): { service: WorkosAuthService; refreshCalls: () => number } {
  const service = new WorkosAuthService(CONFIG)
  let refreshCalls = 0
  const wrapped: FakeSession = {
    authenticate: session.authenticate,
    refresh: () => {
      refreshCalls++
      return session.refresh()
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(service as any).workos = { userManagement: { loadSealedSession: () => wrapped } }
  return { service, refreshCalls: () => refreshCalls }
}

const USER = { id: "user_1", email: "u@example.com", firstName: null, lastName: null }

describe("WorkosAuthService.verifySession", () => {
  test("verifies a valid token locally without ever calling refresh", async () => {
    const { service, refreshCalls } = makeService({
      authenticate: async () => ({ authenticated: true, user: USER, permissions: ["messages:read"] }),
      refresh: async () => {
        throw new Error("verify-only must never refresh")
      },
    })

    const result = await service.verifySession("sealed")

    expect(result).toMatchObject({ success: true, refreshed: false, user: { id: "user_1" } })
    expect(refreshCalls()).toBe(0)
  })

  test("an expired token fails non-terminal (the client refreshes) — still no refresh call", async () => {
    const { service, refreshCalls } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
      refresh: async () => {
        throw new Error("verify-only must never refresh")
      },
    })

    const result = await service.verifySession("sealed")

    expect(result).toMatchObject({ success: false, reason: "invalid_jwt", terminal: false })
    expect(refreshCalls()).toBe(0)
  })

  test("an unsealable cookie fails terminal", async () => {
    const { service } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_session_cookie" }),
      refresh: async () => ({ authenticated: false }),
    })
    expect(await service.verifySession("sealed")).toMatchObject({ success: false, terminal: true })
  })

  test("an empty cookie value fails terminal", async () => {
    const { service } = makeService({
      authenticate: async () => ({ authenticated: true, user: USER }),
      refresh: async () => ({ authenticated: false }),
    })
    expect(await service.verifySession("")).toMatchObject({ success: false, terminal: true })
  })
})

describe("WorkosAuthService.authenticateSession failure classification", () => {
  test("invalid_grant refresh rejection is NOT terminal (concurrent rotation race must not clear the cookie)", async () => {
    const { service } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
      refresh: async () => ({ authenticated: false, reason: "invalid_grant" }),
    })

    const result = await service.authenticateSession("sealed")

    expect(result).toMatchObject({ success: false, reason: "invalid_grant", terminal: false })
  })

  test("a refresh that throws (WorkOS unreachable) is NOT terminal — an outage must not force logouts", async () => {
    const { service } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
      refresh: async () => {
        throw new Error("Request timeout")
      },
    })

    const result = await service.authenticateSession("sealed")

    expect(result).toMatchObject({ success: false, terminal: false })
  })

  test("mfa_enrollment / sso_required refresh rejections are terminal (fresh login flow required)", async () => {
    for (const reason of ["mfa_enrollment", "sso_required"]) {
      const { service } = makeService({
        authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
        refresh: async () => ({ authenticated: false, reason }),
      })
      expect(await service.authenticateSession("sealed")).toMatchObject({ success: false, reason, terminal: true })
    }
  })

  test("an unsealable cookie is terminal and never reaches refresh (which would throw on the same unseal)", async () => {
    const { service, refreshCalls } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_session_cookie" }),
      refresh: async () => {
        throw new Error("unseal failed")
      },
    })

    const result = await service.authenticateSession("sealed")

    expect(result).toMatchObject({ success: false, reason: "invalid_session_cookie", terminal: true })
    expect(refreshCalls()).toBe(0)
  })

  test("an empty cookie value is terminal", async () => {
    const { service } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
      refresh: async () => ({ authenticated: false, reason: "invalid_grant" }),
    })
    expect(await service.authenticateSession("")).toMatchObject({ success: false, terminal: true })
  })

  test("a successful refresh returns the rotated sealed session", async () => {
    const { service } = makeService({
      authenticate: async () => ({ authenticated: false, reason: "invalid_jwt" }),
      refresh: async () => ({
        authenticated: true,
        sealedSession: "sealed_v2",
        user: USER,
        permissions: ["messages:read"],
      }),
    })

    const result = await service.authenticateSession("sealed_v1")

    expect(result).toMatchObject({
      success: true,
      refreshed: true,
      sealedSession: "sealed_v2",
      user: { id: "user_1", permissions: ["messages:read"] },
    })
  })
})
