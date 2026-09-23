import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { StreamEvent, StreamWithPreview } from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
import { messagesApi } from "@/api/messages"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as syncEngineModule from "@/sync/sync-engine"
import { StreamHoverCard, type SidebarHoverIntent } from "./stream-hover-card"

const WS = "ws_1"
const STREAM = { id: "stream_general", type: "channel", slug: "general" } as StreamWithPreview

let reactionLog: { eventType: "reaction_added" | "reaction_removed"; emoji: string; userId: string }[]

function event(sequence: number, eventType: string, payload: Record<string, unknown>): StreamEvent {
  return {
    id: `evt_${sequence}`,
    streamId: STREAM.id,
    sequence: String(sequence),
    eventType,
    payload,
    actorId: "usr_ana",
    actorType: "user",
    createdAt: "2026-09-23T09:00:00.000Z",
  } as StreamEvent
}

function events(): StreamEvent[] {
  return [
    event(1, "message_created", { messageId: "msg_a", contentMarkdown: "Ship it?" }),
    ...reactionLog.map((r, i) => event(i + 2, r.eventType, { messageId: "msg_a", emoji: r.emoji, userId: r.userId })),
  ]
}

function setup() {
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue({
    emojis: [
      { shortcode: "+1", emoji: "👍", type: "native", group: "people", order: 1, aliases: [] },
      { shortcode: "fire", emoji: "🔥", type: "native", group: "nature", order: 2, aliases: [] },
    ],
    emojiWeights: {},
  } as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceMetadata>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([
    { id: "usr_ana", workspaceId: WS, name: "Ana", slug: "ana", avatarUrl: null },
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([])
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([])
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamReadStates").mockReturnValue([])
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  vi.spyOn(hooksModule, "useUnreadCounts").mockReturnValue({
    markAsRead: vi.fn(),
  } as unknown as ReturnType<typeof hooksModule.useUnreadCounts>)
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    kickOperationQueue: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: null,
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(contextsModule, "useStreamService").mockReturnValue({
    getEvents: vi.fn(async () => ({ events: events() })),
  } as unknown as ReturnType<typeof contextsModule.useStreamService>)
  const shortcodes: Record<string, string> = { "👍": ":+1:", "🔥": ":fire:" }
  const addReaction = vi.spyOn(messagesApi, "addReaction").mockImplementation(async (_ws, _msg, emoji) => {
    reactionLog.push({ eventType: "reaction_added", emoji: shortcodes[emoji], userId: "usr_me" })
  })
  const removeReaction = vi.spyOn(messagesApi, "removeReaction").mockImplementation(async (_ws, _msg, emoji) => {
    reactionLog.push({ eventType: "reaction_removed", emoji: shortcodes[emoji], userId: "usr_me" })
  })

  const hover = { enabled: true, open: true, setOpen: vi.fn(), close: vi.fn() } as unknown as SidebarHoverIntent
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <StreamHoverCard hover={hover} workspaceId={WS} stream={STREAM} unreadCount={0}>
          <button type="button">row</button>
        </StreamHoverCard>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { addReaction, removeReaction }
}

describe("StreamHoverCard reactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("should count the viewer's reaction before the server answers when they click someone else's pill", async () => {
    reactionLog = [{ eventType: "reaction_added", emoji: ":+1:", userId: "usr_ana" }]
    const { addReaction } = setup()
    let answer = () => {}
    addReaction.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve(undefined as never))))

    await userEvent.click(await screen.findByRole("button", { name: /👍\s*1/ }))

    expect(addReaction).toHaveBeenCalledWith(WS, "msg_a", "👍")
    expect(await screen.findByRole("button", { name: /👍\s*2/ })).toBeInTheDocument()
    answer()
  })

  it("should remove the pill when the viewer takes back the only reaction", async () => {
    reactionLog = [
      { eventType: "reaction_added", emoji: ":fire:", userId: "usr_ana" },
      { eventType: "reaction_removed", emoji: ":fire:", userId: "usr_ana" },
      { eventType: "reaction_added", emoji: ":fire:", userId: "usr_me" },
    ]
    const { removeReaction } = setup()

    await userEvent.click(await screen.findByRole("button", { name: /🔥\s*1/ }))

    expect(removeReaction).toHaveBeenCalledWith(WS, "msg_a", "🔥")
    await waitFor(() => expect(screen.queryByRole("button", { name: /🔥/ })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Add reaction" })).toBeInTheDocument()
  })
})
