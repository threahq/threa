import { useEffect } from "react"
import { usePreferencesOptional } from "@/contexts"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { setSessionReplay, startAnalytics, stopAnalytics } from "./posthog"

export function AnalyticsConsentGate({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceBootstrap(workspaceId)
  const analytics = data?.analytics
  const preferences = usePreferencesOptional()?.preferences
  const consent = preferences?.analyticsConsent
  const replayOptIn = preferences?.sessionReplayOptIn === true
  // The workspace-scoped `usr_` id (INV-50), not the global WorkOS id: consent
  // is granted per workspace, and the backend reports this workspace's product
  // events under the same id, so both sides describe one person.
  const distinctId = useCurrentWorkspaceUserId(workspaceId)

  // No unmount cleanup: a route error replaces the layout (and this gate)
  // before the error boundary's effect runs, so stopping here would drop the
  // crash we most want. Consent changes and workspace switches re-run the effect.
  useEffect(() => {
    if (consent === "granted" && analytics && distinctId) {
      // Replay is applied once the SDK is up. A withdrawal that lands first
      // leaves nothing active, and `setSessionReplay` is a no-op then.
      void startAnalytics({
        token: analytics.posthogToken,
        host: analytics.posthogHost,
        distinctId,
        workspaceId,
      }).then(() => setSessionReplay(replayOptIn))
      return
    }
    stopAnalytics()
  }, [analytics?.posthogToken, analytics?.posthogHost, consent, replayOptIn, distinctId, workspaceId])

  return null
}
