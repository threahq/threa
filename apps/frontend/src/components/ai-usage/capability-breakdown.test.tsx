import { describe, expect, it } from "vitest"
import { render, screen, userEvent } from "@/test"
import type { AIUsageByFunction, AIUsageByModel } from "@threa/types"
import { CapabilityBreakdown } from "./capability-breakdown"

const byFunction: AIUsageByFunction[] = [
  { functionId: "message-embedding", category: "memory", totalCostUsd: 0.1, totalTokens: 1000, recordCount: 40 },
  { functionId: "memo-embedding", category: "memory", totalCostUsd: 0.05, totalTokens: 500, recordCount: 10 },
  { functionId: "agent-loop", category: "agents", totalCostUsd: 0.3, totalTokens: 9000, recordCount: 12 },
]

const byModel: AIUsageByModel[] = [
  { model: "provider/big", totalCostUsd: 0.3, totalTokens: 9000, recordCount: 12 },
  { model: "provider/embed", totalCostUsd: 0.15, totalTokens: 1500, recordCount: 50 },
]

const totalCost = 0.45

describe("CapabilityBreakdown", () => {
  it("groups functions under their category labels with summed currency", () => {
    render(<CapabilityBreakdown byFunction={byFunction} byModel={byModel} totalCost={totalCost} isLoading={false} />)

    const memory = screen.getByRole("button", { name: /Memory \(GAM\)/ })
    expect(memory).toHaveTextContent("$0.15")
    const agents = screen.getByRole("button", { name: /Agents & personas/ })
    expect(agents).toHaveTextContent("$0.30")
  })

  it("reveals the per-function rows when a category is expanded", async () => {
    const user = userEvent.setup()
    render(<CapabilityBreakdown byFunction={byFunction} byModel={byModel} totalCost={totalCost} isLoading={false} />)

    expect(screen.queryByText("message-embedding")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Memory \(GAM\)/ }))

    expect(screen.getByText("message-embedding")).toBeInTheDocument()
    expect(screen.getByText("memo-embedding")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Memory \(GAM\)/ })).toHaveAttribute("aria-expanded", "true")
  })

  it("renders the empty state when there is no function usage", () => {
    render(<CapabilityBreakdown byFunction={[]} byModel={[]} totalCost={0} isLoading={false} />)
    expect(screen.getByText(/No AI usage recorded yet this cycle/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Memory/ })).not.toBeInTheDocument()
  })
})
