import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { BellOff, Smile, X } from "lucide-react"
import { toast } from "sonner"
import {
  type StatusPreset,
  type WorkspaceBootstrap,
  MAX_STATUS_PRESETS,
  STATUS_TEXT_MAX_LENGTH,
  isStatusContentful,
  presetPausesNotifications,
} from "@threa/types"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { DateTimeField } from "@/components/forms/date-time-field"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import { useSetStatus, useClearStatus, workspaceKeys } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useEffectiveWorkSchedule } from "@/hooks/use-work-schedule"
import { usePreferencesOptional } from "@/contexts"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import { useAuth } from "@/auth"
import { toDateInputValue, toTimeInputValue, parseLocalDateTime } from "@/lib/dates"
import { STATUS_DURATION_OPTIONS, durationsEqual, mergeStatusPresets, statusDurationToExpiry } from "@/lib/status"

interface StatusPickerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CUSTOM_OPTION_ID = "custom"
const NEW_PRESET_ID_PREFIX = "status_"

/** Human label for a preset's default duration, shown beside it in the list. */
function presetDurationLabel(preset: StatusPreset): string {
  return STATUS_DURATION_OPTIONS.find((o) => durationsEqual(o.duration, preset.defaultDuration))?.label ?? "Don't clear"
}

// "Don't clear" reads best at the top of the menu (matches Slack); the rest
// keep their declaration order.
const ORDERED_DURATION_OPTIONS = [
  ...STATUS_DURATION_OPTIONS.filter((o) => o.id === "never"),
  ...STATUS_DURATION_OPTIONS.filter((o) => o.id !== "never"),
]

/**
 * Set, change, or clear the current user's cosmetic status. Reuses the reaction
 * emoji picker for the glyph and the scheduling duration presets for expiry, so
 * it matches the rest of the app. Custom presets the user saves here are stored
 * on their preferences and shown additively alongside the workspace defaults.
 */
export function StatusPicker({ workspaceId, open, onOpenChange }: StatusPickerProps) {
  const { user: authUser } = useAuth()
  const users = useWorkspaceUsers(workspaceId)
  const currentUser = useMemo(() => users.find((u) => u.workosUserId === authUser?.id) ?? null, [users, authUser?.id])

  const { toEmoji, toShortcode } = useWorkspaceEmoji(workspaceId)
  const schedule = useEffectiveWorkSchedule(workspaceId)
  const prefs = usePreferencesOptional()
  const userPresets = prefs?.preferences?.statusPresets ?? []
  const workspacePresets = useWorkspacePresets(workspaceId)
  const presets = useMemo(() => mergeStatusPresets(workspacePresets, userPresets), [workspacePresets, userPresets])
  const userPresetIds = useMemo(() => new Set(userPresets.map((p) => p.id)), [userPresets])

  const setStatus = useSetStatus(workspaceId)
  const clearStatus = useClearStatus(workspaceId)

  // Editor state — `emoji` is a shortcode (no colons), matching storage.
  const [emoji, setEmoji] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [durationId, setDurationId] = useState<string>("never")
  // Whether the user has explicitly chosen a clear-time. Once they have, picking
  // a different preset must NOT override their choice — only the emoji/text change.
  const [durationTouched, setDurationTouched] = useState(false)
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")
  // Whether this status should also silence notifications for its lifetime.
  const [pausesNotifications, setPausesNotifications] = useState(false)

  // Seed the editor from the user's current status each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setEmoji(currentUser?.statusEmoji ?? null)
    setText(currentUser?.statusText ?? "")
    setDurationId("never")
    setDurationTouched(false)
    setPausesNotifications(currentUser?.statusPausesNotifications ?? false)
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    setCustomDate(toDateInputValue(tomorrow))
    setCustomTime(toTimeInputValue(tomorrow))
    // Re-seed only when the dialog opens; depending on `currentUser` would
    // clobber the draft mid-edit when a socket update lands. `currentUser` is
    // read at open time, which is the intended snapshot.
  }, [open])

  /** Manual clear-time change — locks the choice against later preset picks. */
  const handleDurationChange = (id: string) => {
    setDurationId(id)
    setDurationTouched(true)
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const emojiGlyph = emoji ? toEmoji(emoji) : null
  const contentful = isStatusContentful({ emoji, text: text.trim() || null })
  const busy = setStatus.isPending || clearStatus.isPending

  const applyPreset = (preset: StatusPreset) => {
    setEmoji(preset.emoji)
    setText(preset.text ?? "")
    setPausesNotifications(presetPausesNotifications(preset))
    // Respect a clear-time the user explicitly chose; otherwise adopt the
    // preset's default duration.
    if (!durationTouched) {
      const match = STATUS_DURATION_OPTIONS.find((o) => durationsEqual(o.duration, preset.defaultDuration))
      setDurationId(match?.id ?? "never")
    }
  }

  const handleEmojiSelect = (picked: string) => {
    // The picker emits a unicode glyph; store the shortcode to match the rest
    // of the codebase (personas/bots/labels/reactions). Fall back to clearing
    // if the glyph isn't in the workspace set (shouldn't happen).
    setEmoji(toShortcode(picked))
  }

  const resolveExpiry = (): string | null => {
    if (durationId === CUSTOM_OPTION_ID) {
      const when = parseLocalDateTime(customDate, customTime)
      return when ? when.toISOString() : null
    }
    const option = STATUS_DURATION_OPTIONS.find((o) => o.id === durationId)
    return statusDurationToExpiry(option?.duration ?? null, timezone, schedule)
  }

  const handleSet = async () => {
    if (!contentful) return
    // A "Custom" choice with an unparseable date/time must not silently fall
    // back to an indefinite status — abort and prompt for a valid time.
    if (durationId === CUSTOM_OPTION_ID && resolveExpiry() === null) {
      toast.error("Pick a valid custom date and time")
      return
    }
    try {
      await setStatus.mutateAsync({ emoji, text: text.trim() || null, expiresAt: resolveExpiry(), pausesNotifications })
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to set status")
    }
  }

  const handleClear = async () => {
    try {
      await clearStatus.mutateAsync()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear status")
    }
  }

  const handleSavePreset = async () => {
    if (!contentful || !prefs) return
    if (userPresets.length >= MAX_STATUS_PRESETS) {
      toast.error("You've reached the maximum number of saved statuses")
      return
    }
    const option = durationId === CUSTOM_OPTION_ID ? null : STATUS_DURATION_OPTIONS.find((o) => o.id === durationId)
    const preset: StatusPreset = {
      id: `${NEW_PRESET_ID_PREFIX}${crypto.randomUUID()}`,
      emoji,
      text: text.trim() || null,
      // Custom absolute times don't translate to a reusable preset duration, so
      // a preset saved from a custom time is indefinite.
      defaultDuration: option?.duration ?? null,
      pausesNotifications,
    }
    try {
      await prefs.updatePreference("statusPresets", [...userPresets, preset])
    } catch {
      // updatePreference surfaces its own toast on failure.
    }
  }

  const handleRemovePreset = async (id: string) => {
    if (!prefs) return
    try {
      await prefs.updatePreference(
        "statusPresets",
        userPresets.filter((p) => p.id !== id)
      )
    } catch {
      // updatePreference surfaces its own toast on failure.
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Set a status</ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            Choose an emoji and text to show beside your name.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/* pt-1.5 keeps the input's focus ring from being clipped by the body's
            own overflow-y-auto top edge. */}
        <ResponsiveDialogBody className="space-y-4 pb-6 pt-1.5">
          <div className="flex items-center gap-2">
            <ReactionEmojiPicker
              workspaceId={workspaceId}
              onSelect={handleEmojiSelect}
              trigger={
                <button
                  type="button"
                  aria-label="Pick a status emoji"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-input text-lg hover:bg-muted/50"
                >
                  {emojiGlyph ?? <Smile className="h-5 w-5 text-muted-foreground" />}
                </button>
              }
            />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={STATUS_TEXT_MAX_LENGTH}
              placeholder="What's your status?"
              className="flex-1"
            />
            {emoji && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove emoji"
                onClick={() => setEmoji(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {presets.length > 0 && (
            <div className="-mx-1 space-y-0.5">
              {presets.map((preset) => {
                const glyph = preset.emoji ? toEmoji(preset.emoji) : null
                const removable = userPresetIds.has(preset.id)
                return (
                  <div key={preset.id} className="flex items-center rounded-md hover:bg-muted/50">
                    <button
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                    >
                      {glyph ? (
                        <span className="w-5 shrink-0 text-center leading-none">{glyph}</span>
                      ) : (
                        <span className="w-5 shrink-0" />
                      )}
                      <span className="truncate font-medium">{preset.text}</span>
                      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                        {presetDurationLabel(preset)}
                      </span>
                    </button>
                    {removable && (
                      <button
                        type="button"
                        aria-label={`Remove ${preset.text ?? "status"} preset`}
                        onClick={() => handleRemovePreset(preset.id)}
                        // Always visible — this dialog is a drawer on mobile where
                        // there is no hover to reveal it.
                        className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="status-clear-after">Clear after</Label>
            <Select value={durationId} onValueChange={handleDurationChange}>
              <SelectTrigger id="status-clear-after" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDERED_DURATION_OPTIONS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_OPTION_ID}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {durationId === CUSTOM_OPTION_ID && (
              <DateTimeField
                date={customDate}
                time={customTime}
                onDateChange={setCustomDate}
                onTimeChange={setCustomTime}
                minDate={toDateInputValue(new Date())}
                density="compact"
              />
            )}
          </div>

          <label
            htmlFor="status-pause-notifications"
            className="flex items-center justify-between gap-3 rounded-md border border-input px-3 py-2"
          >
            <span className="flex min-w-0 items-center gap-2">
              <BellOff className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Pause notifications</span>
                <span className="block text-xs text-muted-foreground">Don't notify me while this status is set</span>
              </span>
            </span>
            <Switch
              id="status-pause-notifications"
              checked={pausesNotifications}
              onCheckedChange={setPausesNotifications}
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-2">
              {(currentUser?.statusEmoji || currentUser?.statusText) && (
                <Button type="button" variant="ghost" size="sm" onClick={handleClear} disabled={busy}>
                  Clear status
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleSavePreset}
                disabled={!contentful || busy || !prefs}
              >
                Save as preset
              </Button>
            </div>
            <Button type="button" size="sm" onClick={handleSet} disabled={!contentful || busy}>
              Set status
            </Button>
          </div>
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

/**
 * Read the workspace's configured status presets from the bootstrap cache via
 * the cache-only observer pattern (mirrors `useWorkspaceDefaultWorkSchedule`).
 * Undefined until the bootstrap lands; `mergeStatusPresets` falls back to the
 * system presets in that gap.
 */
function useWorkspacePresets(workspaceId: string): StatusPreset[] | undefined {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.workspaceSettings?.userStatusPresets ?? null,
  })
  return data ?? undefined
}
