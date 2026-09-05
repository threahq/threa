import { useEffect } from "react"
import { usePreferencesOptional } from "@/contexts"
import { useUser } from "@/auth"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { startAnalytics, stopAnalytics } from "./posthog"

export function AnalyticsConsentGate({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceBootstrap(workspaceId)
  const analytics = data?.analytics
  const consent = usePreferencesOptional()?.preferences?.analyticsConsent
  const user = useUser()

  // No unmount cleanup: a route error replaces the layout (and this gate)
  // before the error boundary's effect runs, so stopping here would drop the
  // crash we most want. Consent changes and workspace switches re-run the effect.
  useEffect(() => {
    if (consent === "granted" && analytics && user) {
      startAnalytics({
        token: analytics.posthogToken,
        host: analytics.posthogHost,
        distinctId: user.id,
        workspaceId,
      })
      return
    }
    stopAnalytics()
  }, [analytics?.posthogToken, analytics?.posthogHost, consent, user?.id, workspaceId])

  return null
}
