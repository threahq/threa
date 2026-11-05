import { useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { CheckCircle2, CircleHelp, Loader2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DateTimeField } from "@/components/forms/date-time-field"
import {
  CustomDurationPicker,
  customDurationToDate,
  type CustomDurationUnit,
} from "@/components/scheduling/custom-duration-picker"
import { usePreferences } from "@/contexts"
import { useOptionalSettings } from "@/contexts/settings-context"
import { SettingsLink } from "@/components/workspace-settings/settings-link"
import { usePushNotifications } from "@/hooks/use-push-notifications"
import { resolvePushDeviceState, type PushDeviceState } from "@/hooks/push-device-state"
import { useNotificationPauseControls } from "@/hooks/use-notification-pause-controls"
import { toDateInputValue, toTimeInputValue } from "@/lib/dates"
import { cn } from "@/lib/utils"
import { NOTIFICATION_PAUSE_OPTIONS, formatNotificationPauseLabel } from "@/lib/status"
import {
  NOTIFICATION_CONFIG,
  PREF_NOTIFICATION_LEVEL_OPTIONS,
  type PrefNotificationLevel,
  type PushProviderOutcome,
  type PushTestDeviceResult,
} from "@threahq/types"
import { PushActionsSection } from "./push-actions-section"
import {
  ChoiceSetting,
  INSTALLATION_OFF,
  SETTING_CONTROL_CLASS,
  SETTING_CONTROL_HEIGHT,
  SettingBadge,
  SettingDependents,
  SettingEmptyNote,
  SettingFieldError,
  SettingRow,
  SettingStateAction,
  SettingsSection,
  SwitchSetting,
  settingIds,
} from "./setting-primitives"
import { SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "./setting-text"
import { SETTING_CHOICE_LABELS, settingDef } from "./settings-registry"
import { useRouteStreamId } from "./use-stream-settings-scope"
import { usePushTest, type DeviceReport, type TestOutcome, type TestReports, type TestStatus } from "./use-push-test"

export const NOTIFICATION_LEVEL_DESCRIPTIONS: Record<PrefNotificationLevel, string> = {
  all: "Whatever each stream is set to notify you about.",
  mentions: "Only @mentions, DMs and scratchpads.",
  none: "Nothing. Everything still shows in Threa.",
}

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

function TestPushResultView({ state }: { state: TestStatus }) {
  if (state.kind === "error") return <SettingFieldError>{state.message}</SettingFieldError>
  if (state.kind === "ok") return <TestOutcomeView outcome={state} />
  if (state.kind === "sending" && state.previous) return <TestOutcomeView outcome={state.previous} refreshing />
  return null
}

type ReportTone = "pending" | "ok" | "failed" | "muted"

interface ReportLine {
  text: string
  tone: ReportTone
  /** The window ended without a terminal report. */
  unconfirmed?: true
}

const PROVIDER_REFUSED = new Set<PushProviderOutcome>(["registration_gone", "rejected", "invalid_registration"])

/**
 * What the device itself said, kept apart from the push service's answer: a
 * recorded stage shows whatever the provider said, and a missing report is
 * unconfirmed, never a failure.
 */
function resolveReportLine(
  outcome: PushProviderOutcome,
  report: DeviceReport | undefined,
  phase: "waiting" | "settled" | "closed"
): ReportLine | null {
  const waiting = phase === "waiting"
  switch (report?.stage) {
    case "notification_created":
      return { text: "Notification created", tone: "ok" }
    case "creation_failed":
      return { text: "Device couldn't create the notification", tone: "failed" }
    case "suppressed":
      return { text: "Not shown: you were viewing this conversation", tone: "muted" }
    case "received":
      return waiting
        ? { text: "Received by device", tone: "pending" }
        : { text: "Received, notification not confirmed", tone: "muted", unconfirmed: true }
  }
  if (PROVIDER_REFUSED.has(outcome)) return null
  if (report && !report.expected) return { text: "Device report unavailable", tone: "muted" }
  return waiting ? { text: "Waiting for device report", tone: "pending" } : UNCONFIRMED
}

const UNCONFIRMED: ReportLine = { text: "Not confirmed by device", tone: "muted", unconfirmed: true }

const REPORT_TONE_CLASS: Record<ReportTone, string> = {
  pending: "text-muted-foreground",
  ok: "text-foreground",
  failed: "text-destructive",
  muted: "text-muted-foreground",
}

function ReportIcon({ tone }: { tone: ReportTone }) {
  const className = "h-3.5 w-3.5 shrink-0"
  if (tone === "pending") return <Loader2 aria-hidden className={`${className} animate-spin`} />
  if (tone === "ok") return <CheckCircle2 aria-hidden className={className} />
  if (tone === "failed") return <TriangleAlert aria-hidden className={className} />
  return <CircleHelp aria-hidden className={className} />
}

function reportsNote(reports: TestReports, devices: PushTestDeviceResult[]): string | null {
  if (reports.phase === "unavailable")
    return devices.length > 0 ? "Device reports aren't available for this test." : null
  if (reports.pollFailed) {
    return reports.phase === "waiting" ? "Couldn't check device reports. Retrying…" : "Couldn't check device reports."
  }
  if (reports.phase !== "closed") return null
  const unconfirmed = devices.some(
    (device) => resolveReportLine(device.outcome, reports.devices[device.subscriptionId], "closed")?.unconfirmed
  )
  return unconfirmed ? "A device that didn't report within a minute may still have shown the notification." : null
}

function TestOutcomeView({ outcome, refreshing = false }: { outcome: TestOutcome; refreshing?: boolean }) {
  const { result, thisDeviceKey, reports } = outcome
  if (result.attempted === 0) return <SettingEmptyNote>No devices subscribed yet.</SettingEmptyNote>

  const accepted = "accepted" in result ? result.accepted : result.delivered
  const devices = "devices" in result ? (result.devices ?? []) : []
  // The device key hashes only the user agent, so two machines on the same
  // reduced UA share it; claim "This device" only when the match is unique.
  const matches = devices.filter((device) => device.deviceKey === thisDeviceKey)
  const thisSubscriptionId = matches.length === 1 ? matches[0]!.subscriptionId : null
  const note = reportsNote(reports, devices)
  // `ph-no-capture` blocks this subtree from session replay: masked text would
  // still leave each device's row, icon and tone in the recording.
  return (
    <div
      className={refreshing ? "ph-no-capture space-y-2 opacity-60 transition-opacity" : "ph-no-capture space-y-2"}
      aria-busy={refreshing}
    >
      <p
        className={cn(SETTING_NOTE_TEXT, accepted === result.attempted ? "text-muted-foreground" : "text-destructive")}
      >
        {`Accepted by push service on ${accepted} of ${result.attempted} device${result.attempted === 1 ? "" : "s"}.`}
      </p>
      {devices.length > 0 && (
        <ul className="divide-y divide-border" aria-live="polite">
          {devices.map((device) => {
            const report =
              reports.phase === "unavailable"
                ? null
                : resolveReportLine(device.outcome, reports.devices[device.subscriptionId], reports.phase)
            return (
              <li
                key={device.subscriptionId}
                className="flex min-h-11 flex-col gap-0.5 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">{describeUserAgent(device.userAgent)}</span>
                  {device.subscriptionId === thisSubscriptionId && <SettingBadge>This device</SettingBadge>}
                </span>
                <span className={cn("flex shrink-0 flex-col gap-0.5 sm:items-end", SETTING_NOTE_TEXT)}>
                  <span className={device.outcome === "accepted" ? "text-muted-foreground" : "text-destructive"}>
                    {OUTCOME_TEXT[device.outcome]}
                  </span>
                  {report && (
                    <span className={`flex items-center gap-1.5 ${REPORT_TONE_CLASS[report.tone]}`}>
                      <ReportIcon tone={report.tone} />
                      {report.text}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {note && (
        <p role="status" className={SETTING_MUTED_NOTE_TEXT}>
          {note}
        </p>
      )}
    </div>
  )
}

function TestPushControls({ workspaceId }: { workspaceId: string }) {
  const testPush = usePushTest(workspaceId)
  const { state } = testPush
  // Fixed label so a long backend message never blows out the button; the
  // message renders in the result area instead.
  let buttonLabel = "Send test"
  if (state.kind === "sending") buttonLabel = "Sending…"
  else if (state.kind === "error") buttonLabel = "Retry test"
  return (
    <div className="space-y-2">
      <SettingStateAction
        action={{
          onClick: testPush.sendTest,
          disabled: state.kind === "sending",
          "aria-describedby": "push-test-reports-disclosure",
          children: (
            <>
              {state.kind === "sending" && (
                <Loader2 aria-hidden className="mr-2 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              )}
              {buttonLabel}
            </>
          ),
        }}
      >
        Sends to every device with push on.
      </SettingStateAction>
      <p id="push-test-reports-disclosure" className={SETTING_MUTED_NOTE_TEXT}>
        Devices on a current version of Threa report back to Threa whether they created it. Those reports expire after
        24 hours and are only shown here.
      </p>
      <TestPushResultView state={state} />
    </div>
  )
}

const PUSH_DEVICE_REASONS: Partial<Record<PushDeviceState, string>> = {
  unsupported: "This browser can't receive push notifications.",
  blocked: "Your browser blocks notifications from Threa. Allow them in the browser's site settings, then reload.",
  "server-off": INSTALLATION_OFF.reason,
}

/** Push on this device, with the notification buttons that only show while pushes reach it. */
function PushDeviceRows({ workspaceId, level }: { workspaceId: string; level: PrefNotificationLevel }) {
  const push = usePushNotifications(workspaceId)
  const state = resolvePushDeviceState(push)

  return (
    <>
      <PushDeviceSetting workspaceId={workspaceId} push={push} state={state} />
      <SettingDependents parent="push-device">
        <PushActionsSection workspaceId={workspaceId} level={level} pushDevice={state} />
      </SettingDependents>
    </>
  )
}

function PushDeviceSetting({
  workspaceId,
  push,
  state,
}: {
  workspaceId: string
  push: ReturnType<typeof usePushNotifications>
  state: PushDeviceState
}) {
  return (
    <SwitchSetting
      setting="push-device"
      checked={state === "on" || state === "subscribing"}
      disabled={state === "subscribing"}
      inactive={PUSH_DEVICE_REASONS[state]}
      onCheckedChange={(checked) => {
        if (!checked) push.unsubscribe()
        else if (state === "error") push.retry()
        else push.requestPermission()
      }}
      description={
        state === "subscribing" ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            Turning on for this device…
          </span>
        ) : undefined
      }
    >
      {state === "on" && (
        // Keyed so results never carry over to another workspace; unmounting on
        // unsubscribe drops them too.
        <TestPushControls key={workspaceId} workspaceId={workspaceId} />
      )}
      {state === "server-off" && (
        <SettingStateAction action={{ onClick: push.retry, children: "Check again" }}>
          Turned on since?
        </SettingStateAction>
      )}
      {state === "error" && (
        <div className="space-y-2">
          <SettingStateAction action={{ onClick: push.retry, children: "Retry" }}>
            Couldn't turn on push notifications for this device.
          </SettingStateAction>
          {push.error && (
            <SettingFieldError>
              {push.error.message}
              {push.error.code ? ` (${push.error.code})` : ""}
            </SettingFieldError>
          )}
          <div className="flex justify-end">
            <Button
              onClick={push.unsubscribe}
              variant="ghost"
              size="sm"
              className={cn("w-full sm:w-auto", SETTING_CONTROL_HEIGHT)}
            >
              Stop trying on this device
            </Button>
          </div>
        </div>
      )}
    </SwitchSetting>
  )
}

const RESUME = "resume"
const CUSTOM_DURATION = "custom-duration"
const CUSTOM_TIME = "custom-time"

/**
 * Manually pause notifications (do-not-disturb). A status set to pause
 * notifications drives the same state, so the row also shows a status-driven
 * pause and how to end it.
 */
function PauseSetting({ workspaceId }: { workspaceId: string }) {
  const [custom, setCustom] = useState<"duration" | "time" | null>(null)
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")
  const [customDuration, setCustomDuration] = useState<{ amount: number; unit: CustomDurationUnit }>({
    amount: 30,
    unit: "minutes",
  })
  const ids = settingIds("pause")

  const { active, statusOnly, busy, pauseFor, pauseUntilDate, pauseUntilLocal, resume } = useNotificationPauseControls(
    workspaceId,
    () => setCustom(null)
  )

  const openCustomTime = () => {
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000)
    setCustomDate(toDateInputValue(inAnHour))
    setCustomTime(toTimeInputValue(inAnHour))
    setCustom("time")
  }

  const pick = (choice: string) => {
    if (choice === RESUME) resume()
    else if (choice === CUSTOM_DURATION) setCustom("duration")
    else if (choice === CUSTOM_TIME) openCustomTime()
    else {
      const option = NOTIFICATION_PAUSE_OPTIONS.find((candidate) => candidate.id === choice)
      if (option) pauseFor(option)
    }
  }

  // Picking an entry acts once; the field always reads the current state.
  const control = statusOnly ? null : (
    <Select value="" disabled={busy} onValueChange={pick}>
      <SelectTrigger
        id={ids.control}
        aria-labelledby={ids.label}
        aria-describedby={ids.description}
        className={SETTING_CONTROL_CLASS}
      >
        <SelectValue placeholder={active ? "Paused" : "Not paused"} />
      </SelectTrigger>
      <SelectContent>
        {active && <SelectItem value={RESUME}>Resume now</SelectItem>}
        {NOTIFICATION_PAUSE_OPTIONS.filter((option) => option.duration !== null).map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
        <SelectItem value={CUSTOM_DURATION}>Custom duration…</SelectItem>
        <SelectItem value={CUSTOM_TIME}>Until a specific time…</SelectItem>
        {NOTIFICATION_PAUSE_OPTIONS.filter((option) => option.duration === null).map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  let description: ReactNode = settingDef("pause").description
  if (active) {
    description = (
      <>
        {formatNotificationPauseLabel(active)}.{" "}
        {statusOnly ? "Set by your status. Clear the status to resume." : "Nothing pushes until then."}
      </>
    )
  }

  const customActions = (onPause: () => void, canPause = true) => (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setCustom(null)}
        disabled={busy}
        className={cn("w-full sm:w-auto", SETTING_CONTROL_HEIGHT)}
      >
        Cancel
      </Button>
      <Button
        size="sm"
        onClick={onPause}
        disabled={busy || !canPause}
        className={cn("w-full sm:w-auto", SETTING_CONTROL_HEIGHT)}
      >
        Pause
      </Button>
    </div>
  )
  let customPanel: ReactNode = null
  if (custom === "duration") {
    const customUntil = customDurationToDate(customDuration.amount, customDuration.unit)
    customPanel = (
      <div className="space-y-3">
        <CustomDurationPicker
          onSubmit={pauseUntilDate}
          onDurationChange={(amount, unit) => setCustomDuration({ amount, unit })}
          initialAmount={customDuration.amount}
          initialUnit={customDuration.unit}
          showSubmit={false}
          disabled={busy}
          className="px-0 py-0"
          controlClassName={SETTING_CONTROL_HEIGHT}
        />
        {customActions(() => customUntil && pauseUntilDate(customUntil), !!customUntil)}
      </div>
    )
  } else if (custom === "time") {
    customPanel = (
      <div className="space-y-3">
        <DateTimeField
          date={customDate}
          time={customTime}
          onDateChange={setCustomDate}
          onTimeChange={setCustomTime}
          minDate={toDateInputValue(new Date())}
          density="compact"
        />
        {customActions(() => pauseUntilLocal(customDate, customTime))}
      </div>
    )
  }

  return (
    <SettingRow setting="pause" labelFor={false} control={control} description={description}>
      {customPanel}
    </SettingRow>
  )
}

/** The account level sits above each stream's own: where to change one stream. */
function NotificationLevelDescription() {
  const settings = useOptionalSettings()
  const streamId = useRouteStreamId()
  return (
    <>
      {settingDef("notification-level").description} Each stream can push less; channels default to{" "}
      {SETTING_CHOICE_LABELS["stream-notifications"][NOTIFICATION_CONFIG.channel.defaultLevel].toLowerCase()}.{" "}
      {settings && (
        <SettingsLink to={settings.getStreamSettingsUrl(streamId, "general", "stream-notifications")}>
          {streamId ? "This stream's notifications" : "Pick a stream"}
        </SettingsLink>
      )}
    </>
  )
}

export function NotificationsSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference } = usePreferences()
  const level = preferences?.notificationLevel ?? "all"

  return (
    <div className="space-y-8">
      <SettingsSection section="notify-when">
        <ChoiceSetting
          setting="notification-level"
          value={level}
          options={PREF_NOTIFICATION_LEVEL_OPTIONS.map((value) => ({
            value,
            label: SETTING_CHOICE_LABELS["notification-level"][value],
            description: NOTIFICATION_LEVEL_DESCRIPTIONS[value],
          }))}
          description={<NotificationLevelDescription />}
          onValueChange={(value) => void updatePreference("notificationLevel", value)}
        />
        {workspaceId && <PauseSetting workspaceId={workspaceId} />}
      </SettingsSection>

      {workspaceId && (
        <SettingsSection section="notify-device">
          <PushDeviceRows workspaceId={workspaceId} level={level} />
        </SettingsSection>
      )}
    </div>
  )
}
