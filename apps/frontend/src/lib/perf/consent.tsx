import { useEffect } from "react"
import { usePreferencesOptional } from "@/contexts"
import { useFeatureFlag } from "@/hooks"
import { setPerfConsentArmed } from "./capture"

/**
 * True only when the workspace/user flag offers diagnostics AND the user opted
 * in. Both halves are required on the client for UX; the upload endpoint
 * re-resolves the same pair, so this is never the only gate.
 */
export function usePerfDiagnosticsConsent(workspaceId: string): boolean {
  const flag = useFeatureFlag(workspaceId, "perfDiagnostics")
  const optIn = usePreferencesOptional()?.preferences?.performanceDiagnosticsOptIn ?? false
  return flag === "available" && optIn
}

/**
 * Bridges the consent pair into the capture arming store. Mounted inside the
 * preferences provider (which sits below `PerfCaptureProvider` in the tree),
 * so the provider learns about a toggle through the store instead of a prop.
 */
export function PerfCaptureConsentGate({ workspaceId }: { workspaceId: string }) {
  const consented = usePerfDiagnosticsConsent(workspaceId)

  useEffect(() => {
    setPerfConsentArmed(consented)
    return () => setPerfConsentArmed(false)
  }, [consented])

  return null
}
