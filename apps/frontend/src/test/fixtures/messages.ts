/**
 * Search result shape (from search API).
 */
export interface MockSearchResult {
  id: string
  streamId: string
  content: string
  authorId: string
  authorType: "user" | "persona"
  createdAt: string
}

/**
 * Factory for creating mock search results.
 */
export function createMockSearchResult(overrides: Partial<MockSearchResult> & { id: string }): MockSearchResult {
  return {
    streamId: "stream_channel1",
    content: "Test message content",
    authorId: "member_1",
    authorType: "user",
    createdAt: "2025-01-15T10:00:00Z",
    ...overrides,
  }
}

/**
 * Pre-built mock search results.
 */
export const mockSearchResults = {
  hello: createMockSearchResult({
    id: "msg_1",
    streamId: "stream_channel1",
    content: "Hello from the search results",
    createdAt: "2025-01-15T10:00:00Z",
  }),

  another: createMockSearchResult({
    id: "msg_2",
    streamId: "stream_channel2",
    content: "Another search result message",
    createdAt: "2025-01-14T09:00:00Z",
  }),
}

/**
 * Array of all mock search results.
 */
export const mockSearchResultsList: MockSearchResult[] = Object.values(mockSearchResults)
