import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useParams } from "react-router-dom"
import { Check, Send } from "lucide-react"
import { toast } from "sonner"
import { sendPerfCapture } from "@/api/perf-diagnostics"
import { usePreferences } from "@/contexts"
import { ApiError } from "@/api/client"
import { getPerfArmingSources, getPerfCapture, isUploadPermitted, subscribePerfArming } from "@/lib/perf/capture"
import { exportCapture } from "@/lib/perf/export"
import { flushConnectivityDiagnostics } from "@/lib/connectivity-diagnostics/facade"
import { SettingStateAction, SwitchSetting } from "./setting-primitives"

type SendState = "idle" | "sending" | "sent"

const SAVE_FAILED = "Couldn't save. Try again."

/**
 * The consent surface for client performance capture. The toggle IS the
 * consent. Connectivity events send automatically while online; performance
 * measurements send from this screen.
 */
export function DiagnosticsSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference } = usePreferences()
  const optIn = preferences?.performanceDiagnosticsOptIn ?? false

  const [sendState, setSendState] = useState<SendState>("idle")
  const [tick, setTick] = useState(0)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    },
    []
  )

  // Samples accumulate outside React; re-read on a slow tick while the row is
  // mounted so the count reflects the live buffer without instrumenting renders.
  useEffect(() => {
    if (!optIn) return
    const interval = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(interval)
  }, [optIn])

  const sampleCount = useMemo(() => (optIn ? getPerfCapture().snapshot().length : 0), [optIn, tick])
  const armingSources = useSyncExternalStore(subscribePerfArming, getPerfArmingSources, getPerfArmingSources)
  const uploadPermitted = isUploadPermitted(armingSources)
  const devOnly = optIn && !uploadPermitted

  async function toggle(checked: boolean) {
    if (!checked) {
      // Clearing here as well as on disarm keeps the promise literal: the
      // buffer is empty the moment the user says stop, whatever the provider
      // does with the observers afterwards.
      getPerfCapture().clear()
      setSendState("idle")
    }
    setToggleError(null)
    try {
      await updatePreference("performanceDiagnosticsOptIn", checked, { errorShownInPlace: true })
    } catch (err) {
      setToggleError(ApiError.isApiError(err) ? err.message : SAVE_FAILED)
    }
  }

  async function send() {
    if (!workspaceId) return
    setSendState("sending")
    try {
      const capture = getPerfCapture()
      const samples = capture.snapshot()
      const perfUpload =
        samples.length > 0 ? sendPerfCapture(workspaceId, exportCapture(capture, samples)) : Promise.resolve()
      const [perfResult, connectivityResult] = await Promise.allSettled([perfUpload, flushConnectivityDiagnostics()])
      if (samples.length > 0 && perfResult.status === "fulfilled") capture.acknowledge(samples)
      if (
        perfResult.status === "rejected" ||
        connectivityResult.status === "rejected" ||
        connectivityResult.value === false
      )
        throw new Error("Diagnostics could not be delivered")
      setSendState("sent")
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null
        setSendState("idle")
      }, 3000)
    } catch (err) {
      setSendState("idle")
      toast.error(ApiError.isApiError(err) ? err.message : "Failed to send diagnostics")
    }
  }

  return (
    <SwitchSetting
      setting="diagnostics"
      checked={optIn}
      error={toggleError}
      onCheckedChange={(checked) => void toggle(checked)}
    >
      {optIn && (
        <SettingStateAction
          live
          action={{
            disabled: sendState !== "idle" || devOnly,
            onClick: () => void send(),
            children: (
              <>
                {/* Confirm in place: the icon swaps, the label and footprint do
                    not, and there is no success toast (INV-63, INV-21). */}
                {sendState === "sent" ? (
                  <Check className="size-4" aria-hidden />
                ) : (
                  <Send className="size-4" aria-hidden />
                )}
                Send diagnostics
              </>
            ),
          }}
        >
          {sampleCount} measurement{sampleCount === 1 ? "" : "s"} collected
          {devOnly ? ". Local development capture only, sending is off." : ""}
        </SettingStateAction>
      )}
    </SwitchSetting>
  )
}
