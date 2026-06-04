import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Smile, X } from "lucide-react"
import { toast } from "sonner"
import {
  type StatusPreset,
  type WorkspaceBootstrap,
  MAX_STATUS_PRESETS,
  STATUS_TEXT_MAX_LENGTH,
  isStatusContentful,
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
import { cn } from "@/lib/utils"

interface StatusPickerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const CUSTOM_OPTION_ID = "custom"
const NEW_PRESET_ID_PREFIX = "status_"

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
  const [customDate, setCustomDate] = useState("")
  const [customTime, setCustomTime] = useState("")

  // Seed the editor from the user's current status each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setEmoji(currentUser?.statusEmoji ?? null)
    setText(currentUser?.statusText ?? "")
    setDurationId("never")
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    setCustomDate(toDateInputValue(tomorrow))
    setCustomTime(toTimeInputValue(tomorrow))
    // Re-seed only when the dialog opens; depending on `currentUser` would
    // clobber the draft mid-edit when a socket update lands. `currentUser` is
    // read at open time, which is the intended snapshot.
  }, [open])

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const emojiGlyph = emoji ? toEmoji(emoji) : null
  const contentful = isStatusContentful({ emoji, text: text.trim() || null })
  const busy = setStatus.isPending || clearStatus.isPending

  const applyPreset = (preset: StatusPreset) => {
    setEmoji(preset.emoji)
    setText(preset.text ?? "")
    const match = STATUS_DURATION_OPTIONS.find((o) => durationsEqual(o.duration, preset.defaultDuration))
    setDurationId(match?.id ?? "never")
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
      await setStatus.mutateAsync({ emoji, text: text.trim() || null, expiresAt: resolveExpiry() })
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
        <ResponsiveDialogBody className="space-y-5 pb-6">
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
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => {
                const glyph = preset.emoji ? toEmoji(preset.emoji) : null
                const removable = userPresetIds.has(preset.id)
                return (
                  <span key={preset.id} className="inline-flex">
                    <button
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border border-input px-3 py-1 text-sm hover:bg-muted/50",
                        removable && "rounded-r-none border-r-0"
                      )}
                    >
                      {glyph && <span className="leading-none">{glyph}</span>}
                      {preset.text && <span className="truncate">{preset.text}</span>}
                    </button>
                    {removable && (
                      <button
                        type="button"
                        aria-label={`Remove ${preset.text ?? "status"} preset`}
                        onClick={() => handleRemovePreset(preset.id)}
                        className="inline-flex items-center rounded-full rounded-l-none border border-input px-1.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
          )}

          <div className="space-y-2">
            <Label>Clear after</Label>
            <div className="flex flex-wrap gap-2">
              {STATUS_DURATION_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setDurationId(option.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm",
                    durationId === option.id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input hover:bg-muted/50"
                  )}
                >
                  {option.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDurationId(CUSTOM_OPTION_ID)}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  durationId === CUSTOM_OPTION_ID
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-input hover:bg-muted/50"
                )}
              >
                Custom…
              </button>
            </div>
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
