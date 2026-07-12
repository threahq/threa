import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ToolPrivacyCategory, ToolPrivacyPolicy } from "@threa/types"
import { streamKeys } from "@/hooks"
import * as streamsHooks from "@/hooks/use-streams"
import * as personasHooks from "@/hooks/use-personas"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
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
  vi.spyOn(personasHooks, "usePersonas").mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof personasHooks.usePersonas>)
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
}) {
  if (opts.bots) {
    vi.spyOn(workspaceStore, "useWorkspaceBots").mockReturnValue(opts.bots)
  }
  if (opts.personas) {
    vi.spyOn(personasHooks, "usePersonas").mockReturnValue({
      data: opts.personas,
    } as unknown as ReturnType<typeof personasHooks.usePersonas>)
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

  it("offers the companion-agent picker and sends companionPersonaId keeping the current mode", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: null })

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await userEvent.click(screen.getByRole("option", { name: /coach/i }))

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "on", companionPersonaId: "persona_coach" })
  })

  it("treats re-picking the inherit row on an unpinned stream as a no-op", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: null })

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await userEvent.click(screen.getByRole("option", { name: /Default \(/i }))

    expect(companionMutate).not.toHaveBeenCalled()
  })

  it("pins the stream when the resolved default is picked explicitly", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: null })

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await userEvent.click(
      screen.getByRole("option", { name: (name) => name.includes("Ariadne") && !name.includes("Default") })
    )

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "on", companionPersonaId: "persona_ariadne" })
  })

  it("clears the pin back to inherit via the synthetic default row", async () => {
    seedAndRender({ personas: ROSTER, companionPersonaId: "persona_coach" })

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await userEvent.click(screen.getByRole("option", { name: /Default \(/i }))

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "on", companionPersonaId: null })
  })

  it("hides the picker on encrypted scratchpads (enclave runs the built-in Ariadne)", () => {
    seedAndRender({ personas: ROSTER, e2e: true })

    expect(screen.queryByRole("combobox", { name: /companion agent/i })).not.toBeInTheDocument()
  })
})
