import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@/test"
import type { AIBudgetResponse, WorkspaceBootstrap } from "@threahq/types"
import * as hooksModule from "@/hooks"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import { SpendLimitsSetting } from "./spend-limits-setting"

function budget(overrides: Partial<AIBudgetResponse["budget"]> = {}): AIBudgetResponse {
  return {
    budget: {
      monthlyBudgetUsd: 50,
      operatorCeilingUsd: 200,
      aiDisabled: false,
      operatorAiDisabled: false,
      ...overrides,
    },
    currentUsage: { totalCostUsd: 12.3 },
  } as AIBudgetResponse
}

function renderRow(data: AIBudgetResponse | undefined) {
  vi.spyOn(hooksModule, "useAIBudget").mockReturnValue({ data } as ReturnType<typeof hooksModule.useAIBudget>)
  return render(
    <MemoryRouter>
      <SpendLimitsSetting workspaceId="ws_1" />
    </MemoryRouter>
  )
}

describe("SpendLimitsSetting", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useWorkspacesModule, "useCachedWorkspaceBootstrap").mockReturnValue({
      workspaceSettings: { billingTimezone: "Europe/Stockholm" },
    } as WorkspaceBootstrap)
  })

  it("shows this month's spend against the limit that applies, linking to where limits are managed", () => {
    renderRow(budget({ operatorCeilingUsd: 40 }))

    const link = screen.getByRole("link", { name: /^Budget and limits/ })
    expect({
      href: link.getAttribute("href"),
      value: within(link).queryByText("$12.30 of $40 this month") !== null,
    }).toEqual({
      href: "/w/ws_1/admin/ai-usage",
      value: true,
    })
    expect(hooksModule.useAIBudget).toHaveBeenCalledWith("ws_1", "Europe/Stockholm")
  })

  it("says AI is off rather than a spend figure when it is turned off", () => {
    renderRow(budget({ aiDisabled: true }))

    expect(screen.getByText("AI turned off")).toBeInTheDocument()
  })

  it("keeps the link while the budget loads", () => {
    renderRow(undefined)

    expect(screen.queryByText(/this month/)).toBeNull()
    expect(screen.getByRole("link", { name: /^Budget and limits/ })).toBeInTheDocument()
  })
})
