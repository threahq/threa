import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as memosModule from "@/hooks/use-memos"
import { AGENT_SETTABLE_PREFERENCE_KEYS, TOOL_EFFECT_KINDS, type AgentToolEffect } from "@threa/types"
import {
  SETTINGS_TAB_BY_PREFERENCE_KEY,
  effectDiff,
  effectLabel,
  kindNoun,
  resolveEffectPath,
  unionSessionEffects,
  EffectRow,
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
      // A memo opens in place, so it has no route at all.
      memo: null,
      follow_up: null,
      brief: null,
      other: null,
    })
  })

  it("is inert without a target", () => {
    expect(resolveEffectPath(effect({ kind: "delegation" }), ctx)).toBeNull()
  })

  it("is inert without a workspace id", () => {
    expect(resolveEffectPath(effect({ kind: "delegation", target: "dlg_1" }), { ...ctx, workspaceId: null })).toBeNull()
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

  it("returns a diff whenever there is an `after` to show", () => {
    expect(effectDiff(effect({ kind: "settings", before: "dark", after: "light" }))).toEqual({
      before: "dark",
      after: "light",
    })
    // A reschedule knows where it landed, not where it started.
    expect(effectDiff(effect({ kind: "follow_up", after: "Thu 9:00 AM" }))).toEqual({ after: "Thu 9:00 AM" })
    expect(effectDiff(effect({ kind: "settings", before: "dark" }))).toBeNull()
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

describe("EffectRow", () => {
  function renderRow(e: AgentToolEffect, workspaceId: string | null = "ws_1") {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <EffectRow effect={e} workspaceId={workspaceId} getSettingsUrl={ctx.getSettingsUrl} variant="grid" />
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  it("opens a memo in place rather than navigating to the explorer", async () => {
    const detail = vi.spyOn(memosModule, "useMemoDetail").mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof memosModule.useMemoDetail>)

    renderRow(effect({ kind: "memo", label: "Saved a memo", target: "memo_1" }))

    const trigger = screen.getByRole("button", { name: /Saved a memo/ })
    expect(screen.queryByRole("link", { name: /Saved a memo/ })).not.toBeInTheDocument()
    // Closed: the memo is not fetched until the row is clicked.
    expect(detail).toHaveBeenCalledWith("ws_1", null)

    await userEvent.click(trigger)

    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(detail).toHaveBeenLastCalledWith("ws_1", "memo_1")
    // The row's own label carries the dialog until the memo resolves.
    expect(screen.getByRole("dialog")).toHaveTextContent("Saved a memo")
  })

  it("renders a delegation as a link", () => {
    renderRow(effect({ kind: "delegation", label: "Delegated the audit", target: "dlg_1" }))

    expect(screen.getByRole("link", { name: /Delegated the audit/ })).toHaveAttribute(
      "href",
      "/w/ws_1/delegations/dlg_1"
    )
  })

  it("renders a routeless effect as inert text", () => {
    renderRow(effect({ kind: "follow_up", label: "Reminder on Friday", target: "fu_1" }))

    const text = screen.getByText("Reminder on Friday")
    expect(text.closest("a")).toBeNull()
    expect(text.closest("button")).toBeNull()
  })

  it("renders a memo with no workspace as inert text", () => {
    renderRow(effect({ kind: "memo", label: "Saved a memo", target: "memo_1" }), null)

    expect(screen.queryByRole("button", { name: /Saved a memo/ })).not.toBeInTheDocument()
    expect(screen.getByText("Saved a memo")).toBeInTheDocument()
  })
})
