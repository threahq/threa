import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Bot, BotProfile } from "@threahq/types"
import { render, screen, userEvent, within } from "@/test"
import { botsApi } from "@/api/bots"
import * as useFormattedDateModule from "@/hooks/use-formatted-date"
import { resetWorkspaceStoreCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { BotProfileModal } from "./bot-profile-modal"

type SeedData = Parameters<typeof seedWorkspaceCache>[1]
type CachedWorkspaceUser = SeedData["users"][number]

const WORKSPACE_ID = "ws_1"
const BOT_ID = "bot_1"

const botBase = {
  id: BOT_ID,
  workspaceId: WORKSPACE_ID,
  traits: [],
  slug: "helper",
  name: "Helper",
  description: "Answers questions",
  avatarEmoji: null,
  avatarUrl: null,
  archivedAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
} as const

function sharedBot(overrides: Partial<Bot> = {}): Bot {
  return { ...botBase, type: "shared", ownerUserId: null, readsAsOwner: false, ...overrides } as Bot
}

function personalBot(overrides: Partial<Bot> = {}): Bot {
  return { ...botBase, type: "personal", ownerUserId: "usr_owner", readsAsOwner: false, ...overrides } as Bot
}

function profile(overrides: Partial<BotProfile> = {}): BotProfile {
  return { bot: sharedBot(), streams: [], runtime: null, canManage: false, ...overrides }
}

function seedOwner() {
  seedWorkspaceCache(WORKSPACE_ID, {
    workspace: {
      id: WORKSPACE_ID,
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-03-01T10:00:00Z",
      updatedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    },
    users: [
      {
        id: "usr_owner",
        workspaceId: WORKSPACE_ID,
        workosUserId: "workos_owner",
        email: "ada@example.com",
        role: "member",
        slug: "ada",
        name: "Ada",
        description: null,
        avatarUrl: null,
        timezone: null,
        locale: null,
        pronouns: null,
        phone: null,
        githubUsername: null,
        statusEmoji: null,
        statusText: null,
        statusExpiresAt: null,
        statusPausesNotifications: false,
        notificationsPausedUntil: null,
        notificationsPausedIndefinitely: false,
        setupCompleted: true,
        joinedAt: "2026-03-01T10:00:00Z",
        _cachedAt: Date.now(),
      } as CachedWorkspaceUser,
    ],
    streams: [],
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}

function renderModal(onOpenUserProfile = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}/s/stream_here`]}>
        <Routes>
          <Route
            path="/w/:workspaceId/*"
            element={
              <>
                <BotProfileModal botId={BOT_ID} open onOpenChange={() => {}} onOpenUserProfile={onOpenUserProfile} />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { onOpenUserProfile }
}

beforeEach(() => {
  resetWorkspaceStoreCache()
  vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
    formatDate: () => "date",
    formatTime: () => "time",
    formatRelative: () => "5 minutes ago",
    formatFull: () => "full",
  })
})

afterEach(() => vi.restoreAllMocks())

describe("BotProfileModal", () => {
  it("renders a shared bot with its traits, runtime, and streams", async () => {
    const getProfile = vi.spyOn(botsApi, "getProfile").mockResolvedValue(
      profile({
        bot: sharedBot({ traits: ["mentionable", "active-scratchpad"] }),
        streams: [
          { id: "stream_general", type: "channel", slug: "general", displayName: null, parentStreamId: null },
          { id: "stream_pad", type: "scratchpad", slug: null, displayName: "Deploy notes", parentStreamId: null },
        ],
        runtime: {
          botId: BOT_ID,
          runtimeKind: "hermes",
          instanceId: "inst_1",
          displayName: null,
          status: "busy",
          acceptingInvocations: true,
          statusText: null,
          lastSeenAt: "2026-09-17T06:00:00.000Z",
        },
      })
    )

    renderModal()

    expect(await screen.findByRole("heading", { name: "Helper" })).toBeInTheDocument()
    expect(getProfile).toHaveBeenCalledWith(WORKSPACE_ID, BOT_ID)
    expect(screen.getByText("@helper")).toBeInTheDocument()
    expect(screen.getByText("Shared")).toBeInTheDocument()
    expect(screen.getByText("Reads only the streams it's added to")).toBeInTheDocument()
    expect(screen.getByText("Mentionable")).toBeInTheDocument()
    expect(screen.getByText("Active scratchpad")).toBeInTheDocument()
    expect(screen.getByText("Busy")).toBeInTheDocument()
    expect(screen.getByText(/Hermes/)).toBeInTheDocument()
    expect(screen.getByText("5 minutes ago")).toBeInTheDocument()

    const streams = screen.getByRole("list", { name: "Streams" })
    const links = within(streams)
      .getAllByRole("link")
      .map((link) => ({ text: link.textContent, href: link.getAttribute("href") }))
    expect(links).toEqual([
      { text: "#general", href: `/w/${WORKSPACE_ID}/s/stream_general` },
      { text: "Deploy notes", href: `/w/${WORKSPACE_ID}/s/stream_pad` },
    ])
    expect(screen.queryByRole("link", { name: /Manage/ })).toBeNull()
  })

  it("hides read-as-owner from anyone but the owner, and opens the owner's profile", async () => {
    seedOwner()
    vi.spyOn(botsApi, "getProfile").mockResolvedValue(profile({ bot: personalBot({ readsAsOwner: true }) }))

    const { onOpenUserProfile } = renderModal()

    expect(await screen.findByText("Personal")).toBeInTheDocument()
    expect(screen.queryByText(/^Reads /)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Ada" }))
    expect(onOpenUserProfile).toHaveBeenCalledWith("usr_owner")
  })

  it("tells the owner their personal bot reads everything they can", async () => {
    vi.spyOn(botsApi, "getProfile").mockResolvedValue(
      profile({ bot: personalBot({ readsAsOwner: true }), canManage: true })
    )

    renderModal()

    expect(
      await screen.findByText("Reads everything you can read, except end-to-end encrypted streams")
    ).toBeInTheDocument()
  })

  it("omits the streams section when the bot has no visible streams", async () => {
    vi.spyOn(botsApi, "getProfile").mockResolvedValue(profile())

    renderModal()

    expect(await screen.findByRole("heading", { name: "Helper" })).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Streams" })).toBeNull()
  })

  it("links a manager to the bot's settings detail", async () => {
    vi.spyOn(botsApi, "getProfile").mockResolvedValue(profile({ canManage: true }))

    renderModal()

    await userEvent.click(await screen.findByRole("link", { name: /Manage/ }))
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/w/${WORKSPACE_ID}/s/stream_here?ws-settings=bots&bot=${BOT_ID}`
    )
  })
})
