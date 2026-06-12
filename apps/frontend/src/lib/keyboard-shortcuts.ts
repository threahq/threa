/**
 * Keyboard shortcuts registry and utilities.
 *
 * This module defines available keyboard shortcuts and their defaults.
 * Users can customize shortcuts via preferences.
 */

export interface ShortcutAction {
  id: string
  label: string
  description: string
  defaultKey: string
  category: "navigation" | "editing" | "view"
  /** If true, shortcut works even when focus is in an input field */
  global?: boolean
}

/**
 * All available shortcut actions with their defaults.
 * Key format uses "mod" as a platform-agnostic modifier (Cmd on Mac, Ctrl elsewhere).
 */
export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: "openQuickSwitcher",
    label: "Quick Switcher",
    description: "Open stream picker",
    defaultKey: "mod+k",
    category: "navigation",
    global: true,
  },
  {
    id: "searchInStream",
    label: "Search in Stream",
    description: "Search messages in the current stream",
    defaultKey: "mod+f",
    category: "navigation",
    global: true,
  },
  {
    id: "openSearch",
    label: "Search",
    description: "Open search",
    defaultKey: "mod+shift+f",
    category: "navigation",
    global: true,
  },
  {
    id: "openCommands",
    label: "Commands",
    description: "Open command palette",
    defaultKey: "mod+shift+k",
    category: "navigation",
    global: true,
  },
  {
    id: "openSettings",
    label: "Settings",
    description: "Open settings",
    defaultKey: "mod+.",
    category: "view",
    global: true,
  },
  {
    id: "toggleSidebar",
    label: "Toggle Sidebar",
    description: "Show or hide the sidebar",
    defaultKey: "mod+§",
    category: "view",
    global: true,
  },
  {
    id: "openAttachmentExplorer",
    label: "Browse Files",
    description: "Open the attachment explorer",
    defaultKey: "mod+shift+a",
    category: "navigation",
    global: true,
  },
  {
    id: "copyStreamLink",
    label: "Copy Link",
    // Default avoids plain mod+L — browsers reserve that to focus the address
    // bar and won't surrender it. Rebindable in keyboard settings like the rest.
    description: "Copy a link to the focused stream or thread",
    defaultKey: "mod+shift+l",
    category: "navigation",
    global: true,
  },
  // Pane / side-panel management
  {
    id: "focusNextPane",
    label: "Focus Next Pane",
    description: "Move focus to the next pane (main view and side panels)",
    defaultKey: "mod+alt+arrowright",
    category: "view",
    global: true,
  },
  {
    id: "focusPreviousPane",
    label: "Focus Previous Pane",
    description: "Move focus to the previous pane (main view and side panels)",
    defaultKey: "mod+alt+arrowleft",
    category: "view",
    global: true,
  },
  {
    id: "closeFocusedPanel",
    label: "Close Panel",
    // mod+w is reserved by browsers (close tab) and can't be intercepted.
    description: "Close the focused side panel",
    defaultKey: "mod+alt+w",
    category: "view",
    global: true,
  },
  {
    id: "movePanelLeft",
    label: "Move Panel Left",
    description: "Move the focused side panel one slot to the left",
    defaultKey: "mod+alt+shift+arrowleft",
    category: "view",
    global: true,
  },
  {
    id: "movePanelRight",
    label: "Move Panel Right",
    description: "Move the focused side panel one slot to the right",
    defaultKey: "mod+alt+shift+arrowright",
    category: "view",
    global: true,
  },
  // Editor formatting shortcuts (not global — only active when editor is focused)
  {
    id: "formatBold",
    label: "Bold",
    description: "Toggle bold formatting",
    defaultKey: "mod+b",
    category: "editing",
  },
  {
    id: "formatItalic",
    label: "Italic",
    description: "Toggle italic formatting",
    defaultKey: "mod+i",
    category: "editing",
  },
  {
    id: "formatStrike",
    label: "Strikethrough",
    description: "Toggle strikethrough formatting",
    defaultKey: "mod+shift+s",
    category: "editing",
  },
  {
    id: "formatCode",
    label: "Inline Code",
    description: "Toggle inline code formatting",
    defaultKey: "mod+e",
    category: "editing",
  },
  {
    id: "formatCodeBlock",
    label: "Code Block",
    description: "Toggle code block",
    defaultKey: "mod+shift+c",
    category: "editing",
  },
  {
    id: "draftStash",
    label: "Save Draft",
    description: "Stash the current composer content into the saved-drafts pile and clear the editor",
    defaultKey: "mod+s",
    category: "editing",
  },
]

/**
 * Get shortcut action by ID.
 */
export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((a) => a.id === id)
}

/**
 * Get all shortcuts grouped by category.
 */
export function getShortcutsByCategory(): Record<ShortcutAction["category"], ShortcutAction[]> {
  const result: Record<ShortcutAction["category"], ShortcutAction[]> = {
    navigation: [],
    editing: [],
    view: [],
  }

  for (const action of SHORTCUT_ACTIONS) {
    result[action.category].push(action)
  }

  return result
}

/**
 * Get the effective key binding for an action, considering user customizations.
 * Returns undefined if the shortcut is explicitly disabled ("none") or unregistered.
 */
export function getEffectiveKeyBinding(
  actionId: string,
  customBindings: Record<string, string> = {}
): string | undefined {
  const custom = customBindings[actionId]
  if (custom === "none") return undefined
  if (custom) return custom
  return getShortcutAction(actionId)?.defaultKey
}

/**
 * Detect conflicts in keyboard shortcuts.
 * Returns a map of key bindings to the action IDs that use them.
 */
export function detectConflicts(customBindings: Record<string, string> = {}): Map<string, string[]> {
  const keyToActions = new Map<string, string[]>()

  for (const action of SHORTCUT_ACTIONS) {
    const key = getEffectiveKeyBinding(action.id, customBindings)
    if (!key) continue
    const existing = keyToActions.get(key) || []
    keyToActions.set(key, [...existing, action.id])
  }

  // Filter to only return conflicts (more than one action per key)
  const conflicts = new Map<string, string[]>()
  for (const [key, actions] of keyToActions) {
    if (actions.length > 1) {
      conflicts.set(key, actions)
    }
  }

  return conflicts
}

/**
 * Check if the current platform is Mac.
 */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

/**
 * Parse a key string like "mod+k" into keyboard event properties.
 * Returns null if the event doesn't match.
 */
export function parseKeyBinding(key: string): {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
} {
  const parts = key.toLowerCase().split("+")
  let mod = false
  let shift = false
  let alt = false
  let keyStartIndex = 0

  while (keyStartIndex < parts.length) {
    const part = parts[keyStartIndex]
    if (part === "mod") {
      mod = true
      keyStartIndex += 1
      continue
    }

    if (part === "shift") {
      shift = true
      keyStartIndex += 1
      continue
    }

    if (part === "alt") {
      alt = true
      keyStartIndex += 1
      continue
    }

    break
  }

  const actualKey = parts.slice(keyStartIndex).join("+")

  return {
    key: actualKey,
    mod,
    shift,
    alt,
  }
}

/**
 * Check if a keyboard event matches a key binding.
 */
export function matchesKeyBinding(event: KeyboardEvent, binding: string): boolean {
  const parsed = parseKeyBinding(binding)
  // Accept either metaKey OR ctrlKey for "mod" - cross-platform compatibility
  const modPressed = event.metaKey || event.ctrlKey

  // Handle special vim-style escape
  if (parsed.key === "[" && event.ctrlKey && event.key === "[") {
    return true
  }

  return (
    event.key.toLowerCase() === parsed.key &&
    modPressed === parsed.mod &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt
  )
}

/**
 * Format a key binding for display.
 * Converts "mod+k" to "⌘K" on Mac or "Ctrl+K" elsewhere.
 */
export function formatKeyBinding(binding: string): string {
  const mac = isMac()
  const parsed = parseKeyBinding(binding)
  if (!parsed.key) {
    return binding
  }

  const formatted: string[] = []
  if (parsed.mod) formatted.push(mac ? "⌘" : "Ctrl")
  if (parsed.shift) formatted.push(mac ? "⇧" : "Shift")
  if (parsed.alt) formatted.push(mac ? "⌥" : "Alt")

  switch (parsed.key.toLowerCase()) {
    case "escape":
      formatted.push(mac ? "⎋" : "Esc")
      break
    case ",":
      formatted.push(",")
      break
    case "+":
      formatted.push("+")
      break
    default:
      formatted.push(parsed.key.toUpperCase())
      break
  }

  return mac ? formatted.join("") : formatted.join("+")
}

/**
 * Format a key binding as plain text for hover text and accessibility.
 * Converts "mod+k" to "cmd+k" on Mac or "ctrl+k" elsewhere.
 */
export function formatKeyBindingText(binding: string): string {
  const mac = isMac()
  const parsed = parseKeyBinding(binding)
  if (!parsed.key) {
    return binding
  }

  const formatted: string[] = []
  if (parsed.mod) formatted.push(mac ? "cmd" : "ctrl")
  if (parsed.shift) formatted.push("shift")
  if (parsed.alt) formatted.push(mac ? "opt" : "alt")

  switch (parsed.key.toLowerCase()) {
    case "escape":
      formatted.push("escape")
      break
    case ",":
      formatted.push(",")
      break
    case "+":
      formatted.push("+")
      break
    default:
      formatted.push(parsed.key.toLowerCase())
      break
  }

  return formatted.join("+")
}

/** Keys that are only modifiers and should not be captured as standalone bindings. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"])
/**
 * Keys reserved by the app and never bindable as custom shortcuts.
 * Escape is hardcoded to cancel/close flows across the app (Radix Dialog, capture UI,
 * local popovers), so we refuse to capture it as a binding for any action.
 */
const RESERVED_KEYS = new Set(["escape"])

function isFunctionKey(key: string): boolean {
  return /^f([1-9]|1[0-2])$/i.test(key)
}

export function isSafeShortcutBinding(binding: string): boolean {
  const parsed = parseKeyBinding(binding)
  if (!parsed.key) {
    return false
  }

  if (RESERVED_KEYS.has(parsed.key.toLowerCase())) {
    return false
  }

  if (parsed.mod || parsed.alt) {
    return true
  }

  return isFunctionKey(parsed.key.toLowerCase())
}

/**
 * Convert a KeyboardEvent to a normalized binding string (e.g. "mod+shift+f").
 * Returns null for lone modifier presses or unsafe bare keys that would hijack normal typing.
 */
export function keyEventToBinding(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push("mod")
  if (event.shiftKey) parts.push("shift")
  if (event.altKey) parts.push("alt")
  parts.push(event.key.toLowerCase())

  const binding = parts.join("+")
  return isSafeShortcutBinding(binding) ? binding : null
}

/**
 * IDs of all editor formatting shortcut actions.
 */
export const EDITOR_SHORTCUT_IDS = [
  "formatBold",
  "formatItalic",
  "formatStrike",
  "formatCode",
  "formatCodeBlock",
] as const

/**
 * Compute effective editor formatting bindings, excluding any that conflict
 * with a global app-level shortcut (app shortcuts always win).
 */
export function getEffectiveEditorBindings(customBindings: Record<string, string> = {}): Record<string, string> {
  // Collect all global app-level binding values
  const globalBindings = new Set<string>()
  for (const action of SHORTCUT_ACTIONS) {
    if (!action.global) continue
    const binding = getEffectiveKeyBinding(action.id, customBindings)
    if (binding) globalBindings.add(binding)
  }

  // Build editor bindings, excluding any claimed by a global shortcut
  const result: Record<string, string> = {}
  for (const id of EDITOR_SHORTCUT_IDS) {
    const binding = getEffectiveKeyBinding(id, customBindings)
    if (binding && isSafeShortcutBinding(binding) && !globalBindings.has(binding)) {
      result[id] = binding
    }
  }
  return result
}

export function resolveShortcutBindingUpdate(
  customBindings: Record<string, string> = {},
  actionId: string,
  binding: string
): Record<string, string> {
  const nextBindings = { ...customBindings }
  const testBindings = { ...customBindings, [actionId]: binding }
  const conflicts = detectConflicts(testBindings)
  const conflicting = conflicts.get(binding)?.filter((id) => id !== actionId) ?? []

  for (const conflictId of conflicting) {
    nextBindings[conflictId] = "none"
  }

  nextBindings[actionId] = binding
  return nextBindings
}
