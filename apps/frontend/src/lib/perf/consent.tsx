import { useEffect } from "react"
import { usePreferencesOptional } from "@/contexts"
import { useFeatureFlagWhenKnown } from "@/hooks"
import { rememberPerfConsent, setPerfConsentArmed } from "./capture"

/**
 * True only when the workspace/user flag offers diagnostics AND the user opted
 * in; null until both halves have been read. Both halves are required on the
 * client for UX; the upload endpoint re-resolves the same pair, so this is
 * never the only gate.
 */
export function usePerfDiagnosticsConsent(workspaceId: string): boolean | null {
  const flag = useFeatureFlagWhenKnown(workspaceId, "perfDiagnostics")
  const preferences = usePreferencesOptional()?.preferences
  if (flag === null || !preferences) return null
  return flag === "available" && (preferences.performanceDiagnosticsOptIn ?? false)
}

/**
 * Bridges the consent pair into the capture arming store. Mounted inside the
 * preferences provider (which sits below `PerfCaptureProvider` in the tree),
 * so the provider learns about a toggle through the store instead of a prop.
 * While the pair is unknown it leaves arming alone, so a capture armed from
 * remembered consent at page load keeps the start it measured.
 */
export function PerfCaptureConsentGate({ workspaceId }: { workspaceId: string }) {
  const consented = usePerfDiagnosticsConsent(workspaceId)

  // A workspace switch disarms and re-arms: the consent edge clears the
  // buffer, so samples measured in one workspace are never uploaded
  // attributed to another.
  useEffect(() => () => setPerfConsentArmed(false), [workspaceId])

  useEffect(() => {
    if (consented === null) return
    setPerfConsentArmed(consented)
    rememberPerfConsent(workspaceId, consented)
  }, [consented, workspaceId])

  return null
}
