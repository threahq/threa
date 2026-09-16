import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AIUsageByUser, AIUserLimits } from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
import { aiUsageApi } from "@/api/ai-usage"
import * as useMobileModule from "@/hooks/use-mobile"
import { TopSpendersCard } from "./usage-breakdown"

const WS = "ws_1"

const byUser: AIUsageByUser[] = [{ userId: "usr_ada", totalCostUsd: 4, totalTokens: 1000, recordCount: 3 }]

const adaLimits: AIUserLimits = {
  userId: "usr_ada",
  monthlyQuotaUsd: 10,
  agentAllowanceUsd: 5,
  aiDisabled: false,
}

function mount(userLimits: AIUserLimits[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TopSpendersCard
        workspaceId={WS}
        byUser={byUser}
        userNames={
          new Map([
            ["usr_ada", "Ada Lovelace"],
            ["usr_grace", "Grace Hopper"],
          ])
        }
        userLimits={userLimits}
        assistantTotal={4}
        isLoading={false}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
})

afterEach(() => vi.restoreAllMocks())

describe("TopSpendersCard user limits", () => {
  it("shows a user's limits on the row and saves the edited limits as a full replace", async () => {
    const setUserLimits = vi
      .spyOn(aiUsageApi, "setUserLimits")
      .mockResolvedValue({ limits: { ...adaLimits, monthlyQuotaUsd: 20, agentAllowanceUsd: null, aiDisabled: true } })
    const user = userEvent.setup()
    mount([adaLimits])

    expect(screen.getByText("Max $10 · Agents $5")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Edit AI limits for Ada Lovelace" }))

    const quota = screen.getByLabelText("Total AI max")
    await user.clear(quota)
    await user.type(quota, "20")
    await user.clear(screen.getByLabelText("Agent allowance"))
    await user.click(screen.getByRole("switch"))
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(setUserLimits).toHaveBeenCalled())
    expect(setUserLimits.mock.calls[0]).toEqual([
      WS,
      "usr_ada",
      { monthlyQuotaUsd: 20, agentAllowanceUsd: null, aiDisabled: true },
    ])
    await waitFor(() => expect(screen.queryByLabelText("Total AI max")).not.toBeInTheDocument())
  })

  it("resets a user to the workspace defaults", async () => {
    const resetUserLimits = vi.spyOn(aiUsageApi, "resetUserLimits").mockResolvedValue()
    const user = userEvent.setup()
    mount([adaLimits])

    await user.click(screen.getByRole("button", { name: "Edit AI limits for Ada Lovelace" }))
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }))

    await waitFor(() => expect(resetUserLimits).toHaveBeenCalled())
    expect(resetUserLimits.mock.calls[0]).toEqual([WS, "usr_ada"])
  })

  it("offers no reset for a user without limits of their own", async () => {
    const user = userEvent.setup()
    mount([])

    await user.click(screen.getByRole("button", { name: "Edit AI limits for Ada Lovelace" }))

    expect(screen.getByLabelText("Total AI max")).toHaveValue(null)
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).not.toBeInTheDocument()
  })

  it("should open limits for a member who has not used AI when they are picked from the member list", async () => {
    const setUserLimits = vi
      .spyOn(aiUsageApi, "setUserLimits")
      .mockResolvedValue({
        limits: { userId: "usr_grace", monthlyQuotaUsd: 3, agentAllowanceUsd: null, aiDisabled: false },
      })
    const user = userEvent.setup()
    mount([])

    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("Grace Hopper"))
    expect(screen.getByText("AI limits for Grace Hopper")).toBeInTheDocument()

    await user.type(screen.getByLabelText("Total AI max"), "3")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(setUserLimits).toHaveBeenCalled())
    expect(setUserLimits.mock.calls[0]).toEqual([
      WS,
      "usr_grace",
      { monthlyQuotaUsd: 3, agentAllowanceUsd: null, aiDisabled: false },
    ])
  })
})
