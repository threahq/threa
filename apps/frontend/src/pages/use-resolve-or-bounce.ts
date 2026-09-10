import { useEffect, useRef } from "react"
import { useNavigate } from "react-router-dom"
import { accountsApi } from "@/api"
import { ApiError } from "@/api/client"
import { useAccountScope } from "@/auth/account-scope"
import { clearLastWorkspaceId, getLastWorkspaceId } from "@/lib/last-workspace"
import { useSyncStatus } from "@/sync/sync-status"

/**
 * Terminal-workspace-error handler for a deep link that may belong to a
 * *parked* (non-active) account. On a 403/404 workspace bootstrap failure,
 * ask the control plane which signed-in account owns this workspace:
 *
 * - a *different* signed-in account owns it -> flip in place (PR-4a
 *   `switchAccount`). The keyed remount re-bootstraps the same `workspaceId`
 *   (URL unchanged) under the owning account and succeeds — no navigation,
 *   and the pinned last-workspace is preserved so a reload lands back here.
 * - nothing resolvable (none, or an ambiguous multi-member bare link — the
 *   backend enforces unique-only and 404s), or it resolves back to the
 *   already-active account -> the unchanged bounce: drop the pinned
 *   last-workspace and replace-navigate to the workspace list.
 *
 * Resolve is attempted at most once per (workspace, error): the ref keyed to
 * `workspaceId` gates re-entry while the status stays `"error"`, and a
 * cleanup flag drops a late result after unmount or workspace change.
 */
export function useResolveOrBounce(workspaceId: string, syncEngine: { lastWorkspaceError: unknown }): void {
  const navigate = useNavigate()
  const workspaceSyncStatus = useSyncStatus(`workspace:${workspaceId}`)
  const { switchAccount, activeWorkosUserId } = useAccountScope()
  const attemptedRef = useRef<string | null>(null)

  useEffect(() => {
    if (workspaceSyncStatus !== "error") return
    const err = syncEngine.lastWorkspaceError
    if (!err || !ApiError.isApiError(err) || (err.status !== 404 && err.status !== 403)) return
    if (attemptedRef.current === workspaceId) return
    attemptedRef.current = workspaceId

    const bounce = () => {
      // Stop pinning a terminally inaccessible workspace as the "last
      // workspace" or the `/` entry route bounces back through this failing
      // bootstrap on every cold launch. Guarded so a concurrently-set id
      // isn't clobbered.
      if (activeWorkosUserId && getLastWorkspaceId(activeWorkosUserId) === workspaceId) {
        clearLastWorkspaceId(activeWorkosUserId)
      }
      navigate("/workspaces", { replace: true })
    }

    let ignore = false
    void (async () => {
      try {
        const { ownerUserId } = await accountsApi.resolve(workspaceId)
        if (ignore) return
        if (ownerUserId && ownerUserId !== activeWorkosUserId) {
          // The viewer followed this link deliberately and the control plane
          // confirmed the destination account can see it, so the destination
          // keeps the location instead of landing on its own home.
          await switchAccount(ownerUserId, { landing: "keep-location" })
          return
        }
        bounce()
      } catch {
        if (!ignore) bounce()
      }
    })()
    return () => {
      ignore = true
    }
  }, [workspaceSyncStatus, syncEngine, navigate, workspaceId, switchAccount, activeWorkosUserId])
}
