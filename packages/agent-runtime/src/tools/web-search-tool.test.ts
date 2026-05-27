import { describe, it, expect, mock, afterEach } from "bun:test"
import { createWebSearchTool } from "./web-search-tool"

const toolOpts = { toolCallId: "test" }

describe("web-search-tool", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("should return search results on successful API call", async () => {
    const mockResponse = {
      query: "test query",
      answer: "This is the answer",
      results: [
        { title: "Result 1", url: "https://example.com/1", content: "Content 1", score: 0.9 },
        { title: "Result 2", url: "https://example.com/2", content: "Content 2", score: 0.8 },
      ],
      response_time: 0.5,
    }

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({ tavilyApiKey: "test-api-key" })
    const { output } = await tool.config.execute({ query: "test query" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.query).toBe("test query")
    expect(parsed.answer).toBe("This is the answer")
    expect(parsed.results).toHaveLength(2)
    expect(parsed.results[0].title).toBe("Result 1")
    expect(parsed.results[0].url).toBe("https://example.com/1")
  })

  it("should send correct headers and body to Tavily API", async () => {
    let capturedRequest: { url: string; options: RequestInit } | null = null

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedRequest = { url, options }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ query: "test", results: [], response_time: 0.1 }),
      } as Response)
    }) as unknown as typeof fetch

    const tool = createWebSearchTool({ tavilyApiKey: "test-api-key" })
    await tool.config.execute({ query: "test query" }, toolOpts)

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.url).toBe("https://api.tavily.com/search")
    expect(capturedRequest!.options.method).toBe("POST")
    expect(capturedRequest!.options.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-api-key",
    })

    const body = JSON.parse(capturedRequest!.options.body as string)
    expect(body.query).toBe("test query")
    expect(body.max_results).toBe(5)
    expect(body.include_answer).toBe(true)
  })

  it("should expose invocation time in the tool description and output", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ query: "AI news 2026", results: [], response_time: 0.1 }),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({
      tavilyApiKey: "test-api-key",
      currentTime: "2026-11-15T10:00:00.000Z",
      timezone: "Europe/Stockholm",
    })
    const { output } = await tool.config.execute({ query: "AI news 2026" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(tool.config.description).toContain("Current invocation time is 2026-11-15T10:00:00.000Z")
    expect(tool.config.description).toContain("include the current date/year")
    expect(parsed.searchedAt).toBe("2026-11-15T10:00:00.000Z")
    expect(parsed.timezone).toBe("Europe/Stockholm")
  })

  it("should return error on API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({ tavilyApiKey: "invalid-key" })
    const { output } = await tool.config.execute({ query: "test" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Search failed: 401")
    expect(parsed.query).toBe("test")
  })

  it("should return error on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as unknown as typeof fetch

    const tool = createWebSearchTool({ tavilyApiKey: "test-key" })
    const { output } = await tool.config.execute({ query: "test" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Network error")
  })

  it("should respect maxResults parameter", async () => {
    let capturedBody: Record<string, unknown> | null = null

    globalThis.fetch = mock((_url: string, options: RequestInit) => {
      capturedBody = JSON.parse(options.body as string)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ query: "test", results: [], response_time: 0.1 }),
      } as Response)
    }) as unknown as typeof fetch

    const tool = createWebSearchTool({ tavilyApiKey: "test-key", maxResults: 10 })
    await tool.config.execute({ query: "test" }, toolOpts)

    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.max_results).toBe(10)
  })

  it("should return timeout error when request takes too long", async () => {
    const abortError = new Error("The operation was aborted")
    abortError.name = "AbortError"

    globalThis.fetch = mock(() => Promise.reject(abortError)) as unknown as typeof fetch

    const tool = createWebSearchTool({ tavilyApiKey: "test-key" })
    const { output } = await tool.config.execute({ query: "test" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("timed out")
  })
})
