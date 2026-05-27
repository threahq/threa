import type { Response } from "express"
import {
  HttpError,
  MAX_ACCOUNTS,
  MAX_ALT_SLOTS,
  clearAltSessionCookie,
  clearSessionCookie,
  displayNameFromWorkos,
  pickSealed,
  readAltSessionCookies,
  setAltSessionCookie,
  setSessionCookie,
  type AuthService,
} from "@threa/backend-common"

/**
 * One account as seen by the multi-account switcher.
 *
 * `id` is a stable opaque identifier — for live accounts it is the WorkOS user
 * id; for an alt whose sealed session failed validation it is
 * `stale:alt_<slot>` (the raw slot index never crosses the wire). `state` is a
 * single discriminant because the three states are mutually exclusive: the
 * active account is always validated upstream by the `auth` middleware, so an
 * `active && stale` combination is structurally impossible.
 */
export interface AccountSummary {
  id: string
  email: string
  name: string
  state: "active" | "parked" | "stale"
}

interface ActiveUser {
  id: string
  email: string
  firstName: string | null
  lastName: string | null
}

interface ResolvedAlt {
  slot: number
  sealed: string
  ok: boolean
  user?: { id: string; email: string; firstName: string | null; lastName: string | null }
}

/**
 * Membership source of truth. `ControlPlaneWorkspaceService` already
 * structurally satisfies this via its existing `isMember`; injecting the
 * narrow shape (not the concrete service) keeps the cross-feature coupling a
 * single in-process method, not a backend HTTP hop.
 */
interface MembershipChecker {
  isMember(workspaceId: string, workosUserId: string): Promise<boolean>
}

interface Dependencies {
  authService: AuthService
  membership: MembershipChecker
}

const STALE_ID_RE = /^stale:alt_(\d+)$/

export class AccountsService {
  private authService: AuthService
  private membership: MembershipChecker

  constructor({ authService, membership }: Dependencies) {
    this.authService = authService
    this.membership = membership
  }

  // Validate every parked alt cookie in parallel (never a serial loop). A
  // slot whose sealed session fails validation comes back `ok:false` and is
  // reclaimable on the next write (self-heals corrupt/expired alts).
  //
  // WorkOS access tokens are short-lived and `session.refresh()` rotates the
  // refresh token — the pre-refresh sealed value is dead the moment refresh
  // runs. We MUST write the rotated sealed back to the alt cookie and surface
  // it to callers; otherwise a switcher view (or any GET that calls this) kills
  // the parked session for good. Mirrors what `createAuthMiddleware` already
  // does for the active cookie.
  private async resolveAlts(res: Response, cookies: Record<string, string>): Promise<ResolvedAlt[]> {
    const alts = readAltSessionCookies(cookies)
    const auths = await Promise.all(alts.map((a) => this.authService.authenticateSession(a.sealed)))
    return alts.map((a, i) => {
      const r = auths[i]
      if (!r.success || !r.user) {
        return { slot: a.slot, sealed: a.sealed, ok: false }
      }
      const sealed = pickSealed(r, a.sealed)
      if (sealed !== a.sealed) {
        setAltSessionCookie(res, a.slot, sealed)
      }
      return { slot: a.slot, sealed, ok: true, user: r.user }
    })
  }

  /**
   * OAuth add-account: make the freshly authenticated session active and park
   * the previous active session into a free alt slot. Idempotent — a re-auth
   * of the still-active account or one already parked coalesces in place
   * (no slot consumed), and a slot whose cookie failed validation is
   * reclaimed. Returns `MAX_ACCOUNTS_REACHED` instead of throwing when every
   * slot holds a distinct valid account, so the OAuth callback can 302
   * gracefully rather than render an error page mid-flight.
   */
  async addAndParkActive(
    res: Response,
    cookies: Record<string, string>,
    prevActiveSealed: string | undefined,
    newSealed: string,
    newUserId: string
  ): Promise<{ ok: true } | { ok: false; code: "MAX_ACCOUNTS_REACHED" }> {
    // No prior session — treat as a normal first login (no slot consumed).
    if (!prevActiveSealed) {
      setSessionCookie(res, newSealed)
      return { ok: true }
    }

    const prevAuth = await this.authService.authenticateSession(prevActiveSealed)
    // Prev cookie no longer valid, or a re-auth of the same account: there is
    // nothing worth parking — just replace the active session in place.
    if (!prevAuth.success || !prevAuth.user || prevAuth.user.id === newUserId) {
      setSessionCookie(res, newSealed)
      return { ok: true }
    }

    // If WorkOS rotated the prev session while we were validating it, the
    // pre-refresh sealed is now revoked. Park the rotated value so the slot
    // doesn't hold a dead token.
    const prevSealedToPark = pickSealed(prevAuth, prevActiveSealed)

    const alts = await this.resolveAlts(res, cookies)
    const validAlts = alts.filter((a) => a.ok && a.user)

    // The new account is already parked: promote it, park the previous active
    // into the slot it vacated, and clear any duplicate slots of the new user.
    const existing = validAlts.find((a) => a.user?.id === newUserId)
    if (existing) {
      setSessionCookie(res, newSealed)
      setAltSessionCookie(res, existing.slot, prevSealedToPark)
      for (const a of validAlts) {
        if (a.slot !== existing.slot && a.user?.id === newUserId) {
          clearAltSessionCookie(res, a.slot)
        }
      }
      return { ok: true }
    }

    // Lowest free slot. A slot whose cookie failed validation is reclaimable
    // (not "occupied"), self-healing corrupt/expired alts.
    const occupied = new Set(validAlts.map((a) => a.slot))
    let freeSlot = -1
    for (let s = 0; s < MAX_ALT_SLOTS; s++) {
      if (!occupied.has(s)) {
        freeSlot = s
        break
      }
    }
    if (freeSlot === -1) {
      // Every slot holds a distinct valid account — adding would exceed
      // MAX_ACCOUNTS. Refuse gracefully; the prev-active cookie is untouched.
      return { ok: false, code: "MAX_ACCOUNTS_REACHED" }
    }

    setAltSessionCookie(res, freeSlot, prevSealedToPark)
    setSessionCookie(res, newSealed)
    return { ok: true }
  }

  async list(
    res: Response,
    cookies: Record<string, string>,
    activeUser: ActiveUser
  ): Promise<{ accounts: AccountSummary[]; maxAccounts: number }> {
    const accounts: AccountSummary[] = [
      {
        id: activeUser.id,
        email: activeUser.email,
        name: displayNameFromWorkos(activeUser),
        state: "active",
      },
    ]

    // Coalesce on read: hide any alt that resolves to the active account or to
    // an account already surfaced by an earlier (lower) slot. Slot
    // reconciliation (clearing coalesced duplicates) is still deferred to the
    // next write, but `resolveAlts` does write rotated sealed values back when
    // WorkOS refreshes during validation — without that the parked session
    // would be revoked the instant the switcher view triggered a refresh.
    const seen = new Set<string>([activeUser.id])
    for (const alt of await this.resolveAlts(res, cookies)) {
      if (alt.ok && alt.user) {
        if (seen.has(alt.user.id)) continue
        seen.add(alt.user.id)
        accounts.push({
          id: alt.user.id,
          email: alt.user.email,
          name: displayNameFromWorkos(alt.user),
          state: "parked",
        })
      } else {
        accounts.push({ id: `stale:alt_${alt.slot}`, email: "", name: "", state: "stale" })
      }
    }

    return { accounts, maxAccounts: MAX_ACCOUNTS }
  }

  /**
   * Cross-account entry resolver. Given an entry point that may belong to a
   * *parked* account, return which signed-in account owns it so the caller
   * can flip in place. Two mutually exclusive forms:
   *
   * - **Identity** (`userId`, the notification primitive): resolve to *that
   *   exact* account and never substitute a different signed-in account that
   *   merely also has read access. Not signed in here -> 404
   *   `ACCOUNT_NOT_SIGNED_IN` (caller does a full login as that user). A
   *   `workspaceId` is checked as defence-in-depth against a stale
   *   notification for an account since removed from the workspace.
   * - **Bare workspace link** (`workspaceId` only): membership is the only
   *   selector and can be ambiguous, so resolve *only if exactly one*
   *   signed-in account is a member; 0 or 2+ -> 404
   *   `WORKSPACE_NOT_RESOLVABLE` (caller keeps its bounce; the switcher
   *   disambiguates the multi-member case).
   *
   * Active id first, then alts in slot order; coalesced alts repeating an
   * already-seen id are de-duped; stale alts (failed validation) skipped.
   */
  async resolve(
    res: Response,
    cookies: Record<string, string>,
    activeUser: ActiveUser,
    q: { userId?: string; workspaceId?: string }
  ): Promise<{ ownerUserId: string }> {
    const alts = await this.resolveAlts(res, cookies)
    const seen = new Set<string>()
    const signedInIds: string[] = []
    for (const id of [activeUser.id, ...alts.flatMap((a) => (a.ok && a.user ? [a.user.id] : []))]) {
      if (seen.has(id)) continue
      seen.add(id)
      signedInIds.push(id)
    }

    if (q.userId) {
      if (!signedInIds.includes(q.userId)) {
        throw new HttpError("Account not signed in on this browser", {
          status: 404,
          code: "ACCOUNT_NOT_SIGNED_IN",
        })
      }
      if (q.workspaceId && !(await this.membership.isMember(q.workspaceId, q.userId))) {
        throw new HttpError("Account can no longer access this workspace", {
          status: 404,
          code: "WORKSPACE_NOT_RESOLVABLE",
        })
      }
      return { ownerUserId: q.userId }
    }

    // Zod refine guarantees one of the two query params is present.
    const wid = q.workspaceId!
    const flags = await Promise.all(signedInIds.map((id) => this.membership.isMember(wid, id)))
    const members = signedInIds.filter((_, i) => flags[i])
    if (members.length !== 1) {
      throw new HttpError("No unique signed-in account can access this workspace", {
        status: 404,
        code: "WORKSPACE_NOT_RESOLVABLE",
      })
    }
    return { ownerUserId: members[0] }
  }

  async switch(
    res: Response,
    cookies: Record<string, string>,
    activeSealed: string,
    activeUser: ActiveUser,
    targetUserId: string
  ): Promise<{ activeUserId: string }> {
    if (targetUserId === activeUser.id) {
      throw new HttpError("Account is already active", { status: 409, code: "ALREADY_ACTIVE" })
    }

    const alts = await this.resolveAlts(res, cookies)
    const target = alts.find((a) => a.ok && a.user?.id === targetUserId)
    if (!target || !target.user) {
      throw new HttpError("Account not found", { status: 404, code: "ACCOUNT_NOT_FOUND" })
    }

    // Deterministic Set-Cookie order so a mid-flight failure never strands a
    // session: promote target (using the latest sealed `resolveAlts` returned,
    // not the pre-refresh value the browser sent), park the old active into
    // the slot the target just vacated (always free), then drop any duplicate
    // slots. `activeSealed` is whatever the auth middleware surfaced — that's
    // the rotated value when this request triggered a refresh.
    setSessionCookie(res, target.sealed)
    setAltSessionCookie(res, target.slot, activeSealed)
    for (const alt of alts) {
      if (alt.slot === target.slot || !alt.ok || !alt.user) continue
      if (alt.user.id === targetUserId || alt.user.id === activeUser.id) {
        clearAltSessionCookie(res, alt.slot)
      }
    }

    return { activeUserId: targetUserId }
  }

  async remove(
    res: Response,
    cookies: Record<string, string>,
    activeSealed: string,
    activeUser: ActiveUser,
    targetUserId: string
  ): Promise<{ removedId: string }> {
    const staleMatch = STALE_ID_RE.exec(targetUserId)
    if (staleMatch) {
      const slot = Number(staleMatch[1])
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ALT_SLOTS) {
        throw new HttpError("Account not found", { status: 404, code: "ACCOUNT_NOT_FOUND" })
      }
      // The sealed session already failed validation — nothing to revoke.
      clearAltSessionCookie(res, slot)
      return { removedId: targetUserId }
    }

    const alts = await this.resolveAlts(res, cookies)

    if (targetUserId === activeUser.id) {
      // Removing the active account: kill its WorkOS session for real, plus
      // any duplicate alt slots holding the same account, then promote the
      // lowest-slot remaining distinct account (or full logout if none).
      const dups = alts.filter((a) => a.ok && a.user?.id === activeUser.id)
      await Promise.all([
        this.authService.revokeSession(activeSealed),
        ...dups.map((dup) => this.authService.revokeSession(dup.sealed)),
      ])
      clearSessionCookie(res)
      for (const dup of dups) clearAltSessionCookie(res, dup.slot)

      const promote = alts
        .filter((a) => a.ok && a.user && a.user.id !== activeUser.id)
        .sort((a, b) => a.slot - b.slot)[0]
      if (promote) {
        setSessionCookie(res, promote.sealed)
        clearAltSessionCookie(res, promote.slot)
      } else {
        // No survivor — clear every parked alt so nothing is stranded.
        for (const alt of alts) clearAltSessionCookie(res, alt.slot)
      }

      return { removedId: activeUser.id }
    }

    const matches = alts.filter((a) => a.ok && a.user?.id === targetUserId)
    if (matches.length === 0) {
      throw new HttpError("Account not found", { status: 404, code: "ACCOUNT_NOT_FOUND" })
    }
    await Promise.all(matches.map((m) => this.authService.revokeSession(m.sealed)))
    for (const m of matches) clearAltSessionCookie(res, m.slot)

    return { removedId: targetUserId }
  }

  /**
   * "Sign out of just the current account, stay signed in to others" — revokes
   * the active WorkOS session and promotes the lowest parked alt to active.
   * Reuses the existing `remove(active)` orchestration (revoke + cookie writes)
   * and adds the rotation-aware sealed pick the handler can't do alone.
   *
   * Returns `false` without touching cookies when the call is a no-op (no
   * session, no parked alt to promote, or the session can't be authenticated)
   * so the caller can fall through to a normal full-logout flow that hits
   * `getLogoutUrl` for the SSO round-trip.
   */
  async removeCurrentAndPromote(
    res: Response,
    cookies: Record<string, string>,
    activeSealed: string | undefined
  ): Promise<boolean> {
    if (!activeSealed) return false
    const auth = await this.authService.authenticateSession(activeSealed)
    if (!auth.success || !auth.user) return false
    const activeUser = auth.user
    // Stale or duplicate-of-active alts can't be promoted. If we proceeded
    // anyway, `remove` would revoke the active session and clear cookies
    // without ever hitting the SSO logout round-trip — the live WorkOS
    // session would survive. Bail so the caller takes the full-logout path.
    const alts = await this.resolveAlts(res, cookies)
    const promotable = alts.some((a) => a.ok && a.user && a.user.id !== activeUser.id)
    if (!promotable) return false
    // WorkOS may have rotated the refresh token during authenticate; pass the
    // post-refresh sealed into `remove` so `revokeSession` kills the live
    // session, not the already-dead pre-refresh value the browser sent.
    await this.remove(res, cookies, pickSealed(auth, activeSealed), activeUser, activeUser.id)
    return true
  }
}
