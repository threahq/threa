import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Bot } from "@threahq/types"
import { botsApi } from "@/api/bots"
import * as useFormattedDateModule from "@/hooks/use-formatted-date"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BotDetail } from "./bot-detail"

type PersonalBot = Extract<Bot, { type: "personal" }>
type SharedBot = Extract<Bot, { type: "shared" }>

const botBase = {
  id: "bot_1",
  workspaceId: "ws_1",
  traits: [],
  slug: "helper",
  name: "Helper",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  archivedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
} satisfies Omit<PersonalBot, "type" | "ownerUserId" | "readsAsOwner">

function makePersonalBot(overrides: Partial<Omit<PersonalBot, "type">> = {}): PersonalBot {
  return { ...botBase, type: "personal", ownerUserId: "usr_owner", readsAsOwner: false, ...overrides }
}

function makeSharedBot(): SharedBot {
  return { ...botBase, type: "shared", ownerUserId: null, readsAsOwner: false }
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BotDetail workspaceId="ws_1" botId="bot_1" onBack={() => {}} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("BotDetail — reads-as-owner setting", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
      formatTime: (date: Date) => date.toISOString(),
      formatRelative: (date: Date) => date.toISOString(),
      formatFull: (date: Date) => date.toISOString(),
    })
    vi.spyOn(botsApi, "listKeys").mockResolvedValue([])
    vi.spyOn(botsApi, "listStreamGrants").mockResolvedValue([])
  })

  it("turns the setting on for a personal bot via PATCH", async () => {
    vi.spyOn(botsApi, "get").mockResolvedValue(makePersonalBot())
    const update = vi.spyOn(botsApi, "update").mockResolvedValue(makePersonalBot({ readsAsOwner: true }))

    renderDetail()
    const toggle = await screen.findByRole("switch", { name: "Read everything you can read" })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "bot_1", { readsAsOwner: true }))
  })

  it("reflects an enabled setting and turns it off", async () => {
    vi.spyOn(botsApi, "get").mockResolvedValue(makePersonalBot({ readsAsOwner: true }))
    const update = vi.spyOn(botsApi, "update").mockResolvedValue(makePersonalBot({ readsAsOwner: false }))

    renderDetail()
    const toggle = await screen.findByRole("switch", { name: "Read everything you can read" })
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "bot_1", { readsAsOwner: false }))
  })

  it("offers no reading-access section for a shared bot", async () => {
    vi.spyOn(botsApi, "get").mockResolvedValue(makeSharedBot())

    renderDetail()
    await screen.findByRole("heading", { name: "Helper" })
    expect(screen.queryByRole("switch", { name: "Read everything you can read" })).not.toBeInTheDocument()
  })

  it("surfaces a rejected toggle instead of pretending it stuck", async () => {
    vi.spyOn(botsApi, "get").mockResolvedValue(makePersonalBot())
    vi.spyOn(botsApi, "update").mockRejectedValue(new Error("readsAsOwner requires a personal bot"))

    renderDetail()
    await userEvent.click(await screen.findByRole("switch", { name: "Read everything you can read" }))
    expect(await screen.findByText("readsAsOwner requires a personal bot")).toBeInTheDocument()
  })
})
