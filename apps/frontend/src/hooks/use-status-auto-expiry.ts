import { useEffect } from "react"
import { resolveActiveStatus, type UserStatusFields } from "@threa/types"
import { useClearStatus } from "./use-workspaces"

// setTimeout truncates delays past its signed-32-bit ceiling, firing almost
// immediately instead — so for expiries further out than this we rely on
// render-time masking and the next mount's check rather than a bogus timer.
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Clears the current user's status at its expiry instant, authoritatively, so
 * the change broadcasts to the whole workspace. Render-time masking
 * (`resolveActiveStatus`) hides an expired status locally, but only the owner's
 * session can persist the clear — without this, an idle client would keep
 * showing a lapsed status to other viewers until some unrelated re-render.
 *
 * Pass the current user (or null when unresolved); the hook no-ops for
 * indefinite statuses and for expiries too far out for a single timer.
 */
export function useStatusAutoExpiry(workspaceId: string, currentUser: Partial<UserStatusFields> | null): void {
  const clearStatus = useClearStatus(workspaceId)
  const { mutate } = clearStatus

  const active = currentUser
    ? resolveActiveStatus({
        statusEmoji: currentUser.statusEmoji ?? null,
        statusText: currentUser.statusText ?? null,
        statusExpiresAt: currentUser.statusExpiresAt ?? null,
      })
    : null
  // `resolveActiveStatus` already masks past expiries, so any value here is in
  // the future; schedule a one-shot clear for it.
  const expiresAt = active?.expiresAt ?? null

  useEffect(() => {
    if (!expiresAt) return
    const delay = new Date(expiresAt).getTime() - Date.now()
    if (delay <= 0 || delay > MAX_TIMEOUT_MS) return
    const timer = setTimeout(() => mutate(undefined, { onError: () => {} }), delay)
    return () => clearTimeout(timer)
  }, [expiresAt, mutate])
}
