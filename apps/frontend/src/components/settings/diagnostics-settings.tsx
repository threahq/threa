import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useParams } from "react-router-dom"
import { Check, Send } from "lucide-react"
import { toast } from "sonner"
import { sendPerfCapture } from "@/api/perf-diagnostics"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { usePreferences } from "@/contexts"
import { ApiError } from "@/api/client"
import { getPerfArmingSources, getPerfCapture, isUploadPermitted, subscribePerfArming } from "@/lib/perf/capture"
import { exportCapture } from "@/lib/perf/export"
import { flushConnectivityDiagnostics } from "@/lib/connectivity-diagnostics/facade"

type SendState = "idle" | "sending" | "sent"

/**
 * The consent surface for client performance capture. The toggle IS the
 * consent. The `perfDiagnostics` flag only decides whether this tab is
 * offered. Connectivity events send automatically while online; performance
 * measurements send from this screen.
 */
export function DiagnosticsSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference } = usePreferences()
  const optIn = preferences?.performanceDiagnosticsOptIn ?? false

  const [sendState, setSendState] = useState<SendState>("idle")
  const [tick, setTick] = useState(0)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    },
    []
  )

  // Samples accumulate outside React; re-read on a slow tick while the tab is
  // open so the count reflects the live buffer without instrumenting renders.
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
    try {
      await updatePreference("performanceDiagnosticsOptIn", checked)
    } catch (err) {
      toast.error(ApiError.isApiError(err) ? err.message : "Failed to update the diagnostics preference")
    }
  }

  async function send() {
    if (!workspaceId) return
    setSendState("sending")
    try {
      const perfUpload =
        sampleCount > 0 ? sendPerfCapture(workspaceId, exportCapture(getPerfCapture())) : Promise.resolve()
      const [perfResult, connectivityResult] = await Promise.allSettled([perfUpload, flushConnectivityDiagnostics()])
      if (perfResult.status === "fulfilled") getPerfCapture().clear()
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
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="performance-diagnostics">Share performance diagnostics</Label>
            <p className="text-sm text-muted-foreground">
              Store up to 500 connectivity events, 256 KB total, on this device. Events can be sent for up to seven days
              and are removed after that when Threa next runs. With analytics consent, Threa sends them to PostHog
              periodically while online and after reconnecting. Performance measurements use a separate in-memory
              buffer. Message content is never collected.
            </p>
          </div>
          <Switch
            className="shrink-0"
            id="performance-diagnostics"
            checked={optIn}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>

        {optIn && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {sampleCount} performance measurement{sampleCount === 1 ? "" : "s"} collected
              {devOnly ? ". Local development capture only, sending is disabled." : ""}
            </p>
            <Button variant="outline" size="sm" disabled={sendState !== "idle" || devOnly} onClick={() => void send()}>
              {/* Confirm in place: the icon swaps, the label and footprint do
                  not, and there is no success toast (INV-63, INV-21). */}
              {sendState === "sent" ? <Check className="size-4" /> : <Send className="size-4" />}
              Send diagnostics
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
