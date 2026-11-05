import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CircleAlert, RotateCcw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { usePreferences } from "@/contexts"
import { useOptionalSettings } from "@/contexts/settings-context"
import {
  QUICK_JUMP_ACTION_ID,
  SHORTCUT_ACTIONS,
  captureBindingForAction,
  conflictingActions,
  defaultKeyOf,
  detectConflicts,
  formatActionBinding,
  formatKeyBindingText,
  getEffectiveKeyBinding,
  getShortcutAction,
  getShortcutsByCategory,
  isCustomBinding,
  isMac,
  isModifierKey,
  occupiedBindings,
  resolveShortcutBindingUpdate,
  shortcutChord,
  type ShortcutAction,
} from "@/lib/keyboard-shortcuts"
import { cn } from "@/lib/utils"
import {
  COMPOSER_ACTION_SIDE_OPTIONS,
  DEFAULT_ACCESSIBILITY,
  DEFAULT_USER_PREFERENCES,
  MESSAGE_SEND_MODE_OPTIONS,
  type ComposerActionSide,
} from "@threahq/types"
import {
  ChoiceSetting,
  SETTING_CONTROL_HEIGHT,
  SettingEmptyNote,
  SettingRow,
  SettingsSection,
  SwitchSetting,
  settingIds,
} from "./setting-primitives"
import { SettingChangedMark } from "./setting-relations"
import {
  SEND_KEY_CHOICE_DESCRIPTIONS,
  SETTINGS,
  SETTING_CHOICE_LABELS,
  SHORTCUT_ANCHOR_PREFIX,
  settingDef,
  type SettingsSectionId,
} from "./settings-registry"
import { FOCUS_FALLBACK, FOCUS_ITEM, FOCUS_SCOPE, useFocusAfterRemoval } from "./use-focus-after-removal"

const SEND_SIDE_LABELS: Record<ComposerActionSide, string> = { right: "Right", left: "Left" }

const CATEGORY_TITLES: Record<ShortcutAction["category"], string> = {
  navigation: "Navigation",
  view: "View",
  editing: "Editing",
}

const CATEGORY_SECTIONS = {
  navigation: "shortcuts-navigation",
  view: "shortcuts-view",
  editing: "shortcuts-editing",
} as const satisfies Record<ShortcutAction["category"], SettingsSectionId>

const CATEGORY_ORDER: ShortcutAction["category"][] = ["navigation", "view", "editing"]

const PRESS_KEYS = "Press the new keys. Esc cancels."

const SHORTCUT_LIST_ID = "settings-shortcut-list"

type ShortcutEdit =
  | { actionId: string; phase: "capture"; hint: string | null }
  | { actionId: string; phase: "conflict"; binding: string; conflictIds: string[] }

function shortcutIds(actionId: string) {
  return settingIds(`${SHORTCUT_ANCHOR_PREFIX}${actionId}`)
}

function focusShortcut(actionId: string) {
  document.getElementById(shortcutIds(actionId).control)?.focus()
}

function actionLabels(ids: string[]): string {
  return ids
    .map((id) => getShortcutAction(id)?.label)
    .filter((label): label is string => Boolean(label))
    .join(", ")
}

function bindingLabel(actionId: string, binding: string | undefined): string {
  return binding ? formatActionBinding(actionId, binding) : "not set"
}

function modifierHint(actionId: string): string {
  if (actionId === QUICK_JUMP_ACTION_ID) return "Hold a modifier and press a number."
  return isMac() ? "Hold ⌘, ⌥ or ⌃ with the key." : "Hold Ctrl or Alt with the key."
}

/** Plain Tab moves focus on; with a modifier it is a chord being captured (⌃Tab). */
function isFocusTab(event: KeyboardEvent): boolean {
  return event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey
}

export function KeyboardSettings({
  onCaptureStateChange,
}: { onCaptureStateChange?: (isCapturing: boolean) => void } = {}) {
  const { preferences, updatePreference, updateAccessibility, resetKeyboardShortcut, resetAllKeyboardShortcuts } =
    usePreferences()
  // Spread over the defaults: a cached blob written before a field existed lacks it.
  const accessibility = { ...DEFAULT_ACCESSIBILITY, ...preferences?.accessibility }
  const customBindings = useMemo(() => preferences?.keyboardShortcuts ?? {}, [preferences?.keyboardShortcuts])
  const shortcuts = useMemo(() => getShortcutsByCategory(), [])
  const conflicts = useMemo(() => detectConflicts(customBindings), [customBindings])
  const focusAfterRemoval = useFocusAfterRemoval()

  const [edit, setEdit] = useState<ShortcutEdit | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [filter, setFilter] = useState("")
  const [changedOnly, setChangedOnly] = useState(false)
  const changedCount = SHORTCUT_ACTIONS.filter((action) => isCustomBinding(action, customBindings)).length
  const showChangedOnly = changedOnly && changedCount > 0
  const filterWords = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const filtering = filterWords.length > 0 || showChangedOnly
  const visibleShortcuts = CATEGORY_ORDER.map((category) => ({
    category,
    actions: shortcuts[category].filter(
      (action) =>
        matchesFilter(action, filterWords, customBindings) &&
        (!showChangedOnly || isCustomBinding(action, customBindings))
    ),
  })).filter(({ actions }) => actions.length > 0)
  const visibleCount = visibleShortcuts.reduce((count, { actions }) => count + actions.length, 0)

  // A link to a shortcut the filter hides clears the filter, in this render, so the landing finds the row.
  const settings = useOptionalSettings()
  const landingOn = settings?.activeSetting?.startsWith(SHORTCUT_ANCHOR_PREFIX)
    ? settings.activeSetting.slice(SHORTCUT_ANCHOR_PREFIX.length)
    : null
  const [handledLanding, setHandledLanding] = useState<string | null>(null)
  if (landingOn && settings && handledLanding !== settings.landingKey) {
    setHandledLanding(settings.landingKey)
    if (!visibleShortcuts.some(({ actions }) => actions.some((action) => action.id === landingOn))) {
      setFilter("")
      setChangedOnly(false)
    }
  }

  useEffect(() => {
    onCaptureStateChange?.(edit !== null)
  }, [edit, onCaptureStateChange])

  useEffect(() => () => onCaptureStateChange?.(false), [onCaptureStateChange])

  const save = useCallback(
    async (actionId: string, binding: string) => {
      const label = getShortcutAction(actionId)?.label
      setEdit(null)
      focusShortcut(actionId)
      try {
        await updatePreference("keyboardShortcuts", resolveShortcutBindingUpdate(customBindings, actionId, binding))
        setAnnouncement(`${label} is now ${formatActionBinding(actionId, binding)}.`)
      } catch {
        setAnnouncement(`Couldn't change ${label}. Its shortcut is unchanged.`)
      }
    },
    [customBindings, updatePreference]
  )

  const cancel = useCallback((actionId: string, restoreFocus: boolean) => {
    setEdit(null)
    setAnnouncement(`${getShortcutAction(actionId)?.label} unchanged.`)
    if (restoreFocus) focusShortcut(actionId)
  }, [])

  useEffect(() => {
    if (!edit) return
    const label = getShortcutAction(edit.actionId)?.label

    function handleKeyDown(event: KeyboardEvent) {
      if (!edit) return
      if (edit.phase === "conflict") {
        // The choice is ordinary buttons, so only Escape is ours.
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopImmediatePropagation()
        cancel(edit.actionId, true)
        return
      }
      if (isFocusTab(event)) {
        cancel(edit.actionId, false)
        return
      }
      // Window capture phase, so nothing else (the settings window's Escape, app
      // shortcuts) sees the keys being recorded.
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === "Escape") {
        cancel(edit.actionId, true)
        return
      }
      const captured = captureBindingForAction(edit.actionId, event)
      if (!captured) {
        if (isModifierKey(event.key)) return
        const hint = modifierHint(edit.actionId)
        setEdit({ ...edit, hint })
        setAnnouncement(hint)
        return
      }
      const conflictIds = conflictingActions(customBindings, edit.actionId, captured)
      if (conflictIds.length === 0) {
        void save(edit.actionId, captured)
        return
      }
      setEdit({ actionId: edit.actionId, phase: "conflict", binding: captured, conflictIds })
      setAnnouncement(
        `${formatActionBinding(edit.actionId, captured)} is already used by ${actionLabels(conflictIds)}. Move it to ${label}, or keep it.`
      )
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [edit, customBindings, save, cancel])

  const startCapture = (actionId: string) => {
    setEdit({ actionId, phase: "capture", hint: null })
    setAnnouncement(`Press the new keys for ${getShortcutAction(actionId)?.label}. Escape cancels.`)
  }

  const resetOne = async (actionId: string) => {
    const action = getShortcutAction(actionId)
    const defaultKey = action && defaultKeyOf(action)
    focusShortcut(actionId)
    // Under "Changed", the reset row leaves the list.
    const control = document.getElementById(shortcutIds(actionId).control)
    if (control) focusAfterRemoval(control)
    try {
      await resetKeyboardShortcut(actionId)
      setAnnouncement(`${action?.label} reset to ${bindingLabel(actionId, defaultKey)}.`)
    } catch {
      setAnnouncement(`Couldn't reset ${action?.label}.`)
    }
  }

  const resetAll = async () => {
    document.getElementById(settingIds("shortcuts").row)?.focus()
    try {
      await resetAllKeyboardShortcuts()
      setAnnouncement("All shortcuts reset to their defaults.")
    } catch {
      setAnnouncement("Couldn't reset the shortcuts.")
    }
  }

  const shortcutsDescription =
    conflicts.size > 0 ? `${settingDef("shortcuts").description} Some share keys and are marked below.` : undefined
  const filterBar = (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          {...FOCUS_FALLBACK}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by name or keys"
          aria-label="Filter shortcuts"
          aria-controls={SHORTCUT_LIST_ID}
          className={cn("pl-9", SETTING_CONTROL_HEIGHT)}
        />
      </div>
      {changedCount > 0 && (
        <Toggle
          variant="outline"
          pressed={showChangedOnly}
          onPressedChange={setChangedOnly}
          aria-controls={SHORTCUT_LIST_ID}
          className={cn("shrink-0 px-3 text-sm", SETTING_CONTROL_HEIGHT)}
        >
          Changed ({changedCount})
        </Toggle>
      )}
    </div>
  )
  const filterCount = (
    <p aria-live="polite" className="sr-only">
      {filtering ? `${visibleCount} of ${SHORTCUT_ACTIONS.length} shortcuts` : ""}
    </p>
  )
  const shortcutSections = visibleShortcuts.map(({ category, actions }) => (
    <SettingsSection key={category} section={CATEGORY_SECTIONS[category]}>
      {actions.map((action) => (
        <ShortcutRow
          key={action.id}
          action={action}
          customBindings={customBindings}
          sharedWith={sharedWith(conflicts, customBindings, action.id)}
          edit={edit?.actionId === action.id ? edit : null}
          onStartCapture={startCapture}
          onCancel={cancel}
          onSave={save}
          onReset={resetOne}
        />
      ))}
    </SettingsSection>
  ))

  return (
    <div className="space-y-8">
      <SettingsSection section="sending">
        <ChoiceSetting
          setting="send-key"
          value={preferences?.messageSendMode ?? "enter"}
          options={MESSAGE_SEND_MODE_OPTIONS.map((value) => ({
            value,
            label: SETTING_CHOICE_LABELS["send-key"][value],
            description: SEND_KEY_CHOICE_DESCRIPTIONS[value],
          }))}
          variant="segmented"
          onValueChange={(value) => updatePreference("messageSendMode", value)}
        />
        <ChoiceSetting
          setting="send-side"
          value={accessibility.composerActionSide}
          options={COMPOSER_ACTION_SIDE_OPTIONS.map((value) => ({ value, label: SEND_SIDE_LABELS[value] }))}
          onValueChange={(value) => updateAccessibility({ composerActionSide: value })}
        />
      </SettingsSection>

      <SettingsSection section={SETTINGS["file-insert"].section}>
        <SwitchSetting
          setting="file-insert"
          checked={preferences?.mobileInlineAttachments ?? DEFAULT_USER_PREFERENCES.mobileInlineAttachments}
          onCheckedChange={(checked) => updatePreference("mobileInlineAttachments", checked)}
        />
      </SettingsSection>

      <div {...FOCUS_SCOPE} id={SHORTCUT_LIST_ID} className="space-y-8">
        <SettingsSection
          section="shortcuts"
          aside={
            changedCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className={cn("gap-1.5 px-2", SETTING_CONTROL_HEIGHT)}
                onClick={resetAll}
              >
                <RotateCcw aria-hidden />
                Reset to defaults
              </Button>
            )
          }
        >
          <SettingRow setting="shortcuts" labelFor={false} description={shortcutsDescription}>
            {filterBar}
            {filterCount}
            {visibleCount === 0 && (
              <div className="mt-3">
                <SettingEmptyNote>No shortcuts match.</SettingEmptyNote>
              </div>
            )}
          </SettingRow>
        </SettingsSection>
        {shortcutSections}
      </div>
      {/* Last, so the sr-only node never takes the first section's place in the page's spacing. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}

interface ShortcutRowProps {
  action: ShortcutAction
  customBindings: Record<string, string>
  /** Other actions whose current keys collide with this one. */
  sharedWith: string[]
  edit: ShortcutEdit | null
  onStartCapture: (actionId: string) => void
  onCancel: (actionId: string, restoreFocus: boolean) => void
  onSave: (actionId: string, binding: string) => void
  onReset: (actionId: string) => void
}

function ShortcutRow({
  action,
  customBindings,
  sharedWith,
  edit,
  onStartCapture,
  onCancel,
  onSave,
  onReset,
}: ShortcutRowProps) {
  const anchor = `${SHORTCUT_ANCHOR_PREFIX}${action.id}`
  const ids = shortcutIds(action.id)
  const binding = getEffectiveKeyBinding(action.id, customBindings)
  const isCustom = isCustomBinding(action, customBindings)
  const capturing = edit?.phase === "capture"
  const description = capturing ? (edit.hint ?? PRESS_KEYS) : action.description
  const shared = sharedWith.length > 0 && !edit

  return (
    <SettingRow
      label={action.label}
      anchor={anchor}
      landing
      labelFor={false}
      marks={<SettingChangedMark setting={anchor} changed={isCustom} />}
      description={description && (capturing ? <span className="text-foreground">{description}</span> : description)}
      notice={shared ? `Same keys as ${actionLabels(sharedWith)}` : undefined}
      noticeIcon={CircleAlert}
      control={
        <div className="flex items-center gap-1 sm:justify-end">
          {isCustom && !edit && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 text-muted-foreground sm:size-9 [@media(pointer:coarse)]:size-11"
                    onClick={() => onReset(action.id)}
                    aria-label={`Reset ${action.label} to default`}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Reset to default
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <button
            {...FOCUS_ITEM}
            id={ids.control}
            type="button"
            aria-label={
              capturing
                ? `Change shortcut for ${action.label}. Press the new keys`
                : `Change shortcut for ${action.label}, currently ${bindingLabel(action.id, binding)}`
            }
            aria-describedby={
              [description && ids.description, shared && ids.notice].filter(Boolean).join(" ") || undefined
            }
            onClick={() => (capturing ? onCancel(action.id, true) : onStartCapture(action.id))}
            onBlur={() => capturing && onCancel(action.id, false)}
            className={cn(
              "flex min-w-0 flex-1 items-center rounded-md border px-3 text-left text-sm sm:w-40 sm:flex-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              SETTING_CONTROL_HEIGHT,
              capturing
                ? "border-primary bg-primary/10 font-mono font-semibold text-primary motion-safe:animate-pulse"
                : "border-input bg-background hover:bg-muted",
              !capturing && (binding ? "font-mono font-semibold text-foreground" : "text-muted-foreground")
            )}
          >
            <span className="truncate">
              {capturing && "Press keys…"}
              {!capturing && (binding ? formatActionBinding(action.id, binding) : "Not set")}
            </span>
          </button>
        </div>
      }
    >
      {edit?.phase === "conflict" && (
        <ConflictChoice
          action={action}
          binding={edit.binding}
          conflictIds={edit.conflictIds}
          onMove={() => onSave(action.id, edit.binding)}
          onKeep={() => onCancel(action.id, true)}
        />
      )}
    </SettingRow>
  )
}

function ConflictChoice({
  action,
  binding,
  conflictIds,
  onMove,
  onKeep,
}: {
  action: ShortcutAction
  binding: string
  conflictIds: string[]
  onMove: () => void
  onKeep: () => void
}) {
  const moveRef = useRef<HTMLButtonElement>(null)
  const textId = `${shortcutIds(action.id).control}-conflict`
  const owners = actionLabels(conflictIds)

  useEffect(() => {
    moveRef.current?.focus()
  }, [])

  return (
    <div role="group" aria-labelledby={textId} className="space-y-3">
      <p id={textId} className="text-sm">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono font-semibold">{formatActionBinding(action.id, binding)}</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {formatKeyBindingText(binding)}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>{" "}
        is already used by {owners}. Moving it leaves {owners} without a shortcut.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" className={SETTING_CONTROL_HEIGHT} onClick={onKeep}>
          {conflictIds.length === 1 ? `Keep for ${owners}` : "Keep as is"}
        </Button>
        <Button ref={moveRef} size="sm" className={SETTING_CONTROL_HEIGHT} onClick={onMove}>
          Move to {action.label}
        </Button>
      </div>
    </div>
  )
}

/** Every word of the filter appears in the action's name, description, category or keys. */
function matchesFilter(action: ShortcutAction, words: string[], customBindings: Record<string, string>): boolean {
  if (words.length === 0) return true
  const binding = getEffectiveKeyBinding(action.id, customBindings)
  const haystack = [
    action.label,
    action.description,
    CATEGORY_TITLES[action.category],
    binding,
    binding && formatKeyBindingText(binding),
    binding && formatActionBinding(action.id, binding),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

function sharedWith(conflicts: Map<string, string[]>, customBindings: Record<string, string>, actionId: string) {
  const binding = getEffectiveKeyBinding(actionId, customBindings)
  if (!binding) return []
  const ids = occupiedBindings(actionId, binding).flatMap((occupied) => conflicts.get(shortcutChord(occupied)) ?? [])
  return [...new Set(ids)].filter((id) => id !== actionId)
}
