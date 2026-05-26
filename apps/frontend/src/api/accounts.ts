import { api } from "./client"

/**
 * One account as seen by the multi-account switcher. Mirrors the control
 * plane's `AccountSummary` (`apps/control-plane/src/features/accounts/service.ts`);
 * there is no shared types package across that boundary, so the shape is
 * declared here too. `id` is opaque — a WorkOS user id for live accounts,
 * `stale:alt_<slot>` for an alt whose sealed session failed validation.
 */
export interface AccountSummary {
  id: string
  email: string
  name: string
  state: "active" | "parked" | "stale"
}

// Shared TanStack Query key for the accounts switcher list. Several surfaces
// (sidebar logout pre-check, switcher dialog, logout-scope dialog) read the
// same query — keeping the key in one place stops a cache-miss bug from
// sneaking in when one consumer drifts.
export const ACCOUNTS_LIST_KEY = ["accounts", "list"] as const

export const accountsApi = {
  // Bare-workspace form: "which signed-in account owns this workspace?" — used
  // by the cross-account deep-link guard. 404s on ambiguity (a workspace more
  // than one signed-in account can see).
  resolve(workspaceId: string): Promise<{ ownerUserId: string }> {
    return api.get<{ ownerUserId: string }>(`/api/accounts/resolve?workspaceId=${encodeURIComponent(workspaceId)}`)
  },

  // Identity form: "is this specific account signed in on this browser, and
  // does it own this workspace?" — used by the notification-click switch so a
  // push for a parked account disambiguates a workspace both accounts can see.
  // 404 ACCOUNT_NOT_SIGNED_IN if that account isn't signed in here; never
  // substitutes another account.
  resolveIdentity(userId: string, workspaceId: string): Promise<{ ownerUserId: string }> {
    return api.get<{ ownerUserId: string }>(
      `/api/accounts/resolve?userId=${encodeURIComponent(userId)}&workspaceId=${encodeURIComponent(workspaceId)}`
    )
  },

  list(): Promise<{ accounts: AccountSummary[]; maxAccounts: number }> {
    return api.get("/api/accounts")
  },

  remove(targetUserId: string): Promise<{ removedId: string }> {
    return api.post("/api/accounts/remove", { targetUserId })
  },
}
