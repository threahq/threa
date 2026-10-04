import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, Visibilities, type WorkspaceBootstrap } from "@threahq/types"
import { botsApi } from "@/api/bots"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { createMockStream } from "@/test/fixtures"
import { BotChannelsSection } from "./bot-channels-section"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("BotChannelsSection", () => {
  it("should badge each grantable channel with its visibility label when the picker opens", async () => {
    vi.spyOn(botsApi, "listStreamGrants").mockResolvedValue([])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      streams: [
        createMockStream({
          id: "stream_a",
          type: StreamTypes.CHANNEL,
          slug: "a-public",
          visibility: Visibilities.PUBLIC,
        }),
        createMockStream({
          id: "stream_b",
          type: StreamTypes.CHANNEL,
          slug: "b-guests",
          visibility: Visibilities.GUEST_PUBLIC,
        }),
        createMockStream({
          id: "stream_c",
          type: StreamTypes.CHANNEL,
          slug: "c-private",
          visibility: Visibilities.PRIVATE,
        }),
      ],
    } as Partial<WorkspaceBootstrap>)

    render(
      <QueryClientProvider client={queryClient}>
        <BotChannelsSection workspaceId="ws_1" botId="bot_1" isArchived={false} />
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole("combobox"))

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "a-publicPublic",
      "b-guestsOpen to guests",
      "c-privatePrivate",
    ])
  })
})
