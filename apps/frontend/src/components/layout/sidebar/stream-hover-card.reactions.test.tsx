import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import type { StreamWithPreview } from "@threahq/types"
import { render, screen, userEvent, waitFor } from "@/test"
import { messagesApi } from "@/api/messages"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the card's real live read
import { db, type CachedEvent } from "@/db"
import * as contextsModule from "@/contexts"
import * as hooksModule from "@/hooks"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as syncEngineModule from "@/sync/sync-engine"
import { StreamHoverCard, type SidebarHoverIntent } from "./stream-hover-card"

const WS = "ws_1"
const STREAM = { id: "stream_general", type: "channel", slug: "general" } as StreamWithPreview

function messageRow(
  sequence: number,
  messageId: string,
  payload: Record<string, unknown> = {},
  row: Partial<CachedEvent> = {}
): CachedEvent {
  return {
    id: `evt_${sequence}`,
    workspaceId: WS,
    streamId: STREAM.id,
    sequence: String(sequence),
    _sequenceNum: sequence,
    eventType: "message_created",
    payload: { messageId, contentMarkdown: messageId, reactions: {}, ...payload },
    actorId: "usr_ana",
    actorType: "user",
    createdAt: "2026-09-23T09:00:00.000Z",
    _cachedAt: sequence,
    ...row,
  } as CachedEvent
}

/** The socket echo of a reaction, as the sync handler patches it onto the message row. */
async function echoReaction(messageId: string, emoji: string, userId: string, added: boolean) {
  const row = await db.events.where("payload.messageId").equals(messageId).first()
  const payload = row!.payload as { reactions: Record<string, string[]> }
  const users = (payload.reactions[emoji] ?? []).filter((id) => id !== userId)
  const reactions = { ...payload.reactions, [emoji]: added ? [...users, userId] : users }
  if (reactions[emoji].length === 0) delete reactions[emoji]
  await db.events.update(row!.id, { payload: { ...payload, reactions } })
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
  const addReaction = vi.spyOn(messagesApi, "addReaction").mockResolvedValue(undefined as never)
  const removeReaction = vi.spyOn(messagesApi, "removeReaction").mockResolvedValue(undefined as never)

  const hover = { enabled: true, open: true, setOpen: vi.fn(), close: vi.fn() } as unknown as SidebarHoverIntent
  render(
    <MemoryRouter>
      <StreamHoverCard hover={hover} workspaceId={WS} stream={STREAM} unreadCount={0}>
        <button type="button">row</button>
      </StreamHoverCard>
    </MemoryRouter>
  )
  return { addReaction, removeReaction }
}

function messageIds() {
  return Array.from(document.querySelectorAll("[data-message-id]")).map((el) => el.getAttribute("data-message-id"))
}

describe("StreamHoverCard", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await db.events.clear()
  })

  it("should show the stream's stored messages oldest first, skipping deleted and unsent ones, and follow new arrivals", async () => {
    await db.events.bulkPut([
      messageRow(1, "msg_a"),
      messageRow(2, "msg_deleted", { deletedAt: "2026-09-23T09:05:00.000Z" }),
      messageRow(3, "msg_b"),
      messageRow(1700000000000, "msg_pending", {}, { _status: "pending" }),
      { ...messageRow(4, "msg_other"), id: "evt_other", streamId: "stream_other" },
    ])
    setup()

    await waitFor(() => expect(messageIds()).toEqual(["msg_a", "msg_b"]))

    await db.events.put(messageRow(5, "msg_c"))
    await waitFor(() => expect(messageIds()).toEqual(["msg_a", "msg_b", "msg_c"]))
  })

  it("should count the viewer's reaction once its echo lands on the stored message", async () => {
    await db.events.put(messageRow(1, "msg_a", { reactions: { ":+1:": ["usr_ana"] } }))
    const { addReaction } = setup()

    await userEvent.click(await screen.findByRole("button", { name: /👍\s*1/ }))
    expect(addReaction).toHaveBeenCalledWith(WS, "msg_a", "👍")

    await echoReaction("msg_a", ":+1:", "usr_me", true)
    expect(await screen.findByRole("button", { name: /👍\s*2/ })).toBeInTheDocument()
  })

  it("should remove the pill when the viewer takes back the only reaction", async () => {
    await db.events.put(messageRow(1, "msg_a", { reactions: { ":fire:": ["usr_me"] } }))
    const { removeReaction } = setup()

    await userEvent.click(await screen.findByRole("button", { name: /🔥\s*1/ }))
    expect(removeReaction).toHaveBeenCalledWith(WS, "msg_a", "🔥")

    await echoReaction("msg_a", ":fire:", "usr_me", false)
    await waitFor(() => expect(screen.queryByRole("button", { name: /🔥/ })).not.toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Add reaction" })).toBeInTheDocument()
  })
})
