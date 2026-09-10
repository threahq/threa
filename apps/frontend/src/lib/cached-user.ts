import type { User } from "@/auth/types"

// The session credential is the httpOnly WorkOS cookie — never these values.
// We cache only the display identity so a returning user renders instantly
// from local state while `/api/auth/me` revalidates in the background.
//
// One browser can hold several signed-in accounts, so identities are stored
// per WorkOS user id and an explicit pointer names the active one. A single
// shared record would hand the previous account's name and email to the next
// one for as long as revalidation takes.
const IDENTITY_PREFIX = "threa-account-identity"
const ACTIVE_KEY = "threa-active-account"

// Pre-multi-account single-record format. It carries its own `id`, so reading
// it attributes an owner from the record itself rather than guessing; it is
// dropped the first time that account's identity is written in the new format.
const LEGACY_KEY = "threa-cached-user"

function identityKey(workosUserId: string): string {
  return `${IDENTITY_PREFIX}:${workosUserId}`
}

function parseUser(raw: string | null): User | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<User>
    if (typeof parsed?.id !== "string" || typeof parsed?.email !== "string" || typeof parsed?.name !== "string") {
      return null
    }
    return { id: parsed.id, email: parsed.email, name: parsed.name }
  } catch {
    return null
  }
}

function readLegacy(): User | null {
  try {
    return parseUser(localStorage.getItem(LEGACY_KEY))
  } catch {
    return null
  }
}

/** The account whose session cookie this browser last saw as active. */
export function getActiveAccountId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? readLegacy()?.id ?? null
  } catch {
    return null
  }
}

export function setActiveAccountId(workosUserId: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, workosUserId)
  } catch {
    // Storage unavailable — degrade to network-first auth, no crash.
  }
}

/** The cached display identity for one account, or null when unknown here. */
export function getCachedIdentity(workosUserId: string): User | null {
  try {
    const stored = parseUser(localStorage.getItem(identityKey(workosUserId)))
    if (stored) return stored
    const legacy = readLegacy()
    return legacy && legacy.id === workosUserId ? legacy : null
  } catch {
    return null
  }
}

export function setCachedIdentity(user: User): void {
  try {
    localStorage.setItem(identityKey(user.id), JSON.stringify({ id: user.id, email: user.email, name: user.name }))
    if (readLegacy()?.id === user.id) localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Storage unavailable
  }
}

/** Forget one account's identity (that account signed out). */
export function clearCachedIdentity(workosUserId: string): void {
  try {
    localStorage.removeItem(identityKey(workosUserId))
    if (localStorage.getItem(ACTIVE_KEY) === workosUserId) localStorage.removeItem(ACTIVE_KEY)
    if (readLegacy()?.id === workosUserId) localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Storage unavailable
  }
}

/** Forget every account's identity (sign out of all accounts on this browser). */
export function clearAllCachedIdentities(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === ACTIVE_KEY || key === LEGACY_KEY || key.startsWith(`${IDENTITY_PREFIX}:`)) {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Storage unavailable
  }
}
