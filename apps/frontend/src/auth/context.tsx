import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { API_BASE } from "@/api/client"
import { clearAllCachedData } from "@/db"
import {
  clearAllCachedIdentities,
  clearCachedIdentity,
  getActiveAccountId,
  getCachedIdentity,
  setActiveAccountId,
  setCachedIdentity,
} from "@/lib/cached-user"
import { clearAllLastWorkspaceIds, clearLastWorkspaceId } from "@/lib/last-workspace"
import { PUSH_BOOTSTRAP_CACHE } from "@/lib/sw-bootstrap-prefetch"
import { suspendConnectivityDiagnostics } from "@/lib/connectivity-diagnostics/facade"
import type { AuthState, User } from "./types"

declare global {
  interface Window {
    __eagerAuthPromise?: Promise<User | null>
  }
}

interface AuthContextValue extends AuthState {
  /**
   * The account this browser is signed in as right now — authoritative from
   * the moment a switch commits, before its identity record has resolved.
   * `user` is that account's display identity, or null while it is still
   * unknown here; it is never a different account's.
   */
  activeWorkosUserId: string | null
  login: (redirectTo?: string, opts?: { intent?: "add" }) => void
  /**
   * Log out of one or all accounts on this browser. `scope: "current"` revokes
   * just the active session and promotes a parked alt (the user stays signed
   * in to the next account). Default `"all"` empties the local cookie jar of
   * every signed-in account on this browser (parked WorkOS sessions stay
   * intact server-side — explicit revoke is the `/api/accounts/remove` path).
   */
  logout: (opts?: { scope?: "current" | "all" }) => void
  /**
   * Adopt a different account as the active one. The caller has already made
   * it active server-side (`/api/accounts/switch`) or observed another tab do
   * so. `identity` is the destination's display identity when the caller
   * already holds it (the switcher's account list), so the first paint after
   * the flip is already the destination's; without it the account renders
   * unresolved until `/api/auth/me` answers, never as the outgoing account.
   */
  activateAccount: (workosUserId: string, identity?: User | null) => void
  refetch: () => Promise<void>
}

// The OAuth add-account callback appends this when every alt slot is full
// (control plane returns it gracefully rather than erroring mid-flight).
const ACCOUNT_ERROR_PARAM = "accountError"
const MAX_ACCOUNTS_REACHED = "MAX_ACCOUNTS_REACHED"

// A successful add-account redirect carries this (control plane sends the
// browser to /workspaces?accountAdded=1). The pointer it used to invalidate is
// now per-account, so nothing needs clearing — it marks the one boot where the
// last-active pointer must not be trusted (see `isAccountAddedReturn`), and is
// then stripped so a refresh doesn't keep it in the URL.
const ACCOUNT_ADDED_PARAM = "accountAdded"

// Best-effort push cleanup must never delay the logout redirect for long.
// When the SW is healthy this completes in well under a second; the cap only
// fires when `serviceWorker.ready` never settles (stranded worker).
const PUSH_CLEANUP_TIMEOUT_MS = 2000

// Identity revalidation is a background refresh — the UI already rendered from
// the cached user — so its only job here is to never leak a hung request on a
// dead network. Generous because it never blocks first paint. The eager
// pre-bundle fetch in index.html bounds itself with the same value as a raw
// 15000 (it can't import this constant) — keep the two in sync.
const AUTH_REVALIDATE_TIMEOUT_MS = 15000

function isAccountAddedReturn(): boolean {
  return new URLSearchParams(window.location.search).get(ACCOUNT_ADDED_PARAM) === "1"
}

export const AuthContext = createContext<AuthContextValue | null>(null)

interface AuthProviderProps {
  children: ReactNode
}

interface AccountSession extends AuthState {
  activeWorkosUserId: string | null
}

export function AuthProvider({ children }: AuthProviderProps) {
  // Render instantly from the active account's cached display identity (the
  // httpOnly cookie is still the credential — this is display-only).
  // `loading` stays true while the active account has no identity yet, so a
  // genuinely cold first visit and an account whose identity this browser has
  // never seen both wait rather than showing someone else.
  const [state, setState] = useState<AccountSession>(() => {
    // The add-account return is the one entry where the credential is known to
    // have changed out of band, so this browser's last-active pointer is stale
    // by construction. Start unresolved and let `/api/auth/me` name the
    // account, rather than mounting the outgoing account's storage scope under
    // the account that was just added.
    if (isAccountAddedReturn()) {
      return { activeWorkosUserId: null, user: null, loading: true, error: null }
    }
    const activeWorkosUserId = getActiveAccountId()
    const user = activeWorkosUserId ? getCachedIdentity(activeWorkosUserId) : null
    return { activeWorkosUserId, user, loading: !user, error: null }
  })

  // Revalidation is only ever allowed to publish the account it was issued
  // for. `generation` retires every in-flight `/api/auth/me` the moment the
  // active account changes (a response from before a switch would otherwise
  // reinstate the outgoing account); `expectedId` additionally refuses a
  // response naming an account we did not activate, so a cookie that has not
  // caught up leaves the destination unresolved instead of rolling back.
  const generationRef = useRef(0)
  const expectedIdRef = useRef<string | null>(null)
  const activeIdRef = useRef<string | null>(state.activeWorkosUserId)
  activeIdRef.current = state.activeWorkosUserId

  const fetchUser = useCallback(async () => {
    const generation = generationRef.current

    // A 401 is the only authoritative "you are signed out" signal: forget the
    // active account's cached identity and drop to the login redirect. Other
    // accounts parked on this browser keep theirs.
    const onUnauthenticated = () => {
      const active = activeIdRef.current
      if (active) clearCachedIdentity(active)
      expectedIdRef.current = null
      setState({ activeWorkosUserId: null, user: null, loading: false, error: null })
    }
    // Network failure / timeout / 5xx during background revalidation must not
    // sign a returning user out — keep the cached identity so the app stays
    // usable offline. Only a visit with no cached identity for the active
    // account falls through to login.
    const onRevalidateFailure = (message: string) => {
      const active = activeIdRef.current
      const user = active ? getCachedIdentity(active) : null
      setState({
        activeWorkosUserId: active,
        user,
        loading: false,
        error: user ? null : message,
      })
    }
    const onResolved = (user: User) => {
      setCachedIdentity(user)
      // Server named an account we did not activate: keep the destination
      // unresolved rather than publishing an identity the local scope does not
      // belong to. The fetch `activateAccount` issues after the switch is the
      // one that resolves it.
      if (expectedIdRef.current && expectedIdRef.current !== user.id) return
      expectedIdRef.current = null
      setActiveAccountId(user.id)
      setState({ activeWorkosUserId: user.id, user, loading: false, error: null })
    }
    const isStale = () => generationRef.current !== generation

    try {
      // Consume the eager auth promise started in index.html before the bundle
      // loaded. It resolves to the User, or null on 401; it rejects on network
      // error / 5xx, in which case we fall through to a fresh, bounded fetch.
      const eagerPromise = window.__eagerAuthPromise
      if (eagerPromise) {
        window.__eagerAuthPromise = undefined
        try {
          const user = await eagerPromise
          if (isStale()) return
          if (user) {
            onResolved(user)
          } else {
            onUnauthenticated()
          }
          return
        } catch {
          // Eager fetch failed — fall through to regular fetch
        }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), AUTH_REVALIDATE_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(`${API_BASE}/api/auth/me`, {
          credentials: "include",
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }

      if (isStale()) return

      if (res.status === 401) {
        onUnauthenticated()
        return
      }

      if (!res.ok) {
        throw new Error("Failed to fetch user")
      }

      const user: User = await res.json()
      if (isStale()) return
      onResolved(user)
    } catch (err) {
      if (isStale()) return
      onRevalidateFailure(err instanceof Error ? err.message : "Unknown error")
    }
  }, [])

  useEffect(() => {
    fetchUser()
  }, [fetchUser])

  const activateAccount = useCallback(
    (workosUserId: string, identity?: User | null) => {
      generationRef.current += 1
      expectedIdRef.current = workosUserId
      const hint = identity && identity.id === workosUserId ? identity : null
      const known = hint ?? getCachedIdentity(workosUserId)
      if (hint) setCachedIdentity(hint)
      setActiveAccountId(workosUserId)
      setState({ activeWorkosUserId: workosUserId, user: known, loading: !known, error: null })
      void fetchUser()
    },
    [fetchUser]
  )

  // AuthProvider sits above the router, so the add-account callback outcome
  // can't be read via useSearchParams. Handle it once on mount and strip the
  // param so a refresh doesn't re-fire.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    let changed = false

    if (params.get(ACCOUNT_ERROR_PARAM) === MAX_ACCOUNTS_REACHED) {
      toast.error("You're signed in to the maximum number of accounts. Remove one to add another.")
      params.delete(ACCOUNT_ERROR_PARAM)
      changed = true
    }

    if (params.get(ACCOUNT_ADDED_PARAM) === "1") {
      params.delete(ACCOUNT_ADDED_PARAM)
      changed = true
    }

    if (!changed) return
    const query = params.toString()
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
    )
  }, [])

  const login = useCallback((redirectTo?: string, opts?: { intent?: "add" }) => {
    // The add-account flow hands off to the in-app picker first — AuthKit's
    // hosted UI silent-refreshes through its own session cookie, so the only
    // reliable way to add a *different* account is to bypass AuthKit. The
    // picker exposes provider-direct social buttons and a Magic Auth fallback.
    // Plain sign-in still goes straight to `/api/auth/login`.
    if (opts?.intent === "add") {
      const query = new URLSearchParams()
      if (redirectTo) query.set("redirect_to", redirectTo)
      const qs = query.toString()
      window.location.href = `/add-account${qs ? `?${qs}` : ""}`
      return
    }
    const query = new URLSearchParams()
    if (redirectTo) query.set("redirect_to", redirectTo)
    const qs = query.toString()
    window.location.href = `${API_BASE}/api/auth/login${qs ? `?${qs}` : ""}`
  }, [])

  const logout = useCallback(async (opts?: { scope?: "current" | "all" }) => {
    const scope = opts?.scope ?? "all"
    suspendConnectivityDiagnostics()
    // Clean up push subscriptions on logout:
    // 1. Tell backend to remove all records for this browser's endpoint (cross-workspace)
    // 2. Unsubscribe from the browser push service to prevent post-logout notifications
    //
    // `navigator.serviceWorker.ready` only resolves once a worker is active and
    // never rejects, so a worker stranded in "installing" (common with the dev
    // injectManifest module SW) would hang this step — and the redirect below —
    // forever. Cap the whole best-effort block so logout always proceeds.
    //
    // The push subscription is a per-browser endpoint shared across accounts,
    // so cleaning it up belongs to both scopes — we don't want post-logout
    // notifications for an account the user just signed out of either way.
    const pushCleanup = (async () => {
      const registration = await navigator.serviceWorker?.ready
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        await fetch(`${API_BASE}/api/push/cleanup-endpoint`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {})
        await subscription.unsubscribe()
      }
    })()
    await Promise.race([
      pushCleanup,
      new Promise<void>((resolve) => setTimeout(resolve, PUSH_CLEANUP_TIMEOUT_MS)),
    ]).catch(() => {})
    const active = activeIdRef.current
    if (scope === "current") {
      if (active) {
        clearCachedIdentity(active)
        clearLastWorkspaceId(active)
      }
    } else {
      clearAllCachedIdentities()
      clearAllLastWorkspaceIds()
    }
    // `clearAllCachedData` uses the active-account `db` proxy, so it drops
    // exactly the current account's IDB. Promoted-account IDB (a separate
    // named handle) is untouched, which is what scope=current wants.
    await clearAllCachedData().catch(() => {})
    // The service worker's pre-fetched workspace snapshots are per account, so
    // with this account's IDB empty the next sign-in has no local state and
    // would accept its own leftover copy as fresh. Drop the whole cache: the
    // entries are a warm-start optimization, refetched on demand.
    if (typeof caches !== "undefined") await caches.delete(PUSH_BOOTSTRAP_CACHE).catch(() => {})
    window.location.href =
      scope === "current" ? `${API_BASE}/api/auth/logout?scope=current` : `${API_BASE}/api/auth/logout`
  }, [])

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    activateAccount,
    refetch: fetchUser,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
