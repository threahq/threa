import { isStandaloneApp } from "@/lib/device"

export interface ShortcutAction {
  id: string
  label: string
  description: string
  defaultKey: string
  /** Default in the installed app, which can claim keys a browser tab never sees (⌘W, ⌃Tab). */
  installedKey?: string
  category: "navigation" | "editing" | "view"
  /** If true, shortcut works even when focus is in an input field */
  global?: boolean
  /** Exists only in the installed app (PWA). */
  installedAppOnly?: boolean
}

/** "mod" is the platform-agnostic modifier: Cmd on Mac, Ctrl elsewhere. "ctrl" is
 *  Control itself, for the bindings that mean ⌃ on a Mac too (⌃Tab). */
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
    id: "sidebarQuickJump",
    label: "Sidebar Quick Jump",
    description: "Hold the modifier to number the first nine sidebar streams, then press a digit to open one",
    defaultKey: "mod+1",
    category: "navigation",
    global: true,
    // Every browser switches tabs on Cmd/Ctrl+1-9, and Alt or Shift variants
    // collide with typing (⌥2 is "@" on Nordic Macs) or OS screenshots.
    installedAppOnly: true,
  },
  {
    id: "sidebarNextStream",
    label: "Next Stream",
    description: "Open the stream below the current one in the sidebar",
    defaultKey: "alt+shift+arrowdown",
    category: "navigation",
    global: true,
  },
  {
    id: "sidebarPreviousStream",
    label: "Previous Stream",
    description: "Open the stream above the current one in the sidebar",
    defaultKey: "alt+shift+arrowup",
    category: "navigation",
    global: true,
  },
  {
    id: "historyBack",
    label: "Back",
    description: "Go back in stream history",
    defaultKey: "mod+[",
    category: "navigation",
    global: true,
  },
  {
    id: "historyForward",
    label: "Forward",
    description: "Go forward in stream history",
    defaultKey: "mod+]",
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
    id: "openAgentAgenda",
    label: "Agent Agenda",
    description: "Open follow-ups and delegated tasks",
    defaultKey: "mod+shift+o",
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
  {
    id: "closePane",
    label: "Close Pane",
    description: "Close the pane you're working in",
    defaultKey: "alt+w",
    installedKey: "mod+w",
    category: "view",
    global: true,
  },
  {
    id: "reopenPane",
    label: "Reopen Closed Pane",
    description: "Reopen the pane closed last",
    defaultKey: "alt+shift+t",
    installedKey: "mod+shift+t",
    category: "view",
    global: true,
  },
  {
    id: "nextPaneTab",
    label: "Next Tab",
    description: "Show the next tab in the pane you're working in",
    defaultKey: "alt+]",
    installedKey: "ctrl+tab",
    category: "view",
    global: true,
  },
  {
    id: "previousPaneTab",
    label: "Previous Tab",
    description: "Show the previous tab in the pane you're working in",
    defaultKey: "alt+[",
    installedKey: "ctrl+shift+tab",
    category: "view",
    global: true,
  },
  {
    id: "nextPane",
    label: "Next Pane",
    description: "Move to the pane to the right of or below the one you're working in",
    defaultKey: "alt+.",
    category: "view",
    global: true,
  },
  {
    id: "previousPane",
    label: "Previous Pane",
    description: "Move to the pane to the left of or above the one you're working in",
    defaultKey: "alt+,",
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
  {
    id: "clearInboxStream",
    label: "Settle",
    description: "Settle the hovered Inbox row, or the open stream",
    defaultKey: "e",
    category: "view",
  },
]

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((a) => a.id === id)
}

function isShortcutAvailable(action: ShortcutAction): boolean {
  return !action.installedAppOnly || isStandaloneApp()
}

export function getShortcutsByCategory(): Record<ShortcutAction["category"], ShortcutAction[]> {
  const result: Record<ShortcutAction["category"], ShortcutAction[]> = {
    navigation: [],
    editing: [],
    view: [],
  }

  for (const action of SHORTCUT_ACTIONS) {
    if (isShortcutAvailable(action)) result[action.category].push(action)
  }

  return result
}

/** The action's default where Threa runs now: installed, or in a browser tab. */
export function defaultKeyOf(action: ShortcutAction): string {
  return action.installedKey && isStandaloneApp() ? action.installedKey : action.defaultKey
}

/**
 * Get the effective key binding for an action, considering user customizations.
 * Returns undefined if the shortcut is explicitly disabled ("none"), unregistered,
 * or unavailable where the app is running.
 */
export function getEffectiveKeyBinding(
  actionId: string,
  customBindings: Record<string, string> = {}
): string | undefined {
  const action = getShortcutAction(actionId)
  if (action && !isShortcutAvailable(action)) return undefined
  const custom = customBindings[actionId]
  if (custom === "none") return undefined
  if (custom) return custom
  return action && defaultKeyOf(action)
}

/** The chord a binding presses: "mod" answers to Control everywhere, so ctrl+tab and mod+tab are one chord. */
export function shortcutChord(binding: string): string {
  return binding.replace(/^ctrl\+/, "mod+")
}

/** Returns a map of chord ({@link shortcutChord}) to the action IDs that share it (length > 1). */
export function detectConflicts(customBindings: Record<string, string> = {}): Map<string, string[]> {
  const keyToActions = new Map<string, string[]>()

  for (const action of SHORTCUT_ACTIONS) {
    const key = getEffectiveKeyBinding(action.id, customBindings)
    if (!key) continue
    for (const occupied of occupiedBindings(action.id, key)) {
      const chord = shortcutChord(occupied)
      const existing = keyToActions.get(chord) || []
      keyToActions.set(chord, [...existing, action.id])
    }
  }

  const conflicts = new Map<string, string[]>()
  for (const [key, actions] of keyToActions) {
    if (actions.length > 1) {
      conflicts.set(key, actions)
    }
  }

  return conflicts
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
}

/** Parse a key string like "mod+k" into modifier flags + the resolved key. */
export function parseKeyBinding(key: string): {
  key: string
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
} {
  const parts = key.toLowerCase().split("+")
  let mod = false
  let ctrl = false
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

    if (part === "ctrl") {
      ctrl = true
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
    ctrl,
    shift,
    alt,
  }
}

const PHYSICAL_PUNCTUATION: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
}

/**
 * The key an event names. Under ⌥ on a Mac it is the physical key, as on a US
 * layout, since ⌥ rewrites the character (⌥W is "∑"). Alt elsewhere leaves the
 * character alone, so AZERTY's Alt+W stays the key printed W, unless the key
 * prints no ASCII character to match by.
 */
function eventKey(event: KeyboardEvent): string {
  if ((event.altKey && isMac()) || isRewrittenUnderModifier(event)) {
    const code = event.code ?? ""
    const letterOrDigit = /^(?:Key|Digit)(.)$/.exec(code)?.[1]
    if (letterOrDigit) return letterOrDigit.toLowerCase()
    if (code in PHYSICAL_PUNCTUATION) return PHYSICAL_PUNCTUATION[code]
  }
  return event.key.toLowerCase()
}

/** Alt held over a key whose character isn't ASCII, as Alt+[ is "å" on a Swedish
 *  layout and "ü" on a German one, can only match by the key's position. Under
 *  Control or ⌘ the character stands, so Swedish ⌘§ stays "§" (and AltGr, which
 *  reports Control with Alt, keeps what it typed); a dead key has none at all. */
function isRewrittenUnderModifier(event: KeyboardEvent): boolean {
  if (event.key === "Dead") return event.altKey || event.ctrlKey || event.metaKey
  return event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1 && !/^[ -~]$/.test(event.key)
}

/** ⌥ typing a plain character on a Mac: "[" is ⌥8 on Nordic and German Macs and
 *  ⌥ on the bracket keys of Italian ones, so no binding may take it. */
function isOptionTyping(event: KeyboardEvent): boolean {
  return isMac() && event.altKey && !event.metaKey && !event.ctrlKey && /^[ -~]$/.test(event.key)
}

/** Control without Command on a Mac; elsewhere Control is the "mod" key, so this is never captured. */
function isMacControl(event: KeyboardEvent): boolean {
  return isMac() && event.ctrlKey && !event.metaKey
}

/** The binding's modifier parts for an event, in binding order. */
function modifierParts(event: KeyboardEvent): string[] {
  const parts: string[] = []
  if (isMacControl(event)) parts.push("ctrl")
  else if (event.metaKey || event.ctrlKey) parts.push("mod")
  if (event.shiftKey) parts.push("shift")
  if (event.altKey) parts.push("alt")
  return parts
}

function matchesModifiers(event: KeyboardEvent, parsed: ReturnType<typeof parseKeyBinding>): boolean {
  const modifier = parsed.ctrl ? event.ctrlKey && !event.metaKey : (event.metaKey || event.ctrlKey) === parsed.mod
  return modifier && event.shiftKey === parsed.shift && event.altKey === parsed.alt
}

export function matchesKeyBinding(event: KeyboardEvent, binding: string): boolean {
  if (isOptionTyping(event)) return false
  const parsed = parseKeyBinding(binding)

  // vim-style ctrl+[ as escape. AltGr reports as ctrl+alt, and `[` sits on
  // AltGr+8 on Nordic and German layouts, so typing it must not match here.
  if (
    parsed.mod &&
    parsed.key === "[" &&
    event.ctrlKey &&
    event.key === "[" &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey
  ) {
    return true
  }

  // "mod" matches metaKey OR ctrlKey for cross-platform parity. The typed
  // character still matches so ⌥ bindings recorded as it ("alt+˚") keep working.
  const key = eventKey(event)
  return (key === parsed.key || event.key.toLowerCase() === parsed.key) && matchesModifiers(event, parsed)
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
  if (parsed.ctrl) formatted.push(mac ? "⌃" : "Ctrl")
  if (parsed.mod) formatted.push(mac ? "⌘" : "Ctrl")
  if (parsed.shift) formatted.push(mac ? "⇧" : "Shift")
  if (parsed.alt) formatted.push(mac ? "⌥" : "Alt")

  switch (parsed.key.toLowerCase()) {
    case "escape":
      formatted.push(mac ? "⎋" : "Esc")
      break
    case "arrowup":
      formatted.push("↑")
      break
    case "arrowdown":
      formatted.push("↓")
      break
    case "arrowleft":
      formatted.push("←")
      break
    case "arrowright":
      formatted.push("→")
      break
    case "tab":
      formatted.push(mac ? "⇥" : "Tab")
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
  if (parsed.ctrl) formatted.push("ctrl")
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

  if (parsed.mod || parsed.ctrl || parsed.alt) {
    return true
  }

  return isFunctionKey(parsed.key.toLowerCase())
}

/**
 * Convert a KeyboardEvent to a normalized binding string (e.g. "mod+shift+f").
 * Returns null for lone modifier presses or unsafe bare keys that would hijack normal typing.
 */
export function keyEventToBinding(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key) || isOptionTyping(event)) return null

  const parts = modifierParts(event)
  parts.push(eventKey(event))

  const binding = parts.join("+")
  return isSafeShortcutBinding(binding) ? binding : null
}

/**
 * Quick jump claims a RANGE of keys: its stored binding names slot 1, and the
 * same modifiers with 2-9 open slots 2-9. Everything range-shaped about it
 * (capture, matching, display) branches on this id.
 */
export const QUICK_JUMP_ACTION_ID = "sidebarQuickJump"

/** Bare "e" fails `isSafeShortcutBinding`, so this fires only via a bespoke
 *  listener in `Sidebar`, not `useKeyboardShortcuts`. Listed here for display only. */
export const CLEAR_INBOX_STREAM_ACTION_ID = "clearInboxStream"

/** Sidebar rows the quick jump can reach. */
export const QUICK_JUMP_SLOT_COUNT = 9

/** Every binding an action answers to. Quick jump stores slot 1 and owns nine,
 *  so conflict detection has to see all of them. */
export function occupiedBindings(actionId: string, binding: string): string[] {
  if (actionId !== QUICK_JUMP_ACTION_ID) return [binding]
  const prefix = binding.slice(0, binding.lastIndexOf("+") + 1)
  return Array.from({ length: QUICK_JUMP_SLOT_COUNT }, (_, index) => `${prefix}${index + 1}`)
}

/** True for a keydown/keyup of a modifier key itself, which carries no binding. */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/** 1-9 from the event, by character first and physical position second, so a
 *  layout where the modifier rewrites the character (Alt+1 is "¡" on Mac) still
 *  resolves. */
function eventDigit(event: KeyboardEvent): number | null {
  if (/^[1-9]$/.test(event.key)) return Number(event.key)
  const positional = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? "")
  return positional ? Number(positional[1]) : null
}

/** The event's modifiers are exactly the binding's, whatever key it carries. */
export function matchesBindingModifiers(event: KeyboardEvent, binding: string): boolean {
  return matchesModifiers(event, parseKeyBinding(binding))
}

/** The slot a keydown selects under the quick-jump binding, or null. */
export function quickJumpSlotFromEvent(event: KeyboardEvent, binding: string): number | null {
  if (!matchesBindingModifiers(event, binding)) return null
  return eventDigit(event)
}

/**
 * Binding captured from a keypress in the settings capture UI. Quick jump
 * normalizes whichever digit was pressed down to slot 1 (it owns all nine) and
 * refuses a non-digit key.
 */
export function captureBindingForAction(actionId: string, event: KeyboardEvent): string | null {
  if (actionId !== QUICK_JUMP_ACTION_ID) return keyEventToBinding(event)
  if (isModifierKey(event.key)) return null
  if (eventDigit(event) === null) return null

  const parts = modifierParts(event)
  parts.push("1")

  const binding = parts.join("+")
  return isSafeShortcutBinding(binding) ? binding : null
}

/** Display label for a binding in the context of its action — the quick jump
 *  spans the digit range its single binding stands for. */
export function formatActionBinding(actionId: string, binding: string): string {
  const formatted = formatKeyBinding(binding)
  return actionId === QUICK_JUMP_ACTION_ID ? `${formatted}–9` : formatted
}

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
  const globalBindings = new Set<string>()
  for (const action of SHORTCUT_ACTIONS) {
    if (!action.global) continue
    const binding = getEffectiveKeyBinding(action.id, customBindings)
    if (binding) globalBindings.add(shortcutChord(binding))
  }

  const result: Record<string, string> = {}
  for (const id of EDITOR_SHORTCUT_IDS) {
    const binding = getEffectiveKeyBinding(id, customBindings)
    if (binding && isSafeShortcutBinding(binding) && !globalBindings.has(shortcutChord(binding))) {
      result[id] = binding
    }
  }
  return result
}

/** The other actions whose bindings press a chord `binding` would take for `actionId`. */
export function conflictingActions(
  customBindings: Record<string, string>,
  actionId: string,
  binding: string
): string[] {
  const conflicts = detectConflicts({ ...customBindings, [actionId]: binding })
  const ids = occupiedBindings(actionId, binding).flatMap((occupied) => conflicts.get(shortcutChord(occupied)) ?? [])
  return [...new Set(ids)].filter((id) => id !== actionId)
}

export function resolveShortcutBindingUpdate(
  customBindings: Record<string, string> = {},
  actionId: string,
  binding: string
): Record<string, string> {
  const nextBindings = { ...customBindings }
  for (const conflictId of conflictingActions(customBindings, actionId, binding)) {
    nextBindings[conflictId] = "none"
  }

  nextBindings[actionId] = binding
  return nextBindings
}
