import type { MemoExplorerResult, SearchCluster, SearchClusterConversation, SearchResultItem } from "@/api"

export function createMockClusterConversation(
  overrides: Partial<SearchClusterConversation> = {}
): SearchClusterConversation {
  return {
    id: "conv_1",
    streamId: "stream_channel1",
    topicSummary: "Choosing the launch date",
    summary: "The team weighed a May launch against waiting for the mobile build.",
    status: "resolved",
    messageCount: 7,
    participantIds: ["member_1"],
    firstMessageId: "msg_first",
    firstMessageAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  }
}

export function createMockSearchCluster(
  overrides: Partial<SearchCluster> & { hits: SearchResultItem[] }
): SearchCluster {
  return {
    conversation: null,
    streamId: overrides.conversation?.streamId ?? overrides.hits[0]?.streamId ?? "stream_channel1",
    matchedVia: ["message"],
    memoIds: [],
    score: 1,
    ...overrides,
  }
}

const strayClustersByResults = new WeakMap<SearchResultItem[], SearchCluster[]>()

/**
 * One single-message row per hit, the shape the API returns for messages outside
 * any conversation. Stable per results array, as a query result would be, so a
 * hook spy returning it on every render doesn't re-fire effects keyed on rows.
 */
export function strayClusters(results: SearchResultItem[]): SearchCluster[] {
  let clusters = strayClustersByResults.get(results)
  if (!clusters) {
    clusters = results.map((hit) => createMockSearchCluster({ hits: [hit] }))
    strayClustersByResults.set(results, clusters)
  }
  return clusters
}

export function createMockMemoResult(overrides: Partial<MemoExplorerResult["memo"]> = {}): MemoExplorerResult {
  return {
    memo: {
      id: "memo_1",
      workspaceId: "workspace_1",
      memoType: "message",
      sourceMessageId: "msg_1",
      sourceConversationId: null,
      title: "Launch decision",
      abstract: "Approved launch plan",
      keyPoints: [],
      sourceMessageIds: ["msg_1"],
      participantIds: ["member_1"],
      knowledgeType: "decision",
      tags: [],
      parentMemoId: null,
      status: "active",
      version: 1,
      revisionReason: null,
      authoredByKind: "pipeline",
      sourceSessionId: null,
      scope: "workspace",
      scopeUserId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      ...overrides,
    },
    distance: 0,
    sourceStream: { id: "stream_channel1", type: "channel", name: "general" },
    rootStream: null,
  }
}
