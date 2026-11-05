import { describe, expect, it } from "vitest"
import { DEFAULT_ACCESSIBILITY, DEFAULT_USER_PREFERENCES } from "@threahq/types"
import { defaultKeyOf, getShortcutAction } from "@/lib/keyboard-shortcuts"
import { SETTINGS } from "./settings-registry"
import { SETTINGS_WITH_DEFAULTS, isSettingChanged, settingReset } from "./setting-defaults"

describe("setting defaults", () => {
  it("reads nothing as changed on default preferences", () => {
    expect(SETTINGS_WITH_DEFAULTS.filter((id) => isSettingChanged(id, DEFAULT_USER_PREFERENCES))).toEqual([])
  })

  it("covers only settings the registry has", () => {
    expect(SETTINGS_WITH_DEFAULTS.filter((id) => !Object.hasOwn(SETTINGS, id))).toEqual([])
  })

  it("marks a changed value and resets it to the default, accessibility merged per key", () => {
    const preferences = {
      ...DEFAULT_USER_PREFERENCES,
      theme: "dark" as const,
      accessibility: { ...DEFAULT_ACCESSIBILITY, reducedMotion: !DEFAULT_ACCESSIBILITY.reducedMotion },
      voiceSteeringWords: ["Threa"],
    }
    expect({
      changed: ["theme", "reduce-motion", "steering-words", "density"].filter((id) =>
        isSettingChanged(id, preferences)
      ),
      resets: {
        theme: settingReset("theme", preferences),
        motion: settingReset("reduce-motion", preferences),
        words: settingReset("steering-words", preferences),
      },
    }).toEqual({
      changed: ["theme", "reduce-motion", "steering-words"],
      resets: {
        theme: { theme: DEFAULT_USER_PREFERENCES.theme },
        motion: { accessibility: { reducedMotion: DEFAULT_ACCESSIBILITY.reducedMotion } },
        words: null,
      },
    })
  })

  it.each([
    ["message-collapse-at", "messageCollapseAtHeight", "messageCollapseToHeight"],
    ["board-card-collapse-at", "boardCardCollapseAtHeight", "boardCardCollapseToHeight"],
  ] as const)("should keep the collapsed height within the default when %s resets", (setting, at, to) => {
    const preferences = { ...DEFAULT_USER_PREFERENCES, [at]: 2000, [to]: 1500 }
    expect(settingReset(setting, preferences)).toEqual({
      [at]: DEFAULT_USER_PREFERENCES[at],
      [to]: DEFAULT_USER_PREFERENCES[at],
    })
  })

  it.each([
    ["message-collapse-to", "messageCollapseAtHeight", "messageCollapseToHeight"],
    ["board-card-collapse-to", "boardCardCollapseAtHeight", "boardCardCollapseToHeight"],
  ] as const)("should keep %s within the height that collapses when it resets", (setting, at, to) => {
    const preferences = { ...DEFAULT_USER_PREFERENCES, [at]: 100, [to]: 80 }
    expect(settingReset(setting, preferences)).toEqual({ [to]: 100 })
  })

  it("should read shortcuts stored as their own default as unchanged", () => {
    const action = getShortcutAction("formatBold")!
    const preferences = { ...DEFAULT_USER_PREFERENCES, keyboardShortcuts: { formatBold: defaultKeyOf(action)! } }
    expect(isSettingChanged("shortcuts", preferences)).toBe(false)
  })
})
