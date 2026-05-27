import { beforeAll, describe, expect, test } from "bun:test"
import type { Response } from "express"
import type { AuthResult, AuthService } from "@threa/backend-common"
import { AccountsService } from "./service"

// Capture the env-scoped cookie names this test process will use. Mirrors
// middleware.test.ts so this file works in isolation and alongside others.
let SESSION_COOKIE_NAME: string
let altCookieName: (slot: number) => string

beforeAll(async () => {
  process.env.SESSION_COOKIE_NAME ??= "wos_session_test_accounts"
  const cookies = await import("@threa/backend-common")
  SESSION_COOKIE_NAME = cookies.SESSION_COOKIE_NAME
  altCookieName = cookies.altSessionCookieName
})

// In-memory `Response` stub that records `cookie()` / `clearCookie()` calls.
// We assert only the resulting cookie state after a method finishes, so the
// implementation just plays the calls forward into a Map.
interface RecordingResponse extends Response {
  __cookies: Map<string, string | null>
}

function makeRes(): RecordingResponse {
  const cookies = new Map<string, string | null>()
  const res = {
    __cookies: cookies,
    cookie(name: string, value: string) {
      cookies.set(name, value)
      return this
    },
    clearCookie(name: string) {
      cookies.set(name, null)
      return this
    },
  }
  return res as unknown as RecordingResponse
}

// Programmable auth stub. The bug-fix test needs `refreshed: true` (with a
// rotated `sealedSession`), which `StubAuthService` never returns — that's
// exactly why this bug slipped past the e2e suite.
type AuthReply = AuthResult | ((sealed: string) => AuthResult)

class ProgrammableAuthService implements AuthService {
  private replies = new Map<string, AuthReply>()
  readonly revoked: string[] = []

  on(sealed: string, reply: AuthReply): void {
    this.replies.set(sealed, reply)
  }

  async authenticateSession(sealed: string): Promise<AuthResult> {
    const reply = this.replies.get(sealed)
    if (!reply) return { success: false, refreshed: false, reason: "not_found" }
    return typeof reply === "function" ? reply(sealed) : reply
  }

  async authenticateWithCode(): Promise<AuthResult> {
    return { success: false, refreshed: false, reason: "unused" }
  }
  getAuthorizationUrl(): string {
    return "/unused"
  }
  async sendMagicAuthCode(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: true }
  }
  async authenticateWithMagicAuth(): Promise<AuthResult> {
    return { success: false, refreshed: false, reason: "unused" }
  }
  async getLogoutUrl(): Promise<string | null> {
    return null
  }
  async revokeSession(sealed: string): Promise<boolean> {
    this.revoked.push(sealed)
    return true
  }
}

const NEVER_MEMBER = {
  async isMember(): Promise<boolean> {
    return false
  },
}

function makeUser(id: string): NonNullable<AuthResult["user"]> {
  return { id, email: `${id}@example.com`, firstName: id, lastName: null, permissions: null }
}

describe("AccountsService — refreshed sealed propagation", () => {
  test("switch uses the rotated sealed when WorkOS refreshes the parked session", async () => {
    // Setup: A is parked in alt slot 0 with a sealed that's about to be
    // rotated by `authenticate` -> `refresh`. B is active.
    const auth = new ProgrammableAuthService()
    auth.on("sealed_b_active", { success: true, refreshed: false, user: makeUser("user_b") })
    auth.on("sealed_a_stale", {
      success: true,
      refreshed: true,
      sealedSession: "sealed_a_rotated",
      user: makeUser("user_a"),
    })
    // After rotation the pre-refresh value is dead at WorkOS, so any caller
    // who re-uses it for a follow-up `authenticate` would 401. We model that
    // by leaving "sealed_a_stale" unset for the rotated reply (a fresh call
    // returns not_found from the map). The rotated value is what must be
    // promoted to the active cookie.
    auth.on("sealed_a_rotated", { success: true, refreshed: false, user: makeUser("user_a") })

    const service = new AccountsService({ authService: auth, membership: NEVER_MEMBER })
    const res = makeRes()
    const cookies = { [altCookieName(0)]: "sealed_a_stale" }

    const result = await service.switch(res, cookies, "sealed_b_active", makeUser("user_b"), "user_a")

    expect(result).toEqual({ activeUserId: "user_a" })
    // The active cookie now holds the *rotated* sealed, not the dead one the
    // browser sent. Without the fix this would be "sealed_a_stale" and the
    // very next /api/auth/me would 401.
    expect(res.__cookies.get(SESSION_COOKIE_NAME)).toBe("sealed_a_rotated")
    // The previously-active session was parked into the slot the target
    // vacated.
    expect(res.__cookies.get(altCookieName(0))).toBe("sealed_b_active")
  })

  test("list writes the rotated sealed back to the alt cookie when refresh happens", async () => {
    // Just viewing the switcher must not destroy a parked session: if the
    // alt's access token has expired, `authenticate` rotates the refresh
    // token, and the pre-refresh sealed is dead. The cookie has to be
    // rewritten or the next view 401s the parked account.
    const auth = new ProgrammableAuthService()
    auth.on("sealed_a_stale", {
      success: true,
      refreshed: true,
      sealedSession: "sealed_a_rotated",
      user: makeUser("user_a"),
    })

    const service = new AccountsService({ authService: auth, membership: NEVER_MEMBER })
    const res = makeRes()
    const cookies = { [altCookieName(0)]: "sealed_a_stale" }
    const activeUser = makeUser("user_b")

    const { accounts } = await service.list(res, cookies, activeUser)
    expect(accounts.map((a) => a.id)).toEqual(["user_b", "user_a"])
    expect(res.__cookies.get(altCookieName(0))).toBe("sealed_a_rotated")
  })

  test("addAndParkActive parks the rotated sealed when WorkOS refreshes the previous active", async () => {
    // Mid-OAuth-callback we re-authenticate the previous active session to
    // decide whether to park it. WorkOS rotating the refresh token there
    // means the pre-refresh sealed (what the browser sent) is now dead — we
    // must park the rotated value, not the original.
    const auth = new ProgrammableAuthService()
    auth.on("sealed_a_stale", {
      success: true,
      refreshed: true,
      sealedSession: "sealed_a_rotated",
      user: makeUser("user_a"),
    })

    const service = new AccountsService({ authService: auth, membership: NEVER_MEMBER })
    const res = makeRes()

    const result = await service.addAndParkActive(res, {}, "sealed_a_stale", "sealed_b_new", "user_b")

    expect(result).toEqual({ ok: true })
    expect(res.__cookies.get(SESSION_COOKIE_NAME)).toBe("sealed_b_new")
    expect(res.__cookies.get(altCookieName(0))).toBe("sealed_a_rotated")
  })

  test("removeCurrentAndPromote revokes the rotated sealed and promotes the alt", async () => {
    // The "sign out of just this account" path: WorkOS may rotate the active
    // session's refresh token during the authenticate() pre-check. If we then
    // pass the pre-refresh sealed to revokeSession, WorkOS's session.refresh
    // fails on a stale token and revoke silently returns false — the live
    // WorkOS session stays alive. The rotated value must reach revoke.
    const auth = new ProgrammableAuthService()
    auth.on("sealed_a_active", {
      success: true,
      refreshed: true,
      sealedSession: "sealed_a_rotated",
      user: makeUser("user_a"),
    })
    auth.on("sealed_b_parked", { success: true, refreshed: false, user: makeUser("user_b") })

    const service = new AccountsService({ authService: auth, membership: NEVER_MEMBER })
    const res = makeRes()
    const cookies = { [altCookieName(0)]: "sealed_b_parked" }

    const promoted = await service.removeCurrentAndPromote(res, cookies, "sealed_a_active")

    expect(promoted).toBe(true)
    // Active cookie now holds the promoted parked sealed; the parked slot was
    // cleared on promotion.
    expect(res.__cookies.get(SESSION_COOKIE_NAME)).toBe("sealed_b_parked")
    expect(res.__cookies.get(altCookieName(0))).toBeNull()
    // The rotated sealed is what reached revokeSession — without the fix this
    // would be "sealed_a_active" and the active WorkOS session would survive.
    expect(auth.revoked).toEqual(["sealed_a_rotated"])
  })

  test("removeCurrentAndPromote returns false when there is no parked alt to promote", async () => {
    // No alts means a "sign out current" would empty the cookie jar — that's
    // indistinguishable from a full logout, so the caller falls through to
    // the WorkOS SSO logout flow instead of going through revoke + promote.
    const auth = new ProgrammableAuthService()
    auth.on("sealed_a_active", { success: true, refreshed: false, user: makeUser("user_a") })

    const service = new AccountsService({ authService: auth, membership: NEVER_MEMBER })
    const res = makeRes()

    const promoted = await service.removeCurrentAndPromote(res, {}, "sealed_a_active")

    expect(promoted).toBe(false)
    // No cookie writes, no revoke calls — caller is responsible for full logout.
    expect(res.__cookies.size).toBe(0)
    expect(auth.revoked).toEqual([])
  })

  test("removeCurrentAndPromote returns false when there is no active sealed", async () => {
    const auth = new ProgrammableAuthService()
    const service = new AccountsService({ authService: auth, membership: NEVER_MEMBER })
    const res = makeRes()

    const promoted = await service.removeCurrentAndPromote(res, {}, undefined)

    expect(promoted).toBe(false)
    expect(res.__cookies.size).toBe(0)
  })
})
