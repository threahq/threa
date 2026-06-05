import { useEffect, useState } from "react"
import { Moon } from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { DateTimeField } from "@/components/forms/date-time-field"
import { useNotificationPauseControls } from "@/hooks/use-notification-pause-controls"
import { toDateInputValue, toTimeInputValue } from "@/lib/dates"
import { NOTIFICATION_PAUSE_OPTIONS, formatNotificationPauseLabel } from "@/lib/status"

interface PauseNotificationsDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Quick "pause notifications" picker reached from the sidebar account menu —
 * the manual do-not-disturb lever, independent of status. Reuses the shared
 * `useNotificationPauseControls` so it stays in lockstep with the settings
 * surface; only the chrome (a dialog vs. a settings section) differs.
 */
export function PauseNotificationsDialog({ workspaceId, open, onOpenChange }: PauseNotificationsDialogProps) {
  const { active, statusOnly, busy, pauseFor, pauseUntilLocal, resume } = useNotificationPauseControls(
    workspaceId,
    () => onOpenChange(false)
  )

  const [customOpen, setCustomOpen] = useState(false)
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")

  // Reset the custom-time editor each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setCustomOpen(false)
    const inAnHour = new Date(Date.now() + 60 * 60 * 1000)
    setCustomDate(toDateInputValue(inAnHour))
    setCustomTime(toTimeInputValue(inAnHour))
  }, [open])

  const timedOptions = NOTIFICATION_PAUSE_OPTIONS.filter((o) => o.duration !== null)
  const indefiniteOptions = NOTIFICATION_PAUSE_OPTIONS.filter((o) => o.duration === null)

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-sm">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Pause notifications</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Silence notifications on all your devices for a while, independent of your status.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3 pb-6 pt-1">
          {active && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 p-3">
              <div className="flex min-w-0 items-center gap-2">
                <Moon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{formatNotificationPauseLabel(active)}</p>
                  {statusOnly && <p className="text-xs text-muted-foreground">Set by your status.</p>}
                </div>
              </div>
              {!statusOnly && (
                <Button variant="outline" size="sm" onClick={resume} disabled={busy}>
                  Resume
                </Button>
              )}
            </div>
          )}

          {customOpen ? (
            <div className="space-y-3">
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
                <Button size="sm" onClick={() => pauseUntilLocal(customDate, customTime)} disabled={busy}>
                  Pause
                </Button>
              </div>
            </div>
          ) : (
            <div className="-mx-1 space-y-0.5">
              {timedOptions.map((option) => (
                <PauseOptionRow key={option.id} label={option.label} disabled={busy} onClick={() => pauseFor(option)} />
              ))}
              <PauseOptionRow label="Until a specific time…" disabled={busy} onClick={() => setCustomOpen(true)} />
              {indefiniteOptions.map((option) => (
                <PauseOptionRow key={option.id} label={option.label} disabled={busy} onClick={() => pauseFor(option)} />
              ))}
            </div>
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function PauseOptionRow({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
    >
      {label}
    </button>
  )
}
