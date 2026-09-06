import { useEffect } from "react"
import { usePreferencesOptional } from "@/contexts"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { startAnalytics, stopAnalytics } from "./posthog"

export function AnalyticsConsentGate({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceBootstrap(workspaceId)
  const analytics = data?.analytics
  const consent = usePreferencesOptional()?.preferences?.analyticsConsent
  // The workspace-scoped `usr_` id (INV-50), not the global WorkOS id: consent
  // is granted per workspace, and the backend reports this workspace's product
  // events under the same id, so both sides describe one person.
  const distinctId = useCurrentWorkspaceUserId(workspaceId)

  // No unmount cleanup: a route error replaces the layout (and this gate)
  // before the error boundary's effect runs, so stopping here would drop the
  // crash we most want. Consent changes and workspace switches re-run the effect.
  useEffect(() => {
    if (consent === "granted" && analytics && distinctId) {
      startAnalytics({
        token: analytics.posthogToken,
        host: analytics.posthogHost,
        distinctId,
        workspaceId,
      })
      return
    }
    stopAnalytics()
  }, [analytics?.posthogToken, analytics?.posthogHost, consent, distinctId, workspaceId])

  return null
}
