import { describe, it, expect, mock, afterEach, beforeEach, spyOn } from "bun:test"
import * as dns from "dns/promises"
import { createReadUrlTool } from "./read-url-tool"

describe("read-url-tool", () => {
  const originalFetch = globalThis.fetch
  let dnsResolve4Spy: ReturnType<typeof spyOn>
  let dnsResolve6Spy: ReturnType<typeof spyOn>

  beforeEach(() => {
    // Mock DNS to return public IPs by default (both IPv4 and IPv6)
    dnsResolve4Spy = spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"])
    dnsResolve6Spy = spyOn(dns, "resolve6").mockRejectedValue(new Error("No AAAA records"))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    dnsResolve4Spy.mockRestore()
    dnsResolve6Spy.mockRestore()
  })

  const toolOpts = { toolCallId: "test" }

  it("should convert HTML to markdown", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Hello World</h1>
          <p>This is a test paragraph.</p>
          <script>console.log('should be removed')</script>
          <style>.hidden { display: none; }</style>
        </body>
      </html>
    `

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: () => Promise.resolve(html),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.url).toBe("https://example.com")
    expect(parsed.title).toBe("Test Page")
    expect(parsed.content).toContain("Hello World")
    expect(parsed.content).toContain("This is a test paragraph")
  })

  it("should send correct User-Agent header", async () => {
    let capturedHeaders: Record<string, string> | null = null

    globalThis.fetch = mock((_url: string, options: RequestInit) => {
      capturedHeaders = options.headers as Record<string, string>
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: () => Promise.resolve("<html><head><title>Test</title></head><body></body></html>"),
      } as Response)
    }) as unknown as typeof fetch

    const tool = createReadUrlTool()
    await tool.config.execute({ url: "https://example.com" }, toolOpts)

    expect(capturedHeaders).not.toBeNull()
    expect(capturedHeaders!["User-Agent"]).toContain("Threa-Agent")
  })

  it("should return error for non-HTML content types", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        text: () => Promise.resolve("binary content"),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com/file.pdf" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Unsupported content type")
    expect(parsed.error).toContain("application/pdf")
  })

  it("should return error on HTTP failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com/missing" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Failed to fetch URL: 404 Not Found")
  })

  it("should return error on network failure", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("Connection refused"))) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("Connection refused")
  })

  it("should truncate very long content", async () => {
    const longContent = "A".repeat(60000)
    const html = `<html><head><title>Test</title></head><body>${longContent}</body></html>`

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        text: () => Promise.resolve(html),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.content.length).toBeLessThan(60000)
    expect(parsed.content).toContain("[Content truncated...]")
  })

  it("should handle plain text content", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: () => Promise.resolve("This is plain text content."),
      } as Response)
    ) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com/file.txt" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.content).toBe("This is plain text content.")
  })

  const jsonResponse = (data: unknown, contentType = "application/json") =>
    mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": contentType }),
        text: () => Promise.resolve(typeof data === "string" ? data : JSON.stringify(data)),
      } as Response)
    ) as unknown as typeof fetch

  describe("JSON handling", () => {
    it("returns small JSON in full", async () => {
      globalThis.fetch = jsonResponse({ hello: "world", nums: [1, 2, 3] })

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://api.example.com/data" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBe("json")
      expect(parsed.truncated).toBeUndefined()
      expect(parsed.content).toEqual({ hello: "world", nums: [1, 2, 3] })
    })

    it("handles JSON with a +json content type suffix", async () => {
      globalThis.fetch = jsonResponse({ ok: true }, "application/vnd.api+json")

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://api.example.com/data" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBe("json")
      expect(parsed.content).toEqual({ ok: true })
    })

    it("summarizes large JSON with shape, preview, and a hint instead of truncating", async () => {
      const big = {
        data: {
          items: Array.from({ length: 2000 }, (_, i) => ({ id: `item_${i}`, name: `Name ${i}`, score: i })),
          total: 2000,
        },
      }
      globalThis.fetch = jsonResponse(big)

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://api.example.com/big" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBe("json")
      expect(parsed.truncated).toBe(true)
      expect(parsed.byteSize).toBeGreaterThan(50000)
      expect(parsed.shape.data.items).toContain("array[2000]")
      expect(parsed.hint).toContain("select")
      // preview keeps a few real items, not the whole array
      expect(parsed.preview.data.items.length).toBeLessThan(10)
      expect(parsed.preview.data.items[0]).toEqual({ id: "item_0", name: "Name 0", score: 0 })
    })

    it("drills into a subtree with a select path", async () => {
      const big = {
        data: {
          items: Array.from({ length: 2000 }, (_, i) => ({ id: `item_${i}` })),
        },
      }
      globalThis.fetch = jsonResponse(big)

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute(
        { url: "https://api.example.com/big", select: ".data.items[0:2]" },
        toolOpts
      )
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBe("json")
      expect(parsed.select).toBe(".data.items[0:2]")
      expect(parsed.content).toEqual([{ id: "item_0" }, { id: "item_1" }])
    })

    it("returns an actionable error for a bad select path", async () => {
      globalThis.fetch = jsonResponse({ data: { total: 5 } })

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute(
        { url: "https://api.example.com/data", select: ".data.missing" },
        toolOpts
      )
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("not found")
      expect(parsed.error).toContain("total") // surfaces the keys that do exist
      expect(parsed.select).toBe(".data.missing")
    })

    it("errors when content declares JSON but does not parse", async () => {
      globalThis.fetch = jsonResponse("<html>not json</html>")

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://api.example.com/broken" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("did not parse as JSON")
    })

    it("treats plain text that is actually JSON as JSON", async () => {
      globalThis.fetch = jsonResponse('{"served":"as text/plain"}', "text/plain")

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://api.example.com/data" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBe("json")
      expect(parsed.content).toEqual({ served: "as text/plain" })
    })

    it("matches content types case-insensitively", async () => {
      globalThis.fetch = jsonResponse({ ok: true }, "Application/JSON; charset=UTF-8")

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://api.example.com/data" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBe("json")
      expect(parsed.content).toEqual({ ok: true })
    })

    it("keeps real plain text as text", async () => {
      globalThis.fetch = jsonResponse("just some prose, not json", "text/plain")

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://example.com/file.txt" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.kind).toBeUndefined()
      expect(parsed.content).toBe("just some prose, not json")
    })
  })

  it("should return timeout error when request takes too long", async () => {
    const abortError = new Error("The operation was aborted")
    abortError.name = "AbortError"

    globalThis.fetch = mock(() => Promise.reject(abortError)) as unknown as typeof fetch

    const tool = createReadUrlTool()
    const { output } = await tool.config.execute({ url: "https://example.com" }, toolOpts)
    const parsed = JSON.parse(output)

    expect(parsed.error).toContain("timed out")
  })

  describe("SSRF protection", () => {
    it("should block localhost", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://localhost/admin" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block 127.0.0.1", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://127.0.0.1:8080/secret" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block any 127.x.x.x address", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://127.0.0.2/admin" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block private 10.x.x.x addresses", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://10.0.0.1/internal" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block private 192.168.x.x addresses", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://192.168.1.1/router" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block private 172.16-31.x.x addresses", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://172.16.0.1/internal" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block cloud metadata endpoints (169.254.x.x)", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://169.254.169.254/latest/meta-data/" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block .local hostnames", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://internal-service.local/api" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("internal hostnames")
    })

    it("should block .internal hostnames", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://db.internal:5432/" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("internal hostnames")
    })

    it("should block non-HTTP protocols", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "file:///etc/passwd" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("Unsupported protocol")
    })

    it("should block IPv6 loopback", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://[::1]/admin" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block IPv4-mapped IPv6 addresses", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://[::ffff:127.0.0.1]/admin" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block URLs that resolve to private IPs via A records", async () => {
      dnsResolve4Spy.mockResolvedValue(["10.0.0.1"])

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://evil.com/redirect" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("resolves to a private or reserved")
    })

    it("should block URLs that resolve to private IPs via AAAA records", async () => {
      dnsResolve4Spy.mockRejectedValue(new Error("No A records"))
      dnsResolve6Spy.mockResolvedValue(["::1"])

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://evil.com/ipv6-only" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("resolves to a private or reserved")
    })

    it("should block when DNS resolution fails (fail-closed)", async () => {
      dnsResolve4Spy.mockRejectedValue(new Error("DNS timeout"))
      dnsResolve6Spy.mockRejectedValue(new Error("DNS timeout"))

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://unreachable.example.com" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("no DNS records found")
    })

    it("should block localhost with trailing dot (FQDN)", async () => {
      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "http://localhost./admin" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("private or reserved")
    })

    it("should block redirects to private IPs", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 302,
          headers: new Headers({ location: "http://169.254.169.254/metadata" }),
          text: () => Promise.resolve(""),
        } as Response)
      ) as unknown as typeof fetch

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://example.com/redirect" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("Redirect blocked")
    })

    it("should follow safe redirects", async () => {
      let callCount = 0
      globalThis.fetch = mock(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 302,
            headers: new Headers({ location: "https://example.com/final" }),
            text: () => Promise.resolve(""),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          text: () => Promise.resolve("<html><head><title>Final</title></head><body>Content</body></html>"),
        } as Response)
      }) as unknown as typeof fetch

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://example.com/start" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.title).toBe("Final")
      expect(callCount).toBe(2)
    })

    it("should limit redirect count", async () => {
      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 302,
          headers: new Headers({ location: "https://example.com/next" }),
          text: () => Promise.resolve(""),
        } as Response)
      ) as unknown as typeof fetch

      const tool = createReadUrlTool()
      const { output } = await tool.config.execute({ url: "https://example.com/loop" }, toolOpts)
      const parsed = JSON.parse(output)

      expect(parsed.error).toContain("Too many redirects")
    })
  })
})
