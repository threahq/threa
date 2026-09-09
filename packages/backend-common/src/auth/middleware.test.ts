import { describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import { ACCOUNT_ASSERTION_HEADER, AuthErrorCodes } from "@threahq/types"
import { SessionCookies } from "../cookies"
import { createAuthMiddleware } from "./middleware"
import type { AuthResult, AuthService } from "./auth-service"

class FakeAuthService implements AuthService {
  constructor(private result: AuthResult) {}
  async authenticateSession(): Promise<AuthResult> {
    return this.result
  }
  async authenticateWithCode(): Promise<AuthResult> {
    return this.result
  }
  getAuthorizationUrl(): string {
    return "/login"
  }
  async getLogoutUrl(): Promise<string | null> {
    return null
  }
  async revokeSession(): Promise<boolean> {
    return false
  }
  async sendMagicAuthCode(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: true }
  }
  async authenticateWithMagicAuth(): Promise<AuthResult> {
    return this.result
  }
}

interface CapturingRes {
  statusCode: number
  body: unknown
  clearedCookies: string[]
  setCookies: string[]
}

function makeRes(): Response & CapturingRes {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    clearedCookies: [] as string[],
    setCookies: [] as string[],
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
    clearCookie(name: string) {
      this.clearedCookies.push(name)
      return this
    },
    cookie(name: string) {
      this.setCookies.push(name)
      return this
    },
  }
  return res as unknown as Response & CapturingRes
}

describe("createAuthMiddleware", () => {
  const sessionCookieName = "wos_session_test_mw"
  const sessionCookies = new SessionCookies({
    name: sessionCookieName,
    options: { path: "/", httpOnly: true, secure: false, sameSite: "lax" },
  })

  test("populates req.authUser.permissions from the JWT permission claim", async () => {
    const middleware = createAuthMiddleware({
      sessionCookies,
      authService: new FakeAuthService({
        success: true,
        refreshed: false,
        user: {
          id: "user_123",
          email: "u@example.com",
          firstName: null,
          lastName: null,
          permissions: ["messages:read", "members:write"],
        },
      }),
    })

    const req = { cookies: { [sessionCookieName]: "session" }, headers: {} } as unknown as Request
    let nextCalled = false
    await middleware(req, makeRes(), () => {
      nextCalled = true
    })

    expect(nextCalled).toBe(true)
    expect(req.authUser?.permissions?.slice().sort()).toEqual(["members:write", "messages:read"])
    expect(req.workosUserId).toBe("user_123")
  })

  test("empty permission claim is preserved as empty array (not coerced to null)", async () => {
    // Bootstrap callers rely on this distinction: `[]` means "WorkOS sent an
    // empty grant" (no fallback), `null` means "no claim — fall back to role".
    const middleware = createAuthMiddleware({
      sessionCookies,
      authService: new FakeAuthService({
        success: true,
        refreshed: false,
        user: {
          id: "user_123",
          email: "u@example.com",
          firstName: null,
          lastName: null,
          permissions: [],
        },
      }),
    })

    const req = { cookies: { [sessionCookieName]: "session" }, headers: {} } as unknown as Request
    await middleware(req, makeRes(), () => {})

    expect(req.authUser?.permissions).toEqual([])
  })

  test("absent permission claim surfaces as null so callers can fall back", async () => {
    const middleware = createAuthMiddleware({
      sessionCookies,
      authService: new FakeAuthService({
        success: true,
        refreshed: false,
        user: {
          id: "user_123",
          email: "u@example.com",
          firstName: null,
          lastName: null,
          permissions: null,
        },
      }),
    })

    const req = { cookies: { [sessionCookieName]: "session" }, headers: {} } as unknown as Request
    await middleware(req, makeRes(), () => {})

    expect(req.authUser?.permissions).toBeNull()
  })

  test("non-terminal auth failure 401s WITHOUT clearing the session cookie (refresh race / WorkOS outage)", async () => {
    const middleware = createAuthMiddleware({
      sessionCookies,
      authService: new FakeAuthService({ success: false, refreshed: false, reason: "invalid_grant", terminal: false }),
    })

    const req = { cookies: { [sessionCookieName]: "session" }, headers: {} } as unknown as Request
    const res = makeRes()
    await middleware(req, res, () => {})

    expect(res.statusCode).toBe(401)
    expect(res.clearedCookies).toEqual([])
  })

  function authenticatedMiddleware(userId: string, refreshed = false) {
    return createAuthMiddleware({
      sessionCookies,
      authService: new FakeAuthService({
        success: true,
        refreshed,
        ...(refreshed && { sealedSession: "rotated-sealed" }),
        user: { id: userId, email: "u@example.com", firstName: null, lastName: null, permissions: null },
      }),
    })
  }

  test("refuses a request formed for a different signed-in account", async () => {
    const middleware = authenticatedMiddleware("user_b")
    const req = {
      cookies: { [sessionCookieName]: "session" },
      headers: { [ACCOUNT_ASSERTION_HEADER.toLowerCase()]: "user_a" },
    } as unknown as Request
    const res = makeRes()
    let nextCalled = false
    await middleware(req, res, () => {
      nextCalled = true
    })

    expect({ status: res.statusCode, body: res.body, nextCalled, workosUserId: req.workosUserId }).toEqual({
      status: 409,
      body: {
        error: "This browser is signed in as a different account",
        code: AuthErrorCodes.ACCOUNT_MISMATCH,
      },
      nextCalled: false,
      workosUserId: undefined,
    })
  })

  test("refuses a duplicated assertion header instead of reading past it", async () => {
    // Express hands a repeated header over as an array. A `typeof === "string"`
    // guard skips it, so a client that sends the header twice would sail past
    // the very check the header exists to enforce.
    const middleware = authenticatedMiddleware("user_b")
    const req = {
      cookies: { [sessionCookieName]: "session" },
      headers: { [ACCOUNT_ASSERTION_HEADER.toLowerCase()]: ["user_a", "user_b"] },
    } as unknown as Request
    const res = makeRes()
    let nextCalled = false
    await middleware(req, res, () => {
      nextCalled = true
    })

    expect({ status: res.statusCode, body: res.body, nextCalled, workosUserId: req.workosUserId }).toEqual({
      status: 400,
      body: { error: "Malformed account assertion", code: AuthErrorCodes.INVALID_ACCOUNT_ASSERTION },
      nextCalled: false,
      workosUserId: undefined,
    })
  })

  test("refuses an empty assertion header", async () => {
    const middleware = authenticatedMiddleware("user_b")
    const req = {
      cookies: { [sessionCookieName]: "session" },
      headers: { [ACCOUNT_ASSERTION_HEADER.toLowerCase()]: "  " },
    } as unknown as Request
    const res = makeRes()
    await middleware(req, res, () => {})

    expect({ status: res.statusCode, workosUserId: req.workosUserId }).toEqual({
      status: 400,
      workosUserId: undefined,
    })
  })

  test("accepts a matching assertion and an absent one alike", async () => {
    // Absent is an older client or an API-key/OAuth caller: normal rollout
    // means they keep working, so only a supplied claim is ever judged.
    const middleware = authenticatedMiddleware("user_b")
    const outcomes: Array<{ nextCalled: boolean; workosUserId?: string }> = []
    for (const headers of [{ [ACCOUNT_ASSERTION_HEADER.toLowerCase()]: "user_b" }, {}]) {
      const req = { cookies: { [sessionCookieName]: "session" }, headers } as unknown as Request
      let nextCalled = false
      await middleware(req, makeRes(), () => {
        nextCalled = true
      })
      outcomes.push({ nextCalled, workosUserId: req.workosUserId })
    }

    expect(outcomes).toEqual([
      { nextCalled: true, workosUserId: "user_b" },
      { nextCalled: true, workosUserId: "user_b" },
    ])
  })

  test("keeps a rotated session cookie even when it refuses the assertion", async () => {
    // The refresh already happened at WorkOS: dropping the rotated sealed
    // session here would revoke a perfectly good session over a mismatch.
    const middleware = authenticatedMiddleware("user_b", true)
    const req = {
      cookies: { [sessionCookieName]: "session" },
      headers: { [ACCOUNT_ASSERTION_HEADER.toLowerCase()]: "user_a" },
    } as unknown as Request
    const res = makeRes()
    await middleware(req, res, () => {})

    expect({ status: res.statusCode, setCookies: res.setCookies }).toEqual({
      status: 409,
      setCookies: [sessionCookieName],
    })
  })

  test("passes a request whose assertion matches the session's account", async () => {
    const middleware = authenticatedMiddleware("user_a")
    const req = {
      cookies: { [sessionCookieName]: "session" },
      headers: { [ACCOUNT_ASSERTION_HEADER.toLowerCase()]: "user_a" },
    } as unknown as Request
    let nextCalled = false
    await middleware(req, makeRes(), () => {
      nextCalled = true
    })

    expect({ nextCalled, workosUserId: req.workosUserId }).toEqual({ nextCalled: true, workosUserId: "user_a" })
  })

  test("passes a request that asserts nothing, so older clients keep working", async () => {
    const middleware = authenticatedMiddleware("user_a")
    const req = { cookies: { [sessionCookieName]: "session" }, headers: {} } as unknown as Request
    let nextCalled = false
    await middleware(req, makeRes(), () => {
      nextCalled = true
    })

    expect({ nextCalled, workosUserId: req.workosUserId }).toEqual({ nextCalled: true, workosUserId: "user_a" })
  })

  test("terminal auth failure clears the session cookie", async () => {
    const middleware = createAuthMiddleware({
      sessionCookies,
      authService: new FakeAuthService({
        success: false,
        refreshed: false,
        reason: "invalid_session_cookie",
        terminal: true,
      }),
    })

    const req = { cookies: { [sessionCookieName]: "session" }, headers: {} } as unknown as Request
    const res = makeRes()
    await middleware(req, res, () => {})

    expect(res.statusCode).toBe(401)
    expect(res.clearedCookies).toContain(sessionCookieName)
  })
})
