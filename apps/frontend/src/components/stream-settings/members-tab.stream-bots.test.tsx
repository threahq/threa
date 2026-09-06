import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type Bot, type Stream } from "@threahq/types"
import { StreamBotsSection } from "./members-tab"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as inviteActorModule from "@/hooks/use-invite-actor"
import * as useMobileModule from "@/hooks/use-mobile"
import { botsApi } from "@/api/bots"

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

function renderSection(stream: Stream | undefined, invite: InviteFn, isUnlocked = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([makeBot()] as unknown as ReturnType<
    typeof workspaceStoreModule.useWorkspaceBots
  >)
  vi.spyOn(inviteActorModule, "useInviteActor").mockReturnValue({ invite, isInviting: false, isUnlocked })
  return render(
    <QueryClientProvider client={queryClient}>
      <StreamBotsSection workspaceId="ws_1" streamId="stream_1" stream={stream} />
    </QueryClientProvider>
  )
}

async function openAndSelectBot(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("combobox"))
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

    await user.click(screen.getByRole("button", { name: "Add bot" }))

    await waitFor(() => expect(invite).toHaveBeenCalledWith("bot", "bot_1"))
    await waitFor(() => expect(botsApi.grantStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
  })

  it("blocks adding a bot to an E2E stream while the session is locked (can't wrap the key)", async () => {
    const invite = vi.fn()
    renderSection(makeStream({ e2eEnabled: true, e2eActors: [] }), invite, false)

    // The add affordance is disabled and an unlock hint is shown — no key-blind grant.
    expect(screen.getByRole("combobox")).toBeDisabled()
    expect(screen.getByText(/unlock this scratchpad.s encryption to add a bot/i)).toBeInTheDocument()
    expect(invite).not.toHaveBeenCalled()
  })

  it("skips the redundant invite when the bot is already an E2E actor", async () => {
    const user = userEvent.setup()
    const invite = vi.fn().mockResolvedValue(undefined)
    renderSection(makeStream({ e2eEnabled: true, e2eActors: [{ kind: "bot", actorId: "bot_1" }] }), invite)

    await openAndSelectBot(user)
    await user.click(await screen.findByRole("button", { name: "Add bot" }))

    await waitFor(() => expect(botsApi.grantStreamAccess).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1"))
    expect(invite).not.toHaveBeenCalled()
  })
})
