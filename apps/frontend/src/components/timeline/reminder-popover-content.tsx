import { useMemo, useState } from "react"
import { Bell, BellOff, Archive, Check, Clock, Trash2, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { SavedMessageView, SavedStatus } from "@threa/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSaveMessage, useUpdateSaved, useDeleteSaved } from "@/hooks/use-saved"
import { ReminderBadge } from "@/components/saved/reminder-badge"
import { REMINDER_PRESETS, computeRemindAt } from "@/lib/reminder-presets"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"

interface ReminderPopoverContentProps {
  workspaceId: string
  /** Null for standalone saved items — those always carry a `saved` row, so the save-new path never runs. */
  messageId: string | null
  saved: SavedMessageView | null
}

export function ReminderPopoverContent({ workspaceId, messageId, saved }: ReminderPopoverContentProps) {
  // Browser-local everywhere in the UI — never use `preferences.timezone`
  // here. Native pickers operate in device-local; any drift would silently
  // shift saved reminders by the device-vs-preference offset.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const workSchedule = useEffectiveWorkSchedule(workspaceId)
  const saveMutation = useSaveMessage(workspaceId)
  const updateMutation = useUpdateSaved(workspaceId)
  const deleteMutation = useDeleteSaved(workspaceId)
  const [customOpen, setCustomOpen] = useState(false)
  const [customDateTime, setCustomDateTime] = useState("")
  // Grey out past times in the native picker. Computed once per open so the
  // boundary doesn't jitter as the minute rolls over mid-interaction; the
  // server-side clamp catches the seconds-granularity edge case anyway.
  const minDateTime = useMemo(() => (customOpen ? toDateTimeLocal(new Date()) : ""), [customOpen])

  const openCustom = () => {
    if (customOpen) {
      setCustomOpen(false)
      return
    }
    // Seed with the existing reminder when present, otherwise now + 15 minutes
    // — matches the mobile sheet so both entry points feel identical.
    const baseline = saved?.remindAt ? new Date(saved.remindAt) : new Date(Date.now() + 15 * 60_000)
    setCustomDateTime(toDateTimeLocal(baseline))
    setCustomOpen(true)
  }

  const setReminder = (date: Date | null) => {
    if (!saved) {
      if (!messageId) return
      saveMutation.mutate(
        { messageId, remindAt: date?.toISOString() ?? null },
        {
          onSuccess: () => toast.success(date ? "Reminder set" : "Saved"),
          onError: () => toast.error("Could not save"),
        }
      )
      return
    }
    updateMutation.mutate(
      { savedId: saved.id, input: { remindAt: date?.toISOString() ?? null } },
      {
        onSuccess: () => toast.success(date ? "Reminder set" : "Reminder cleared"),
        onError: () => toast.error("Could not update reminder"),
      }
    )
  }

  const setStatus = (status: SavedStatus, successLabel: string) => {
    if (!saved) return
    updateMutation.mutate(
      { savedId: saved.id, input: { status } },
      {
        onSuccess: () => toast.success(successLabel),
        onError: () => toast.error("Could not update"),
      }
    )
  }

  const remove = () => {
    if (!saved) return
    deleteMutation.mutate(saved.id, {
      onSuccess: () => toast.success("Removed from saved"),
      onError: () => toast.error("Could not remove"),
    })
  }

  const handleCustom = () => {
    if (!customDateTime) return
    const parsed = new Date(customDateTime)
    if (isNaN(parsed.getTime())) {
      toast.error("Invalid date")
      return
    }
    setReminder(parsed)
    setCustomOpen(false)
    setCustomDateTime("")
  }

  const status = saved?.status ?? null

  return (
    <div className="flex flex-col divide-y">
      <div className="flex items-center justify-between px-3 py-2 text-sm">
        <span className="font-medium">
          {saved ? "Saved" : "Save for later"}
          {status && status !== "saved" && (
            <span className="ml-1.5 text-xs text-muted-foreground capitalize">· {status}</span>
          )}
        </span>
        {saved && <ReminderBadge remindAt={saved.remindAt} reminderSentAt={saved.reminderSentAt} className="text-xs" />}
      </div>

      <div className="p-1">
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          Remind me
        </div>
        {REMINDER_PRESETS.map((preset) => (
          <PopoverMenuButton
            key={preset.label}
            onClick={() => setReminder(computeRemindAt(preset, new Date(), timezone, workSchedule))}
          >
            <Bell className="h-3.5 w-3.5" />
            {preset.label}
          </PopoverMenuButton>
        ))}
        <PopoverMenuButton onClick={openCustom}>
          <Bell className="h-3.5 w-3.5" />
          Pick a time…
        </PopoverMenuButton>
        {customOpen && (
          <div className="flex items-center gap-1.5 px-2 py-1">
            <input
              type="datetime-local"
              value={customDateTime}
              min={minDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="flex-1 text-xs rounded border bg-background px-1.5 py-1"
            />
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleCustom}
              disabled={!customDateTime || saveMutation.isPending || updateMutation.isPending}
            >
              Set
            </Button>
          </div>
        )}
        {saved?.remindAt && (
          <PopoverMenuButton onClick={() => setReminder(null)}>
            <BellOff className="h-3.5 w-3.5" />
            Clear reminder
          </PopoverMenuButton>
        )}
      </div>

      {saved && (
        <div className="p-1">
          {status === "saved" && (
            <>
              <PopoverMenuButton onClick={() => setStatus("done", "Marked done")}>
                <Check className="h-3.5 w-3.5" />
                Mark done
              </PopoverMenuButton>
              <PopoverMenuButton onClick={() => setStatus("archived", "Archived")}>
                <Archive className="h-3.5 w-3.5" />
                Archive
              </PopoverMenuButton>
            </>
          )}
          {status !== "saved" && (
            <PopoverMenuButton onClick={() => setStatus("saved", "Restored")}>
              <Undo2 className="h-3.5 w-3.5" />
              Move back to Saved
            </PopoverMenuButton>
          )}
          <PopoverMenuButton
            onClick={remove}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </PopoverMenuButton>
        </div>
      )}
    </div>
  )
}

/** Format a Date as `YYYY-MM-DDTHH:mm` in local time — the shape `<input type="datetime-local">` expects. */
function toDateTimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface PopoverMenuButtonProps {
  children: React.ReactNode
  onClick: () => void
  className?: string
}

function PopoverMenuButton({ children, onClick, className }: PopoverMenuButtonProps) {
  // Shadcn Button with ghost variant (INV-14) — styled as a dense menu row.
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn("w-full justify-start gap-2 h-auto px-2 py-1.5 text-sm font-normal", className)}
    >
      {children}
    </Button>
  )
}
