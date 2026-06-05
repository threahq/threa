import { useEffect, useRef, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { Bell, BellOff, CheckCircle2, Loader2, Moon, ServerCrash, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DateTimeField } from "@/components/forms/date-time-field"
import { ApiError, api } from "@/api/client"
import { usePreferences } from "@/contexts"
import { usePushNotifications } from "@/hooks/use-push-notifications"
import { useCurrentWorkspaceUser, usePauseNotifications, useResumeNotifications } from "@/hooks"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"
import { parseLocalDateTime, toDateInputValue, toTimeInputValue } from "@/lib/dates"
import {
  NOTIFICATION_PAUSE_OPTIONS,
  type NotificationPauseOption,
  formatNotificationPauseLabel,
  statusDurationToExpiry,
} from "@/lib/status"
import { PREF_NOTIFICATION_LEVEL_OPTIONS, resolveNotificationPause, type PrefNotificationLevel } from "@threa/types"

const NOTIFICATION_LABELS: Record<PrefNotificationLevel, string> = {
  all: "All messages",
  mentions: "Mentions only",
  none: "None",
}

const NOTIFICATION_DESCRIPTIONS: Record<PrefNotificationLevel, string> = {
  all: "Get notified for all new messages",
  mentions: "Get notified for @mentions, DMs, and scratchpad messages",
  none: "Don't send any notifications",
}

interface TestPushResponse {
  attempted: number
  delivered: number
  failed: number
}

type TestStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; delivered: number; attempted: number; failed: number }
  | { kind: "error"; message: string }

function TestPushButton({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<TestStatus>({ kind: "idle" })
  // Track the auto-reset timer so a second click clears any pending reset
  // from the previous click — without this, a stale timer can fire mid-flight
  // and clobber a "sending"/"ok" state with "idle".
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    },
    []
  )

  function scheduleReset() {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null
      setState({ kind: "idle" })
    }, 5000)
  }

  async function sendTest() {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
    setState({ kind: "sending" })
    try {
      // Backend-driven test: actually exercises the full delivery loop
      // (DB → web-push → device), not just the local SW path. The phone
      // should receive the notification within a few seconds.
      const result = await api.post<TestPushResponse>(`/api/workspaces/${workspaceId}/push/test`)
      setState({
        kind: "ok",
        delivered: result.delivered,
        attempted: result.attempted,
        failed: result.failed,
      })
    } catch (err) {
      console.error("[Push] Test push failed:", err)
      const message = ApiError.isApiError(err) ? err.message : "Failed to send test"
      setState({ kind: "error", message })
    } finally {
      scheduleReset()
    }
  }

  // Keep the button label fixed so a long backend message (e.g. "Push
  // notifications are not enabled on this server") never blows out the layout
  // — surface the message in an adjacent line instead.
  let buttonLabel: string
  if (state.kind === "sending") buttonLabel = "Sending…"
  else if (state.kind === "error") buttonLabel = "Retry test"
  else buttonLabel = "Send test"

  let resultLine: { tone: "muted" | "destructive"; text: string } | null = null
  if (state.kind === "ok") {
    if (state.attempted === 0) {
      resultLine = { tone: "muted", text: "No devices subscribed yet." }
    } else if (state.failed === 0) {
      resultLine = {
        tone: "muted",
        text: `Sent to ${state.delivered} device${state.delivered === 1 ? "" : "s"}.`,
      }
    } else {
      resultLine = {
        tone: "destructive",
        text: `Delivered to ${state.delivered} of ${state.attempted} devices — ${state.failed} failed.`,
      }
    }
  } else if (state.kind === "error") {
    resultLine = { tone: "destructive", text: state.message }
  }

  return (
    <div className="flex flex-col gap-1">
      <Button onClick={sendTest} variant="outline" size="sm" disabled={state.kind === "sending"} className="self-start">
        {state.kind === "sending" && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        {buttonLabel}
      </Button>
      {resultLine && (
        <p className={resultLine.tone === "destructive" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {resultLine.text}
        </p>
      )}
    </div>
  )
}

interface StatusInfo {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
}

function PushStatusBadge({ info }: { info: StatusInfo }) {
  return (
    <Badge variant={info.variant} className="font-normal">
      {info.label}
    </Badge>
  )
}

function PushNotificationSection({ workspaceId }: { workspaceId: string }) {
  const {
    permission,
    isSubscribed,
    status,
    error,
    optedOut,
    pushDisabledOnServer,
    requestPermission,
    unsubscribe,
    retry,
  } = usePushNotifications(workspaceId)

  const statusInfo = resolveStatusInfo({ permission, isSubscribed, status, optedOut, pushDisabledOnServer })

  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
          {isSubscribed ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Push notifications</h3>
            <PushStatusBadge info={statusInfo} />
          </div>
          <p className="text-sm text-muted-foreground">Get notified on this device even when Threa isn't open.</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        {permission === "unsupported" && (
          <p className="text-sm text-muted-foreground">Push notifications aren't supported in this browser.</p>
        )}

        {permission === "denied" && (
          <p className="text-sm text-muted-foreground">
            Notifications are blocked at the browser level. Open your browser's site settings and allow notifications
            for Threa, then reload this page.
          </p>
        )}

        {permission === "default" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Allow notifications so messages and mentions can reach you when the app is closed.
            </p>
            <Button onClick={requestPermission} variant="default" size="sm">
              <Bell className="mr-2 h-3.5 w-3.5" />
              Enable push notifications
            </Button>
          </div>
        )}

        {permission === "granted" && isSubscribed && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p className="text-muted-foreground">
                This device is subscribed. Use <span className="font-medium text-foreground">Send test</span> to verify
                that your phone or other devices actually receive a push.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <TestPushButton workspaceId={workspaceId} />
              <Button onClick={unsubscribe} variant="outline" size="sm">
                Disable for this device
              </Button>
            </div>
          </div>
        )}

        {permission === "granted" && !isSubscribed && optedOut && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              You've turned off push for this device. Re-enable to start getting notifications again.
            </p>
            <Button onClick={requestPermission} variant="outline" size="sm">
              <Bell className="mr-2 h-3.5 w-3.5" />
              Re-enable
            </Button>
          </div>
        )}

        {permission === "granted" && !isSubscribed && !optedOut && pushDisabledOnServer && (
          <Alert>
            <ServerCrash className="h-4 w-4" />
            <AlertTitle>Not available on this server</AlertTitle>
            <AlertDescription className="mt-1 space-y-3">
              <p>The Threa server isn't configured to send push notifications.</p>
              <Button onClick={retry} variant="outline" size="sm">
                Check again
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {permission === "granted" && !isSubscribed && !optedOut && !pushDisabledOnServer && status !== "error" && (
          // Covers both "subscribing" (active flow) and "idle" (fresh mount before
          // the auto-subscribe effect has set status). Without the "idle" case the
          // card body was empty whenever a fresh permission grant raced ahead of
          // the first subscribe() call.
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Subscribing this device…</span>
          </div>
        )}

        {permission === "granted" && !isSubscribed && !optedOut && !pushDisabledOnServer && status === "error" && (
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>Couldn't enable push notifications</AlertTitle>
            <AlertDescription className="mt-1 space-y-3">
              {error && (
                <p className="text-xs">
                  {error.message}
                  {error.code ? ` (${error.code})` : ""}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={retry} variant="outline" size="sm">
                  Retry
                </Button>
                <Button onClick={unsubscribe} variant="ghost" size="sm">
                  Stop trying for this device
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  )
}

function resolveStatusInfo(args: {
  permission: ReturnType<typeof usePushNotifications>["permission"]
  isSubscribed: boolean
  status: ReturnType<typeof usePushNotifications>["status"]
  optedOut: boolean
  pushDisabledOnServer: boolean
}): StatusInfo {
  const { permission, isSubscribed, status, optedOut, pushDisabledOnServer } = args
  if (permission === "unsupported") return { label: "Unsupported", variant: "outline" }
  if (permission === "denied") return { label: "Blocked", variant: "destructive" }
  if (permission === "default") return { label: "Off", variant: "outline" }
  if (isSubscribed) return { label: "Enabled", variant: "default" }
  if (optedOut) return { label: "Off", variant: "outline" }
  if (pushDisabledOnServer) return { label: "Unavailable", variant: "outline" }
  if (status === "error") return { label: "Error", variant: "destructive" }
  // permission=granted, no other flag set → either "subscribing" or "idle"
  // before the first subscribe() call. Either way we're trying, not Off.
  return { label: "Subscribing…", variant: "secondary" }
}

/**
 * Manually pause notifications (do-not-disturb), independent of status. A
 * status with "pause notifications" set drives the same underlying state, so
 * this section also surfaces a status-driven pause and explains it.
 */
function PauseNotificationsSection({ workspaceId }: { workspaceId: string }) {
  const currentUser = useCurrentWorkspaceUser(workspaceId)
  const schedule = useEffectiveWorkSchedule(workspaceId)
  const pause = usePauseNotifications(workspaceId)
  const resume = useResumeNotifications(workspaceId)

  const active = currentUser ? resolveNotificationPause(currentUser, new Date()) : null
  const busy = pause.isPending || resume.isPending
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  // The "Custom…" path reveals an inline date/time field rather than pausing
  // immediately, mirroring the status picker's custom expiry.
  const [customOpen, setCustomOpen] = useState(false)
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")

  const pauseUntil = async (until: string | null) => {
    try {
      await pause.mutateAsync(until)
      setCustomOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pause notifications")
    }
  }

  const handlePause = (option: NotificationPauseOption) => {
    void pauseUntil(option.duration ? statusDurationToExpiry(option.duration, timezone, schedule) : null)
  }

  const openCustom = () => {
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000)
    setCustomDate(toDateInputValue(inAnHour))
    setCustomTime(toTimeInputValue(inAnHour))
    setCustomOpen(true)
  }

  const handleCustomPause = () => {
    const when = parseLocalDateTime(customDate, customTime)
    if (!when || when.getTime() <= Date.now()) {
      toast.error("Pick a time in the future")
      return
    }
    void pauseUntil(when.toISOString())
  }

  const handleResume = async () => {
    try {
      await resume.mutateAsync()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resume notifications")
    }
  }

  // A pause coming purely from a do-not-disturb status can't be lifted from
  // here without changing the status — explain that instead of a dead button.
  const statusOnly = active?.source === "status"

  // The pause-duration choices, shared by the initial "Pause notifications"
  // trigger and the "Change" trigger on an active pause. Timed options first,
  // then the custom-time path, then the indefinite option.
  const pauseMenuContent = (
    <DropdownMenuContent align="start">
      {NOTIFICATION_PAUSE_OPTIONS.filter((o) => o.duration !== null).map((option) => (
        <DropdownMenuItem key={option.id} onSelect={() => handlePause(option)}>
          {option.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={openCustom}>Until a specific time…</DropdownMenuItem>
      {NOTIFICATION_PAUSE_OPTIONS.filter((o) => o.duration === null).map((option) => (
        <DropdownMenuItem key={option.id} onSelect={() => handlePause(option)}>
          {option.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  )

  // One ternary level (INV-47): pick the control via if/else, render it once.
  // `customOpen` wins so the picker can adjust an already-active pause in place.
  let control: ReactNode
  if (customOpen) {
    control = (
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <DateTimeField
          date={customDate}
          time={customTime}
          onDateChange={setCustomDate}
          onTimeChange={setCustomTime}
          minDate={toDateInputValue(new Date())}
          density="compact"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCustomOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCustomPause} disabled={busy}>
            Pause
          </Button>
        </div>
      </div>
    )
  } else if (active) {
    control = (
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="flex min-w-0 items-center gap-2">
          <Moon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{formatNotificationPauseLabel(active)}</p>
            {statusOnly ? (
              <p className="text-xs text-muted-foreground">Set by your status — clear your status to resume.</p>
            ) : (
              <p className="text-xs text-muted-foreground">Overrides your notification level while paused.</p>
            )}
          </div>
        </div>
        {!statusOnly && (
          <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" disabled={busy}>
                  Change
                </Button>
              </DropdownMenuTrigger>
              {pauseMenuContent}
            </DropdownMenu>
            <Button onClick={handleResume} variant="outline" size="sm" disabled={busy}>
              Resume
            </Button>
          </div>
        )}
      </div>
    )
  } else {
    control = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy}>
            <BellOff className="mr-2 h-3.5 w-3.5" />
            Pause notifications
          </Button>
        </DropdownMenuTrigger>
        {pauseMenuContent}
      </DropdownMenu>
    )
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Pause notifications</h3>
        <p className="text-sm text-muted-foreground">
          Snooze notifications on all your devices for a while. Your activity still lands in Threa — only the push is
          held back.
        </p>
      </div>

      {control}
    </section>
  )
}

export function NotificationsSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference } = usePreferences()

  const notificationLevel = preferences?.notificationLevel ?? "all"

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Notification level</h3>
          <p className="text-sm text-muted-foreground">Choose when you want to be notified</p>
        </div>
        <RadioGroup
          value={notificationLevel}
          onValueChange={(value) => updatePreference("notificationLevel", value as PrefNotificationLevel)}
          className="space-y-4"
        >
          {PREF_NOTIFICATION_LEVEL_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`notify-${option}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`notify-${option}`} className="cursor-pointer">
                  {NOTIFICATION_LABELS[option]}
                </Label>
                <p className="text-sm text-muted-foreground">{NOTIFICATION_DESCRIPTIONS[option]}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      {workspaceId && (
        <>
          <Separator />
          <PauseNotificationsSection workspaceId={workspaceId} />
          <Separator />
          <PushNotificationSection workspaceId={workspaceId} />
        </>
      )}
    </div>
  )
}
