import { useMemo, useState } from "react"
import { Bell, BellOff, Calendar as CalendarIcon, ChevronLeft } from "lucide-react"
import { toast } from "sonner"
import type { SavedMessageView } from "@threa/types"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useSaveMessage, useUpdateSaved } from "@/hooks/use-saved"
import { ReminderBadge } from "@/components/saved/reminder-badge"
import { REMINDER_PRESETS, computeRemindAt } from "@/lib/reminder-presets"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"
import { DateTimeField } from "@/components/forms/date-time-field"
import { parseLocalDateTime, toDateInputValue, toTimeInputValue } from "@/lib/dates"

interface ReminderPickerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** Null for standalone saved items — those always carry a `saved` row, so the save-new path never runs. */
  messageId: string | null
  /** Current saved state (null if not yet saved). Controls save-vs-update behaviour. */
  saved: SavedMessageView | null
}

/**
 * Mobile bottom-sheet for picking a reminder time. "Pick a time…" swaps the
 * preset list for an inline date/time picker so the action row stays near the
 * bottom of the screen — no thumb-jump to a centered dialog.
 *
 * Date and time are kept as separate native inputs so each segment opens its
 * own platform picker on tap — Android's `datetime-local` only reacts to the
 * trailing calendar icon, which meant users couldn't edit just the time.
 */
export function ReminderPickerSheet({ open, onOpenChange, workspaceId, messageId, saved }: ReminderPickerSheetProps) {
  // Browser-local timezone — never use `preferences.timezone` in the UI
  // because native pickers always operate in device-local.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const workSchedule = useEffectiveWorkSchedule(workspaceId)
  const saveMutation = useSaveMessage(workspaceId)
  const updateMutation = useUpdateSaved(workspaceId)
  const [mode, setMode] = useState<"presets" | "custom">("presets")
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")

  // Date's `min` is today — the time input can't express a past-today clamp
  // without extra logic, so we let the server-side clamp catch "today at 9am
  // when it's already noon".
  const minDate = useMemo(() => toDateInputValue(new Date()), [open, mode])

  const openCustom = () => {
    // If a reminder is already set, pre-populate with that; otherwise default
    // to now + 15 minutes so the picker opens on a sensible seed.
    const baseline = saved?.remindAt ? new Date(saved.remindAt) : new Date(Date.now() + 15 * 60_000)
    setCustomDate(toDateInputValue(baseline))
    setCustomTime(toTimeInputValue(baseline))
    setMode("custom")
  }

  const resetAndClose = () => {
    setMode("presets")
    setCustomDate("")
    setCustomTime("")
    onOpenChange(false)
  }

  const setReminder = (date: Date | null) => {
    if (!saved) {
      if (!messageId) return
      saveMutation.mutate(
        { messageId, remindAt: date?.toISOString() ?? null },
        {
          onSuccess: () => {
            toast.success(date ? "Reminder set" : "Saved")
            resetAndClose()
          },
          onError: () => toast.error("Could not save"),
        }
      )
      return
    }
    updateMutation.mutate(
      { savedId: saved.id, input: { remindAt: date?.toISOString() ?? null } },
      {
        onSuccess: () => {
          toast.success(date ? "Reminder set" : "Reminder cleared")
          resetAndClose()
        },
        onError: () => toast.error("Could not update reminder"),
      }
    )
  }

  const handleCustom = () => {
    const parsed = parseLocalDateTime(customDate, customTime)
    if (!parsed) {
      toast.error("Invalid date")
      return
    }
    setReminder(parsed)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Reset mode when drawer closes so the next open starts on the preset list.
      setMode("presets")
      setCustomDate("")
      setCustomTime("")
    }
    onOpenChange(nextOpen)
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent className="max-h-[85vh]">
        <div className="flex flex-col px-5 pt-3 pb-6 pb-safe">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              {mode === "custom" && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 -ml-2 rounded-full"
                  onClick={() => setMode("presets")}
                  aria-label="Back to presets"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Button>
              )}
              <DrawerTitle className="text-lg font-semibold">{resolveTitle(mode, saved)}</DrawerTitle>
            </div>
            {saved && mode === "presets" && (
              <ReminderBadge remindAt={saved.remindAt} reminderSentAt={saved.reminderSentAt} className="text-xs" />
            )}
          </div>

          {mode === "presets" ? (
            <div className="flex flex-col gap-1">
              {REMINDER_PRESETS.map((preset) => (
                <SheetMenuButton
                  key={preset.label}
                  onClick={() => setReminder(computeRemindAt(preset, new Date(), timezone, workSchedule))}
                >
                  <Bell className="h-4 w-4 text-muted-foreground" />
                  {preset.label}
                </SheetMenuButton>
              ))}
              <SheetMenuButton onClick={openCustom}>
                <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                Pick a time…
              </SheetMenuButton>
              {saved?.remindAt && (
                <SheetMenuButton onClick={() => setReminder(null)}>
                  <BellOff className="h-4 w-4 text-muted-foreground" />
                  Clear reminder
                </SheetMenuButton>
              )}
            </div>
          ) : (
            // Keep the inputs + Set button grouped at the bottom of the sheet
            // so the tap target is close to the thumb that just opened the
            // drawer.
            <div className="flex flex-col gap-4">
              <DateTimeField
                date={customDate}
                time={customTime}
                onDateChange={setCustomDate}
                onTimeChange={setCustomTime}
                minDate={minDate}
              />
              <Button
                className="w-full h-12 text-base"
                onClick={handleCustom}
                disabled={!customDate || !customTime || saveMutation.isPending || updateMutation.isPending}
              >
                Set reminder
              </Button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

function resolveTitle(mode: "presets" | "custom", saved: SavedMessageView | null): string {
  if (mode === "custom") return "Pick a reminder time"
  return saved ? "Reminder" : "Save & remind"
}

interface SheetMenuButtonProps {
  children: React.ReactNode
  onClick: () => void
  className?: string
}

function SheetMenuButton({ children, onClick, className }: SheetMenuButtonProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn("w-full justify-start gap-3 h-11 text-sm font-normal px-3", className)}
    >
      {children}
    </Button>
  )
}
