import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { useStashedDraftOrigins } from "./use-stashed-draft-origins"
import type { StashedDraftOrigin, StashedDraftSource } from "./use-stashed-drafts"

const workspaceId = "ws_origins"

function origin(
  source: StashedDraftSource,
  overrides: Partial<Omit<StashedDraftOrigin, keyof StashedDraftSource>> = {}
): StashedDraftOrigin {
  return {
    ...source,
    tier: "borrowed",
    title: null,
    anchorStreamId: null,
    ...overrides,
  } as unknown as StashedDraftOrigin
}

afterEach(() => vi.restoreAllMocks())

describe("useStashedDraftOrigins", () => {
  it("resolves every origin kind, fallback tier, and DM peer name from workspace caches", () => {
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
      [
        { id: "stream_general", type: "channel", slug: "general", displayName: null },
        { id: "stream_dm", type: "dm", slug: null, displayName: null },
      ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
      [{ id: "user_peer", name: "Ada" }] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue(
      [{ streamId: "stream_dm", userId: "user_peer" }] as unknown as ReturnType<
        typeof workspaceStoreModule.useWorkspaceDmPeers
      >
    )

    const origins = new Map<string, StashedDraftOrigin>([
      ["stream", origin({ kind: "stream", streamId: "stream_general" }, { tier: "own" })],
      ["stream-missing", origin({ kind: "stream", streamId: "stream_missing" })],
      ["dm", origin({ kind: "stream", streamId: "stream_dm" })],
      ["thread", origin({ kind: "thread", anchorId: "msg_1", streamId: "stream_general" })],
      ["thread-missing", origin({ kind: "thread", anchorId: "msg_2", streamId: null })],
      [
        "conversation-title",
        origin({ kind: "conversation", conversationId: "conv_1" }, { title: "Roadmap", anchorStreamId: "stream_general" }),
      ],
      [
        "conversation-anchor",
        origin({ kind: "conversation", conversationId: "conv_2" }, { anchorStreamId: "stream_general" }),
      ],
      ["branch-missing", origin({ kind: "branch", conversationId: "conv_3" })],
      [
        "subtopic-title",
        origin({ kind: "subtopic", streamId: "stream_general", messageId: "msg_3" }, { title: "Metrics" }),
      ],
      ["subtopic-missing", origin({ kind: "subtopic", streamId: "stream_missing", messageId: "msg_4" })],
    ])

    const { result } = renderHook(() => useStashedDraftOrigins(workspaceId, origins))
    const labels = Object.fromEntries(
      [...result.current].map(([id, row]) => [id, { label: row.label, tier: row.tier }])
    )

    expect(labels).toEqual({
      stream: { label: "#general", tier: "own" },
      "stream-missing": { label: "Untitled", tier: "borrowed" },
      dm: { label: "Ada", tier: "borrowed" },
      thread: { label: "Thread in #general", tier: "borrowed" },
      "thread-missing": { label: "Thread reply", tier: "borrowed" },
      "conversation-title": { label: "Reply in Roadmap", tier: "borrowed" },
      "conversation-anchor": { label: "Reply in #general", tier: "borrowed" },
      "branch-missing": { label: "Conversation reply", tier: "borrowed" },
      "subtopic-title": { label: "New sub-topic in Metrics", tier: "borrowed" },
      "subtopic-missing": { label: "New sub-topic", tier: "borrowed" },
    })
  })
})
