import { useEffect } from "react"
import { usePreferencesOptional } from "@/contexts"
import { rememberPerfConsent, setPerfConsentArmed } from "./capture"

/**
 * Bridges the consent into the capture arming store. Mounted inside the
 * preferences provider (which sits below `PerfCaptureProvider` in the tree),
 * so the provider learns about a toggle through the store instead of a prop.
 * While consent is unknown it leaves arming alone, so a capture armed from
 * remembered consent at page load keeps the start it measured.
 */
export function PerfCaptureConsentGate({ workspaceId }: { workspaceId: string }) {
  const preferences = usePreferencesOptional()?.preferences
  const consented = preferences ? (preferences.performanceDiagnosticsOptIn ?? false) : null

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
