import { describe, it, expect, mock, afterEach } from "bun:test"
import { createWebSearchTool } from "./web-search-tool"
import {
  createExaEngine,
  createSerperEngine,
  createWebSearchEngines,
  type WebPage,
  type WebSearchEngine,
} from "./web-search-engines"

const toolOpts = { toolCallId: "test" }

describe("web-search-tool", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("should return search results on successful API call", async () => {
    const mockResponse = {
      results: [
        { title: "Result 1", url: "https://example.com/1", text: "Content 1" },
        { title: "Result 2", url: "https://example.com/2", text: "Content 2" },
      ],
    }

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("test-api-key")] })
    const { output } = await tool.config.execute({ query: "test query" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.query).toBe("test query")
    expect(
      parsed.results.map((r: { title: string; url: string; content: string }) => [r.title, r.url, r.content])
    ).toEqual([
      ["Result 1", "https://example.com/1", "Content 1"],
      ["Result 2", "https://example.com/2", "Content 2"],
    ])
  })

  it("should send correct headers and body to Exa API", async () => {
    let capturedRequest: { url: string; options: RequestInit } | null = null

    globalThis.fetch = mock((url: string, options: RequestInit) => {
      capturedRequest = { url, options }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response)
    }) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("test-api-key")] })
    await tool.config.execute({ query: "test query" }, toolOpts)

    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.url).toBe("https://api.exa.ai/search")
    expect(capturedRequest!.options.method).toBe("POST")
    expect(capturedRequest!.options.headers).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "test-api-key",
    })

    const body = JSON.parse(capturedRequest!.options.body as string)
    expect(body.query).toBe("test query")
    expect(body.numResults).toBe(5)
  })

  it("should carry invocation time in output but never in the definition", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({
      engines: [createExaEngine("test-api-key")],
      currentTime: "2026-11-15T10:00:00.000Z",
      timezone: "Europe/Stockholm",
    })
    const { output } = await tool.config.execute({ query: "AI news 2026" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(tool.config.description).toContain("include it in your query")
    expect(parsed.searchedAt).toBe("2026-11-15T10:00:00.000Z")
    expect(parsed.timezone).toBe("Europe/Stockholm")
  })

  // Tool definitions render ahead of the system prompt in the prompt-cache
  // prefix: any per-request value in a description or promptBlock invalidates
  // the cached prefix on every call, silently dropping the hit rate to zero
  // for the entire toolset. Guards against reintroducing the invocation time.
  it("should produce a byte-identical definition across differing invocation times", () => {
    const define = (currentTime: string) => {
      const t = createWebSearchTool({
        engines: [createExaEngine("test-api-key")],
        currentTime,
        timezone: "Europe/Stockholm",
      })
      return { description: t.config.description, promptBlock: t.config.promptBlock }
    }

    expect(define("2026-11-15T10:00:00.000Z")).toEqual(define("2026-11-15T10:00:31.000Z"))
  })

  it("should return error on API failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("invalid-key")] })
    const { output } = await tool.config.execute({ query: "test" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Search failed: api.exa.ai 401")
    expect(parsed.query).toBe("test")
  })

  it("should return error on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Network error"))) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("test-key")] })
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
        json: () => Promise.resolve({ results: [] }),
      } as Response)
    }) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("test-key")], maxResults: 10 })
    await tool.config.execute({ query: "test" }, toolOpts)

    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.numResults).toBe(10)
  })

  it("should return timeout error when request takes too long", async () => {
    const abortError = new Error("The operation was aborted")
    abortError.name = "AbortError"

    globalThis.fetch = mock(() => Promise.reject(abortError)) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("test-key")] })
    const { output } = await tool.config.execute({ query: "test" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("timed out")
  })

  it("reports a graceful stop (not a timeout) when the session signal aborts", async () => {
    // Reject with the aborted signal's reason, as a real fetch does — the reason
    // is the plain "user_abort" string, NOT an AbortError-named error, so a catch
    // that keyed on `error.name` would miss it and fall through to a generic error.
    globalThis.fetch = mock((_url: string, options: RequestInit) =>
      Promise.reject(options.signal?.reason ?? new Error("aborted"))
    ) as unknown as typeof fetch

    const controller = new AbortController()
    controller.abort("user_abort")

    const tool = createWebSearchTool({ engines: [createExaEngine("test-key")] })
    const { output } = await tool.config.execute({ query: "test" }, { toolCallId: "test", signal: controller.signal })
    const parsed = JSON.parse(output)

    expect(parsed.stopped).toBe(true)
    expect(parsed.error).toBeUndefined()
    expect(parsed.query).toBe("test")
  })

  it("merges Exa and Serper results, putting today's listing title over the stored copy", async () => {
    globalThis.fetch = mock((url: string) => {
      const body = url.includes("exa.ai")
        ? {
            results: [
              {
                url: "https://www.example.com/profile",
                title: "Old title",
                text: "Works at Acme",
                publishedDate: "2026-01-02T00:00:00Z",
              },
              { url: "https://docs.example.org/guide", title: "Guide", text: "Full guide text" },
            ],
          }
        : { organic: [{ link: "https://example.com/profile/", title: "New title", snippet: "Now at Globex" }] }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
    }) as unknown as typeof fetch

    const tool = createWebSearchTool({
      engines: [createExaEngine("exa-key"), createSerperEngine("serper-key")],
      currentTime: "2026-09-23T10:00:00.000Z",
    })
    const parsed = JSON.parse((await tool.config.execute({ query: "who" }, toolOpts)).output)

    expect(parsed.results).toEqual([
      {
        title: "New title",
        url: "https://www.example.com/profile",
        content: "Works at Acme",
        age: "Google lists this page on 2026-09-23 under the title above. The text is a stored copy dated 2026-01-02; where it disagrees with the title, the title is current",
      },
      {
        title: "Guide",
        url: "https://docs.example.org/guide",
        content: "Full guide text",
        age: "stored copy of the page, age unknown",
      },
    ])
  })

  it("merges a listing into its stored copy whichever engine answers first, and keeps sibling hosts apart", async () => {
    globalThis.fetch = mock((url: string) => {
      const body = url.includes("exa.ai")
        ? {
            results: [
              { url: "https://www.linkedin.com/in/someone", title: "Old role", text: "Staff Engineer" },
              { url: "https://google.dev", title: "Google for Developers", text: "Dev home" },
            ],
          }
        : {
            organic: [
              { link: "https://ai.google.dev", title: "Gemini API", snippet: "Gemini" },
              { link: "https://se.linkedin.com/in/someone", title: "New role", snippet: "Founding Engineer" },
            ],
          }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
    }) as unknown as typeof fetch

    const tool = createWebSearchTool({
      engines: [createSerperEngine("serper-key"), createExaEngine("exa-key")],
      currentTime: "2026-09-23T10:00:00.000Z",
    })
    const parsed = JSON.parse((await tool.config.execute({ query: "who" }, toolOpts)).output)

    expect(parsed.results.map((result: { title: string; url: string }) => [result.title, result.url])).toEqual([
      ["Gemini API", "https://ai.google.dev"],
      ["New role", "https://www.linkedin.com/in/someone"],
      ["Google for Developers", "https://google.dev"],
    ])
  })

  it("answers from the engines that worked when one fails", async () => {
    globalThis.fetch = mock((url: string) =>
      url.includes("exa.ai")
        ? Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") } as Response)
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ organic: [{ link: "https://a.example/x", title: "A", snippet: "a" }] }),
          } as Response)
    ) as unknown as typeof fetch

    const tool = createWebSearchTool({ engines: [createExaEngine("exa-key"), createSerperEngine("serper-key")] })
    const parsed = JSON.parse((await tool.config.execute({ query: "q" }, toolOpts)).output)

    expect(parsed.error).toBeUndefined()
    expect(parsed.results.map((r: { url: string }) => r.url)).toEqual(["https://a.example/x"])
  })
})

describe("web-search-tool judged and opened", () => {
  const engine = (pages: WebPage[]): WebSearchEngine => ({ name: "serper", search: async () => pages })
  const listed = (n: number): WebPage => ({
    title: `Listing ${n}`,
    url: `https://listed.example/${n}`,
    content: `snippet ${n}`,
    seen: "listed",
  })
  const both: WebPage = {
    title: "Kris - Founding Engineer - Galdera Labs",
    url: "https://profile.example/kris",
    content: "Staff Engineer at Telness Tech",
    seen: "both",
  }
  const stored: WebPage = { title: "Guide", url: "https://stored.example/guide", content: "Guide text", seen: "stored" }
  const run = async (tool: ReturnType<typeof createWebSearchTool>) =>
    JSON.parse((await tool.config.execute({ query: "kris role" }, toolOpts)).output)

  it("opens the stale stored copy and the top three listings, and nothing else", async () => {
    const opened: string[] = []
    const tool = createWebSearchTool({
      engines: [engine([listed(1), listed(2), listed(3), listed(4), both, stored])],
      currentTime: "2026-09-23T10:00:00.000Z",
      judge: async () => ({ offTopic: false, ambiguous: false, stale: [false, false, false, false, true, false] }),
      openPage: async (url) => {
        opened.push(url)
        return `page at ${url}`
      },
    })

    const parsed = await run(tool)

    expect({
      opened: opened.sort(),
      results: parsed.results.map((r: { url: string; content: string; age: string }) => [r.url, r.content, r.age]),
    }).toEqual({
      opened: [both.url, listed(1).url, listed(2).url, listed(3).url].sort(),
      results: [
        [listed(1).url, `page at ${listed(1).url}`, "the page itself, read on 2026-09-23"],
        [listed(2).url, `page at ${listed(2).url}`, "the page itself, read on 2026-09-23"],
        [listed(3).url, `page at ${listed(3).url}`, "the page itself, read on 2026-09-23"],
        [
          listed(4).url,
          "snippet 4",
          "Google's listing on 2026-09-23. The title is current, the text under it may not be",
        ],
        [both.url, `page at ${both.url}`, "the page itself, read on 2026-09-23"],
        [stored.url, "Guide text", "stored copy of the page, age unknown"],
      ],
    })
  })

  it("keeps the engine's text for a page that cannot be opened, and leaves out a stale one's", async () => {
    const tool = createWebSearchTool({
      engines: [engine([listed(1), both])],
      judge: async () => ({ offTopic: false, ambiguous: false, stale: [false, true] }),
      openPage: async (url) => {
        if (url === both.url) throw new Error("authwall")
        return null
      },
    })

    const parsed = await run(tool)

    expect(
      parsed.results.map((r: { content: string; age: string }) => [r.content, r.age.includes("contradicts")])
    ).toEqual([
      ["snippet 1", false],
      ["", true],
    ])
  })

  it("leaves out stale copies' text when nothing opens pages", async () => {
    const tool = createWebSearchTool({
      engines: [engine([both, stored])],
      judge: async () => ({ offTopic: false, ambiguous: false, stale: [true, false] }),
    })

    const parsed = await run(tool)

    expect(
      parsed.results.map((r: { url: string; content: string; age: string }) => [
        r.url,
        r.content,
        r.age.includes("contradicts"),
      ])
    ).toEqual([
      [both.url, "", true],
      [stored.url, "Guide text", false],
    ])
  })

  it("drops every result and says so when they are off topic", async () => {
    const openPage = mock(async () => "page")
    const tool = createWebSearchTool({
      engines: [engine([listed(1), both])],
      judge: async () => ({ offTopic: true, ambiguous: false, stale: [false, true] }),
      openPage,
    })

    const parsed = await run(tool)

    expect({ results: parsed.results, note: parsed.note, opens: openPage.mock.calls.length }).toEqual({
      results: [],
      note: expect.stringContaining("None of these results are about what was searched for"),
      opens: 0,
    })
  })

  it("keeps ambiguous results with a note to ask which one was meant", async () => {
    const tool = createWebSearchTool({
      engines: [engine([stored])],
      judge: async () => ({ offTopic: false, ambiguous: true, stale: [false] }),
    })

    const parsed = await run(tool)

    expect({ urls: parsed.results.map((r: { url: string }) => r.url), note: parsed.note }).toEqual({
      urls: [stored.url],
      note: expect.stringContaining("several different things that share a name"),
    })
  })

  it("still opens thin listings when no judgment was made", async () => {
    const tool = createWebSearchTool({
      engines: [engine([listed(1), both])],
      judge: async () => null,
      openPage: async (url) => `page at ${url}`,
    })

    const parsed = await run(tool)

    expect({
      note: parsed.note,
      contents: parsed.results.map((r: { content: string }) => r.content),
    }).toEqual({ note: undefined, contents: [`page at ${listed(1).url}`, "Staff Engineer at Telness Tech"] })
  })
})

describe("createWebSearchEngines", () => {
  it("builds one engine per key that is set", () => {
    const names = (keys: { exa?: string; serper?: string }) => createWebSearchEngines(keys).map((engine) => engine.name)
    expect([names({ exa: "e", serper: "s" }), names({ serper: "s" }), names({})]).toEqual([
      ["exa", "serper"],
      ["serper"],
      [],
    ])
  })
})
