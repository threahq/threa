import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as deviceModule from "@/lib/device"
import {
  SHORTCUT_ACTIONS,
  getShortcutAction,
  matchesKeyBinding,
  detectConflicts,
  getEffectiveKeyBinding,
  keyEventToBinding,
  getEffectiveEditorBindings,
  EDITOR_SHORTCUT_IDS,
  isSafeShortcutBinding,
  resolveShortcutBindingUpdate,
  formatKeyBinding,
  formatKeyBindingText,
  QUICK_JUMP_ACTION_ID,
  occupiedBindings,
  captureBindingForAction,
  formatActionBinding,
  quickJumpSlotFromEvent,
  CLEAR_INBOX_STREAM_ACTION_ID,
  getShortcutsByCategory,
  defaultKeyOf,
} from "./keyboard-shortcuts"

beforeEach(() => {
  vi.spyOn(deviceModule, "isStandaloneApp").mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("toggleSidebar shortcut", () => {
  it("is registered as a view-category action with mod+§ default", () => {
    const action = getShortcutAction("toggleSidebar")
    expect(action).toBeDefined()
    expect(action?.defaultKey).toBe("mod+§")
    expect(action?.category).toBe("view")
    expect(action?.global).toBe(true)
  })

  it("matches a Ctrl+§ keydown event", () => {
    const event = new KeyboardEvent("keydown", {
      key: "§",
      ctrlKey: true,
    })
    expect(matchesKeyBinding(event, "mod+§")).toBe(true)
  })

  it("matches a Cmd+§ keydown event on Mac", () => {
    const event = new KeyboardEvent("keydown", {
      key: "§",
      metaKey: true,
    })
    expect(matchesKeyBinding(event, "mod+§")).toBe(true)
  })

  it("does not match a bare § keydown event", () => {
    const event = new KeyboardEvent("keydown", { key: "§" })
    expect(matchesKeyBinding(event, "mod+§")).toBe(false)
  })

  it("does not conflict with any other default binding", () => {
    const conflicts = detectConflicts()
    expect(conflicts.get("mod+§")).toBeUndefined()
  })

  it("is included in SHORTCUT_ACTIONS exactly once", () => {
    const matches = SHORTCUT_ACTIONS.filter((a) => a.id === "toggleSidebar")
    expect(matches).toHaveLength(1)
  })
})

describe("searchInStream shortcut", () => {
  it("is registered as a navigation action with mod+f default", () => {
    const action = getShortcutAction("searchInStream")
    expect(action).toBeDefined()
    expect(action?.defaultKey).toBe("mod+f")
    expect(action?.category).toBe("navigation")
    expect(action?.global).toBe(true)
  })

  it("does not conflict with any other default binding", () => {
    const conflicts = detectConflicts()
    expect(conflicts.get("mod+f")).toBeUndefined()
  })
})

describe("editor formatting shortcuts", () => {
  it("registers all 5 editor formatting actions in the editing category", () => {
    for (const id of EDITOR_SHORTCUT_IDS) {
      const action = getShortcutAction(id)
      expect(action).toBeDefined()
      expect(action?.category).toBe("editing")
      expect(action?.global).toBeUndefined()
    }
  })

  it("has correct default keys", () => {
    expect(getShortcutAction("formatBold")?.defaultKey).toBe("mod+b")
    expect(getShortcutAction("formatItalic")?.defaultKey).toBe("mod+i")
    expect(getShortcutAction("formatStrike")?.defaultKey).toBe("mod+shift+s")
    expect(getShortcutAction("formatCode")?.defaultKey).toBe("mod+e")
    expect(getShortcutAction("formatCodeBlock")?.defaultKey).toBe("mod+shift+c")
  })

  it("no default editor shortcuts conflict with each other", () => {
    const conflicts = detectConflicts()
    for (const id of EDITOR_SHORTCUT_IDS) {
      const action = getShortcutAction(id)!
      const conflicting = conflicts.get(action.defaultKey)
      expect(conflicting).toBeUndefined()
    }
  })
})

describe("getEffectiveKeyBinding", () => {
  it("returns default key when no custom bindings", () => {
    expect(getEffectiveKeyBinding("formatBold")).toBe("mod+b")
  })

  it("returns custom binding when set", () => {
    expect(getEffectiveKeyBinding("formatBold", { formatBold: "mod+shift+b" })).toBe("mod+shift+b")
  })

  it("returns undefined when set to 'none' (disabled)", () => {
    expect(getEffectiveKeyBinding("formatBold", { formatBold: "none" })).toBeUndefined()
  })

  it("returns undefined for unknown action IDs", () => {
    expect(getEffectiveKeyBinding("nonexistent")).toBeUndefined()
  })
})

describe("detectConflicts", () => {
  it("detects conflict when two actions share the same binding", () => {
    const conflicts = detectConflicts({ toggleSidebar: "mod+b" })
    const conflicting = conflicts.get("mod+b")
    expect(conflicting).toBeDefined()
    expect(conflicting).toContain("toggleSidebar")
    expect(conflicting).toContain("formatBold")
  })

  it("excludes disabled shortcuts from conflict detection", () => {
    const conflicts = detectConflicts({ formatBold: "none", toggleSidebar: "mod+b" })
    // formatBold is disabled, so mod+b is only used by toggleSidebar — no conflict
    expect(conflicts.get("mod+b")).toBeUndefined()
  })
})

describe("keyEventToBinding", () => {
  it("converts Ctrl+B to mod+b", () => {
    const event = new KeyboardEvent("keydown", { key: "b", ctrlKey: true })
    expect(keyEventToBinding(event)).toBe("mod+b")
  })

  it("converts Cmd+Shift+F to mod+shift+f", () => {
    const event = new KeyboardEvent("keydown", { key: "f", metaKey: true, shiftKey: true })
    expect(keyEventToBinding(event)).toBe("mod+shift+f")
  })

  it("converts Alt+K to alt+k", () => {
    const event = new KeyboardEvent("keydown", { key: "k", altKey: true })
    expect(keyEventToBinding(event)).toBe("alt+k")
  })

  it("refuses to capture Escape — it is reserved for close/cancel flows", () => {
    const event = new KeyboardEvent("keydown", { key: "Escape" })
    expect(keyEventToBinding(event)).toBeNull()
  })

  it("returns null for lone modifier presses", () => {
    expect(keyEventToBinding(new KeyboardEvent("keydown", { key: "Control" }))).toBeNull()
    expect(keyEventToBinding(new KeyboardEvent("keydown", { key: "Shift" }))).toBeNull()
    expect(keyEventToBinding(new KeyboardEvent("keydown", { key: "Alt" }))).toBeNull()
    expect(keyEventToBinding(new KeyboardEvent("keydown", { key: "Meta" }))).toBeNull()
  })

  it("rejects unsafe bare printable keys", () => {
    expect(keyEventToBinding(new KeyboardEvent("keydown", { key: "b" }))).toBeNull()
    expect(keyEventToBinding(new KeyboardEvent("keydown", { key: "B", shiftKey: true }))).toBeNull()
  })

  it("captures keys whose names contain + when the shortcut is otherwise safe", () => {
    const event = new KeyboardEvent("keydown", { key: "+", metaKey: true, shiftKey: true })
    expect(keyEventToBinding(event)).toBe("mod+shift++")
  })
})

describe("isSafeShortcutBinding", () => {
  it("allows modified shortcuts and function keys", () => {
    expect(isSafeShortcutBinding("mod+b")).toBe(true)
    expect(isSafeShortcutBinding("alt+k")).toBe(true)
    expect(isSafeShortcutBinding("f6")).toBe(true)
  })

  it("rejects unsafe bare printable bindings", () => {
    expect(isSafeShortcutBinding("b")).toBe(false)
    expect(isSafeShortcutBinding("shift+b")).toBe(false)
    expect(isSafeShortcutBinding("shift++")).toBe(false)
  })

  it("rejects Escape in any form — reserved for close/cancel flows", () => {
    expect(isSafeShortcutBinding("escape")).toBe(false)
    expect(isSafeShortcutBinding("mod+escape")).toBe(false)
    expect(isSafeShortcutBinding("shift+escape")).toBe(false)
  })
})

describe("parse and format bindings", () => {
  it("matches bindings whose key contains +", () => {
    const event = new KeyboardEvent("keydown", { key: "+", metaKey: true, shiftKey: true })
    expect(matchesKeyBinding(event, "mod+shift++")).toBe(true)
  })

  it("formats bindings whose key contains +", () => {
    expect(formatKeyBinding("mod+shift++")).toMatch(/^\u2318\u21e7\+$|^Ctrl\+Shift\+\+$/)
  })

  it("formats bindings as plain text", () => {
    expect(formatKeyBindingText("mod+shift++")).toMatch(/^cmd\+shift\+\+$|^ctrl\+shift\+\+$/)
    expect(formatKeyBindingText("escape")).toBe("escape")
  })
})

describe("getEffectiveEditorBindings", () => {
  it("returns all default editor bindings when no custom bindings", () => {
    const bindings = getEffectiveEditorBindings()
    expect(bindings).toEqual({
      formatBold: "mod+b",
      formatItalic: "mod+i",
      formatStrike: "mod+shift+s",
      formatCode: "mod+e",
      formatCodeBlock: "mod+shift+c",
    })
  })

  it("excludes editor bindings that conflict with global app shortcuts", () => {
    // User binds toggleSidebar to mod+b — formatBold should be excluded
    const bindings = getEffectiveEditorBindings({ toggleSidebar: "mod+b" })
    expect(bindings.formatBold).toBeUndefined()
    // Other editor shortcuts unaffected
    expect(bindings.formatItalic).toBe("mod+i")
  })

  it("respects custom editor bindings", () => {
    const bindings = getEffectiveEditorBindings({ formatBold: "mod+shift+b" })
    expect(bindings.formatBold).toBe("mod+shift+b")
  })

  it("excludes disabled editor shortcuts", () => {
    const bindings = getEffectiveEditorBindings({ formatBold: "none" })
    expect(bindings.formatBold).toBeUndefined()
  })

  it("excludes unsafe editor bindings that would hijack typing", () => {
    const bindings = getEffectiveEditorBindings({ formatBold: "b" })
    expect(bindings.formatBold).toBeUndefined()
  })
})

describe("resolveShortcutBindingUpdate", () => {
  it("builds a single update that clears conflicting bindings", () => {
    expect(resolveShortcutBindingUpdate({}, "toggleSidebar", "mod+b")).toEqual({
      formatBold: "none",
      toggleSidebar: "mod+b",
    })
  })
})

describe("sidebarQuickJump shortcut", () => {
  it("is registered once as a global navigation action defaulting to mod+1", () => {
    const action = getShortcutAction(QUICK_JUMP_ACTION_ID)
    expect(action).toMatchObject({ defaultKey: "mod+1", category: "navigation", global: true })
    expect(SHORTCUT_ACTIONS.filter((a) => a.id === QUICK_JUMP_ACTION_ID)).toHaveLength(1)
  })

  it("does not collide with any other default binding", () => {
    expect(detectConflicts()).toEqual(new Map())
  })

  it("conflicts on any slot in the range, not just the stored one", () => {
    expect(detectConflicts({ toggleSidebar: "mod+2" })).toEqual(
      new Map([["mod+2", [QUICK_JUMP_ACTION_ID, "toggleSidebar"]]])
    )
    // The range follows a rebound modifier.
    expect(detectConflicts({ [QUICK_JUMP_ACTION_ID]: "alt+1", toggleSidebar: "alt+9" })).toEqual(
      new Map([["alt+9", [QUICK_JUMP_ACTION_ID, "toggleSidebar"]]])
    )
  })

  it("does not exist in a browser tab, where Cmd/Ctrl+digit switches tabs", () => {
    vi.spyOn(deviceModule, "isStandaloneApp").mockReturnValue(false)

    expect({
      binding: getEffectiveKeyBinding(QUICK_JUMP_ACTION_ID, { [QUICK_JUMP_ACTION_ID]: "mod+alt+1" }),
      listed: getShortcutsByCategory().navigation.some((a) => a.id === QUICK_JUMP_ACTION_ID),
      conflicts: detectConflicts({ toggleSidebar: "mod+2" }),
    }).toEqual({ binding: undefined, listed: false, conflicts: new Map() })
  })

  it("expands only quick jump into a range of occupied bindings", () => {
    expect(occupiedBindings(QUICK_JUMP_ACTION_ID, "mod+alt+1")).toEqual([
      "mod+alt+1",
      "mod+alt+2",
      "mod+alt+3",
      "mod+alt+4",
      "mod+alt+5",
      "mod+alt+6",
      "mod+alt+7",
      "mod+alt+8",
      "mod+alt+9",
    ])
    expect(occupiedBindings("toggleSidebar", "mod+b")).toEqual(["mod+b"])
  })

  it("resolves a slot from any digit under the bound modifiers", () => {
    const event = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init)
    expect(quickJumpSlotFromEvent(event({ key: "1", metaKey: true }), "mod+1")).toBe(1)
    expect(quickJumpSlotFromEvent(event({ key: "7", ctrlKey: true }), "mod+1")).toBe(7)
    // Alt rewrites the character on macOS; the physical key still decides.
    expect(quickJumpSlotFromEvent(event({ key: "™", code: "Digit2", altKey: true }), "alt+1")).toBe(2)
    expect(quickJumpSlotFromEvent(event({ key: "1" }), "mod+1")).toBeNull()
    expect(quickJumpSlotFromEvent(event({ key: "1", metaKey: true, shiftKey: true }), "mod+1")).toBeNull()
    expect(quickJumpSlotFromEvent(event({ key: "0", metaKey: true }), "mod+1")).toBeNull()
  })

  it("captures any digit as the whole 1-9 range and refuses everything else", () => {
    const capture = (init: KeyboardEventInit) =>
      captureBindingForAction(QUICK_JUMP_ACTION_ID, new KeyboardEvent("keydown", init))
    expect(capture({ key: "4", metaKey: true, altKey: true })).toBe("mod+alt+1")
    expect(capture({ key: "2", altKey: true })).toBe("alt+1")
    expect(capture({ key: "Meta", metaKey: true })).toBeNull()
    expect(capture({ key: "k", metaKey: true })).toBeNull()
    // A bare digit would hijack typing.
    expect(capture({ key: "1" })).toBeNull()
  })

  it("matches the bracket history bindings", () => {
    const back = getEffectiveKeyBinding("historyBack") ?? "none"
    const forward = getEffectiveKeyBinding("historyForward") ?? "none"
    expect([back, forward]).toEqual(["mod+[", "mod+]"])
    expect(matchesKeyBinding(new KeyboardEvent("keydown", { key: "[", metaKey: true }), back)).toBe(true)
    expect(matchesKeyBinding(new KeyboardEvent("keydown", { key: "]", metaKey: true }), forward)).toBe(true)
    expect(isSafeShortcutBinding(back)).toBe(true)
    // AltGr+8 is `[` on Nordic and German layouts and arrives as ctrl+alt.
    expect(matchesKeyBinding(new KeyboardEvent("keydown", { key: "[", ctrlKey: true, altKey: true }), back)).toBe(false)
  })

  it("captures other actions unchanged", () => {
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true })
    expect(captureBindingForAction("toggleSidebar", event)).toBe(keyEventToBinding(event))
  })

  it("labels the binding as a range only for quick jump", () => {
    expect(formatActionBinding(QUICK_JUMP_ACTION_ID, "mod+1")).toBe(`${formatKeyBinding("mod+1")}–9`)
    expect(formatActionBinding("toggleSidebar", "mod+b")).toBe(formatKeyBinding("mod+b"))
  })
})

describe("clearInboxStream shortcut", () => {
  it("is registered once as a view-category action defaulting to a bare 'e'", () => {
    const action = getShortcutAction(CLEAR_INBOX_STREAM_ACTION_ID)
    expect(action).toMatchObject({ defaultKey: "e", category: "view" })
    expect(action?.global).toBeFalsy()
    expect(SHORTCUT_ACTIONS.filter((a) => a.id === CLEAR_INBOX_STREAM_ACTION_ID)).toHaveLength(1)
  })

  it("is unsafe for the shared global-shortcut gate, since a bare letter would hijack typing", () => {
    // `isSafeShortcutBinding` rejects any non-mod/alt binding that isn't a function
    // key, so `useKeyboardShortcuts()` never fires this action — it's wired up via
    // a bespoke, narrowly scoped listener in `Sidebar` instead (see that binding's
    // usage for why: it only listens outside editable targets).
    expect(isSafeShortcutBinding("e")).toBe(false)
  })

  it("still resolves an effective binding despite failing the safe-binding gate", () => {
    expect(getEffectiveKeyBinding(CLEAR_INBOX_STREAM_ACTION_ID)).toBe("e")
    expect(getEffectiveKeyBinding(CLEAR_INBOX_STREAM_ACTION_ID, { [CLEAR_INBOX_STREAM_ACTION_ID]: "alt+e" })).toBe(
      "alt+e"
    )
  })

  it("matches a bare 'e' keydown with no modifiers", () => {
    const binding = getEffectiveKeyBinding(CLEAR_INBOX_STREAM_ACTION_ID) ?? "e"
    expect(matchesKeyBinding(new KeyboardEvent("keydown", { key: "e" }), binding)).toBe(true)
    expect(matchesKeyBinding(new KeyboardEvent("keydown", { key: "e", metaKey: true }), binding)).toBe(false)
  })

  it("does not collide with any other default binding", () => {
    expect(detectConflicts()).toEqual(new Map())
  })
})

describe("pane shortcuts", () => {
  const PANE_ACTIONS = ["closePane", "reopenPane", "nextPaneTab", "previousPaneTab", "nextPane", "previousPane"]
  const realPlatform = navigator.platform

  function installed(value: boolean) {
    vi.spyOn(deviceModule, "isStandaloneApp").mockReturnValue(value)
  }
  function platform(value: string) {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => value })
  }
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init)

  afterEach(() => {
    platform(realPlatform)
  })

  it("should default to keys a browser tab keeps when in a browser, and the app's own once installed", () => {
    installed(false)
    expect(PANE_ACTIONS.map((id) => getEffectiveKeyBinding(id))).toEqual([
      "alt+w",
      "alt+shift+t",
      "alt+]",
      "alt+[",
      "alt+.",
      "alt+,",
    ])
    installed(true)
    expect(PANE_ACTIONS.map((id) => getEffectiveKeyBinding(id))).toEqual([
      "mod+w",
      "mod+shift+t",
      "ctrl+tab",
      "ctrl+shift+tab",
      "alt+.",
      "alt+,",
    ])
  })

  it("should keep every default free of conflicts whether installed or not", () => {
    for (const value of [false, true]) {
      installed(value)
      expect(detectConflicts()).toEqual(new Map())
      for (const id of PANE_ACTIONS) expect(isSafeShortcutBinding(defaultKeyOf(getShortcutAction(id)!))).toBe(true)
    }
  })

  it("should match Alt bindings by physical key when Alt rewrites the character", () => {
    platform("MacIntel")
    // ⌥W types "∑" and ⌥[ types a curly quote on a US Mac.
    expect(matchesKeyBinding(key({ key: "∑", code: "KeyW", altKey: true }), "alt+w")).toBe(true)
    expect(matchesKeyBinding(key({ key: "“", code: "BracketLeft", altKey: true }), "alt+[")).toBe(true)
    expect(matchesKeyBinding(key({ key: "ˇ", code: "KeyT", altKey: true, shiftKey: true }), "alt+shift+t")).toBe(true)
    expect(matchesKeyBinding(key({ key: "≥", code: "Period", altKey: true }), "alt+.")).toBe(true)
    // ⌥8 types "[" on a Swedish Mac; that's typing, not Alt+[.
    expect(matchesKeyBinding(key({ key: "[", code: "Digit8", altKey: true }), "alt+[")).toBe(false)
    // Without Alt the character decides, so Dvorak and friends keep their letters.
    expect(matchesKeyBinding(key({ key: "w", code: "Comma", metaKey: true }), "mod+w")).toBe(true)
  })

  it("should leave characters ⌥ types on a Mac to the composer", () => {
    platform("MacIntel")
    // ⌥ on the bracket keys types "[" and "]" on an Italian Mac.
    expect(matchesKeyBinding(key({ key: "[", code: "BracketLeft", altKey: true }), "alt+[")).toBe(false)
    expect(matchesKeyBinding(key({ key: "]", code: "BracketRight", altKey: true }), "alt+]")).toBe(false)
    expect(keyEventToBinding(key({ key: "[", code: "Digit8", altKey: true }))).toBeNull()
  })

  it("should match Alt bindings by character off a Mac", () => {
    platform("Win32")
    // The key printed W on AZERTY sits where a US layout has Z.
    expect(matchesKeyBinding(key({ key: "w", code: "KeyZ", altKey: true }), "alt+w")).toBe(true)
    expect(matchesKeyBinding(key({ key: "z", code: "KeyW", altKey: true }), "alt+w")).toBe(false)
  })

  it("should match Alt bindings by physical key off a Mac when the key prints no ASCII character", () => {
    for (const name of ["Win32", "Linux x86_64"]) {
      platform(name)
      // Swedish has "å" where a US layout has "[", German has "ü".
      expect(matchesKeyBinding(key({ key: "å", code: "BracketLeft", altKey: true }), "alt+[")).toBe(true)
      expect(matchesKeyBinding(key({ key: "ü", code: "BracketLeft", altKey: true }), "alt+[")).toBe(true)
      expect(keyEventToBinding(key({ key: "å", code: "BracketLeft", altKey: true }))).toBe("alt+[")
    }
  })

  it("should see ctrl and mod as one chord, since mod answers to Control on a Mac too", () => {
    installed(true)
    for (const name of ["Win32", "MacIntel"]) {
      platform(name)
      expect(detectConflicts({ toggleSidebar: "mod+tab" }).get("mod+tab")).toEqual(["toggleSidebar", "nextPaneTab"])
    }
  })

  it("should clear the binding a Mac's Control chord takes over when one action is rebound onto it", () => {
    installed(true)
    platform("MacIntel")
    expect(resolveShortcutBindingUpdate({}, "toggleSidebar", "ctrl+tab")).toEqual({
      nextPaneTab: "none",
      toggleSidebar: "ctrl+tab",
    })
  })

  it("should keep matching ⌥ bindings recorded as the character ⌥ types", () => {
    platform("MacIntel")
    expect(matchesKeyBinding(key({ key: "˚", code: "KeyK", altKey: true }), "alt+˚")).toBe(true)
  })

  it("should match ctrl only to Control, never Command", () => {
    expect(matchesKeyBinding(key({ key: "Tab", ctrlKey: true }), "ctrl+tab")).toBe(true)
    expect(matchesKeyBinding(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "ctrl+shift+tab")).toBe(true)
    expect(matchesKeyBinding(key({ key: "Tab", metaKey: true }), "ctrl+tab")).toBe(false)
    expect(matchesKeyBinding(key({ key: "Tab", ctrlKey: true, metaKey: true }), "ctrl+tab")).toBe(false)
    expect(matchesKeyBinding(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "ctrl+tab")).toBe(false)
  })

  it("should keep vim's ctrl+[ escape off Alt bindings", () => {
    expect(matchesKeyBinding(key({ key: "[", ctrlKey: true }), "alt+[")).toBe(false)
    expect(matchesKeyBinding(key({ key: "[", ctrlKey: true }), "mod+[")).toBe(true)
  })

  it("should capture Control on a Mac as ctrl and as mod elsewhere", () => {
    platform("MacIntel")
    expect(keyEventToBinding(key({ key: "Tab", ctrlKey: true }))).toBe("ctrl+tab")
    expect(keyEventToBinding(key({ key: "w", metaKey: true }))).toBe("mod+w")
    expect(keyEventToBinding(key({ key: "∑", code: "KeyW", altKey: true }))).toBe("alt+w")
    expect(formatKeyBinding("ctrl+shift+tab")).toBe("⌃⇧⇥")
    platform("Win32")
    expect(keyEventToBinding(key({ key: "Tab", ctrlKey: true }))).toBe("mod+tab")
    expect(formatKeyBinding("ctrl+shift+tab")).toBe("Ctrl+Shift+Tab")
  })
})
