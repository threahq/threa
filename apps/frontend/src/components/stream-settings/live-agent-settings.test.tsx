import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threa/types"
import { streamKeys } from "@/hooks"
import * as streamsHooks from "@/hooks/use-streams"
import * as workspacesHooks from "@/hooks/use-workspaces"
import * as workspaceStore from "@/stores/workspace-store"
import { LiveAgentSettings } from "./live-agent-settings"

type WorkspaceBot = ReturnType<typeof workspaceStore.useWorkspaceBots>[number]

const companionMutate = vi.fn(async () => {})
const toolMutate = vi.fn(async () => {})

beforeEach(() => {
  companionMutate.mockClear()
  toolMutate.mockClear()
  vi.spyOn(streamsHooks, "useUpdateCompanionMode").mockReturnValue({
    mutateAsync: companionMutate,
    isPending: false,
  } as unknown as ReturnType<typeof streamsHooks.useUpdateCompanionMode>)
  vi.spyOn(streamsHooks, "useUpdateToolPolicy").mockReturnValue({
    mutateAsync: toolMutate,
    isPending: false,
  } as unknown as ReturnType<typeof streamsHooks.useUpdateToolPolicy>)
  vi.spyOn(workspacesHooks, "useCurrentWorkspaceUser").mockReturnValue({
    id: "user_owner",
  } as unknown as ReturnType<typeof workspacesHooks.useCurrentWorkspaceUser>)
  vi.spyOn(workspaceStore, "useWorkspaceBots").mockReturnValue([])
})

function seedAndRender(opts: {
  createdBy?: string
  allowed?: ToolPrivacyPolicy
  configured?: ToolPrivacyCategory[]
  e2e?: boolean
  botMemberIds?: string[]
  botRuntimePresence?: Record<string, { status: string } | null>
  bots?: WorkspaceBot[]
}) {
  if (opts.bots) {
    vi.spyOn(workspaceStore, "useWorkspaceBots").mockReturnValue(opts.bots)
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_sp"), {
    stream: { createdBy: opts.createdBy ?? "user_owner" },
    allowedToolCategories: opts.allowed ?? null,
    configuredToolCategories: opts.configured,
    botMemberIds: opts.botMemberIds,
    botRuntimePresence: opts.botRuntimePresence,
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, createElement(TooltipProvider, null, children))
  }
  return render(
    <LiveAgentSettings workspaceId="ws_1" streamId="stream_sp" companionMode="on" e2e={opts.e2e ?? false} />,
    { wrapper: Wrapper }
  )
}

describe("LiveAgentSettings", () => {
  it("changes companion mode via the live mutation", async () => {
    seedAndRender({})

    await userEvent.click(screen.getByRole("radio", { name: /quiet/i }))

    expect(companionMutate).toHaveBeenCalledWith("off")
  })

  it("lets the owner restrict tools via the live mutation", async () => {
    seedAndRender({ allowed: null, configured: ["web", "workspace"] })

    await userEvent.click(screen.getByRole("switch", { name: /restrict tool access/i }))

    expect(toolMutate).toHaveBeenCalledWith([])
  })

  it("hides the tool section from a non-owner but still shows companion mode", () => {
    seedAndRender({ createdBy: "someone_else" })

    expect(screen.queryByRole("switch", { name: /restrict tool access/i })).not.toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /companion/i })).toBeInTheDocument()
  })

  it("surfaces an attached, connected external agent above the mode radios", () => {
    seedAndRender({
      botMemberIds: ["bot_pi"],
      botRuntimePresence: { bot_pi: { status: "available" } },
      bots: [{ id: "bot_pi", name: "Pi Remote" } as WorkspaceBot],
    })

    expect(screen.getByText("Pi Remote")).toBeInTheDocument()
    expect(screen.getByText(/connected/i)).toBeInTheDocument()
    expect(screen.getByText(/reads and replies/i)).toBeInTheDocument()
  })

  it("shows an attached external agent as not connected when its runtime is offline", () => {
    seedAndRender({
      botMemberIds: ["bot_pi"],
      botRuntimePresence: { bot_pi: { status: "offline" } },
      bots: [{ id: "bot_pi", name: "Pi Remote" } as WorkspaceBot],
    })

    expect(screen.getByText("Pi Remote")).toBeInTheDocument()
    expect(screen.getByText(/not connected/i)).toBeInTheDocument()
  })

  it("shows no external-agent indicator when none is attached", () => {
    seedAndRender({})

    expect(screen.queryByText(/external agent/i)).not.toBeInTheDocument()
  })
})
