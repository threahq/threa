import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type IncomingWebhook } from "@threahq/types"
import { botsApi } from "@/api/bots"
import { API_BASE } from "@/api/client"
import { workspaceKeys } from "@/hooks/use-workspaces"
import * as useFormattedDateModule from "@/hooks/use-formatted-date"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BotWebhooksSection } from "./bot-webhooks-section"

const SECRET = "s3cr3t-token"
const ORIGIN = API_BASE || window.location.origin
const EXPECTED_URL = `${ORIGIN}/api/v1/workspaces/ws_1/hooks/hook_1/${SECRET}`

function makeWebhook(overrides: Partial<IncomingWebhook> = {}): IncomingWebhook {
  return {
    id: "hook_1",
    botId: "bot_1",
    streamId: "stream_alerts",
    name: "alertmanager",
    createdAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    streams: [
      { id: "stream_alerts", type: StreamTypes.CHANNEL, slug: "alerts", displayName: null, archivedAt: null },
      {
        id: "stream_sealed",
        type: StreamTypes.CHANNEL,
        slug: "sealed",
        displayName: null,
        archivedAt: null,
        e2eEnabled: true,
      },
      { id: "stream_ops", type: StreamTypes.CHANNEL, slug: "ops", displayName: null, archivedAt: null },
      { id: "stream_thread", type: StreamTypes.THREAD, slug: null, displayName: "a thread", archivedAt: null },
    ],
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BotWebhooksSection workspaceId="ws_1" botId="bot_1" isArchived={false} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("BotWebhooksSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
      formatTime: (date: Date) => date.toISOString(),
      formatRelative: (date: Date) => date.toISOString(),
      formatFull: (date: Date) => date.toISOString(),
    })
  })

  it("offers a retry instead of the empty state when the list fails to load", async () => {
    const list = vi.spyOn(botsApi, "listWebhooks").mockRejectedValueOnce(new Error("offline"))
    const user = userEvent.setup()
    renderSection()

    await screen.findByText(/Couldn't load webhooks/)
    expect(screen.queryByText(/No webhooks yet/)).toBeNull()

    list.mockResolvedValue([makeWebhook()])
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByText("alertmanager")
    expect(screen.queryByText(/Couldn't load webhooks/)).toBeNull()
  })

  it("creates a webhook, reveals both URLs once, copies one, lists it, then revokes it", async () => {
    let listed: IncomingWebhook[] = []
    vi.spyOn(botsApi, "listWebhooks").mockImplementation(async () => listed)
    const create = vi.spyOn(botsApi, "createWebhook").mockImplementation(async () => {
      listed = [makeWebhook()]
      return { webhook: makeWebhook(), secret: SECRET }
    })
    const revoke = vi.spyOn(botsApi, "revokeWebhook").mockImplementation(async () => {
      listed = [makeWebhook({ revokedAt: "2026-09-02T00:00:00.000Z" })]
    })

    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    renderSection()

    await user.click(await screen.findByRole("button", { name: /New webhook/ }))
    await user.type(screen.getByPlaceholderText("e.g. alertmanager"), "alertmanager")

    await user.click(screen.getByRole("combobox"))
    expect(screen.queryByText("a thread")).toBeNull()
    expect(screen.queryByText("#sealed")).toBeNull()
    await user.click(await screen.findByText("#alerts"))

    await user.click(screen.getByRole("button", { name: /Create webhook/ }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("ws_1", "bot_1", { name: "alertmanager", streamId: "stream_alerts" })
    )

    expect(await screen.findByText(EXPECTED_URL)).toBeTruthy()
    expect(screen.getByText(`${EXPECTED_URL}/slack`)).toBeTruthy()

    const copySlack = screen.getByRole("button", { name: "Copy Slack webhook URL" })
    expect(copySlack.querySelector(".lucide-copy")).toBeTruthy()
    await user.click(copySlack)
    expect(writeText).toHaveBeenCalledWith(`${EXPECTED_URL}/slack`)
    await waitFor(() => expect(copySlack.querySelector(".lucide-check")).toBeTruthy())

    const row = await screen.findByText("alertmanager")
    expect(row).toBeTruthy()
    expect(screen.getAllByText("#alerts").length).toBeGreaterThan(0)

    await user.click(screen.getByRole("button", { name: "Revoke alertmanager" }))
    await user.click(await screen.findByRole("button", { name: /^Revoke webhook$/ }))

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("ws_1", "bot_1", "hook_1"))
    expect(await screen.findByText("1 revoked webhook")).toBeTruthy()
  })

  it("edits a webhook's name and stream without revealing the URL again", async () => {
    let listed: IncomingWebhook[] = [makeWebhook()]
    vi.spyOn(botsApi, "listWebhooks").mockImplementation(async () => listed)
    const update = vi.spyOn(botsApi, "updateWebhook").mockImplementation(async (_ws, _bot, _hook, data) => {
      listed = [makeWebhook({ ...data })]
      return listed[0]
    })

    const user = userEvent.setup()
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Edit alertmanager" }))

    const nameInput = screen.getByPlaceholderText("e.g. alertmanager")
    expect((nameInput as HTMLInputElement).value).toBe("alertmanager")
    await user.clear(nameInput)
    await user.type(nameInput, "grafana")

    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("#ops"))

    await user.click(screen.getByRole("button", { name: /Save webhook/ }))

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("ws_1", "bot_1", "hook_1", { name: "grafana", streamId: "stream_ops" })
    )

    expect(await screen.findByText("grafana")).toBeTruthy()
    expect(screen.getAllByText("#ops").length).toBeGreaterThan(0)
    expect(screen.queryByText(EXPECTED_URL)).toBeNull()
    expect(screen.queryByText(`${EXPECTED_URL}/slack`)).toBeNull()
  })
  it("should send only the name when a webhook is renamed and its stream is no longer selectable", async () => {
    let listed: IncomingWebhook[] = [makeWebhook({ streamId: "stream_archived" })]
    vi.spyOn(botsApi, "listWebhooks").mockImplementation(async () => listed)
    const update = vi.spyOn(botsApi, "updateWebhook").mockImplementation(async (_ws, _bot, _hook, data) => {
      listed = [makeWebhook({ streamId: "stream_archived", ...data })]
      return listed[0]
    })

    const user = userEvent.setup()
    renderSection()

    await user.click(await screen.findByRole("button", { name: "Edit alertmanager" }))
    const nameInput = screen.getByPlaceholderText("e.g. alertmanager")
    await user.clear(nameInput)
    await user.type(nameInput, "grafana")
    await user.click(screen.getByRole("button", { name: /Save webhook/ }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "bot_1", "hook_1", { name: "grafana" }))
  })
})
