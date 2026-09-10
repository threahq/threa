import { useEffect } from "react"
import { accountsApi } from "@/api"
import { ApiError } from "@/api/client"
import { useAccountScope } from "@/auth/account-scope"
import { useAuth } from "@/auth"
import { setNotificationIntent, subscribeNotificationIntent, takeNotificationIntent } from "@/lib/notification-intent"

/**
 * Cross-account notification-click handler. A push for a *parked* account
 * carries that account's WorkOS user id; `main.tsx` stashes it (keyed to the
 * workspace) and navigates the deep link, so on mount the URL is already
 * correct but the active account may be the wrong one.
 *
 * This hook reads the one-shot intent and, if it names a different account,
 * asks the control plane (identity `resolve` form) which signed-in account
 * owns it, then flips in place (PR-4a `switchAccount`). The keyed remount
 * re-bootstraps the same `workspaceId` under the owning account — no
 * navigation here (`main.tsx` already navigated; the module-singleton router's
 * location survives the remount).
 *
 * - intent === active account, or no intent -> no-op (common case).
 * - 404 `ACCOUNT_NOT_SIGNED_IN`: that account isn't on this browser -> full
 *   re-auth that lands back on the deep link.
 * - other resolve errors (network / `WORKSPACE_NOT_RESOLVABLE`) -> benign
 *   no-op; `useResolveOrBounce` is the safety net for the already-navigated
 *   URL.
 *
 * The intent is read on mount *and* whenever one is set afterwards: a click on
 * a notification for the workspace already on screen navigates within the same
 * mounted layout, so a mount-only read would leave that deep link open under
 * the outgoing account. The intent is one-shot (`takeNotificationIntent`
 * clears it), so neither entry can re-trigger; a disposed flag drops a late
 * resolve after unmount or workspace change. If the effect tears down before
 * an attempt settles (StrictMode's throwaway first mount, or a fast unmount),
 * the cleanup hands the unconsumed intent back so the retained mount still
 * sees it. Mirrors `useResolveOrBounce`.
 */
export function useNotificationAccountSwitch(workspaceId: string): void {
  const { switchAccount, activeWorkosUserId } = useAccountScope()
  const { login } = useAuth()

  useEffect(() => {
    let disposed = false
    // The intent taken by an attempt that has not settled yet, so teardown can
    // hand it back rather than swallowing it.
    let unsettledIntent: string | null = null

    const attempt = () => {
      const intentUserId = takeNotificationIntent(workspaceId)
      if (!intentUserId || intentUserId === activeWorkosUserId) return
      unsettledIntent = intentUserId

      void (async () => {
        try {
          const { ownerUserId } = await accountsApi.resolveIdentity(intentUserId, workspaceId)
          if (disposed) return
          unsettledIntent = null
          if (ownerUserId === activeWorkosUserId) return
          // `main.tsx` already navigated to the notification's deep link and
          // `resolveIdentity` confirmed this account owns it — keep it.
          await switchAccount(ownerUserId, { landing: "keep-location" })
        } catch (e) {
          if (disposed) return
          unsettledIntent = null
          if (ApiError.isApiError(e) && e.code === "ACCOUNT_NOT_SIGNED_IN") {
            login(`/w/${workspaceId}`)
          }
        }
      })()
    }

    attempt()
    const unsubscribe = subscribeNotificationIntent(attempt)
    return () => {
      disposed = true
      unsubscribe()
      if (unsettledIntent) setNotificationIntent(workspaceId, unsettledIntent)
    }
  }, [workspaceId, activeWorkosUserId, switchAccount, login])
}
