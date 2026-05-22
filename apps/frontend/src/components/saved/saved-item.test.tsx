import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { SavedMessageView } from "@threa/types"
import { SavedItem } from "./saved-item"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useMobileModule from "@/hooks/use-mobile"
import * as contextsModule from "@/contexts"

const WORKSPACE_ID = "ws_1"

function makeView(overrides: Partial<SavedMessageView> = {}): SavedMessageView {
  const now = "2026-01-01T00:00:00.000Z"
  return {
    id: "saved_1",
    workspaceId: WORKSPACE_ID,
    userId: "usr_me",
    messageId: "msg_1",
    streamId: "stream_dm",
    status: "saved",
    remindAt: null,
    reminderSentAt: null,
    savedAt: now,
    statusChangedAt: now,
    unavailableReason: null,
    message: {
      authorId: "usr_peer",
      authorType: "user",
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello there",
      createdAt: now,
      editedAt: null,
      // Backend snapshot stores the raw stream.displayName, which is null for DMs.
      streamName: null,
    },
    ...overrides,
  }
}

function mockStore({
  streams = [],
  users = [],
  dmPeers = [],
}: {
  streams?: unknown[]
  users?: unknown[]
  dmPeers?: unknown[]
} = {}) {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
    streams as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
    users as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue(
    dmPeers as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>
  )
}

function mount(saved: SavedMessageView) {
  return render(
    <MemoryRouter>
      <SavedItem saved={saved} workspaceId={WORKSPACE_ID} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  // RelativeTime (rendered in the row footer) reads the timezone/locale from
  // the preferences context.
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("SavedItem stream label", () => {
  it("resolves a DM peer name even when the DM stream is absent from the streams cache", () => {
    // The regression: the streams cache has no entry for this DM, but dmPeers +
    // users do. The label must still resolve to the peer's name, not "Unknown".
    mockStore({
      streams: [],
      users: [{ id: "usr_peer", name: "Ada Lovelace" }],
      dmPeers: [{ streamId: "stream_dm", userId: "usr_peer" }],
    })

    const { getByText, queryByText } = mount(makeView({ streamId: "stream_dm" }))

    expect(getByText("Ada Lovelace")).toBeTruthy()
    expect(queryByText("Unknown")).toBeNull()
  })

  it("renders a channel with its # slug from the streams cache", () => {
    mockStore({
      streams: [{ id: "stream_ch", type: "channel", slug: "general", displayName: null }],
    })

    const { getByText } = mount(makeView({ streamId: "stream_ch" }))

    expect(getByText("#general")).toBeTruthy()
  })

  it("falls back to the snapshot stream name when the cache lookup misses", () => {
    mockStore({ streams: [], users: [], dmPeers: [] })

    const { getByText } = mount(
      makeView({ streamId: "stream_gone", message: { ...makeView().message!, streamName: "Legacy Stream" } })
    )

    expect(getByText("Legacy Stream")).toBeTruthy()
  })

  it("falls back to Unknown when neither cache nor snapshot resolves", () => {
    mockStore({ streams: [], users: [], dmPeers: [] })

    const { getByText } = mount(
      makeView({ streamId: "stream_gone", message: { ...makeView().message!, streamName: null } })
    )

    expect(getByText("Unknown")).toBeTruthy()
  })
})
