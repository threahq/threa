import { describe, it, expect } from "vitest"
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
} from "./keyboard-shortcuts"

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

  it("captures other actions unchanged", () => {
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true })
    expect(captureBindingForAction("toggleSidebar", event)).toBe(keyEventToBinding(event))
  })

  it("labels the binding as a range only for quick jump", () => {
    expect(formatActionBinding(QUICK_JUMP_ACTION_ID, "mod+1")).toBe(`${formatKeyBinding("mod+1")}–9`)
    expect(formatActionBinding("toggleSidebar", "mod+b")).toBe(formatKeyBinding("mod+b"))
  })
})
