import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { RotateCcw } from "lucide-react"
import { usePreferences } from "@/contexts"
import {
  SHORTCUT_ACTIONS,
  getShortcutsByCategory,
  getEffectiveKeyBinding,
  formatKeyBinding,
  formatKeyBindingText,
  detectConflicts,
  keyEventToBinding,
  resolveShortcutBindingUpdate,
  type ShortcutAction,
} from "@/lib/keyboard-shortcuts"
import { DEFAULT_USER_PREFERENCES, MESSAGE_SEND_MODE_OPTIONS, type MessageSendMode } from "@threa/types"

const SEND_MODE_CONFIG: Record<MessageSendMode, { label: string; description: string }> = {
  enter: {
    label: "Enter to send",
    description: "Press Enter to send, Shift+Enter for new line",
  },
  cmdEnter: {
    label: "⌘/Ctrl + Enter to send",
    description: "Press ⌘+Enter (Mac) or Ctrl+Enter (Windows) to send",
  },
}

function getBadgeLabel(
  isCapturing: boolean,
  conflictInfo: { binding: string } | null,
  binding: string | undefined
): string {
  if (isCapturing) {
    return conflictInfo ? formatKeyBinding(conflictInfo.binding) : "Press keys..."
  }
  return binding ? formatKeyBinding(binding) : "—"
}

interface ShortcutRowProps {
  action: ShortcutAction
  customBindings: Record<string, string>
  capturingId: string | null
  onStartCapture: (id: string) => void
  onCancelCapture: () => void
  onSaveBinding: (actionId: string, binding: string) => void
  onResetBinding: (actionId: string) => void
}

function ShortcutRow({
  action,
  customBindings,
  capturingId,
  onStartCapture,
  onCancelCapture,
  onSaveBinding,
  onResetBinding,
}: ShortcutRowProps) {
  const isCapturing = capturingId === action.id
  const [pendingBinding, setPendingBinding] = useState<string | null>(null)
  const [conflictInfo, setConflictInfo] = useState<{ binding: string; conflictIds: string[] } | null>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const binding = getEffectiveKeyBinding(action.id, customBindings)
  const isCustom = action.id in customBindings && customBindings[action.id] !== action.defaultKey
  const conflictLabels =
    conflictInfo?.conflictIds
      .map((id) => SHORTCUT_ACTIONS.find((shortcutAction) => shortcutAction.id === id)?.label)
      .filter((label): label is string => Boolean(label)) ?? []
  const conflictOwnersLabel = conflictLabels.join(", ")
  const keepLabel = conflictLabels.length === 1 ? `Keep ${conflictOwnersLabel}` : "Keep current owners"

  const handleCapturedBinding = useCallback(
    (captured: string) => {
      const testBindings = { ...customBindings, [action.id]: captured }
      const conflicts = detectConflicts(testBindings)
      const conflicting = conflicts.get(captured)?.filter((id) => id !== action.id) ?? []

      if (conflicting.length > 0) {
        setPendingBinding(captured)
        setConflictInfo({ binding: captured, conflictIds: conflicting })
      } else {
        onSaveBinding(action.id, captured)
      }
    },
    [action.id, customBindings, onSaveBinding]
  )

  useEffect(() => {
    if (!isCapturing) {
      setPendingBinding(null)
      setConflictInfo(null)
      return
    }

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      if (e.key === "Escape") {
        onCancelCapture()
        return
      }

      const captured = keyEventToBinding(e)
      if (!captured) return

      handleCapturedBinding(captured)
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [isCapturing, onCancelCapture, handleCapturedBinding])

  useEffect(() => {
    if (isCapturing) {
      badgeRef.current?.focus()
    }
  }, [isCapturing])

  const handleConfirmConflict = useCallback(() => {
    if (!pendingBinding || !conflictInfo) return
    onSaveBinding(action.id, pendingBinding)
  }, [action.id, pendingBinding, conflictInfo, onSaveBinding])

  return (
    <div className="space-y-2" data-shortcut-row>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">{action.label}</p>
          <p className="text-xs text-muted-foreground">{action.description}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isCustom && !isCapturing && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => onResetBinding(action.id)}
                    aria-label="Reset to default"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Reset to default
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Popover open={isCapturing} onOpenChange={(open) => !open && onCancelCapture()}>
            <PopoverAnchor asChild>
              <button
                ref={badgeRef}
                type="button"
                onClick={() => (isCapturing ? onCancelCapture() : onStartCapture(action.id))}
                title={!isCapturing && binding ? formatKeyBindingText(binding) : undefined}
                className={
                  isCapturing
                    ? "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-mono font-semibold border-primary bg-primary/10 text-primary animate-pulse cursor-pointer focus:outline-none"
                    : "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-mono font-semibold border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                }
              >
                {getBadgeLabel(isCapturing, conflictInfo, binding)}
              </button>
            </PopoverAnchor>

            {isCapturing && (
              <PopoverContent align="end" className="w-80 p-3" onOpenAutoFocus={(event) => event.preventDefault()}>
                {conflictInfo ? (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <p className="font-medium text-sm">Move shortcut?</p>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Badge
                          variant="outline"
                          className="mr-1 font-mono"
                          title={formatKeyBindingText(conflictInfo.binding)}
                        >
                          {formatKeyBinding(conflictInfo.binding)}
                        </Badge>
                        is currently used by {conflictOwnersLabel}.
                      </div>
                    </div>

                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">
                          {conflictLabels.length === 1 ? "Current owner" : "Current owners"}
                        </span>
                        <span className="font-medium text-right">{conflictOwnersLabel}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">New owner</span>
                        <span className="font-medium text-right">{action.label}</span>
                      </div>
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={onCancelCapture}>
                        {keepLabel}
                      </Button>
                      <Button size="sm" onClick={handleConfirmConflict}>
                        Move to {action.label}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="font-medium text-sm">Press shortcut keys</p>
                    <div className="flex items-center justify-end">
                      <Button variant="ghost" size="sm" onClick={onCancelCapture}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </PopoverContent>
            )}
          </Popover>
        </div>
      </div>
    </div>
  )
}

function ShortcutCategory({
  title,
  description,
  actions,
  customBindings,
  capturingId,
  onStartCapture,
  onCancelCapture,
  onSaveBinding,
  onResetBinding,
}: {
  title: string
  description: string
  actions: ShortcutAction[]
  customBindings: Record<string, string>
  capturingId: string | null
  onStartCapture: (id: string) => void
  onCancelCapture: () => void
  onSaveBinding: (actionId: string, binding: string) => void
  onResetBinding: (actionId: string) => void
}) {
  if (actions.length === 0) return null

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-3">
        {actions.map((action) => (
          <ShortcutRow
            key={action.id}
            action={action}
            customBindings={customBindings}
            capturingId={capturingId}
            onStartCapture={onStartCapture}
            onCancelCapture={onCancelCapture}
            onSaveBinding={onSaveBinding}
            onResetBinding={onResetBinding}
          />
        ))}
      </div>
    </section>
  )
}

interface KeyboardSettingsProps {
  onCaptureStateChange?: (isCapturing: boolean) => void
}

export function KeyboardSettings({ onCaptureStateChange }: KeyboardSettingsProps = {}) {
  const { preferences, updatePreference, resetKeyboardShortcut, resetAllKeyboardShortcuts } = usePreferences()

  const customBindings = preferences?.keyboardShortcuts ?? {}
  const shortcuts = useMemo(() => getShortcutsByCategory(), [])
  const conflicts = useMemo(() => detectConflicts(customBindings), [customBindings])
  const hasConflicts = conflicts.size > 0
  const hasCustomBindings = Object.keys(customBindings).length > 0
  const messageSendMode = preferences?.messageSendMode ?? "enter"
  const mobileInlineAttachments =
    preferences?.mobileInlineAttachments ?? DEFAULT_USER_PREFERENCES.mobileInlineAttachments

  const [capturingId, setCapturingId] = useState<string | null>(null)

  useEffect(() => {
    onCaptureStateChange?.(capturingId !== null)
  }, [capturingId, onCaptureStateChange])

  useEffect(() => {
    return () => onCaptureStateChange?.(false)
  }, [onCaptureStateChange])

  const handleSaveBinding = useCallback(
    (actionId: string, binding: string) => {
      const nextBindings = resolveShortcutBindingUpdate(customBindings, actionId, binding)
      void updatePreference("keyboardShortcuts", nextBindings)
      setCapturingId(null)
    },
    [customBindings, updatePreference]
  )

  const handleResetBinding = useCallback(
    (actionId: string) => {
      resetKeyboardShortcut(actionId)
    },
    [resetKeyboardShortcut]
  )

  const handleCancelCapture = useCallback(() => {
    setCapturingId(null)
  }, [])

  const handleStartCapture = useCallback((id: string) => {
    setCapturingId(id)
  }, [])

  const sharedProps = {
    customBindings,
    capturingId,
    onStartCapture: handleStartCapture,
    onCancelCapture: handleCancelCapture,
    onSaveBinding: handleSaveBinding,
    onResetBinding: handleResetBinding,
  }

  return (
    <div className="space-y-6">
      {hasConflicts && (
        <>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-destructive">Shortcut Conflicts</h3>
              <p className="text-sm text-muted-foreground">Some shortcuts are using the same key binding</p>
            </div>
            <ul className="space-y-2 text-sm">
              {Array.from(conflicts.entries()).map(([key, actionIds]) => (
                <li key={key}>
                  <Badge variant="outline" className="font-mono mr-2" title={formatKeyBindingText(key)}>
                    {formatKeyBinding(key)}
                  </Badge>
                  <span className="text-muted-foreground">
                    {actionIds
                      .map((id) => SHORTCUT_ACTIONS.find((a) => a.id === id)?.label)
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <Separator />
        </>
      )}

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Send Messages</h3>
          <p className="text-sm text-muted-foreground">Choose how to send messages in the composer</p>
        </div>
        <RadioGroup
          value={messageSendMode}
          onValueChange={(value) => updatePreference("messageSendMode", value as MessageSendMode)}
          className="space-y-3"
        >
          {MESSAGE_SEND_MODE_OPTIONS.map((option) => (
            <div key={option} className="flex items-start space-x-3">
              <RadioGroupItem value={option} id={`send-mode-${option}`} className="mt-1" />
              <div className="grid gap-0.5">
                <Label htmlFor={`send-mode-${option}`} className="cursor-pointer font-medium">
                  {SEND_MODE_CONFIG[option].label}
                </Label>
                <p className="text-sm text-muted-foreground">{SEND_MODE_CONFIG[option].description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>

      <Separator />

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">File attachments</h3>
          <p className="text-sm text-muted-foreground">Control how picked files appear in the mobile composer</p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="mobile-inline-attachments">Insert files at the cursor</Label>
            <p className="text-sm text-muted-foreground">
              Adds a file chip to the message. Removing the chip keeps the file attached.
            </p>
          </div>
          <Switch
            id="mobile-inline-attachments"
            checked={mobileInlineAttachments}
            onCheckedChange={(checked) => updatePreference("mobileInlineAttachments", checked)}
          />
        </div>
      </section>

      {shortcuts.navigation.length > 0 && (
        <>
          <Separator />
          <ShortcutCategory
            title="Navigation"
            description="Keyboard shortcuts for navigating Threa"
            actions={shortcuts.navigation}
            {...sharedProps}
          />
        </>
      )}

      {shortcuts.view.length > 0 && (
        <>
          <Separator />
          <ShortcutCategory
            title="View"
            description="Keyboard shortcuts for view controls"
            actions={shortcuts.view}
            {...sharedProps}
          />
        </>
      )}

      {shortcuts.editing.length > 0 && (
        <>
          <Separator />
          <ShortcutCategory
            title="Editing"
            description="Keyboard shortcuts for formatting in the editor"
            actions={shortcuts.editing}
            {...sharedProps}
          />
        </>
      )}

      {hasCustomBindings && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={resetAllKeyboardShortcuts}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Reset all shortcuts
          </Button>
        </div>
      )}
    </div>
  )
}
