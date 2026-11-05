import { useId, useMemo, useState, type FormEvent } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { Pencil, RotateCcw, Smile } from "lucide-react"
import {
  SYSTEM_DEFAULT_STATUSES,
  STATUS_TEXT_MAX_LENGTH,
  MAX_STATUS_PRESETS,
  isStatusContentful,
  presetPausesNotifications,
  type StatusPreset,
  type WorkspaceBootstrap,
} from "@threahq/types"
import { useCachedWorkspaceBootstrap, workspaceKeys } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { STATUS_DURATION_OPTIONS, durationsEqual } from "@/lib/status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import {
  INACTIVE_CONTROL_CLASS,
  SETTING_CONTROL_CLASS,
  SETTING_CONTROL_HEIGHT,
  SettingAddButton,
  SettingControlSkeleton,
  SettingFieldError,
  SettingRemoveButton,
  SettingRow,
  SettingsSection,
  settingIds,
  useSettingDescribedBy,
} from "@/components/settings/setting-primitives"
import { SETTING_MUTED_NOTE_TEXT, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import {
  FOCUS_FALLBACK,
  FOCUS_ITEM,
  FOCUS_SCOPE,
  useFocusAfterRemoval,
} from "@/components/settings/use-focus-after-removal"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface StatusesTabProps {
  workspaceId: string
}

const NEVER_OPTION = STATUS_DURATION_OPTIONS.find((o) => o.id === "never")!

function durationOptionFor(duration: StatusPreset["defaultDuration"]) {
  return STATUS_DURATION_OPTIONS.find((o) => durationsEqual(o.duration, duration)) ?? NEVER_OPTION
}

function presetMeta(preset: StatusPreset): string {
  const duration = durationOptionFor(preset.defaultDuration).label
  return presetPausesNotifications(preset) ? `${duration} · Pauses notifications` : duration
}

function cachedPresets(queryClient: QueryClient, workspaceId: string): StatusPreset[] {
  return (
    queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))?.workspaceSettings
      ?.userStatusPresets ?? SYSTEM_DEFAULT_STATUSES
  )
}

interface PresetEditor {
  preset: StatusPreset
  isNew: boolean
  open: boolean
}

export function StatusesTab({ workspaceId }: StatusesTabProps) {
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const access = useWorkspaceAccess(workspaceId)
  const canManage = access.allowed
  const save = useWorkspaceSettingMutation(workspaceId, "userStatusPresets", "Couldn't save the statuses")
  const saveFromDialog = useWorkspaceSettingMutation(workspaceId, "userStatusPresets", "Couldn't save the status", {
    errorShownInPlace: true,
  })
  const [editor, setEditor] = useState<PresetEditor | null>(null)
  const [confirmDefaults, setConfirmDefaults] = useState(false)
  const focusAfterRemoval = useFocusAfterRemoval()
  const queryClient = useQueryClient()

  const saved = useMemo<StatusPreset[]>(
    () => bootstrap?.workspaceSettings?.userStatusPresets ?? SYSTEM_DEFAULT_STATUSES,
    [bootstrap?.workspaceSettings?.userStatusPresets]
  )
  const usingDefaults = JSON.stringify(saved) === JSON.stringify(SYSTEM_DEFAULT_STATUSES)
  const full = canManage && saved.length >= MAX_STATUS_PRESETS
  const addDescribedBy = useSettingDescribedBy("status-presets", {
    extra: [full && settingIds("status-presets").reason],
  })

  const openEditor = (preset: StatusPreset, isNew: boolean) => {
    saveFromDialog.reset()
    setEditor({ preset, isNew, open: true })
  }
  const closeEditor = (presetId: string) =>
    setEditor((current) => (current?.preset.id === presetId ? { ...current, open: false } : current))

  // Edits derive from the cache, not this render's `saved`: the optimistic write
  // lands there before a second click can, the re-render showing it may not.
  const latestPresets = () => cachedPresets(queryClient, workspaceId)

  const savePreset = async (next: StatusPreset, isNew: boolean) => {
    const current = latestPresets()
    await saveFromDialog.mutateAsync(isNew ? [...current, next] : current.map((p) => (p.id === next.id ? next : p)))
    closeEditor(next.id)
  }

  const removePreset = (id: string, button: HTMLElement) => {
    focusAfterRemoval(button)
    save.mutate(latestPresets().filter((p) => p.id !== id))
  }

  return (
    <SettingsSection
      section="defaults-status"
      aside={
        canManage &&
        !usingDefaults && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("gap-1.5 px-2", SETTING_CONTROL_HEIGHT)}
            onClick={() => setConfirmDefaults(true)}
          >
            <RotateCcw aria-hidden />
            Reset to defaults
          </Button>
        )
      }
    >
      <div {...FOCUS_SCOPE}>
        <SettingRow
          setting="status-presets"
          labelFor={false}
          description={accessDescription("status-presets", access)}
          inactive={full && `A workspace holds up to ${MAX_STATUS_PRESETS} statuses. Remove one to add another.`}
          control={
            !access.known ? (
              <SettingControlSkeleton className="w-32" />
            ) : (
              canManage && (
                <SettingAddButton
                  {...FOCUS_FALLBACK}
                  aria-disabled={full || undefined}
                  aria-describedby={addDescribedBy}
                  className={INACTIVE_CONTROL_CLASS}
                  onClick={() =>
                    !full &&
                    openEditor(
                      {
                        id: `status_${crypto.randomUUID()}`,
                        emoji: null,
                        text: "",
                        defaultDuration: null,
                        pausesNotifications: false,
                      },
                      true
                    )
                  }
                >
                  New status
                </SettingAddButton>
              )
            )
          }
        >
          <ul aria-labelledby={settingIds("status-presets").label} className="divide-y divide-border">
            {saved.map((preset, index) =>
              access.known ? (
                <StatusPresetItem
                  key={preset.id}
                  workspaceId={workspaceId}
                  preset={preset}
                  name={presetName(preset, index)}
                  onEdit={canManage ? () => openEditor(preset, false) : undefined}
                  onRemove={canManage ? (button) => removePreset(preset.id, button) : undefined}
                />
              ) : (
                <li key={preset.id} className="py-2">
                  <SettingControlSkeleton className="w-full" />
                </li>
              )
            )}
          </ul>
        </SettingRow>
      </div>

      <ResponsiveDialog
        open={editor?.open ?? false}
        onOpenChange={(open) => !open && editor && !saveFromDialog.isPending && closeEditor(editor.preset.id)}
        disableSnapPoints
        historyEntry={false}
      >
        <ResponsiveDialogContent desktopClassName="max-w-md" drawerClassName="max-h-[92dvh]">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{editor?.isNew ? "New status" : "Edit status"}</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          {editor?.open && (
            <StatusPresetForm
              workspaceId={workspaceId}
              preset={editor.preset}
              isPending={saveFromDialog.isPending}
              saveFailed={saveFromDialog.isError}
              onSave={(next) => savePreset(next, editor.isNew).catch(() => undefined)}
              onCancel={() => closeEditor(editor.preset.id)}
            />
          )}
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialog open={confirmDefaults} onOpenChange={setConfirmDefaults}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset statuses to the defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the workspace&apos;s statuses with Threa&apos;s defaults for everyone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => save.mutate(SYSTEM_DEFAULT_STATUSES)}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}

/** What a preset is called in controls' names: its text, else its position. */
function presetName(preset: StatusPreset, index: number): string {
  return preset.text?.trim() || `Status ${index + 1}`
}

/** One preset as a list item: emoji and name, its duration and pause as the meta line, then Edit and remove for admins. */
function StatusPresetItem({
  workspaceId,
  preset,
  name,
  onEdit,
  onRemove,
}: {
  workspaceId: string
  preset: StatusPreset
  name: string
  onEdit?: () => void
  onRemove?: (button: HTMLElement) => void
}) {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const hasText = Boolean(preset.text?.trim())
  return (
    <li data-slot="status-preset" className="flex min-h-11 items-center gap-3 py-2">
      <span aria-hidden className="w-6 shrink-0 text-center text-base">
        {preset.emoji ? toEmoji(preset.emoji) : null}
      </span>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm font-medium leading-snug [overflow-wrap:anywhere]",
            !hasText && "text-muted-foreground"
          )}
        >
          {name}
        </span>
        <span className={cn("mt-0.5 block text-muted-foreground", SETTING_NOTE_TEXT)}>{presetMeta(preset)}</span>
      </div>
      {onEdit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Edit ${name}`}
          className={cn("shrink-0", SETTING_CONTROL_HEIGHT)}
          onClick={onEdit}
        >
          <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
          Edit
        </Button>
      )}
      {onRemove && (
        <SettingRemoveButton
          label={`Remove ${name}`}
          onClick={(event) => onRemove(event.currentTarget)}
          {...FOCUS_ITEM}
        />
      )}
    </li>
  )
}

function StatusPresetForm({
  workspaceId,
  preset,
  isPending,
  saveFailed,
  onSave,
  onCancel,
}: {
  workspaceId: string
  preset: StatusPreset
  isPending: boolean
  saveFailed: boolean
  onSave: (next: StatusPreset) => void
  onCancel: () => void
}) {
  const ids = { name: useId(), duration: useId(), pause: useId(), pauseHint: useId(), error: useId() }
  const { toEmoji, toShortcode } = useWorkspaceEmoji(workspaceId)
  const [emoji, setEmoji] = useState(preset.emoji)
  const [text, setText] = useState(preset.text ?? "")
  const [duration, setDuration] = useState(preset.defaultDuration)
  const [pauses, setPauses] = useState(presetPausesNotifications(preset))
  const [empty, setEmpty] = useState(false)
  const glyph = emoji ? toEmoji(emoji) : null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next: StatusPreset = {
      ...preset,
      emoji,
      text: text.trim(),
      defaultDuration: duration,
      pausesNotifications: pauses,
    }
    if (!isStatusContentful(next)) {
      setEmpty(true)
      return
    }
    setEmpty(false)
    onSave(next)
  }

  let error: string | null = null
  if (empty) error = "Give the status an emoji or a name."
  else if (saveFailed) error = "Couldn't save the status. Try again."

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} noValidate>
      <ResponsiveDialogBody className="min-h-0 space-y-5 pt-1.5">
        <div className="space-y-2">
          <Label htmlFor={ids.name}>Name</Label>
          <div className="flex items-center gap-2">
            <ReactionEmojiPicker
              workspaceId={workspaceId}
              onSelect={(picked) => {
                setEmoji(toShortcode(picked))
                setEmpty(false)
              }}
              trigger={
                <button
                  type="button"
                  aria-label={glyph ? `Emoji: ${glyph}` : "Pick an emoji"}
                  disabled={isPending}
                  className="flex size-11 shrink-0 items-center justify-center rounded-md border border-input text-base hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9 [@media(pointer:coarse)]:size-11"
                >
                  {glyph ?? <Smile className="h-4 w-4 text-muted-foreground" aria-hidden />}
                </button>
              }
            />
            <Input
              id={ids.name}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                setEmpty(false)
              }}
              maxLength={STATUS_TEXT_MAX_LENGTH}
              placeholder="e.g. Focus time"
              disabled={isPending}
              aria-invalid={empty || undefined}
              aria-describedby={error ? ids.error : undefined}
              className={cn("min-w-0 flex-1", SETTING_CONTROL_HEIGHT)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.duration}>Clears after</Label>
          <Select
            value={durationOptionFor(duration).id}
            onValueChange={(id) => setDuration(STATUS_DURATION_OPTIONS.find((o) => o.id === id)?.duration ?? null)}
            disabled={isPending}
          >
            <SelectTrigger id={ids.duration} className={cn("text-left", SETTING_CONTROL_CLASS)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_DURATION_OPTIONS.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label htmlFor={ids.pause} className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
          <Checkbox
            id={ids.pause}
            className="mt-0.5"
            checked={pauses}
            disabled={isPending}
            aria-describedby={ids.pauseHint}
            onCheckedChange={(checked) => setPauses(checked === true)}
          />
          <span className="grid min-w-0 gap-0.5">
            <span className="text-sm font-medium leading-snug">Pauses notifications</span>
            <span id={ids.pauseHint} className={SETTING_MUTED_NOTE_TEXT}>
              No notifications reach whoever has it set, until it clears.
            </span>
          </span>
        </label>
        {error && <SettingFieldError id={ids.error}>{error}</SettingFieldError>}
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : "Save"}
        </Button>
      </ResponsiveDialogFooter>
    </form>
  )
}
