import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { PersonaListItem, Stream } from "@threa/types"
import * as streamsHooks from "@/hooks/use-streams"
import * as personasHooks from "@/hooks/use-personas"
import * as defaultCompanionHooks from "@/hooks/use-default-companion-persona"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import * as botPresenceHooks from "@/hooks/use-active-bot-presence"
import * as briefHooks from "@/hooks/use-stream-brief"
import { CompanionTab } from "./companion-tab"

const companionMutate = vi.fn(async () => ({}) as Stream)

function persona(overrides: Partial<PersonaListItem> & Pick<PersonaListItem, "id" | "slug" | "name">): PersonaListItem {
  return {
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "custom",
    avatarUrl: null,
    isCustomized: false,
    ...overrides,
  }
}

const ARIADNE = persona({ id: "persona_ariadne", slug: "ariadne", name: "Ariadne", kind: "builtin" })
const COACH = persona({ id: "persona_coach", slug: "coach", name: "Coach", avatarEmoji: "🏋️" })

beforeEach(() => {
  companionMutate.mockClear()
  vi.spyOn(streamsHooks, "useUpdateCompanionMode").mockReturnValue({
    mutateAsync: companionMutate,
    isPending: false,
  } as unknown as ReturnType<typeof streamsHooks.useUpdateCompanionMode>)
  vi.spyOn(personasHooks, "usePersonas").mockReturnValue({
    data: [ARIADNE, COACH],
  } as unknown as ReturnType<typeof personasHooks.usePersonas>)
  vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
    effectiveDefault: ARIADNE,
    workspaceDefault: ARIADNE,
  } as unknown as ReturnType<typeof defaultCompanionHooks.useDefaultCompanionPersona>)
  vi.spyOn(emojiHooks, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: (shortcode: string) => shortcode,
  } as unknown as ReturnType<typeof emojiHooks.useWorkspaceEmoji>)
  vi.spyOn(botPresenceHooks, "useActiveBotPresence").mockReturnValue(null)
  vi.spyOn(briefHooks, "useStreamBrief").mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof briefHooks.useStreamBrief>)
  vi.spyOn(briefHooks, "useUpdateStreamBrief").mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof briefHooks.useUpdateStreamBrief>)
})

function streamFixture(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_sp",
    type: "scratchpad",
    companionMode: "on",
    companionPersonaId: null,
    e2eEnabled: false,
    ...overrides,
  } as unknown as Stream
}

function renderTab(overrides: Partial<Stream> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, createElement(TooltipProvider, null, children))
  }
  return render(
    <CompanionTab
      workspaceId="ws_1"
      stream={streamFixture(overrides)}
      allowedToolCategories={null}
      canManageToolPolicy={false}
    />,
    { wrapper: Wrapper }
  )
}

describe("CompanionTab persona picker", () => {
  it("lists built-ins and customs and names the resolved default in the mode copy", async () => {
    renderTab({ companionPersonaId: null })

    // Null pointer resolves to the built-in default (Ariadne) in the copy.
    expect(screen.getByText(/Ariadne reads new messages and replies in the thread/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    // Leading synthetic inherit row, then the roster.
    expect(await screen.findByRole("option", { name: /Default \(Ariadne\)/i })).toBeInTheDocument()
    expect(
      screen.getByRole("option", { name: (name) => name.includes("Ariadne") && !name.includes("Default") })
    ).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Coach/i })).toBeInTheDocument()
  })

  it("sends companionPersonaId (keeping the current mode) when a different agent is picked", async () => {
    renderTab({ companionMode: "on", companionPersonaId: null })

    await userEvent.click(screen.getByRole("combobox", { name: /companion agent/i }))
    await userEvent.click(await screen.findByRole("option", { name: /Coach/i }))

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "on", companionPersonaId: "persona_coach" })
  })

  it("names the pointed-at persona in the mode copy", () => {
    renderTab({ companionPersonaId: "persona_coach" })

    expect(screen.getByText(/Coach reads new messages and replies in the thread/i)).toBeInTheDocument()
  })

  it("shows the configured workspace default on an unpinned stream", () => {
    vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
      effectiveDefault: COACH,
      workspaceDefault: COACH,
    })
    renderTab({ companionPersonaId: null })

    // A null pointer now resolves to the configured default, not the hardcoded Ariadne.
    expect(screen.getByText(/Coach reads new messages and replies in the thread/i)).toBeInTheDocument()
  })

  it("hides the persona picker on encrypted streams (enclave is Ariadne-only)", () => {
    renderTab({ e2eEnabled: true })

    expect(screen.queryByRole("combobox", { name: /companion agent/i })).not.toBeInTheDocument()
  })
})
