import { useMemo, useState } from "react"
import { Bell, BellOff, Archive, Check, Clock, Trash2, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { SavedMessageView, SavedStatus } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useSaveMessage, useUpdateSaved, useDeleteSaved } from "@/hooks/use-saved"
import { ReminderBadge } from "@/components/saved/reminder-badge"
import { REMINDER_PRESETS, computeRemindAt } from "@/lib/reminder-presets"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"
import { CustomDurationPicker } from "@/components/scheduling/custom-duration-picker"
import { DateTimeField } from "@/components/forms/date-time-field"
import { parseLocalDateTime, toDateInputValue, toTimeInputValue } from "@/lib/dates"

interface ReminderPopoverContentProps {
  workspaceId: string
  /** Null for standalone saved items — those always carry a `saved` row, so the save-new path never runs. */
  messageId: string | null
  /** Conversation origin for the save-new path; omitted on stream/label surfaces. */
  conversationId?: string
  saved: SavedMessageView | null
  onReminderSet?: () => void
  menu?: boolean
}

export function ReminderPopoverContent({
  workspaceId,
  messageId,
  conversationId,
  saved,
  onReminderSet,
  menu = false,
}: ReminderPopoverContentProps) {
  // Browser-local everywhere in the UI — never use `preferences.timezone`
  // here. Native pickers operate in device-local; any drift would silently
  // shift saved reminders by the device-vs-preference offset.
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const workSchedule = useEffectiveWorkSchedule(workspaceId)
  const saveMutation = useSaveMessage(workspaceId)
  const updateMutation = useUpdateSaved(workspaceId)
  const deleteMutation = useDeleteSaved(workspaceId)
  const [customOpen, setCustomOpen] = useState(false)
  const [durationOpen, setDurationOpen] = useState(false)
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")
  const minDate = useMemo(() => (customOpen ? toDateInputValue(new Date()) : ""), [customOpen])

  const openCustom = () => {
    if (customOpen) {
      setCustomOpen(false)
      return
    }
    setDurationOpen(false)
    // Seed with the existing reminder when present, otherwise now + 15 minutes
    // — matches the mobile sheet so both entry points feel identical.
    const baseline = saved?.remindAt ? new Date(saved.remindAt) : new Date(Date.now() + 15 * 60_000)
    setCustomDate(toDateInputValue(baseline))
    setCustomTime(toTimeInputValue(baseline))
    setCustomOpen(true)
  }

  const toggleDuration = () => {
    setCustomOpen(false)
    setDurationOpen((prev) => !prev)
  }

  const setReminder = (date: Date | null) => {
    if (!saved) {
      if (!messageId) return
      void saveMutation
        .mutateAsync({ messageId, conversationId, remindAt: date?.toISOString() ?? null })
        .then(() => onReminderSet?.())
        .catch(() => toast.error("Could not save"))
      return
    }
    void updateMutation
      .mutateAsync({ savedId: saved.id, input: { remindAt: date?.toISOString() ?? null } })
      .then(() => onReminderSet?.())
      .catch(() => toast.error("Could not update reminder"))
  }

  const setStatus = (status: SavedStatus) => {
    if (!saved) return
    void updateMutation
      .mutateAsync({ savedId: saved.id, input: { status } })
      .then(() => onReminderSet?.())
      .catch(() => toast.error("Could not update"))
  }

  const remove = () => {
    if (!saved) return
    void deleteMutation
      .mutateAsync(saved.id)
      .then(() => onReminderSet?.())
      .catch(() => toast.error("Could not remove"))
  }

  const handleCustom = () => {
    const parsed = parseLocalDateTime(customDate, customTime)
    if (!parsed) {
      toast.error("Invalid date")
      return
    }
    setReminder(parsed)
    setCustomOpen(false)
    setCustomDate("")
    setCustomTime("")
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
            menu={menu}
            onClick={() => setReminder(computeRemindAt(preset, new Date(), timezone, workSchedule))}
          >
            <Bell className="h-3.5 w-3.5" />
            {preset.label}
          </PopoverMenuButton>
        ))}
        <PopoverMenuButton menu={menu} onClick={toggleDuration}>
          <Clock className="h-3.5 w-3.5" />
          Custom duration…
        </PopoverMenuButton>
        {durationOpen && (
          <CustomDurationPicker
            onSubmit={setReminder}
            disabled={saveMutation.isPending || updateMutation.isPending}
            submitLabel="Set reminder"
            autoFocus={menu}
          />
        )}
        <PopoverMenuButton menu={menu} onClick={openCustom}>
          <Bell className="h-3.5 w-3.5" />
          Pick a time…
        </PopoverMenuButton>
        {customOpen && (
          <div className="space-y-2 px-2 py-2">
            <DateTimeField
              date={customDate}
              time={customTime}
              onDateChange={setCustomDate}
              onTimeChange={setCustomTime}
              minDate={minDate}
              autoFocusDate={menu}
              density="compact"
              gridClassName="grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2 [&_input]:min-w-0 [&_input]:px-1.5"
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleCustom}
                disabled={!customDate || !customTime || saveMutation.isPending || updateMutation.isPending}
              >
                Set reminder
              </Button>
            </div>
          </div>
        )}
        {saved?.remindAt && (
          <PopoverMenuButton menu={menu} onClick={() => setReminder(null)}>
            <BellOff className="h-3.5 w-3.5" />
            Clear reminder
          </PopoverMenuButton>
        )}
      </div>

      {saved && (
        <div className="p-1">
          {status === "saved" && (
            <>
              <PopoverMenuButton menu={menu} onClick={() => setStatus("done")}>
                <Check className="h-3.5 w-3.5" />
                Mark done
              </PopoverMenuButton>
              <PopoverMenuButton menu={menu} onClick={() => setStatus("archived")}>
                <Archive className="h-3.5 w-3.5" />
                Archive
              </PopoverMenuButton>
            </>
          )}
          {status !== "saved" && (
            <PopoverMenuButton menu={menu} onClick={() => setStatus("saved")}>
              <Undo2 className="h-3.5 w-3.5" />
              Move back to Saved
            </PopoverMenuButton>
          )}
          <PopoverMenuButton
            menu={menu}
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

interface PopoverMenuButtonProps {
  children: React.ReactNode
  onClick: () => void
  className?: string
  menu?: boolean
}

function PopoverMenuButton({ children, onClick, className, menu }: PopoverMenuButtonProps) {
  if (menu) {
    return (
      <DropdownMenuItem
        className={cn("gap-2 cursor-pointer", className)}
        onSelect={(event) => {
          event.preventDefault()
          onClick()
        }}
      >
        {children}
      </DropdownMenuItem>
    )
  }
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
