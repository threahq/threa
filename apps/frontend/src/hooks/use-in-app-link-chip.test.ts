import { beforeEach, describe, it, expect, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { MessageSquare } from "lucide-react"
import { createElement, type ReactNode } from "react"
import type { MessageLinkPreviewData } from "@threahq/types"
import { AuthContext } from "@/auth/context"
import { db, type CachedWorkspaceUser } from "@/db"
import { resetActorLookups } from "@/stores/actor-lookup"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import { buildMessageChipLabel, buildLocalMessageParts, useInAppLinkChip } from "./use-in-app-link-chip"

function messageData(overrides: Partial<MessageLinkPreviewData>): MessageLinkPreviewData {
  return { kind: "message", accessTier: "full", ...overrides }
}

describe("buildMessageChipLabel", () => {
  it("phrases a DM as '{author} to {recipient}' with full names", () => {
    expect(
      buildMessageChipLabel(
        messageData({ streamType: "dm", authorName: "Pierre Boberg", recipientName: "Kristoffer Remback" })
      )
    ).toBe("Pierre Boberg to Kristoffer Remback")

    expect(
      buildMessageChipLabel(
        messageData({ streamType: "dm", authorName: "Kristoffer Remback", recipientName: "Pierre Boberg" })
      )
    ).toBe("Kristoffer Remback to Pierre Boberg")
  })

  it("phrases a channel message as '{author} in #slug'", () => {
    expect(
      buildMessageChipLabel(
        messageData({ streamType: "channel", authorName: "Kristoffer Remback", streamName: "tech-big-new-prop" })
      )
    ).toBe("Kristoffer Remback in #tech-big-new-prop")
  })

  it("does not double the '#' when the stream name already carries one", () => {
    expect(
      buildMessageChipLabel(messageData({ streamType: "channel", authorName: "Kris", streamName: "#general" }))
    ).toBe("Kris in #general")
  })

  it("phrases a scratchpad/thread message as '{author} in {name}' without a sigil", () => {
    expect(
      buildMessageChipLabel(messageData({ streamType: "scratchpad", authorName: "Kris", streamName: "My notes" }))
    ).toBe("Kris in My notes")
  })

  it("returns null when the author could not be resolved, so the caller falls back", () => {
    expect(buildMessageChipLabel(messageData({ streamType: "channel", streamName: "general" }))).toBeNull()
  })

  it("falls back to just the author when a DM recipient could not be resolved", () => {
    expect(buildMessageChipLabel(messageData({ streamType: "dm", authorName: "Pierre" }))).toBe("Pierre")
  })
})

describe("buildLocalMessageParts", () => {
  const names: Record<string, string> = {
    user_pierre: "Pierre Boberg",
    user_viewer: "Kristoffer Remback",
  }
  const resolveName = (id: string) => names[id] ?? id

  it("names a channel message as '{author} in {streamLabel}'", () => {
    expect(
      buildLocalMessageParts({
        authorId: "user_pierre",
        authorName: "Pierre Boberg",
        streamId: "stream_1",
        localName: "#general",
        dmPeers: [],
        currentUserId: "user_viewer",
        resolveName,
      })
    ).toEqual({ lead: "Pierre Boberg", tail: " in #general" })
  })

  it("names a DM the peer authored as '{author} to {viewer}'", () => {
    expect(
      buildLocalMessageParts({
        authorId: "user_pierre",
        authorName: "Pierre Boberg",
        streamId: "stream_dm",
        localName: "Pierre Boberg",
        dmPeers: [{ streamId: "stream_dm", userId: "user_pierre" }],
        currentUserId: "user_viewer",
        resolveName,
      })
    ).toEqual({ lead: "Pierre Boberg", tail: " to Kristoffer Remback" })
  })

  it("names a DM the viewer authored as '{author} to {peer}'", () => {
    expect(
      buildLocalMessageParts({
        authorId: "user_viewer",
        authorName: "Kristoffer Remback",
        streamId: "stream_dm",
        localName: "Pierre Boberg",
        dmPeers: [{ streamId: "stream_dm", userId: "user_pierre" }],
        currentUserId: "user_viewer",
        resolveName,
      })
    ).toEqual({ lead: "Kristoffer Remback", tail: " to Pierre Boberg" })
  })

  it("drops the location tail when neither a DM peer nor a stream label is known", () => {
    expect(
      buildLocalMessageParts({
        authorId: "user_pierre",
        authorName: "Pierre Boberg",
        streamId: "stream_x",
        localName: null,
        dmPeers: [],
        currentUserId: "user_viewer",
        resolveName,
      })
    ).toEqual({ lead: "Pierre Boberg", tail: "" })
  })
})

describe("useInAppLinkChip", () => {
  function workspaceUser(workspaceId: string, id: string, name: string): CachedWorkspaceUser {
    return {
      id,
      workspaceId,
      workosUserId: `workos_${id}`,
      email: `${id}@example.com`,
      role: "member",
      slug: id,
      name,
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
      _cachedAt: 1,
    }
  }

  function copiedMessage(workspaceId: string, actorId: string) {
    return {
      id: "evt_copied",
      workspaceId,
      streamId: "stream_src",
      sequence: "1",
      _sequenceNum: 1,
      eventType: "message_created" as const,
      payload: { messageId: "msg_copied", contentMarkdown: "hello" },
      actorId,
      actorType: "user" as const,
      createdAt: "2026-04-23T10:00:00Z",
      _cachedAt: 1,
    }
  }

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        AuthContext.Provider,
        {
          value: {
            user: { id: "workos_viewer", email: "viewer@example.com", name: "Viewer" },
            activeWorkosUserId: "workos_viewer",
            loading: false,
            error: null,
            login: vi.fn(),
            logout: vi.fn(),
            activateAccount: vi.fn(),
            refetch: vi.fn(),
          },
        },
        children
      )
    )
  }

  beforeEach(async () => {
    resetWorkspaceTableRegistry()
    resetWorkspaceStoreCache()
    resetActorLookups()
    await db.events.clear()
    await db.workspaceUsers.clear()
  })

  it("should name a message from the requested workspace's cached copy when another workspace holds the same ids", async () => {
    await db.workspaceUsers.bulkPut([workspaceUser("ws_1", "usr_1", "Ada"), workspaceUser("ws_2", "usr_2", "Grace")])
    await db.events.bulkPut([copiedMessage("ws_1", "usr_1"), copiedMessage("ws_2", "usr_2")])

    const { result } = renderHook(
      () =>
        useInAppLinkChip({
          workspaceId: "ws_2",
          streamId: "stream_src",
          messageId: "msg_copied",
          isMessage: true,
          url: "https://app.threa.io/w/ws_2/s/stream_src?m=msg_copied",
        }),
      { wrapper }
    )

    await waitFor(() => expect(result.current).toEqual({ status: "resolved", icon: MessageSquare, label: "Grace" }))
  })
})
