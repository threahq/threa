import { useEffect } from "react"
import { coerceLayers, resolveFeatureFlags } from "@threahq/types"
import { usePreferencesOptional } from "@/contexts"
import { useAccountScopeOptional } from "@/auth/account-scope"
import { useCurrentWorkspaceUserId } from "@/hooks/use-current-workspace-user-id"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { setSessionReplay, startAnalytics, stopAnalytics } from "./posthog"
import {
  authorizeConnectivityDiagnostics,
  revokeConnectivityDiagnostics,
  suspendConnectivityDiagnostics,
} from "@/lib/connectivity-diagnostics"

export function AnalyticsConsentGate({ workspaceId }: { workspaceId: string }) {
  const { data } = useWorkspaceBootstrap(workspaceId)
  const analytics = data?.analytics
  const preferencesContext = usePreferencesOptional()
  const preferences = preferencesContext?.preferences
  const preferencesPending = preferencesContext?.isLoading === true
  const consent = preferences?.analyticsConsent
  const replayOptIn = preferences?.sessionReplayOptIn === true
  const distinctId = useCurrentWorkspaceUserId(workspaceId)
  const diagnosticFlag = data
    ? resolveFeatureFlags(coerceLayers(data.featureFlags ?? null) ?? { workspace: {}, user: {} }).perfDiagnostics
    : null
  const diagnosticsOptIn = preferences?.performanceDiagnosticsOptIn
  const diagnosticsDecisionVersion = preferences?.updatedAt
  const accountId = useAccountScopeOptional()?.activeWorkosUserId ?? null

  // A route error unmounts this gate before the error boundary reports the crash.
  // Keep analytics active for that report; diagnostics have their own cleanup.
  useEffect(() => {
    if (consent === "granted" && analytics && distinctId) {
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

  useEffect(() => {
    if (preferencesPending) return
    if (analytics && distinctId && accountId && diagnosticsDecisionVersion) {
      const scope = {
        token: analytics.posthogToken,
        host: analytics.posthogHost,
        userId: distinctId,
        workspaceId,
        region: analytics.posthogHost,
      }
      if (consent === "granted" && diagnosticsOptIn === true && diagnosticFlag === "available") {
        authorizeConnectivityDiagnostics(accountId, scope, diagnosticsDecisionVersion)
      } else if (
        consent === "denied" ||
        diagnosticsOptIn === false ||
        (diagnosticFlag !== null && diagnosticFlag !== "available")
      ) {
        revokeConnectivityDiagnostics({ ...scope, accountId, decisionVersion: diagnosticsDecisionVersion })
      } else {
        suspendConnectivityDiagnostics()
      }
    } else {
      suspendConnectivityDiagnostics()
    }
  }, [
    analytics?.posthogToken,
    analytics?.posthogHost,
    consent,
    diagnosticsOptIn,
    diagnosticFlag,
    diagnosticsDecisionVersion,
    preferencesPending,
    distinctId,
    workspaceId,
    accountId,
  ])

  useEffect(() => () => suspendConnectivityDiagnostics(), [])

  return null
}
