import { useEffect, useRef, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { Bell, BellOff, CheckCircle2, Loader2, Moon, ServerCrash, TriangleAlert } from "lucide-react"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { DateTimeField } from "@/components/forms/date-time-field"
import { CustomDurationPicker } from "@/components/scheduling/custom-duration-picker"
import { PushActionsSection } from "./push-actions-section"
import { ApiError, api } from "@/api/client"
import { usePreferences } from "@/contexts"
import { getDeviceKey, usePushNotifications } from "@/hooks/use-push-notifications"
import { useNotificationPauseControls } from "@/hooks/use-notification-pause-controls"
import { toDateInputValue, toTimeInputValue } from "@/lib/dates"
import { NOTIFICATION_PAUSE_OPTIONS, formatNotificationPauseLabel } from "@/lib/status"
import {
  PREF_NOTIFICATION_LEVEL_OPTIONS,
  type PrefNotificationLevel,
  type PushProviderOutcome,
  type PushTestResponse,
} from "@threahq/types"

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

/**
 * A backend that predates per-device results answers only
 * `{ attempted, failed, delivered }`, where `delivered` counts push-service
 * acceptances.
 */
type TestPushResult =
  | (Pick<PushTestResponse, "attempted" | "accepted"> & Partial<Pick<PushTestResponse, "devices">>)
  | Pick<PushTestResponse, "attempted" | "delivered">

interface TestOutcome {
  result: TestPushResult
  thisDeviceKey: string | null
}

type TestStatus =
  | { kind: "idle" }
  | { kind: "sending"; previous: TestOutcome | null }
  | ({ kind: "ok" } & TestOutcome)
  | { kind: "error"; message: string }

const OUTCOME_TEXT: Record<PushProviderOutcome, string> = {
  accepted: "Accepted by push service",
  registration_gone: "Registration expired — removed",
  rejected: "Rejected by push service",
  unreachable: "Couldn't reach push service",
  invalid_registration: "Invalid registration — not sent",
}

function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device"
  let browser = "Browser"
  if (/Edg(A|iOS)?\//.test(userAgent)) browser = "Edge"
  else if (/OPR\//.test(userAgent)) browser = "Opera"
  else if (/SamsungBrowser\//.test(userAgent)) browser = "Samsung Internet"
  else if (/(Firefox|FxiOS)\//.test(userAgent)) browser = "Firefox"
  else if (/(Chrome|CriOS)\//.test(userAgent)) browser = "Chrome"
  else if (/Safari\//.test(userAgent)) browser = "Safari"

  let os: string | null = null
  if (/iPhone/.test(userAgent)) os = "iPhone"
  else if (/iPad/.test(userAgent)) os = "iPad"
  else if (/Android/.test(userAgent)) os = "Android"
  else if (/CrOS/.test(userAgent)) os = "ChromeOS"
  else if (/Mac OS X|Macintosh/.test(userAgent)) os = "macOS"
  else if (/Windows/.test(userAgent)) os = "Windows"
  else if (/Linux/.test(userAgent)) os = "Linux"

  return os ? `${browser} on ${os}` : browser
}

function useTestPush(workspaceId: string) {
  const [state, setState] = useState<TestStatus>({ kind: "idle" })
  // Only an error resets on its own; per-device results stay until the next
  // test so they can be read. A second click clears a pending reset so a stale
  // timer can't clobber the new attempt.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped per attempt and on unmount: a completion whose attempt is no longer
  // current (superseded, unsubscribed, workspace switched) is dropped.
  const attemptRef = useRef(0)

  useEffect(
    () => () => {
      attemptRef.current += 1
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current)
    },
    []
  )

  async function sendTest() {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
    const attempt = ++attemptRef.current
    setState((current) => ({
      kind: "sending",
      previous: current.kind === "ok" ? { result: current.result, thisDeviceKey: current.thisDeviceKey } : null,
    }))
    try {
      // Backend-driven test: exercises DB → web-push → push service, not just
      // the local SW path.
      const [result, thisDeviceKey] = await Promise.all([
        api.post<TestPushResult>(`/api/workspaces/${workspaceId}/push/test`),
        getDeviceKey().catch(() => null),
      ])
      if (attempt !== attemptRef.current) return
      setState({ kind: "ok", result, thisDeviceKey })
    } catch (err) {
      if (attempt !== attemptRef.current) return
      console.error("[Push] Test push failed:", err)
      const message = ApiError.isApiError(err) ? err.message : "Failed to send test"
      setState({ kind: "error", message })
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null
        setState({ kind: "idle" })
      }, 5000)
    }
  }

  return { state, sendTest }
}

function TestPushButton({ state, onSend }: { state: TestStatus; onSend: () => void }) {
  // Fixed label so a long backend message never blows out the button; the
  // message renders in the result area instead.
  let buttonLabel: string
  if (state.kind === "sending") buttonLabel = "Sending…"
  else if (state.kind === "error") buttonLabel = "Retry test"
  else buttonLabel = "Send test"

  return (
    <Button onClick={onSend} variant="outline" size="sm" disabled={state.kind === "sending"}>
      {state.kind === "sending" && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
      {buttonLabel}
    </Button>
  )
}

function TestPushResultView({ state }: { state: TestStatus }) {
  if (state.kind === "error") return <p className="text-xs text-destructive">{state.message}</p>
  if (state.kind === "ok") return <TestOutcomeView outcome={state} />
  if (state.kind === "sending" && state.previous) return <TestOutcomeView outcome={state.previous} refreshing />
  return null
}

function TestOutcomeView({ outcome, refreshing = false }: { outcome: TestOutcome; refreshing?: boolean }) {
  const { result, thisDeviceKey } = outcome
  if (result.attempted === 0) return <p className="text-xs text-muted-foreground">No devices subscribed yet.</p>

  const accepted = "accepted" in result ? result.accepted : result.delivered
  const devices = "devices" in result ? (result.devices ?? []) : []
  // The device key hashes only the user agent, so two machines on the same
  // reduced UA share it; claim "This device" only when the match is unique.
  const matches = devices.filter((device) => device.deviceKey === thisDeviceKey)
  const thisSubscriptionId = matches.length === 1 ? matches[0]!.subscriptionId : null
  return (
    <div className={refreshing ? "space-y-2 opacity-60 transition-opacity" : "space-y-2"} aria-busy={refreshing}>
      <p className={accepted === result.attempted ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
        {`Accepted by push service on ${accepted} of ${result.attempted} device${result.attempted === 1 ? "" : "s"}.`}
      </p>
      {devices.length > 0 && (
        <ul className="divide-y rounded-md border">
          {devices.map((device) => (
            <li
              key={device.subscriptionId}
              className="flex flex-col gap-0.5 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{describeUserAgent(device.userAgent)}</span>
                {device.subscriptionId === thisSubscriptionId && (
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    This device
                  </Badge>
                )}
              </span>
              <span
                className={
                  device.outcome === "accepted" ? "shrink-0 text-muted-foreground" : "shrink-0 text-destructive"
                }
              >
                {OUTCOME_TEXT[device.outcome]}
              </span>
            </li>
          ))}
        </ul>
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

function SubscribedPushControls({ workspaceId, onUnsubscribe }: { workspaceId: string; onUnsubscribe: () => void }) {
  const testPush = useTestPush(workspaceId)
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="text-muted-foreground">
          This device is subscribed. Use <span className="font-medium text-foreground">Send test</span> to verify that
          your phone or other devices actually receive a push.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <TestPushButton state={testPush.state} onSend={testPush.sendTest} />
        <Button onClick={onUnsubscribe} variant="outline" size="sm">
          Disable for this device
        </Button>
      </div>
      <TestPushResultView state={testPush.state} />
    </div>
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
          // Keyed so results never carry over to another workspace; unmounting on
          // unsubscribe drops them too.
          <SubscribedPushControls key={workspaceId} workspaceId={workspaceId} onUnsubscribe={unsubscribe} />
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
  // The custom paths reveal inline fields rather than pausing immediately,
  // mirroring the status picker's custom expiry.
  const [customOpen, setCustomOpen] = useState(false)
  const [customDurationOpen, setCustomDurationOpen] = useState(false)
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")

  const { active, statusOnly, busy, pauseFor, pauseUntilDate, pauseUntilLocal, resume } = useNotificationPauseControls(
    workspaceId,
    () => {
      setCustomOpen(false)
      setCustomDurationOpen(false)
    }
  )

  const openCustom = () => {
    setCustomDurationOpen(false)
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000)
    setCustomDate(toDateInputValue(inAnHour))
    setCustomTime(toTimeInputValue(inAnHour))
    setCustomOpen(true)
  }

  const openCustomDuration = () => {
    setCustomOpen(false)
    setCustomDurationOpen(true)
  }

  const handleCustomPause = () => {
    pauseUntilLocal(customDate, customTime)
  }

  // The pause-duration choices, shared by the initial "Pause notifications"
  // trigger and the "Change" trigger on an active pause. Timed options first,
  // then the custom-time path, then the indefinite option.
  const pauseMenuContent = (
    <DropdownMenuContent align="start" className="min-w-[260px]">
      {NOTIFICATION_PAUSE_OPTIONS.filter((o) => o.duration !== null).map((option) => (
        <DropdownMenuItem key={option.id} onSelect={() => pauseFor(option)}>
          {option.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={openCustomDuration}>Custom duration…</DropdownMenuItem>
      <DropdownMenuItem onSelect={openCustom}>Until a specific time…</DropdownMenuItem>
      {NOTIFICATION_PAUSE_OPTIONS.filter((o) => o.duration === null).map((option) => (
        <DropdownMenuItem key={option.id} onSelect={() => pauseFor(option)}>
          {option.label}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  )

  // One ternary level (INV-47): pick the control via if/else, render it once.
  let control: ReactNode
  if (customDurationOpen) {
    control = (
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <CustomDurationPicker
          onSubmit={pauseUntilDate}
          disabled={busy}
          submitLabel="Pause"
          className="px-0"
          controlClassName="h-11"
          buttonClassName="h-11"
        />
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setCustomDurationOpen(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    )
  } else if (customOpen) {
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
            <Button onClick={resume} variant="outline" size="sm" disabled={busy}>
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
          <Separator />
          <PushActionsSection workspaceId={workspaceId} />
        </>
      )}
    </div>
  )
}
