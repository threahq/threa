import { createContext, useCallback, useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { API_BASE } from "@/api/client"
import { clearAllCachedData } from "@/db"
import { getCachedUser, setCachedUser, clearCachedUser } from "@/lib/cached-user"
import { clearLastWorkspaceId } from "@/lib/last-workspace"
import type { AuthState, User } from "./types"

declare global {
  interface Window {
    __eagerAuthPromise?: Promise<User | null>
  }
}

interface AuthContextValue extends AuthState {
  login: (redirectTo?: string, opts?: { intent?: "add" }) => void
  /**
   * Log out of one or all accounts on this browser. `scope: "current"` revokes
   * just the active session and promotes a parked alt (the user stays signed
   * in to the next account). Default `"all"` empties the local cookie jar of
   * every signed-in account on this browser (parked WorkOS sessions stay
   * intact server-side — explicit revoke is the `/api/accounts/remove` path).
   */
  logout: (opts?: { scope?: "current" | "all" }) => void
  refetch: () => Promise<void>
}

// The OAuth add-account callback appends this when every alt slot is full
// (control plane returns it gracefully rather than erroring mid-flight).
const ACCOUNT_ERROR_PARAM = "accountError"
const MAX_ACCOUNTS_REACHED = "MAX_ACCOUNTS_REACHED"

// A successful add-account redirect carries this (control plane sends the
// browser to /workspaces?accountAdded=1 so the app drops its stale
// last-workspace pointer instead of routing back into the old account).
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

export const AuthContext = createContext<AuthContextValue | null>(null)

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  // Render instantly from the cached display identity (the httpOnly cookie is
  // still the credential — this is display-only). `loading` stays true only
  // for a genuinely cold first visit so the app doesn't gate on the network.
  const [state, setState] = useState<AuthState>(() => {
    const cachedUser = getCachedUser()
    return { user: cachedUser, loading: !cachedUser, error: null }
  })

  const fetchUser = useCallback(async () => {
    // A 401 is the only authoritative "you are signed out" signal: clear the
    // cached identity and drop to the login redirect.
    const onUnauthenticated = () => {
      clearCachedUser()
      setState({ user: null, loading: false, error: null })
    }
    // Network failure / timeout / 5xx during background revalidation must not
    // sign a returning user out — keep the cached identity so the app stays
    // usable offline. Only a cold visit with no cache falls through to login.
    const onRevalidateFailure = (message: string) => {
      const cachedUser = getCachedUser()
      setState({
        user: cachedUser,
        loading: false,
        error: cachedUser ? null : message,
      })
    }

    try {
      // Consume the eager auth promise started in index.html before the bundle
      // loaded. It resolves to the User, or null on 401; it rejects on network
      // error / 5xx, in which case we fall through to a fresh, bounded fetch.
      const eagerPromise = window.__eagerAuthPromise
      if (eagerPromise) {
        window.__eagerAuthPromise = undefined
        try {
          const user = await eagerPromise
          if (user) {
            setCachedUser(user)
            setState({ user, loading: false, error: null })
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

      if (res.status === 401) {
        onUnauthenticated()
        return
      }

      if (!res.ok) {
        throw new Error("Failed to fetch user")
      }

      const user: User = await res.json()
      setCachedUser(user)
      setState({ user, loading: false, error: null })
    } catch (err) {
      onRevalidateFailure(err instanceof Error ? err.message : "Unknown error")
    }
  }, [])

  useEffect(() => {
    fetchUser()
  }, [fetchUser])

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

    // A successful add makes the just-added account the active session. The
    // last-workspace pointer still names the *previous* account's workspace;
    // clearing it stops RootRedirect from routing into a workspace the new
    // account can't see (which 403s and bounces back to the old account).
    if (params.get(ACCOUNT_ADDED_PARAM) === "1") {
      clearLastWorkspaceId()
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
    clearCachedUser()
    clearLastWorkspaceId()
    // `clearAllCachedData` uses the active-account `db` proxy, so it drops
    // exactly the current account's IDB. Promoted-account IDB (a separate
    // named handle) is untouched, which is what scope=current wants.
    await clearAllCachedData().catch(() => {})
    window.location.href =
      scope === "current" ? `${API_BASE}/api/auth/logout?scope=current` : `${API_BASE}/api/auth/logout`
  }, [])

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    refetch: fetchUser,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
