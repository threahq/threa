import type { CookieOptions, Response } from "express"

export const parseCookies = (cookieHeader: string): Record<string, string> => {
  return cookieHeader.split(";").reduce(
    (acc, cookie) => {
      const [key, ...rest] = cookie.trim().split("=")
      const value = rest.join("=")
      if (key && value) {
        acc[key] = decodeURIComponent(value)
      }
      return acc
    },
    {} as Record<string, string>
  )
}

export type SessionCookieOptions = CookieOptions

export interface SessionCookieConfig {
  /** Deployment-scoped cookie name. Production uses `wos_session`. */
  name: string
  options: SessionCookieOptions
}

// Multi-account: one active session cookie plus up to MAX_ALT_SLOTS "parked"
// alt cookies. The cap is bounded by the Cloudflare Workers request-header
// limit (~32 KB total, ~16 KB per header) — the browser concatenates every
// cookie for the origin into a single `Cookie:` header, so that combined header
// is the binding constraint. We size conservatively from documented worst-case
// inputs (an empirical measurement is recorded in the PR); PR-5 may
// only relax MAX_ACCOUNTS upward with a fresh measurement.
const WORST_CASE_SEALED_BYTES = 3072
const PER_COOKIE_OVERHEAD_BYTES = 32
// Conservative reservation for session cookies within the single `Cookie:`
// header: 13 KB, ~81% of the ~16 KB (16384 B) Cloudflare per-header limit,
// leaving ~3 KB for any non-session cookies on the origin.
const CONSERVATIVE_COOKIE_HEADER_BUDGET = 13312
// Per cookie: 3072 + 32 = 3104 B. (1 active + 3 alts) · 3104 = 12416 B ≤ 13312 B
// budget; the next bump (MAX_ACCOUNTS=5 → 15520 B) trips the guard below.
// Source of truth (INV-33); MAX_ALT_SLOTS is always derived (INV-31).
export const MAX_ACCOUNTS = 4
export const MAX_ALT_SLOTS = MAX_ACCOUNTS - 1

// Fails the build if MAX_ACCOUNTS is bumped past the documented header budget.
if ((1 + MAX_ALT_SLOTS) * (WORST_CASE_SEALED_BYTES + PER_COOKIE_OVERHEAD_BYTES) > CONSERVATIVE_COOKIE_HEADER_BUDGET) {
  throw new Error(
    `[backend-common/cookies] MAX_ACCOUNTS=${MAX_ACCOUNTS} exceeds the conservative ` +
      `Cookie-header budget (${CONSERVATIVE_COOKIE_HEADER_BUDGET} B). Re-measure the ` +
      `sealed-session size before raising it.`
  )
}

export function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ALT_SLOTS) {
    throw new RangeError(`alt slot out of range: ${slot} (expected 0..${MAX_ALT_SLOTS - 1})`)
  }
}

function clearOptions(options: SessionCookieOptions): SessionCookieOptions {
  const { maxAge: _, ...rest } = options
  return rest
}

function hostOnlyOptions(options: SessionCookieOptions): SessionCookieOptions {
  const { domain: _, ...rest } = options
  return rest
}

// RFC 6265 cookie-name token: no whitespace, controls, or separators. Express
// throws when it serializes a bad name, which would land on a user's first
// login rather than at boot, so the constructor checks it up front.
const COOKIE_NAME = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/

/**
 * Reads and writes the WorkOS session cookies for one environment. Construct it
 * once at the composition root of a service that serves sessions (INV-13) and
 * pass it to collaborators; a process that never touches sessions never builds
 * one, and so never needs `SESSION_COOKIE_NAME` configured.
 */
export class SessionCookies {
  private readonly config: SessionCookieConfig

  constructor(config: SessionCookieConfig) {
    if (!COOKIE_NAME.test(config.name)) {
      throw new Error(
        `[backend-common/cookies] invalid session cookie name ${JSON.stringify(config.name)}; ` +
          "expected an RFC 6265 token (no whitespace, controls or separators)."
      )
    }
    this.config = config
  }

  get name(): string {
    return this.config.name
  }

  get defaultOptions(): SessionCookieOptions {
    return this.config.options
  }

  /** The active sealed session from an already-parsed cookie jar. */
  read(cookies: Record<string, string>): string | undefined {
    return cookies[this.config.name]
  }

  // Derived from the active cookie name so deployments sharing a parent domain
  // never name or read each other's alternate cookies.
  altName(slot: number): string {
    assertSlot(slot)
    return `${this.config.name}_alt_${slot}`
  }

  set(res: Response, session: string, options: SessionCookieOptions = this.config.options): void {
    this.setNamed(res, this.config.name, session, options)
  }

  clear(res: Response, options: SessionCookieOptions = this.config.options): void {
    this.clearNamed(res, this.config.name, options)
  }

  setAlt(res: Response, slot: number, session: string, options: SessionCookieOptions = this.config.options): void {
    this.setNamed(res, this.altName(slot), session, options)
  }

  clearAlt(res: Response, slot: number, options: SessionCookieOptions = this.config.options): void {
    this.clearNamed(res, this.altName(slot), options)
  }

  // Extract occupied alt slots from already-parsed cookies. Env-scoped: matches
  // exactly `${name}_alt_<n>`, so the active cookie and the other environment's
  // alt cookies are ignored. Returns slots sorted ascending.
  readAlts(cookies: Record<string, string>): Array<{ slot: number; sealed: string }> {
    const prefix = `${this.config.name}_alt_`
    const result: Array<{ slot: number; sealed: string }> = []
    for (const [name, value] of Object.entries(cookies)) {
      if (!name.startsWith(prefix) || !value) continue
      const slotStr = name.slice(prefix.length)
      if (!/^\d+$/.test(slotStr)) continue
      const slot = Number(slotStr)
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ALT_SLOTS) continue
      // `_alt_01` parses to slot 1; without this a jar holding both spellings
      // would yield the same slot twice and park two sessions in one place.
      if (name !== this.altName(slot)) continue
      result.push({ slot, sealed: value })
    }
    return result.sort((a, b) => a.slot - b.slot)
  }

  private setNamed(res: Response, name: string, value: string, options: SessionCookieOptions): void {
    if (options.domain) {
      res.clearCookie(name, clearOptions(hostOnlyOptions(options)))
    }
    res.cookie(name, value, options)
  }

  private clearNamed(res: Response, name: string, options: SessionCookieOptions): void {
    res.clearCookie(name, clearOptions(options))
    if (options.domain) {
      res.clearCookie(name, clearOptions(hostOnlyOptions(options)))
    }
  }
}

/** INV-11: a service that serves sessions must configure its cookie name. */
export function sessionCookieConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SessionCookieConfig {
  const name = env.SESSION_COOKIE_NAME
  if (!name) {
    throw new Error(
      "[backend-common/cookies] SESSION_COOKIE_NAME is required for a service that serves sessions " +
        "(production uses 'wos_session')."
    )
  }
  return {
    name,
    options: {
      path: "/",
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax" as const,
      maxAge: 60 * 60 * 24 * 30 * 1000, // 30 days
      // Honor COOKIE_DOMAIN whenever it is set so application subdomains share
      // the active session.
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    },
  }
}
