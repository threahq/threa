import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threahq/types"
import { streamKeys } from "@/hooks"
import * as streamsHooks from "@/hooks/use-streams"
import * as rosterHooks from "@/hooks/use-companion-roster"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import * as workspacesHooks from "@/hooks/use-workspaces"
import * as workspaceStore from "@/stores/workspace-store"
import { MemoryRouter } from "react-router-dom"
import { SettingsProvider } from "@/contexts"
import * as briefHooks from "@/hooks/use-stream-brief"
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
  vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue([])
  vi.spyOn(briefHooks, "useStreamBrief").mockReturnValue({
    data: null,
    isLoading: false,
  } as unknown as ReturnType<typeof briefHooks.useStreamBrief>)
  vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: (shortcode: string) => shortcode,
  } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
})

const ROSTER = [
  {
    id: "persona_ariadne",
    slug: "ariadne",
    name: "Ariadne",
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-sonnet-5",
    kind: "builtin",
    avatarUrl: null,
    isCustomized: false,
  },
  {
    id: "persona_coach",
    slug: "coach",
    name: "Coach",
    description: null,
    avatarEmoji: "🏋️",
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "custom",
    avatarUrl: null,
    isCustomized: false,
  },
]

function seedAndRender(opts: {
  createdBy?: string
  allowed?: ToolPrivacyPolicy
  configured?: ToolPrivacyCategory[]
  e2e?: boolean
  botMemberIds?: string[]
  botRuntimePresence?: Record<string, { status: string } | null>
  bots?: WorkspaceBot[]
  personas?: typeof ROSTER
  companionPersonaId?: string | null
  inWorkspace?: boolean
}) {
  if (opts.bots) {
    vi.spyOn(workspaceStore, "useWorkspaceBots").mockReturnValue(opts.bots)
  }
  if (opts.personas) {
    vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue(
      opts.personas as unknown as ReturnType<typeof rosterHooks.useCompanionRoster>
    )
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_sp"), {
    stream: { createdBy: opts.createdBy ?? "user_owner", companionPersonaId: opts.companionPersonaId ?? null },
    allowedToolCategories: opts.allowed ?? null,
    configuredToolCategories: opts.configured,
    botMemberIds: opts.botMemberIds,
    botRuntimePresence: opts.botRuntimePresence,
  })
  function Wrapper({ children }: { children: ReactNode }) {
    const inner = createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TooltipProvider, null, children)
    )
    return opts.inWorkspace
      ? createElement(
          MemoryRouter,
          { initialEntries: ["/w/ws_1/s/stream_sp"] },
          createElement(SettingsProvider, null, inner)
        )
      : inner
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

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "off" })
  })

  it("lets the owner restrict tools via the live mutation", async () => {
    seedAndRender({ allowed: null, configured: ["web", "workspace"] })

    await userEvent.click(screen.getByRole("switch", { name: /restrict tool access/i }))

    expect(toolMutate).toHaveBeenCalledWith([])
  })

  it("hides the tool section from a non-owner but still shows companion mode", () => {
    seedAndRender({ createdBy: "someone_else" })

    expect(screen.queryByRole("switch", { name: /restrict tool access/i })).not.toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "On" })).toBeInTheDocument()
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

  it("offers the companion-agent picker and sends companionPersonaId keeping the current mode", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: null })

    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    await userEvent.click(screen.getByRole("option", { name: /coach/i }))

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "on", companionPersonaId: "persona_coach" })
  })

  it("offers no inherit row — a created stream is pinned; rows carry default badges", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: "persona_coach" })

    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))

    expect(screen.queryByRole("option", { name: /Default \(/i })).not.toBeInTheDocument()
    // No workspace/personal default configured → the built-in tier (Ariadne) is
    // the workspace default and gets the badge.
    expect(screen.getByRole("option", { name: /Ariadne.*Workspace default/i })).toBeInTheDocument()
  })

  it("treats re-picking the pinned persona as a no-op", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: "persona_coach" })

    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    await userEvent.click(screen.getByRole("option", { name: /coach/i }))

    expect(companionMutate).not.toHaveBeenCalled()
  })

  it("hides the picker on encrypted scratchpads (enclave runs the built-in Ariadne)", () => {
    seedAndRender({ personas: ROSTER, e2e: true })

    expect(screen.queryByRole("combobox", { name: "Agent" })).not.toBeInTheDocument()
  })

  it("keeps the picker mounted but disabled while the roster is still hydrating (empty store)", () => {
    seedAndRender({})

    // No pop-in shove once the roster resolves (INV-21): the section renders
    // immediately with a full-size disabled trigger.
    const trigger = screen.getByRole("combobox", { name: "Agent" })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent("Loading agents…")
  })

  it("links the default agent beside the picker and lists what the agent sees, tools included for a non-owner", () => {
    seedAndRender({ personas: ROSTER, createdBy: "someone_else", allowed: ["web"], inWorkspace: true })

    expect(screen.getByRole("link", { name: "Change default" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_sp?settings=ai&setting=default-companion"
    )
    const summary = screen.getByRole("region", { name: "What shapes replies" })
    expect(within(summary).getByText("Web")).toBeInTheDocument()
    expect(within(summary).getByRole("link", { name: /Brief/ })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_sp?stream-settings=companion&sid=stream_sp&setting=stream-brief"
    )
  })
})
