import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threahq/types"
import { ToolPolicyPicker } from "./tool-policy-picker"

const updateToolPolicy =
  vi.fn<(workspaceId: string, streamId: string, policy: ToolPrivacyPolicy) => Promise<ToolPrivacyPolicy>>()

function renderPicker(
  value: ToolPrivacyPolicy,
  opts: { configuredCategories?: ToolPrivacyCategory[]; e2e?: boolean } = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ServicesProvider, {
        services: { streams: { updateToolPolicy } as unknown as StreamService },
        children: createElement(TooltipProvider, null, children),
      })
    )
  }
  return render(
    <ToolPolicyPicker
      workspaceId="ws_1"
      streamId="stream_sp"
      value={value}
      configuredCategories={opts.configuredCategories}
      e2e={opts.e2e ?? false}
    />,
    { wrapper: Wrapper }
  )
}

describe("ToolPolicyPicker", () => {
  beforeEach(() => {
    updateToolPolicy.mockReset()
    updateToolPolicy.mockImplementation(async (_w, _s, policy) => policy)
  })

  it("is unrestricted by default and hides the category checkboxes", () => {
    renderPicker(null)

    expect(screen.getByRole("switch", { name: /restrict tool access/i })).not.toBeChecked()
    expect(screen.queryByRole("checkbox", { name: /web/i })).not.toBeInTheDocument()
  })

  it("turning restriction on persists an empty policy — no tools until categories are chosen", async () => {
    renderPicker(null)

    await userEvent.click(screen.getByRole("switch", { name: /restrict tool access/i }))

    expect(updateToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", [])
  })

  it("adds a category to an existing policy without dropping the current ones", async () => {
    renderPicker(["web"])

    expect(screen.getByRole("checkbox", { name: /web/i })).toBeChecked()
    await userEvent.click(screen.getByRole("checkbox", { name: /workspace/i }))

    expect(updateToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", ["web", "workspace"])
  })

  it("turning restriction off clears the policy back to unrestricted (null)", async () => {
    renderPicker(["web"])

    await userEvent.click(screen.getByRole("switch", { name: /restrict tool access/i }))

    expect(updateToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", null)
  })

  it("hides categories the workspace has not configured (e.g. unconnected GitHub/Linear)", () => {
    renderPicker([], { configuredCategories: ["web", "workspace"] })

    expect(screen.getByRole("checkbox", { name: /web/i })).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: /workspace/i })).toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /github/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("checkbox", { name: /linear/i })).not.toBeInTheDocument()
  })

  it("still shows a granted category the workspace no longer configures, so it can be revoked", async () => {
    renderPicker(["web", "github"], { configuredCategories: ["web", "workspace"] })

    // GitHub is no longer configured but remains granted — it must stay visible
    // and checked so the owner can turn it off.
    const github = screen.getByRole("checkbox", { name: /github/i })
    expect(github).toBeInTheDocument()
    expect(github).toBeChecked()

    await userEvent.click(github)

    expect(updateToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", ["web"])
  })

  it("disables non-web categories on an encrypted scratchpad (enclave is web-only)", () => {
    renderPicker([], { configuredCategories: ["web", "workspace"], e2e: true })

    expect(screen.getByRole("checkbox", { name: /web/i })).not.toBeDisabled()
    expect(screen.getByRole("checkbox", { name: /workspace/i })).toBeDisabled()
  })
})
