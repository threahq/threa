import { QueryClientProvider, QueryClient } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WORKSPACE_PERMISSION_SCOPES, type PersonaListItem, type Stream, type WorkspaceBootstrap } from "@threahq/types"
import * as workspacesHooks from "@/hooks/use-workspaces"
import * as streamsHooks from "@/hooks/use-streams"
import * as rosterHooks from "@/hooks/use-companion-roster"
import * as defaultCompanionHooks from "@/hooks/use-default-companion-persona"
import * as emojiHooks from "@/hooks/use-workspace-emoji"
import * as botPresenceHooks from "@/hooks/use-active-bot-presence"
import * as briefHooks from "@/hooks/use-stream-brief"
import * as preferencesModule from "@/contexts/preferences-context"
import * as workspaceStore from "@/stores/workspace-store"
import { MemoryRouter } from "react-router-dom"
import { SettingsProvider } from "@/contexts"
import { CompanionTab } from "./companion-tab"

const companionMutate = vi.fn(async () => ({}) as Stream)

function persona(overrides: Partial<PersonaListItem> & Pick<PersonaListItem, "id" | "slug" | "name">): PersonaListItem {
  return {
    description: null,
    avatarEmoji: null,
    model: "openrouter:anthropic/claude-haiku-4.5",
    kind: "custom",
    ownerUserId: null,
    avatarUrl: null,
    isCustomized: false,
    status: "active",
    ...overrides,
  }
}

const ARIADNE = persona({ id: "persona_ariadne", slug: "ariadne", name: "Ariadne", kind: "builtin" })
const COACH = persona({ id: "persona_coach", slug: "coach", name: "Coach", avatarEmoji: "🏋️" })

beforeEach(() => {
  companionMutate.mockClear()
  vi.spyOn(workspacesHooks, "useCurrentWorkspaceUser").mockReturnValue(null)
  vi.spyOn(streamsHooks, "useUpdateCompanionMode").mockReturnValue({
    mutateAsync: companionMutate,
    isPending: false,
  } as unknown as ReturnType<typeof streamsHooks.useUpdateCompanionMode>)
  vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue([ARIADNE, COACH])
  vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
    effectiveDefault: ARIADNE,
    workspaceDefault: ARIADNE,
    personalDefault: undefined,
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

function renderTab(overrides: Partial<Stream> = {}, rootStream?: Stream) {
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
      rootStream={rootStream}
    />,
    { wrapper: Wrapper }
  )
}

describe("CompanionTab persona picker", () => {
  it("lists built-ins and customs and names the resolved default in the mode copy", async () => {
    renderTab({ companionPersonaId: null })

    // Null pointer resolves to the built-in default (Ariadne) in the copy.
    expect(screen.getByText(/Ariadne answers each new message/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    // No inherit row on a created stream — it's pinned; rows carry default badges.
    expect(screen.queryByRole("option", { name: /Default \(/i })).not.toBeInTheDocument()
    expect(await screen.findByRole("option", { name: /Ariadne.*Workspace default/i })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Coach/i })).toBeInTheDocument()
  })

  it("sends companionPersonaId (keeping the current mode) when a different agent is picked", async () => {
    renderTab({ companionMode: "on", companionPersonaId: null })

    await userEvent.click(screen.getByRole("combobox", { name: "Agent" }))
    await userEvent.click(await screen.findByRole("option", { name: /Coach/i }))

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "on", companionPersonaId: "persona_coach" })
  })

  it("names the pointed-at persona in the mode copy", () => {
    renderTab({ companionPersonaId: "persona_coach" })

    expect(screen.getByText(/Coach answers each new message/)).toBeInTheDocument()
  })

  it("turns agent replies off from the radio group", async () => {
    renderTab({ companionMode: "on" })

    const group = screen.getByRole("radiogroup", { name: "Agent replies" })
    await userEvent.click(within(group).getByRole("radio", { name: "Quiet" }))

    expect(companionMutate).toHaveBeenCalledWith({ companionMode: "off" })
  })

  it("describes only the picked reply mode, under the control", () => {
    renderTab({ companionMode: "off" })

    const group = screen.getByRole("radiogroup", { name: "Agent replies" })
    expect({
      quiet: within(group).getByRole("radio", { name: "Quiet" }).getAttribute("aria-checked"),
      describedOn: screen.queryByText(/answers each new message/),
    }).toEqual({ quiet: "true", describedOn: null })
    expect(group).toHaveAccessibleDescription("No agent replies and no AI usage.")
  })

  it("does NOT retroactively apply a changed default to a stream with a null pointer", () => {
    vi.spyOn(defaultCompanionHooks, "useDefaultCompanionPersona").mockReturnValue({
      effectiveDefault: COACH,
      workspaceDefault: COACH,
      personalDefault: undefined,
    })
    renderTab({ companionPersonaId: null })

    // Defaults pin at CREATE; a legacy null pointer displays (and dispatches
    // as) the built-in default, never the currently-configured one.
    expect(screen.getByText(/Ariadne answers each new message/)).toBeInTheDocument()
  })

  it("hides the persona picker on encrypted streams (enclave is Ariadne-only)", () => {
    renderTab({ e2eEnabled: true })

    expect(screen.queryByRole("combobox", { name: "Agent" })).not.toBeInTheDocument()
  })

  it("keeps the picker mounted but disabled while the roster is still hydrating (empty store)", () => {
    vi.spyOn(rosterHooks, "useCompanionRoster").mockReturnValue([])

    renderTab({})

    // No pop-in shove once the roster resolves (INV-21): the section renders
    // immediately with a full-size disabled trigger.
    const trigger = screen.getByRole("combobox", { name: "Agent" })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent("Loading agents…")
  })
})

describe("CompanionTab channel settings for a guest", () => {
  const BROWSE = [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE]

  function viewerWith(viewerPermissions: WorkspaceBootstrap["viewerPermissions"]) {
    vi.spyOn(workspacesHooks, "useViewerPermissions").mockReturnValue(viewerPermissions)
  }

  function disabledControls() {
    return {
      modeOptions: screen.getAllByRole("radio").map((option) => (option as HTMLButtonElement).disabled),
      agentPicker: (screen.getByRole("combobox", { name: "Agent" }) as HTMLButtonElement).disabled,
      addBrief: (screen.getByRole("button", { name: "Add brief" }) as HTMLButtonElement).disabled,
    }
  }

  it("should disable the companion mode, agent and brief controls on a channel when the viewer lacks browse", () => {
    viewerWith([])
    renderTab({ type: "channel" })

    expect(disabledControls()).toEqual({ modeOptions: [true, true], agentPicker: true, addBrief: true })
  })

  it("should enable the companion mode, agent and brief controls on a channel when the viewer can browse", () => {
    viewerWith(BROWSE)
    renderTab({ type: "channel" })

    expect(disabledControls()).toEqual({ modeOptions: [false, false], agentPicker: false, addBrief: false })
  })

  it("should lock only the shared brief on a thread in a channel when the viewer lacks browse", () => {
    viewerWith([])
    renderTab({ id: "stream_thread", type: "thread", rootStreamId: "stream_chan" }, {
      id: "stream_chan",
      type: "channel",
    } as Stream)

    expect(disabledControls()).toEqual({ modeOptions: [false, false], agentPicker: false, addBrief: true })
  })

  it("should lock the shared brief on a thread whose root is not cached yet when the viewer lacks browse", () => {
    viewerWith([])
    renderTab({ id: "stream_thread", type: "thread", rootStreamId: "stream_chan" })

    expect(disabledControls()).toEqual({ modeOptions: [false, false], agentPicker: false, addBrief: true })
  })

  it("names the parent a thread's brief is shared with", () => {
    const thread = { id: "stream_thread", type: "thread", rootStreamId: "stream_root" } as const
    const { unmount } = renderTab(thread, { id: "stream_root", type: "channel", slug: "general" } as Stream)
    expect(screen.getByText(/Shared with #general\./)).toBeInTheDocument()
    unmount()

    renderTab(thread, { id: "stream_root", type: "scratchpad", slug: null } as Stream)
    expect(screen.getByText(/Shared with the parent scratchpad\./)).toBeInTheDocument()
  })

  it("should leave a guest's own scratchpad controls enabled", () => {
    viewerWith([])
    renderTab({ type: "scratchpad" })

    expect(disabledControls()).toEqual({ modeOptions: [false, false], agentPicker: false, addBrief: false })
  })
})

describe("CompanionTab links to the account settings behind it", () => {
  function withInstructions(scratchpadCustomPrompt: string) {
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockReturnValue({
      preferences: { scratchpadCustomPrompt },
    } as unknown as ReturnType<typeof preferencesModule.usePreferencesOptional>)
  }

  function renderInWorkspace(overrides: Partial<Stream> = {}, rootStream?: Stream) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/w/ws_1/s/stream_sp"]}>
            <SettingsProvider>
              <CompanionTab
                workspaceId="ws_1"
                stream={streamFixture(overrides)}
                allowedToolCategories={null}
                canManageToolPolicy={false}
                rootStream={rootStream}
              />
            </SettingsProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    )
  }

  function hrefOf(name: string | RegExp) {
    return screen.getByRole("link", { name }).getAttribute("href")
  }

  it("names the default for new scratchpads and links it and the instructions", () => {
    withInstructions("Answer in bullet points.")
    renderInWorkspace({ type: "scratchpad" })

    expect(screen.getByText(/Your default for new scratchpads: Ariadne\./)).toBeInTheDocument()
    expect(screen.getByText("Agents here follow them too.")).toBeInTheDocument()
    expect({
      defaultHref: hrefOf("Change default"),
      instructionsHref: hrefOf(/^Instructions for your scratchpads/),
    }).toEqual({
      defaultHref: "/w/ws_1/s/stream_sp?settings=ai&setting=default-companion",
      instructionsHref: "/w/ws_1/s/stream_sp?settings=ai&setting=ai-instructions",
    })
  })

  it("invites writing instructions when there are none", () => {
    withInstructions("  ")
    renderInWorkspace({ type: "scratchpad" })

    expect({
      href: hrefOf(/^Instructions for your scratchpads/),
      note: screen.getByText("No instructions yet.") !== null,
    }).toEqual({ href: "/w/ws_1/s/stream_sp?settings=ai&setting=ai-instructions", note: true })
  })

  it("links instructions on a scratchpad thread but not the scratchpad default", () => {
    withInstructions("Answer in bullet points.")
    renderInWorkspace({ id: "stream_thread", type: "thread", rootStreamId: "stream_sp" }, {
      id: "stream_sp",
      type: "scratchpad",
    } as Stream)

    expect(screen.getByRole("link", { name: /^Instructions for your scratchpads/ })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Change default" })).not.toBeInTheDocument()
  })

  it("sums up what the agent sees beyond this page's controls, each row linked to where it's edited", () => {
    withInstructions("Answer in bullet points.")
    vi.spyOn(workspaceStore, "useWorkspacePersonas").mockReturnValue([
      {
        id: "persona_ariadne",
        name: "Ariadne",
        model: "openrouter:anthropic/claude-sonnet-5",
        systemPrompt: "You are Ariadne.",
        managedBy: "system",
      },
    ] as unknown as ReturnType<typeof workspaceStore.useWorkspacePersonas>)
    renderInWorkspace({ type: "scratchpad" })

    const summary = screen.getByRole("region", { name: "What shapes replies" })
    const rows = within(summary)
      .getAllByRole("listitem")
      .map((row) => [row.textContent, row.querySelector("a")?.getAttribute("href") ?? null])
    expect(rows).toEqual([
      ["ModelThe model this agent runs on. Edited by workspace admins.Claude Sonnet 5", null],
      ["Agent instructionsWhat the agent follows wherever it replies. Edited by workspace admins.3 words", null],
      ["ToolsWhat the agent can use besides replying. Edited by the owner.All tools", null],
      [
        "Your deviceOnly youWhat agents learn about the device you're on. Edited by you.Layout, system and open docs",
        "/w/ws_1/s/stream_sp?settings=privacy&setting=device-sharing",
      ],
    ])
  })

  it("sums up agent instructions by length and opens them in full", async () => {
    const user = userEvent.setup()
    vi.spyOn(workspaceStore, "useWorkspacePersonas").mockReturnValue([
      {
        id: "persona_ariadne",
        name: "Ariadne",
        model: "openrouter:anthropic/claude-sonnet-5",
        systemPrompt: "You are **Ariadne**.\n\nHelp people think, decide and remember.",
        managedBy: "system",
      },
    ] as unknown as ReturnType<typeof workspaceStore.useWorkspacePersonas>)
    renderInWorkspace({ type: "channel" })

    const summary = screen.getByRole("region", { name: "What shapes replies" })
    const instructions = within(summary).getByRole("button", { name: /^Agent instructions/ })
    await user.click(instructions)
    expect({
      summary: instructions.textContent,
      opened: within(summary).getByText(/Help people think/).textContent,
    }).toEqual({
      summary: "Agent instructionsWhat the agent follows wherever it replies. Edited by workspace admins.9 words",
      opened: "Help people think, decide and remember.",
    })
  })

  it("shows an attached external agent as the first row of Replies, stating its connection in words", () => {
    vi.spyOn(botPresenceHooks, "useActiveBotPresence").mockReturnValue({
      bot: { id: "bot_pi", name: "Pi remote", avatarEmoji: null } as botPresenceHooks.ActiveBotPresence["bot"],
      presence: null,
    })
    renderInWorkspace({ type: "scratchpad" })

    const replies = screen.getByRole("region", { name: "Replies" })
    const text = replies.textContent ?? ""
    expect(text.indexOf("Pi remote")).toBeGreaterThan(-1)
    expect(text.indexOf("Pi remote")).toBeLessThan(text.indexOf("Quiet"))
    expect(
      within(replies).getByText("External agent, not connected. It reads and replies once its runtime reconnects.")
    ).toBeInTheDocument()
  })

  it("puts what the agent sees right under the agent picker, ahead of the brief", () => {
    renderInWorkspace({ type: "scratchpad" })

    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Replies",
      "What shapes replies",
      "Context",
    ])
  })

  it("gives section jumps a focusable row in What shapes replies", () => {
    renderInWorkspace({ type: "scratchpad" })

    const summary = screen.getByRole("region", { name: "What shapes replies" })
    const target = summary.querySelector<HTMLElement>("[data-setting]")
    target?.focus()
    expect({ setting: target?.dataset.setting, focused: document.activeElement === target }).toEqual({
      setting: "stream-agent-context",
      focused: true,
    })
  })

  it("lets a member read a shared agent's instructions without editing them", async () => {
    vi.spyOn(workspaceStore, "useWorkspacePersonas").mockReturnValue([
      {
        id: "persona_ariadne",
        name: "Ariadne",
        model: "openrouter:anthropic/claude-sonnet-5",
        systemPrompt: "You are Ariadne.\n\nCite your sources.",
        managedBy: "system",
      },
    ] as unknown as ReturnType<typeof workspaceStore.useWorkspacePersonas>)
    renderInWorkspace({ type: "channel" })

    const toggle = screen.getByRole("button", { name: /Agent instructions/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Cite your sources.")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Edit agent" })).not.toBeInTheDocument()
  })

  it("speaks of the channel, without scratchpad links, on a channel", () => {
    withInstructions("Answer in bullet points.")
    vi.spyOn(workspacesHooks, "useViewerPermissions").mockReturnValue([WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE])
    renderInWorkspace({ type: "channel" })

    expect(screen.getByText(/answers each new message in this channel/i)).toBeInTheDocument()
    expect(screen.queryByText(/scratchpad/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Change default|instructions/ })).not.toBeInTheDocument()
  })
})
