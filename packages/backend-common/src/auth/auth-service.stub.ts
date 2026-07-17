import type { SocialProvider } from "@threa/types"
import type { AuthResult, AuthService } from "./auth-service"

// Stub sessions deliberately surface no JWT permission claim
// (`permissions: null`). Production OAuth-callback sessions also start with
// `permissions: null` until the next refresh, so this exercises a real
// production code path — the role-derived fallback inside
// `requireWorkspacePermission`. Returning the owner permission set here would
// short-circuit the JWT-claim branch and silently elevate every test session,
// which would break the role-based e2e tests in `apps/backend/tests/e2e/rbac.test.ts`
// (member/admin/owner differentiation depends on the role-derived path).
// The JWT-claim-present branch is exercised by
// `apps/backend/tests/integration/workspace-permission-middleware.test.ts`.
export interface DevLoginResult {
  user: { id: string; email: string; name: string }
  session: string
}

/**
 * A stub AuthService for e2e testing that bypasses WorkOS entirely.
 * Users are identified by a simple token format: "test_session_<userId>"
 */
export class StubAuthService implements AuthService {
  private users: Map<string, { id: string; email: string; firstName: string | null; lastName: string | null }> =
    new Map()
  private revoked = new Set<string>()
  // Issued magic codes, keyed by lowercase email. One code per email at a time
  // — a fresh send overwrites the previous one, mirroring real Magic Auth.
  private magicCodes = new Map<string, string>()
  /**
   * Test seam: the fixed code the stub returns to every `sendMagicAuthCode` so
   * e2e tests don't have to inspect emails. Defaults to "123456".
   */
  magicCodeForTests = "123456"

  async devLogin(options: { email?: string; name?: string } = {}): Promise<DevLoginResult> {
    const email = options.email || "test@example.com"
    const name = options.name || "Test User"

    // base64url-encode the email so authenticateSession can reverse it back
    const fakeWorkosUserId = `workos_test_${Buffer.from(email).toString("base64url")}`

    const session = this.registerTestUser({
      id: fakeWorkosUserId,
      email,
      firstName: name,
    })

    return {
      user: { id: fakeWorkosUserId, email, name },
      session,
    }
  }

  registerTestUser(user: { id: string; email: string; firstName?: string | null; lastName?: string | null }): string {
    this.users.set(user.id, {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
    })
    return `test_session_${user.id}`
  }

  clearUsers(): void {
    this.users.clear()
    this.revoked.clear()
    this.magicCodes.clear()
  }

  async revokeSession(sealedSession: string): Promise<boolean> {
    if (!/^test_session_(.+)$/.test(sealedSession)) return false
    this.revoked.add(sealedSession)
    return true
  }

  // Stub sessions never expire, so verify-only and full auth are the same path.
  async verifySession(sealedSession: string): Promise<AuthResult> {
    return this.authenticateSession(sealedSession)
  }

  async authenticateSession(sealedSession: string): Promise<AuthResult> {
    if (!sealedSession) {
      return {
        success: false,
        refreshed: false,
        reason: "no_session_cookie_provided",
        terminal: true,
      }
    }

    const match = sealedSession.match(/^test_session_(.+)$/)
    if (!match) {
      return { success: false, refreshed: false, reason: "invalid_session_format", terminal: true }
    }

    if (this.revoked.has(sealedSession)) {
      return { success: false, refreshed: false, reason: "session_revoked", terminal: true }
    }

    const userId = match[1]
    let user = this.users.get(userId)

    // Auto-register from session token for cross-process stub auth.
    // When the control-plane sets the session cookie, the regional backend
    // (a separate process with its own StubAuthService) needs to trust it.
    if (!user && userId?.startsWith("workos_test_")) {
      const emailPart = userId.slice("workos_test_".length)
      const email = Buffer.from(emailPart, "base64url").toString()
      user = { id: userId, email, firstName: null, lastName: null }
      this.users.set(userId, user)
    }

    if (!user) {
      return { success: false, refreshed: false, reason: "user_not_found" }
    }

    return {
      success: true,
      user: { ...user, permissions: null },
      refreshed: false,
    }
  }

  async authenticateWithCode(code: string): Promise<AuthResult> {
    const match = code.match(/^test_code_(.+)$/)
    if (!match) {
      return { success: false, refreshed: false, reason: "invalid_code" }
    }

    const userId = match[1]
    const user = this.users.get(userId)

    if (!user) {
      return { success: false, refreshed: false, reason: "user_not_found" }
    }

    return {
      success: true,
      user: { ...user, permissions: null },
      sealedSession: `test_session_${userId}`,
      refreshed: false,
    }
  }

  getAuthorizationUrl(redirectTo?: string, redirectUri?: string, options?: { provider?: SocialProvider }): string {
    // Encode state, optional redirect_uri, and optional provider into the stub
    // login URL so tests can assert on any of them. The stub login page
    // ignores redirect_uri and provider.
    const state = redirectTo ? Buffer.from(redirectTo).toString("base64") : ""
    const params = new URLSearchParams({ state })
    if (redirectUri) {
      params.set("redirect_uri", redirectUri)
    }
    if (options?.provider) {
      params.set("provider", options.provider)
    }
    return `/test-auth-login?${params.toString()}`
  }

  async sendMagicAuthCode(email: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!email) return { ok: false, reason: "send_failed" }
    this.magicCodes.set(email.toLowerCase(), this.magicCodeForTests)
    return { ok: true }
  }

  async authenticateWithMagicAuth(email: string, code: string): Promise<AuthResult> {
    const normalized = email.toLowerCase()
    const expected = this.magicCodes.get(normalized)
    if (!expected || expected !== code) {
      return { success: false, refreshed: false, reason: "authentication_failed" }
    }
    this.magicCodes.delete(normalized)

    // Auto-create the user the same way devLogin does so subsequent
    // authenticateSession calls find them. Key off the normalized address so a
    // case-only variant resolves to the same in-memory user that the magic
    // code was issued against, instead of forking a second record.
    const fakeWorkosUserId = `workos_test_${Buffer.from(normalized).toString("base64url")}`
    const existing = this.users.get(fakeWorkosUserId)
    const user = existing ?? {
      id: fakeWorkosUserId,
      email: normalized,
      firstName: normalized.split("@")[0] ?? null,
      lastName: null,
    }
    this.users.set(fakeWorkosUserId, user)

    return {
      success: true,
      user: { ...user, permissions: null },
      sealedSession: `test_session_${fakeWorkosUserId}`,
      refreshed: false,
    }
  }

  async getLogoutUrl(_sealedSession: string, returnTo?: string): Promise<string | null> {
    // Encode returnTo as a query param so tests can assert on it.
    if (returnTo) {
      const params = new URLSearchParams({ return_to: returnTo })
      return `/test-logged-out?${params.toString()}`
    }
    return "/test-logged-out"
  }
}
