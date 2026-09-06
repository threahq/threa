import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CURRENT_API_VERSION, type BotApiKey } from "@threahq/types"
import { botsApi } from "@/api/bots"
import * as useFormattedDateModule from "@/hooks/use-formatted-date"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BotKeysSection } from "./bot-keys-section"

function makeKey(overrides: Partial<BotApiKey> = {}): BotApiKey {
  return {
    id: "bak_1",
    botId: "bot_1",
    name: "production",
    keyPrefix: "abcd",
    scopes: ["messages:write"],
    apiVersion: null,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

function renderSection(queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BotKeysSection workspaceId="ws_1" botId="bot_1" isArchived={false} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("BotKeysSection — API version pin", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
      formatTime: (date: Date) => date.toISOString(),
      formatRelative: (date: Date) => date.toISOString(),
      formatFull: (date: Date) => date.toISOString(),
    })
  })

  it("pins an unpinned bot key to a dated version", async () => {
    vi.spyOn(botsApi, "listKeys").mockResolvedValue([makeKey({ apiVersion: null })])
    const update = vi.spyOn(botsApi, "updateKeyVersion").mockResolvedValue(makeKey({ apiVersion: CURRENT_API_VERSION }))
    const user = userEvent.setup()

    renderSection()

    const trigger = await screen.findByRole("button", {
      name: new RegExp(`API version:.*Latest \\(${CURRENT_API_VERSION}\\)`),
    })
    await user.click(trigger)
    await user.click(await screen.findByRole("menuitemradio", { name: CURRENT_API_VERSION }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "bot_1", "bak_1", CURRENT_API_VERSION))
  })

  it("detaches a pinned bot key back to latest", async () => {
    vi.spyOn(botsApi, "listKeys").mockResolvedValue([makeKey({ apiVersion: CURRENT_API_VERSION })])
    const update = vi.spyOn(botsApi, "updateKeyVersion").mockResolvedValue(makeKey({ apiVersion: null }))
    const user = userEvent.setup()

    renderSection()

    const trigger = await screen.findByRole("button", {
      name: (name) => name.includes("API version") && name.includes(CURRENT_API_VERSION) && !name.includes("Latest"),
    })
    await user.click(trigger)
    await user.click(await screen.findByRole("menuitemradio", { name: /Always latest/ }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "bot_1", "bak_1", null))
  })
})
