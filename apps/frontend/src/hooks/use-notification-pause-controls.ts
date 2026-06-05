import { toast } from "sonner"
import { resolveNotificationPause, type ActiveNotificationPause } from "@threa/types"
import { useCurrentWorkspaceUser, usePauseNotifications, useResumeNotifications } from "@/hooks"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"
import { parseLocalDateTime } from "@/lib/dates"
import { type NotificationPauseOption, statusDurationToExpiry } from "@/lib/status"

export interface NotificationPauseControls {
  /** The active pause (do-not-disturb), or null when notifications are flowing. */
  active: ActiveNotificationPause | null
  /** True when the pause is driven only by a status — there's no manual lever to resume here. */
  statusOnly: boolean
  /** A pause/resume mutation is in flight. */
  busy: boolean
  /** Pause for a preset option (a relative/calendar duration, or `null` for indefinite). */
  pauseFor: (option: NotificationPauseOption) => void
  /** Pause until a specific local date/time; returns false (and toasts) when the time is invalid or past. */
  pauseUntilLocal: (date: string, time: string) => boolean
  /** Resume notifications, clearing the manual pause. */
  resume: () => void
}

/**
 * Shared orchestration for the manual notification pause, so every surface that
 * exposes it (the settings section, the sidebar account menu dialog) drives the
 * same hooks and resolution rather than reimplementing the glue (INV-35). The
 * optional `onDone` fires after a successful pause/resume — callers use it to
 * close their dialog/menu.
 */
export function useNotificationPauseControls(workspaceId: string, onDone?: () => void): NotificationPauseControls {
  const currentUser = useCurrentWorkspaceUser(workspaceId)
  const schedule = useEffectiveWorkSchedule(workspaceId)
  const pause = usePauseNotifications(workspaceId)
  const resume = useResumeNotifications(workspaceId)

  const active = currentUser ? resolveNotificationPause(currentUser, new Date()) : null
  const statusOnly = active?.source === "status"
  const busy = pause.isPending || resume.isPending
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

  const pauseUntil = async (until: string | null) => {
    try {
      await pause.mutateAsync(until)
      onDone?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pause notifications")
    }
  }

  const pauseFor = (option: NotificationPauseOption) => {
    void pauseUntil(option.duration ? statusDurationToExpiry(option.duration, timezone, schedule) : null)
  }

  const pauseUntilLocal = (date: string, time: string): boolean => {
    const when = parseLocalDateTime(date, time)
    if (!when || when.getTime() <= Date.now()) {
      toast.error("Pick a time in the future")
      return false
    }
    void pauseUntil(when.toISOString())
    return true
  }

  const handleResume = async () => {
    try {
      await resume.mutateAsync()
      onDone?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to resume notifications")
    }
  }

  return { active, statusOnly, busy, pauseFor, pauseUntilLocal, resume: handleResume }
}
