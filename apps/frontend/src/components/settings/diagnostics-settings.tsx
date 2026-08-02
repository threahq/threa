import { useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { Check, Send } from "lucide-react"
import { toast } from "sonner"
import { sendPerfCapture } from "@/api/perf-diagnostics"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { usePreferences } from "@/contexts"
import { ApiError } from "@/api/client"
import { getPerfArmingSources, getPerfCapture, isUploadPermitted } from "@/lib/perf/capture"
import { exportCapture } from "@/lib/perf/export"

type SendState = "idle" | "sending" | "sent"

/**
 * The consent surface for client performance capture. The toggle IS the
 * consent — the `perfDiagnostics` flag only decides whether this tab is
 * offered — and upload happens only when the user presses Send.
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
  const uploadPermitted = isUploadPermitted(getPerfArmingSources())
  const devOnly = optIn && !uploadPermitted

  async function toggle(checked: boolean) {
    if (!checked) {
      // Clearing here as well as on disarm keeps the promise literal: the
      // buffer is empty the moment the user says stop, whatever the provider
      // does with the observers afterwards.
      getPerfCapture().clear()
      setSendState("idle")
    }
    await updatePreference("performanceDiagnosticsOptIn", checked)
  }

  async function send() {
    if (!workspaceId) return
    setSendState("sending")
    try {
      await sendPerfCapture(workspaceId, exportCapture(getPerfCapture()))
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
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label htmlFor="performance-diagnostics">Share performance diagnostics</Label>
            <p className="text-sm text-muted-foreground">
              Temporarily send timing and device-performance data to help diagnose this issue. Message content is never
              collected.
            </p>
          </div>
          <Switch id="performance-diagnostics" checked={optIn} onCheckedChange={(checked) => void toggle(checked)} />
        </div>

        {optIn && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {sampleCount} measurement{sampleCount === 1 ? "" : "s"} collected
              {devOnly ? " — local development capture only, sending is disabled." : ""}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={sampleCount === 0 || sendState !== "idle" || devOnly}
              onClick={() => void send()}
            >
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
