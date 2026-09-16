import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { WorkspaceAISpendSection } from "./workspace-detail-ai-spend"

const WORKSPACE_ID = "ws_abc"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function installFetch(onPut: (body: unknown) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (!url.includes(`/workspaces/${WORKSPACE_ID}/ai-spend-controls`)) throw new Error(`unexpected fetch: ${url}`)
      if (init?.method === "PUT") return onPut(JSON.parse(init.body as string))
      return json({ controls: { operatorCeilingUsd: 50, operatorAiDisabled: false } })
    })
  )
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <WorkspaceAISpendSection workspaceId={WORKSPACE_ID} />
    </QueryClientProvider>
  )
}

describe("WorkspaceAISpendSection", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("should save the off switch immediately when the ceiling input is invalid", async () => {
    const puts: unknown[] = []
    installFetch((body) => {
      puts.push(body)
      return json({ controls: body })
    })
    renderSection()

    const ceiling = await screen.findByLabelText<HTMLInputElement>("Monthly ceiling (USD)")
    await userEvent.clear(ceiling)
    await userEvent.click(screen.getByRole("switch", { name: "AI off for this workspace" }))

    await waitFor(() => expect(puts).toEqual([{ operatorCeilingUsd: 50, operatorAiDisabled: true }]))
    await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled())
    expect({
      off: screen.getByRole<HTMLInputElement>("switch").checked,
      ceiling: screen.getByLabelText<HTMLInputElement>("Monthly ceiling (USD)").value,
      saveCeilingDisabled: screen.getByRole("button", { name: "Save ceiling" }).hasAttribute("disabled"),
    }).toEqual({ off: true, ceiling: "", saveCeilingDisabled: true })
  })

  it("should save the ceiling when the operator presses Save ceiling", async () => {
    const puts: unknown[] = []
    installFetch((body) => {
      puts.push(body)
      return json({ controls: body })
    })
    renderSection()

    const ceiling = await screen.findByLabelText<HTMLInputElement>("Monthly ceiling (USD)")
    expect(screen.getByRole("button", { name: "Save ceiling" })).toBeDisabled()

    await userEvent.clear(ceiling)
    await userEvent.type(ceiling, "120.5")
    await userEvent.click(screen.getByRole("button", { name: "Save ceiling" }))

    await waitFor(() => expect(puts).toEqual([{ operatorCeilingUsd: 120.5, operatorAiDisabled: false }]))
    await waitFor(() => expect(screen.getByRole("button", { name: "Save ceiling" })).toBeDisabled())
    expect({
      ceiling: screen.getByLabelText<HTMLInputElement>("Monthly ceiling (USD)").value,
      alert: screen.queryByRole("alert"),
    }).toEqual({ ceiling: "120.5", alert: null })
  })

  it("should show the stored state and an error when a save fails", async () => {
    installFetch(() => json({ error: "Invalid request body", code: "VALIDATION_ERROR" }, 400))
    renderSection()

    await userEvent.click(await screen.findByRole("switch", { name: "AI off for this workspace" }))

    expect(await screen.findByText(/Couldn't save AI spend controls/)).toBeInTheDocument()
    expect(screen.getByRole<HTMLInputElement>("switch").checked).toBe(false)
  })
})
