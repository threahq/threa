import { useEffect, useRef } from "react"
import { Navigate, useNavigate } from "react-router-dom"
import { useAuth } from "@/auth"
import { useWorkspaces } from "@/hooks"
import { readShareStash } from "@/lib/share-target-storage"
import { ThreaLogo } from "@/components/threa-logo"

/**
 * PWA Share Target entry point.
 *
 * When a user shares content to Threa from another app (via the Web Share Target API),
 * the service worker intercepts the POST, stashes files + text in the Cache API,
 * and redirects here. This page resolves the user's workspace and redirects into
 * the workspace-scoped share picker at `/w/:workspaceId/share`.
 */
export function ShareTargetPage() {
  const { user, activeWorkosUserId, loading: authLoading } = useAuth()
  const { workspaces, isLoading: workspacesLoading } = useWorkspaces()
  const navigate = useNavigate()
  const hasNavigated = useRef(false)

  useEffect(() => {
    if (authLoading || workspacesLoading || hasNavigated.current) return
    if (!user) return // Unauthenticated — render-time <Navigate> handles login redirect

    hasNavigated.current = true

    if (!workspaces?.length) {
      navigate("/workspaces", { replace: true })
      return
    }

    const workspaceId = workspaces[0].id
    let cancelled = false

    // Pass only lightweight text metadata via navigation state.
    // Files stay in the Cache API — passing File blobs through history.state
    // would hit browser serialization limits (~640 KB in Firefox).
    // The stash is read as this account and no other: a share addressed to the
    // account that was signed in when it arrived is not this one's to open.
    readShareStash(activeWorkosUserId).then((shareRead) => {
      if (cancelled) return
      navigate(`/w/${workspaceId}/share`, {
        replace: true,
        state: { shareRead },
      })
    })

    return () => {
      cancelled = true
    }
  }, [authLoading, workspacesLoading, user, activeWorkosUserId, workspaces, navigate])

  // Redirect to login if not authenticated — preserve /share as the return destination
  if (!authLoading && !user) {
    return <Navigate to={`/login?redirect=${encodeURIComponent("/share")}`} replace />
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <ThreaLogo size="lg" className="animate-pulse" />
        <p className="text-muted-foreground text-sm">Loading...</p>
      </div>
    </div>
  )
}
