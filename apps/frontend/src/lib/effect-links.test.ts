import { describe, expect, it } from "vitest"
import { AGENT_SETTABLE_PREFERENCE_KEYS, TOOL_EFFECT_KINDS, type AgentToolEffect } from "@threa/types"
import {
  SETTINGS_TAB_BY_PREFERENCE_KEY,
  effectDiff,
  effectLabel,
  kindNoun,
  resolveEffectPath,
  unionSessionEffects,
} from "./effect-links"

const ctx = {
  workspaceId: "ws_1",
  getSettingsUrl: (tab?: string) => `?settings=${tab}`,
}

function effect(partial: Partial<AgentToolEffect> & Pick<AgentToolEffect, "kind">): AgentToolEffect {
  return partial as AgentToolEffect
}

describe("resolveEffectPath", () => {
  it("resolves every kind to its expected path or null", () => {
    const resolved = TOOL_EFFECT_KINDS.map((kind) =>
      resolveEffectPath(effect({ kind, target: kind === "settings" ? "theme" : "id_1" }), ctx)
    )
    expect(Object.fromEntries(TOOL_EFFECT_KINDS.map((kind, i) => [kind, resolved[i]]))).toEqual({
      settings: "?settings=appearance",
      delegation: "/w/ws_1/delegations/id_1",
      memo: "/w/ws_1/memory?memo=id_1",
      follow_up: null,
      brief: null,
      other: null,
    })
  })

  it("is inert without a target", () => {
    expect(resolveEffectPath(effect({ kind: "memo" }), ctx)).toBeNull()
  })

  it("is inert without a workspace id", () => {
    expect(resolveEffectPath(effect({ kind: "memo", target: "memo_1" }), { ...ctx, workspaceId: null })).toBeNull()
  })

  it("is inert for a settings key no tab renders", () => {
    expect(resolveEffectPath(effect({ kind: "settings", target: "language" }), ctx)).toBeNull()
  })

  it("is inert for a preference the agent cannot set", () => {
    expect(resolveEffectPath(effect({ kind: "settings", target: "sidebarCollapsed" }), ctx)).toBeNull()
  })

  it("is inert for settings when there is no settings context", () => {
    expect(resolveEffectPath(effect({ kind: "settings", target: "theme" }), { workspaceId: "ws_1" })).toBeNull()
  })
})

describe("SETTINGS_TAB_BY_PREFERENCE_KEY", () => {
  it("covers every agent-settable preference key", () => {
    expect(Object.keys(SETTINGS_TAB_BY_PREFERENCE_KEY).sort()).toEqual([...AGENT_SETTABLE_PREFERENCE_KEYS].sort())
  })
})

describe("labels and diffs", () => {
  it("names a label-less effect from its kind", () => {
    expect(TOOL_EFFECT_KINDS.map((kind) => kindNoun(kind))).toEqual([
      "Setting",
      "Delegation",
      "Memo",
      "Follow-up",
      "Brief",
      "Change",
    ])
  })

  it("prefers the tool's own label", () => {
    expect(effectLabel(effect({ kind: "memo", label: "Saved a memo" }))).toBe("Saved a memo")
  })

  it("returns a diff only when both sides exist", () => {
    expect(effectDiff(effect({ kind: "settings", before: "dark", after: "light" }))).toEqual({
      before: "dark",
      after: "light",
    })
    expect(effectDiff(effect({ kind: "settings", after: "light" }))).toBeNull()
  })
})

describe("unionSessionEffects", () => {
  it("unions across payloads and dedupes identical effects", () => {
    const shared = effect({ kind: "memo", label: "Memo A", target: "memo_1" })
    const result = unionSessionEffects(
      { effects: [shared, effect({ kind: "settings", label: "Theme", target: "theme" })] },
      { effects: [shared, effect({ kind: "delegation", label: "Task", target: "dlg_1" })] },
      null
    )
    expect(result).toEqual([
      shared,
      effect({ kind: "settings", label: "Theme", target: "theme" }),
      effect({ kind: "delegation", label: "Task", target: "dlg_1" }),
    ])
  })
})
