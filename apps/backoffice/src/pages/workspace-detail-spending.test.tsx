import { describe, it, expect, afterEach, vi } from "vitest"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query"
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter } from "react-router-dom"
import {
  AI_SPENDING_COVERAGE,
  type AISpendingLimits,
  type AISpendingOverview,
  type AISpendingPolicyWire,
} from "@threahq/types"
import { WorkspaceDetailSpendingPage } from "./workspace-detail-spending"
import { WorkspaceDetailLayout } from "./workspace-detail-layout"
import { WorkspaceDetailFlagsPage } from "./workspace-detail-flags"
import { backofficeKeys } from "@/api/backoffice"

const WORKSPACE_ID = "ws_abc"
const OPERATOR = "user_operator"
const SPENDING_URL = `/api/backoffice/workspaces/${WORKSPACE_ID}/ai-spending`

const LIMITS: AISpendingLimits = {
  agentCutoffUsd: "10",
  enrichmentCutoffUsd: "20",
  coreCutoffUsd: "30",
  embeddingCutoffUsd: "40",
  operatorCeilingUsd: "50",
}

function enforcedPolicy(overrides: Partial<AISpendingPolicyWire> = {}): AISpendingPolicyWire {
  return {
    workspaceId: WORKSPACE_ID,
    version: 2,
    emergencyLatched: false,
    statusChangedAt: "2026-09-01T10:00:00.000Z",
    statusChangedBy: OPERATOR,
    updatedBy: OPERATOR,
    status: "enforced",
    limits: LIMITS,
    coverageProfile: "assistant-text-v1",
    ...overrides,
  } as AISpendingPolicyWire
}

function overviewWith(
  policy: AISpendingPolicyWire | null,
  currentPeriod: AISpendingOverview["currentPeriod"] = null
): AISpendingOverview {
  return {
    workspaceId: WORKSPACE_ID,
    policy,
    currentPeriod,
    coverage: { ...AI_SPENDING_COVERAGE, metered: [...AI_SPENDING_COVERAGE.metered] },
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

interface FakeRegion {
  overview: AISpendingOverview
  gets: number
  puts: unknown[]
}

type PutHandler = (body: unknown, region: FakeRegion) => Response | Promise<Response>

/** Stands in for the control plane at the fetch boundary; each PUT consumes the next handler. */
function installRegion(initial: AISpendingOverview, putHandlers: PutHandler[] = [], getFailures = 0): FakeRegion {
  const region: FakeRegion = { overview: initial, gets: 0, puts: [] }
  let remainingGetFailures = getFailures
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      if (url === SPENDING_URL && method === "PUT") {
        const body = JSON.parse(init?.body as string)
        region.puts.push(body)
        const handler = putHandlers.shift()
        if (!handler) throw new Error("unexpected PUT")
        return handler(body, region)
      }
      if (url === SPENDING_URL) {
        region.gets += 1
        if (remainingGetFailures > 0) {
          remainingGetFailures -= 1
          return json(502, { error: "Region unavailable", code: "REGION_UNAVAILABLE" })
        }
        return json(200, region.overview)
      }
      if (url.endsWith("/feature-flags")) return json(200, { flags: [], overrides: [] })
      if (url.endsWith("/members")) return json(200, { members: [] })
      if (url === "/api/backoffice/config") {
        return json(200, { config: { workspaceAppBaseUrl: "", workosEnvironmentId: null } })
      }
      if (url === `/api/backoffice/workspaces/${WORKSPACE_ID}`) {
        return json(200, {
          workspace: {
            id: WORKSPACE_ID,
            name: "Acme",
            slug: "acme",
            region: "eu",
            createdByWorkosUserId: OPERATOR,
            workosOrganizationId: null,
            memberCount: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            owner: { workosUserId: OPERATOR, email: null, name: null },
          },
        })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    })
  )
  return region
}

/** Saves as the region would: next version, normalized amounts, latch untouched. */
function acknowledge(normalize: (limits: AISpendingLimits) => AISpendingLimits = (l) => l): PutHandler {
  return (body, region) => {
    const update = body as { expectedVersion: number; status: "enforced" | "disabled"; limits?: AISpendingLimits }
    const previous = region.overview.policy
    const policy = {
      workspaceId: WORKSPACE_ID,
      version: update.expectedVersion + 1,
      emergencyLatched: previous?.emergencyLatched ?? false,
      statusChangedAt: "2026-09-16T12:00:00.000Z",
      statusChangedBy: OPERATOR,
      updatedBy: OPERATOR,
      status: update.status,
      limits: update.limits ? normalize(update.limits) : (previous?.limits ?? null),
      coverageProfile: update.limits ? "assistant-text-v1" : (previous?.coverageProfile ?? null),
    } as AISpendingPolicyWire
    region.overview = { ...region.overview, policy }
    return json(200, { policy })
  }
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderPage() {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter initialEntries={[`/workspaces/${WORKSPACE_ID}/spending`]}>
        <Routes>
          <Route path="/workspaces/:id/spending" element={<WorkspaceDetailSpendingPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const amount = (label: string) => screen.getByLabelText<HTMLInputElement>(label)
const applyButton = () => screen.getByRole("button", { name: /Apply limits|Applying/ })

async function fillLimits(user: ReturnType<typeof userEvent.setup>, limits: AISpendingLimits) {
  for (const [label, value] of [
    ["Operator ceiling (USD)", limits.operatorCeilingUsd],
    ["Agent cutoff (USD)", limits.agentCutoffUsd],
    ["Enrichment cutoff (USD)", limits.enrichmentCutoffUsd],
    ["Core cutoff (USD)", limits.coreCutoffUsd],
    ["Embedding cutoff (USD)", limits.embeddingCutoffUsd],
  ] as const) {
    await user.clear(amount(label))
    if (value) await user.type(amount(label), value)
  }
}

function acknowledgeCoverage(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole("checkbox", { name: /only the metered work listed above/ }))
}

describe("WorkspaceDetailSpendingPage", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  it("should show a load failure with retry when the region is unavailable", async () => {
    const region = installRegion(overviewWith(null), [], 1)
    renderPage()

    expect(screen.getByText("Loading AI spending…")).toBeInTheDocument()
    await screen.findByText("Couldn't load AI spending from the workspace's region.")

    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByText("No policy")).toBeInTheDocument()
    expect(region.gets).toBe(2)
  })

  it("should show a missing policy with empty amounts and Apply unavailable until all five and coverage are set", async () => {
    const user = userEvent.setup()
    installRegion(overviewWith(null))
    renderPage()

    expect(await screen.findByText("No policy")).toBeInTheDocument()
    expect(screen.getByText("The spending ledger has no reservations this period.")).toBeInTheDocument()
    expect(
      [
        "Operator ceiling (USD)",
        "Agent cutoff (USD)",
        "Enrichment cutoff (USD)",
        "Core cutoff (USD)",
        "Embedding cutoff (USD)",
      ].map((label) => amount(label).value)
    ).toEqual(["", "", "", "", ""])
    expect(applyButton()).toBeDisabled()

    await fillLimits(user, { ...LIMITS, embeddingCutoffUsd: "" })
    await acknowledgeCoverage(user)
    expect(applyButton()).toBeDisabled()

    await user.type(amount("Embedding cutoff (USD)"), "40")
    expect(applyButton()).toBeEnabled()
  })

  it("should label an explicit unprotected policy as unprotected, never as enforced", async () => {
    installRegion(
      overviewWith(enforcedPolicy({ status: "unprotected", limits: null, coverageProfile: null, version: 1 }))
    )
    renderPage()

    expect(await screen.findByText("Unprotected")).toBeInTheDocument()
    expect(
      screen.getByText("These spending controls are inactive. Existing AI budget settings still apply.")
    ).toBeInTheDocument()
    expect(screen.queryByText("Limits enforced")).not.toBeInTheDocument()
    expect(amount("Agent cutoff (USD)").value).toBe("")
  })

  it("should show exact period amounts without rounding a nonzero amount to zero", async () => {
    installRegion(
      overviewWith(enforcedPolicy(), {
        id: "period_1",
        workspaceId: WORKSPACE_ID,
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
        timezone: "UTC",
        settledUsd: "0.00000001",
        committedUsd: "1234567.5",
      })
    )
    renderPage()

    const settled = await screen.findByText("Settled")
    expect(settled.nextElementSibling).toHaveTextContent("$0.00000001")
    expect(screen.getByText("Committed, not yet settled").nextElementSibling).toHaveTextContent("$1,234,567.50")
  })

  it("should send exact strings with version and coverage and show only the acknowledged regional state", async () => {
    const user = userEvent.setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const region = installRegion(overviewWith(null), [
      async (body, r) => {
        await gate
        return acknowledge((limits) => ({ ...limits, embeddingCutoffUsd: "1.5" }))(body, r)
      },
    ])
    renderPage()
    await screen.findByText("No policy")

    const typed: AISpendingLimits = {
      agentCutoffUsd: "0",
      enrichmentCutoffUsd: "0.00000001",
      coreCutoffUsd: "0.5",
      embeddingCutoffUsd: "1.50",
      operatorCeilingUsd: "999999999999.99999999",
    }
    await fillLimits(user, typed)
    await acknowledgeCoverage(user)
    await user.click(applyButton())

    await waitFor(() => expect(region.puts).toHaveLength(1))
    expect(region.puts[0]).toEqual({
      expectedVersion: 0,
      status: "enforced",
      limits: typed,
      coverageProfile: "assistant-text-v1",
    })
    expect(applyButton()).toHaveTextContent("Applying…")
    expect(applyButton()).toBeDisabled()
    expect(screen.getByText("No policy")).toBeInTheDocument()
    expect(screen.queryByText("Limits enforced")).not.toBeInTheDocument()

    await act(async () => release())

    expect(await screen.findByText("Limits enforced")).toBeInTheDocument()
    expect(screen.getByText(/^Version/)).toHaveTextContent("Version 1.")
    expect(amount("Embedding cutoff (USD)").value).toBe("1.5")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("should disable AI only after confirmation and keep the saved limits", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(enforcedPolicy({ version: 3 })), [acknowledge()])
    renderPage()
    await screen.findByText("Limits enforced")

    await user.click(screen.getByRole("button", { name: "Disable AI" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("admit no paid AI work in this workspace until limits are applied again")
    await user.click(within(dialog).getByRole("button", { name: "Keep AI on" }))
    expect(region.puts).toEqual([])

    await user.click(screen.getByRole("button", { name: "Disable AI" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disable AI" }))

    expect(await screen.findByText("AI disabled")).toBeInTheDocument()
    expect(region.puts).toEqual([{ expectedVersion: 3, status: "disabled" }])
    expect(amount("Operator ceiling (USD)").value).toBe("50")
    expect(screen.queryByRole("button", { name: "Disable AI" })).not.toBeInTheDocument()
  })

  it("should keep showing a latched emergency stop after limits are applied, with no way to clear it", async () => {
    const user = userEvent.setup()
    installRegion(overviewWith(enforcedPolicy({ emergencyLatched: true, status: "disabled" })), [acknowledge()])
    renderPage()

    expect(await screen.findByText("Emergency stop")).toBeInTheDocument()
    expect(screen.getByText("Saved status: AI disabled")).toBeInTheDocument()

    await acknowledgeCoverage(user)
    await user.click(applyButton())

    expect(await screen.findByText("Saved status: Limits enforced")).toBeInTheDocument()
    expect(screen.getByText("Emergency stop")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /clear|unprotect|reset/i })).not.toBeInTheDocument()
  })

  it("should keep the draft on a stale 409, show the newer saved policy, and require review before resubmitting", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(enforcedPolicy({ version: 2 })), [
      (_body, r) => {
        r.overview = overviewWith(enforcedPolicy({ version: 3, limits: { ...LIMITS, agentCutoffUsd: "9" } }))
        return json(409, { error: "stale", code: "STALE_SPEND_POLICY" })
      },
      acknowledge(),
    ])
    renderPage()
    await screen.findByText("Limits enforced")

    await user.clear(amount("Agent cutoff (USD)"))
    await user.type(amount("Agent cutoff (USD)"), "7")
    await acknowledgeCoverage(user)
    await user.click(applyButton())

    expect(await screen.findByText(/saved policy is now version 3/)).toBeInTheDocument()
    expect(screen.getByText(/^Version/)).toHaveTextContent("Version 3.")
    expect(amount("Agent cutoff (USD)").value).toBe("7")
    expect(applyButton()).toBeDisabled()
    expect(region.puts).toHaveLength(1)

    await user.click(screen.getByRole("button", { name: "Keep my values" }))
    expect(applyButton()).toBeDisabled()
    await acknowledgeCoverage(user)
    await user.click(applyButton())

    await waitFor(() => expect(screen.getByText(/^Version/)).toHaveTextContent("Version 4."))
    expect(region.puts[1]).toEqual({
      expectedVersion: 3,
      status: "enforced",
      limits: { ...LIMITS, agentCutoffUsd: "7" },
      coverageProfile: "assistant-text-v1",
    })
  })

  it("should not claim success on a network failure and should allow a retry at the same version", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(null), [
      () => Promise.reject(new TypeError("Failed to fetch")),
      acknowledge(),
    ])
    renderPage()
    await screen.findByText("No policy")

    await fillLimits(user, LIMITS)
    await acknowledgeCoverage(user)
    const getsBefore = region.gets
    await user.click(applyButton())

    expect(await screen.findByText(/Limits not confirmed\. The region didn't confirm the change/)).toBeInTheDocument()
    await waitFor(() => expect(region.gets).toBeGreaterThan(getsBefore))
    expect(screen.getByText("No policy")).toBeInTheDocument()
    expect(amount("Operator ceiling (USD)").value).toBe("50")
    expect(applyButton()).toBeEnabled()

    await user.click(applyButton())
    expect(await screen.findByText("Limits enforced")).toBeInTheDocument()
    expect(region.puts.map((put) => (put as { expectedVersion: number }).expectedVersion)).toEqual([0, 0])
  })

  it("should treat a 502 whose write did apply as a newer saved version needing review", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(null), [
      (body, r) => {
        acknowledge()(body, r)
        return json(502, { error: "Region unavailable", code: "REGION_UNAVAILABLE" })
      },
    ])
    renderPage()
    await screen.findByText("No policy")

    await fillLimits(user, LIMITS)
    await acknowledgeCoverage(user)
    await user.click(applyButton())

    expect(await screen.findByText("Limits enforced")).toBeInTheDocument()
    expect(screen.getByText(/didn't confirm the change/)).toBeInTheDocument()
    expect(screen.getByText(/saved policy is now version 1/)).toBeInTheDocument()
    expect(applyButton()).toBeDisabled()
    expect(region.puts).toHaveLength(1)
  })

  it("should reach every amount and the coverage checkbox by label in keyboard order", async () => {
    const user = userEvent.setup()
    installRegion(overviewWith(null))
    renderPage()
    await screen.findByText("No policy")

    amount("Operator ceiling (USD)").focus()
    const order = [document.activeElement]
    for (let i = 0; i < 5; i++) {
      await user.tab()
      order.push(document.activeElement)
    }
    expect(order).toEqual([
      amount("Operator ceiling (USD)"),
      amount("Agent cutoff (USD)"),
      amount("Enrichment cutoff (USD)"),
      amount("Core cutoff (USD)"),
      amount("Embedding cutoff (USD)"),
      screen.getByRole("checkbox", { name: /only the metered work listed above/ }),
    ])
    expect(amount("Agent cutoff (USD)")).toHaveAttribute("inputmode", "decimal")
  })

  it("should derive the active tab from the URL across navigation and history back", async () => {
    installRegion(overviewWith(enforcedPolicy()))
    const router = createMemoryRouter(
      [
        {
          path: "/workspaces/:id",
          element: <WorkspaceDetailLayout />,
          children: [
            { path: "flags", element: <WorkspaceDetailFlagsPage /> },
            { path: "spending", element: <WorkspaceDetailSpendingPage /> },
          ],
        },
      ],
      { initialEntries: [`/workspaces/${WORKSPACE_ID}/spending`] }
    )
    render(
      <QueryClientProvider client={newQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )

    const tab = (name: string) => screen.getByRole("link", { name })
    await screen.findByText("Limits enforced")
    expect(tab("AI spending")).toHaveAttribute("aria-current", "page")

    await userEvent.click(tab("Feature flags"))
    await waitFor(() => expect(tab("Feature flags")).toHaveAttribute("aria-current", "page"))
    expect(tab("AI spending")).not.toHaveAttribute("aria-current")

    await act(() => router.navigate(-1))
    expect(await screen.findByText("Limits enforced")).toBeInTheDocument()
    expect(tab("AI spending")).toHaveAttribute("aria-current", "page")
  })
  it("should refetch on focus and reconnect without discarding a draft, and block Apply when the saved version moved", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(enforcedPolicy({ version: 2 })))
    renderPage()
    await screen.findByText("Limits enforced")

    await user.clear(amount("Agent cutoff (USD)"))
    await user.type(amount("Agent cutoff (USD)"), "7")
    await acknowledgeCoverage(user)
    expect(applyButton()).toBeEnabled()

    region.overview = overviewWith(enforcedPolicy({ version: 3, limits: { ...LIMITS, agentCutoffUsd: "9" } }))
    const getsBeforeFocus = region.gets
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(screen.getByText(/^Version/)).toHaveTextContent("Version 3."))
    expect(region.gets).toBe(getsBeforeFocus + 1)
    expect(amount("Agent cutoff (USD)").value).toBe("7")
    expect(screen.getByText(/saved policy is now version 3/)).toBeInTheDocument()
    expect(applyButton()).toBeDisabled()

    const getsBeforeReconnect = region.gets
    act(() => {
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
    })
    await waitFor(() => expect(region.gets).toBe(getsBeforeReconnect + 1))
    expect(amount("Agent cutoff (USD)").value).toBe("7")
    expect(region.puts).toEqual([])
  })

  it("should send the version captured when the disable dialog opened and surface a stale rejection", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(enforcedPolicy({ version: 3 })), [
      () => json(409, { error: "raw backend stale text", code: "STALE_SPEND_POLICY" }),
    ])
    renderPage()
    await screen.findByText("Limits enforced")

    await user.click(screen.getByRole("button", { name: "Disable AI" }))
    const dialog = await screen.findByRole("alertdialog")

    region.overview = overviewWith(enforcedPolicy({ version: 4 }))
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(screen.getByText(/^Version/)).toHaveTextContent("Version 4."))

    await user.click(within(dialog).getByRole("button", { name: "Disable AI" }))

    expect(await screen.findByText(/AI disable not confirmed\. The policy version changed/)).toBeInTheDocument()
    expect(region.puts).toEqual([{ expectedVersion: 3, status: "disabled" }])
    expect(screen.getByText("Limits enforced")).toBeInTheDocument()
    expect(screen.queryByText(/raw backend stale text/)).not.toBeInTheDocument()
  })

  it("should show local recovery copy, never the backend message, for coverage and ordering rejections", async () => {
    const user = userEvent.setup()
    const region = installRegion(overviewWith(null), [
      () => json(409, { error: "raw coverage text", code: "SPEND_COVERAGE_NOT_ACKNOWLEDGED" }),
      () => json(400, { error: "raw order text", code: "INVALID_SPEND_POLICY" }),
    ])
    renderPage()
    await screen.findByText("No policy")

    await fillLimits(user, LIMITS)
    await acknowledgeCoverage(user)
    await user.click(applyButton())
    expect(await screen.findByText(/no longer accepts this coverage profile/)).toBeInTheDocument()

    await user.click(applyButton())
    expect(await screen.findByText(/Each cutoff must be at most the next one/)).toBeInTheDocument()
    expect(screen.queryByText(/raw (coverage|order) text/)).not.toBeInTheDocument()
    expect(amount("Operator ceiling (USD)").value).toBe("50")
    expect(region.puts).toHaveLength(2)
  })

  it("should keep drafts and late acknowledgements inside their own workspace when the route changes mid-save", async () => {
    const user = userEvent.setup()
    const B_LIMITS: AISpendingLimits = { ...LIMITS, agentCutoffUsd: "1" }
    const workspaces: Record<string, AISpendingOverview> = {
      ws_a: { ...overviewWith(enforcedPolicy({ workspaceId: "ws_a", version: 2 })), workspaceId: "ws_a" },
      ws_b: {
        ...overviewWith(enforcedPolicy({ workspaceId: "ws_b", version: 5, limits: B_LIMITS })),
        workspaceId: "ws_b",
      },
    }
    const puts: { url: string; body: unknown }[] = []
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => (releaseA = resolve))
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        const id = /workspaces\/(ws_[ab])\/ai-spending$/.exec(url)?.[1]
        if (!id) throw new Error(`unexpected fetch: ${url}`)
        if (init?.method === "PUT") {
          const body = JSON.parse(init.body as string) as { expectedVersion: number; limits: AISpendingLimits }
          puts.push({ url, body })
          if (id === "ws_a") await gateA
          const policy = enforcedPolicy({ workspaceId: id, version: body.expectedVersion + 1, limits: body.limits })
          workspaces[id] = { ...workspaces[id]!, policy }
          return json(200, { policy })
        }
        return json(200, workspaces[id])
      })
    )
    const queryClient = newQueryClient()
    const router = createMemoryRouter(
      [{ path: "/workspaces/:id/spending", element: <WorkspaceDetailSpendingPage /> }],
      {
        initialEntries: ["/workspaces/ws_a/spending"],
      }
    )
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    )
    await screen.findByText("Limits enforced")

    await user.clear(amount("Agent cutoff (USD)"))
    await user.type(amount("Agent cutoff (USD)"), "7")
    await acknowledgeCoverage(user)
    await user.click(applyButton())
    await waitFor(() => expect(applyButton()).toHaveTextContent("Applying…"))

    await act(() => router.navigate("/workspaces/ws_b/spending"))
    await waitFor(() => expect(screen.getByText(/^Version/)).toHaveTextContent("Version 5."))
    expect({
      agent: amount("Agent cutoff (USD)").value,
      acknowledged: screen.getByRole("checkbox", { name: /only the metered work listed above/ }).matches(":checked"),
      apply: applyButton().textContent,
      applyDisabled: applyButton().hasAttribute("disabled"),
    }).toEqual({ agent: "1", acknowledged: false, apply: "Apply limits", applyDisabled: true })

    await act(async () => releaseA())
    await waitFor(() =>
      expect(
        queryClient.getQueryData<AISpendingOverview>(backofficeKeys.workspaceAISpending("ws_a"))?.policy?.version
      ).toBe(3)
    )
    expect(screen.getByText(/^Version/)).toHaveTextContent("Version 5.")
    expect(amount("Agent cutoff (USD)").value).toBe("1")
    expect(queryClient.getQueryData<AISpendingOverview>(backofficeKeys.workspaceAISpending("ws_b"))?.policy).toEqual(
      workspaces.ws_b!.policy
    )

    await user.clear(amount("Agent cutoff (USD)"))
    await user.type(amount("Agent cutoff (USD)"), "2")
    await acknowledgeCoverage(user)
    await user.click(applyButton())
    await waitFor(() => expect(screen.getByText(/^Version/)).toHaveTextContent("Version 6."))
    expect(
      puts.map(({ url, body }) => ({ url, expectedVersion: (body as { expectedVersion: number }).expectedVersion }))
    ).toEqual([
      { url: "/api/backoffice/workspaces/ws_a/ai-spending", expectedVersion: 2 },
      { url: "/api/backoffice/workspaces/ws_b/ai-spending", expectedVersion: 5 },
    ])

    await act(() => router.navigate("/workspaces/ws_a/spending"))
    await waitFor(() => expect(screen.getByText(/^Version/)).toHaveTextContent("Version 3."))
    expect(amount("Agent cutoff (USD)").value).toBe("7")
  })
})
