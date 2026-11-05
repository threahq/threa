import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import {
  StreamTypes,
  WORKSPACE_PERMISSION_SCOPES,
  type Bot,
  type Stream,
  type WorkspaceBootstrap,
} from "@threahq/types"
import { SettingsProvider } from "@/contexts/settings-context"
import { MembersTab, StreamBotsSection } from "./members-tab"
import * as servicesModule from "@/contexts/services-context"
import * as workspacesModule from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as inviteActorModule from "@/hooks/use-e2e-actors"
import * as useMobileModule from "@/hooks/use-mobile"
import { botsApi } from "@/api/bots"
import { toast } from "sonner"

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot_1",
    workspaceId: "ws_1",
    name: "Helper",
    slug: "helper",
    archivedAt: null,
    ...overrides,
  } as Bot
}

type InviteFn = ReturnType<typeof inviteActorModule.useInviteActor>["invite"]
type RevokeFn = ReturnType<typeof inviteActorModule.useRevokeActor>["revoke"]

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_1",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    displayName: "Scratch",
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_1",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  }
}

function renderSection(stream: Stream | undefined, invite: InviteFn, isUnlocked = true, revoke: RevokeFn = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([makeBot()] as unknown as ReturnType<
    typeof workspaceStoreModule.useWorkspaceBots
  >)
  vi.spyOn(inviteActorModule, "useInviteActor").mockReturnValue({ invite, isInviting: false, isUnlocked })
  vi.spyOn(inviteActorModule, "useRevokeActor").mockReturnValue({ revoke, isRevoking: false, isUnlocked })
  return render(
    <QueryClientProvider client={queryClient}>
      <StreamBotsSection workspaceId="ws_1" streamId="stream_1" stream={stream} />
    </QueryClientProvider>
  )
}

async function openAndSelectBot(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Add bot" }))
  // cmdk renders the filtered items inside the popover; the bot row is selectable.
  await user.click(await screen.findByText("Helper"))
}

describe("StreamBotsSection bot grant consent", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // cmdk calls scrollIntoView on the active item; jsdom doesn't implement it.
    Element.prototype.scrollIntoView = vi.fn()
    vi.spyOn(botsApi, "listStreamBots").mockResolvedValue([])
    vi.spyOn(botsApi, "grantStreamAccess").mockResolvedValue(undefined)
  })

  it("grants a bot immediately on a plaintext stream — no consent dialog", async () => {
    const user = userEvent.setup()
    const invite = vi.fn()
    renderSection(makeStream({ e2eEnabled: false }), invite)

    await openAndSelectBot(user)

    await waitFor(() => expect(botsApi.grantStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
    expect(invite).not.toHaveBeenCalled()
    expect(screen.queryByText(/encrypted scratchpad\?/i)).not.toBeInTheDocument()
  })

  it("requires confirmation on an E2E stream, then wraps the key and grants access", async () => {
    const user = userEvent.setup()
    const invite = vi.fn().mockResolvedValue(undefined)
    renderSection(makeStream({ e2eEnabled: true, e2eActors: [] }), invite)

    await openAndSelectBot(user)

    // The grant is gated behind the consent dialog — nothing committed yet.
    expect(await screen.findByText(/read every message in this end-to-end encrypted scratchpad/i)).toBeInTheDocument()
    expect(botsApi.grantStreamAccess).not.toHaveBeenCalled()
    expect(invite).not.toHaveBeenCalled()

    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Add bot" }))

    await waitFor(() => expect(invite).toHaveBeenCalledWith("bot", "bot_1"))
    await waitFor(() => expect(botsApi.grantStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
  })

  it("blocks adding a bot to an E2E stream while the session is locked (can't wrap the key)", async () => {
    const invite = vi.fn()
    renderSection(makeStream({ e2eEnabled: true, e2eActors: [] }), invite, false)

    // The add affordance is disabled and an unlock hint is shown — no key-blind grant.
    expect(screen.getByRole("button", { name: "Add bot" })).toBeDisabled()
    expect(screen.getByText(/unlock this scratchpad.s encryption to add a bot/i)).toBeInTheDocument()
    expect(invite).not.toHaveBeenCalled()
  })

  it("skips the redundant invite when the bot is already an E2E actor", async () => {
    const user = userEvent.setup()
    const invite = vi.fn().mockResolvedValue(undefined)
    renderSection(makeStream({ e2eEnabled: true, e2eActors: [{ kind: "bot", actorId: "bot_1" }] }), invite)

    await openAndSelectBot(user)
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Add bot" }))

    await waitFor(() => expect(botsApi.grantStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
    expect(invite).not.toHaveBeenCalled()
  })
})

describe("StreamBotsSection bot removal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
    vi.spyOn(botsApi, "listStreamBots").mockResolvedValue(["bot_1"])
    vi.spyOn(botsApi, "revokeStreamAccess").mockResolvedValue(undefined)
  })

  async function clickRemove(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Remove Helper" }))
  }

  it("removes a bot from a plaintext stream immediately — no revoke, no dialog", async () => {
    const user = userEvent.setup()
    const revoke = vi.fn()
    renderSection(makeStream({ e2eEnabled: false }), vi.fn(), true, revoke)

    await clickRemove(user)

    await waitFor(() => expect(botsApi.revokeStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
    expect(revoke).not.toHaveBeenCalled()
  })

  it("confirms before revoking an E2E actor, then revokes the key and the channel grant", async () => {
    const user = userEvent.setup()
    const revoke = vi.fn().mockResolvedValue(undefined)
    renderSection(
      makeStream({ e2eEnabled: true, e2eActors: [{ kind: "bot", actorId: "bot_1" }] }),
      vi.fn(),
      true,
      revoke
    )

    await clickRemove(user)

    expect(await screen.findByText(/loses access to everything sent from now on/i)).toBeInTheDocument()
    expect(revoke).not.toHaveBeenCalled()
    expect(botsApi.revokeStreamAccess).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Remove bot" }))

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("bot", "bot_1"))
    await waitFor(() => expect(botsApi.revokeStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
  })

  it("leaves the channel grant alone when the revoke fails, so the bot is never half-removed", async () => {
    const user = userEvent.setup()
    const revoke = vi.fn().mockRejectedValue(new Error("nope"))
    renderSection(
      makeStream({ e2eEnabled: true, e2eActors: [{ kind: "bot", actorId: "bot_1" }] }),
      vi.fn(),
      true,
      revoke
    )

    await clickRemove(user)
    await user.click(await screen.findByRole("button", { name: "Remove bot" }))

    await waitFor(() => expect(revoke).toHaveBeenCalled())
    expect(botsApi.revokeStreamAccess).not.toHaveBeenCalled()
  })

  it("should say the removal failed when the channel grant can't be dropped", async () => {
    vi.spyOn(botsApi, "revokeStreamAccess").mockRejectedValue(new Error("offline"))
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => "")
    const user = userEvent.setup()
    renderSection(makeStream({ e2eEnabled: false }), vi.fn())

    await clickRemove(user)

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to remove bot"))
  })

  it("removes a bot that has a channel grant but no E2E actor row without a dialog", async () => {
    const user = userEvent.setup()
    const revoke = vi.fn()
    renderSection(makeStream({ e2eEnabled: true, e2eActors: [] }), vi.fn(), true, revoke)

    await clickRemove(user)

    await waitFor(() => expect(botsApi.revokeStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
    expect(revoke).not.toHaveBeenCalled()
  })
})

describe("MembersTab roles", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("should show Guest on a guest member's row when the stream has a guest member", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_1"), {
      stream: makeStream({ type: StreamTypes.CHANNEL }),
      members: [{ memberId: "usr_guest", streamId: "stream_1" }],
    })
    vi.spyOn(servicesModule, "useStreamService").mockReturnValue(
      {} as ReturnType<typeof servicesModule.useStreamService>
    )
    vi.spyOn(workspacesModule, "useCachedWorkspaceBootstrap").mockReturnValue(null)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: "usr_guest", name: "Gus", slug: "gus", role: "guest" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([])
    vi.spyOn(inviteActorModule, "useInviteActor").mockReturnValue({
      invite: vi.fn(),
      isInviting: false,
      isUnlocked: true,
    })
    vi.spyOn(inviteActorModule, "useRevokeActor").mockReturnValue({
      revoke: vi.fn(),
      isRevoking: false,
      isUnlocked: true,
    })
    vi.spyOn(botsApi, "listStreamBots").mockResolvedValue([])

    render(
      <QueryClientProvider client={queryClient}>
        <MembersTab workspaceId="ws_1" streamId="stream_1" currentUserId="usr_admin" />
      </QueryClientProvider>
    )

    const gusRow = screen.getAllByRole("listitem").find((row) => within(row).queryByText("Gus"))
    expect(gusRow).toHaveTextContent("Gus@gusGuest")

    const name = screen.getByText("Gus")
    const handle = screen.getByText("@gus")
    expect({
      truncated: [name, handle].some((el) => el.classList.contains("truncate")),
      wraps: name.parentElement?.classList.contains("flex-wrap"),
    }).toEqual({ truncated: false, wraps: true })
  })
})

/** The viewer's workspace permissions, as the cached workspace bootstrap holds them. */
function grantViewer(...viewerPermissions: string[]) {
  const bootstrap = { viewerPermissions } as unknown as WorkspaceBootstrap
  vi.spyOn(workspacesModule, "useCachedWorkspaceBootstrap").mockImplementation(((
    _workspaceId: string,
    select?: (value: WorkspaceBootstrap) => unknown
  ) => (select ? select(bootstrap) : bootstrap)) as typeof workspacesModule.useCachedWorkspaceBootstrap)
}

describe("MembersTab with nothing left to add", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(servicesModule, "useStreamService").mockReturnValue(
      {} as ReturnType<typeof servicesModule.useStreamService>
    )
    grantViewer(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE, WORKSPACE_PERMISSION_SCOPES.BOTS_CREATE_SHARED)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: "usr_admin", name: "Ada", slug: "ada", role: "admin" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
    vi.spyOn(inviteActorModule, "useInviteActor").mockReturnValue({
      invite: vi.fn(),
      isInviting: false,
      isUnlocked: true,
    })
    vi.spyOn(inviteActorModule, "useRevokeActor").mockReturnValue({
      revoke: vi.fn(),
      isRevoking: false,
      isUnlocked: true,
    })
  })

  function renderTab(bots: Bot[], grantedBotIds: string[]) {
    vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue(
      bots as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceBots>
    )
    vi.spyOn(botsApi, "listStreamBots").mockResolvedValue(grantedBotIds)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_1"), {
      stream: makeStream({ type: StreamTypes.CHANNEL }),
      members: [{ memberId: "usr_admin", streamId: "stream_1" }],
    })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <SettingsProvider>
            <MembersTab workspaceId="ws_1" streamId="stream_1" currentUserId="usr_admin" />
          </SettingsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  it("says so in plain text instead of a disabled picker, and links to where bots are made when there are none", () => {
    renderTab([], [])

    const row = document.querySelector<HTMLElement>('[data-setting="stream-bots"]')!
    expect({
      everyoneIn: screen.queryByText("Everyone in the workspace is a member.") !== null,
      pickers: screen.queryAllByRole("button", { name: /^Add (member|bot)$/ }).length,
      purpose: document.getElementById("setting-stream-bots-description")?.textContent,
      empty: within(row).queryByText("No bots in this workspace yet.") !== null,
      links: within(row)
        .queryAllByRole("link")
        .map((link) => ({ text: link.closest("span")?.textContent, href: link.getAttribute("href") })),
    }).toEqual({
      everyoneIn: true,
      pickers: 0,
      purpose: "Bots added here can post in this stream.",
      empty: true,
      links: [{ text: "Bots in Shared bots", href: expect.stringContaining("setting=workspace-bots") }],
    })
  })

  it("says every bot has access once they all do", async () => {
    renderTab([makeBot()], ["bot_1"])

    expect(await screen.findByText("Every bot in the workspace has access.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Add bot" })).not.toBeInTheDocument()
  })
})

describe("MembersTab while the members load", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    grantViewer(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
      { id: "usr_admin", name: "Ada", slug: "ada", role: "admin" },
    ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
    vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([])
    vi.spyOn(inviteActorModule, "useInviteActor").mockReturnValue({
      invite: vi.fn(),
      isInviting: false,
      isUnlocked: true,
    })
    vi.spyOn(inviteActorModule, "useRevokeActor").mockReturnValue({
      revoke: vi.fn(),
      isRevoking: false,
      isUnlocked: true,
    })
    vi.spyOn(botsApi, "listStreamBots").mockResolvedValue([])
  })

  function renderTab(bootstrap: Promise<unknown>) {
    vi.spyOn(servicesModule, "useStreamService").mockReturnValue({
      bootstrap: () => bootstrap,
    } as unknown as ReturnType<typeof servicesModule.useStreamService>)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <SettingsProvider>
            <MembersTab workspaceId="ws_1" streamId="stream_1" currentUserId="usr_admin" />
          </SettingsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }

  const notes = () => ({
    count: screen.queryByText(/^\d+ members?$/)?.textContent ?? null,
    empty: screen.queryByText(/^No members (match|yet)\.$/)?.textContent ?? null,
  })

  it("claims no count and no empty list before the members arrive", () => {
    renderTab(new Promise(() => undefined))
    expect(notes()).toEqual({ count: null, empty: null })
  })

  it("says the stream has no members yet, and that none match only once a filter is typed", async () => {
    const user = userEvent.setup()
    renderTab(Promise.resolve({ stream: makeStream({ type: StreamTypes.CHANNEL }), members: [] }))

    await waitFor(() => expect(notes()).toEqual({ count: "0 members", empty: "No members yet." }))
    await user.type(screen.getByRole("textbox", { name: "Filter members" }), "zed")
    expect(notes()).toEqual({ count: "0 members", empty: "No members match." })
  })
})
