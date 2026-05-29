import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  createLinkPreviewWorker,
  decodeHtmlBytes,
  detectCharset,
  extractOEmbedDescription,
  parseHtmlMeta,
} from "./worker"
import { GitHubPreviewTypes } from "@threa/types"

/** Encode a string as ISO-8859-1 (Latin-1) bytes. Each char with code ≤ 0xFF becomes one byte. */
function latin1Bytes(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i) & 0xff
  return bytes
}

describe("detectCharset", () => {
  test("reads charset from HTTP Content-Type header", () => {
    const bytes = latin1Bytes("<html><head></head></html>")
    expect(detectCharset("text/html; charset=iso-8859-1", bytes)).toBe("iso-8859-1")
    expect(detectCharset('text/html; charset="UTF-8"', bytes)).toBe("utf-8")
    expect(detectCharset("text/html; charset=Windows-1252", bytes)).toBe("windows-1252")
  })

  test("falls back to <meta charset> in the document", () => {
    const html = `<html><head><meta charset="utf-8"></head></html>`
    expect(detectCharset("text/html", latin1Bytes(html))).toBe("utf-8")
  })

  test("falls back to <meta http-equiv='Content-Type'> in the document", () => {
    const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head></html>`
    expect(detectCharset("text/html", latin1Bytes(html))).toBe("iso-8859-1")
  })

  test("HTTP header takes priority over meta tag", () => {
    const html = `<html><head><meta charset="iso-8859-1"></head></html>`
    expect(detectCharset("text/html; charset=utf-8", latin1Bytes(html))).toBe("utf-8")
  })

  test("defaults to utf-8 when nothing is declared", () => {
    const html = `<html><head></head></html>`
    expect(detectCharset("text/html", latin1Bytes(html))).toBe("utf-8")
    expect(detectCharset("", latin1Bytes(html))).toBe("utf-8")
  })
})

describe("decodeHtmlBytes", () => {
  test("decodes ISO-8859-1 bytes declared via HTTP header", () => {
    // ä = 0xE4, å = 0xE5, ö = 0xF6 in ISO-8859-1
    const bytes = latin1Bytes(`<html><head><title>Core Vitamins Man | Multivitamin för män</title></head></html>`)
    const decoded = decodeHtmlBytes(bytes, "text/html; charset=iso-8859-1")
    expect(decoded).toContain("för män")
    expect(decoded).not.toContain("\uFFFD")
  })

  test("decodes ISO-8859-1 bytes declared via <meta http-equiv>", () => {
    const bytes = latin1Bytes(
      `<html><head>` +
        `<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">` +
        `<title>Bär och frukt</title>` +
        `</head></html>`
    )
    const decoded = decodeHtmlBytes(bytes, "text/html")
    expect(decoded).toContain("Bär och frukt")
    expect(decoded).not.toContain("\uFFFD")
  })

  test("decodes UTF-8 bytes by default", () => {
    const bytes = new TextEncoder().encode(`<html><head><title>Vitaminer för män</title></head></html>`)
    const decoded = decodeHtmlBytes(bytes, "text/html; charset=utf-8")
    expect(decoded).toContain("för män")
  })

  test("falls back to UTF-8 when the declared charset is unknown", () => {
    const bytes = new TextEncoder().encode(`<html><head></head></html>`)
    const decoded = decodeHtmlBytes(bytes, "text/html; charset=nonsense-label")
    expect(decoded).toContain("<html>")
  })

  test("parseHtmlMeta reads Swedish OG tags after ISO-8859-1 decode", async () => {
    // Mimics svensktkosttillskott.se: charset in <meta http-equiv>, og tags with Latin-1 chars.
    const bytes = latin1Bytes(
      `<html><head>` +
        `<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">` +
        `<meta property="og:title" content="Core Vitamins Man | Multivitamin för män">` +
        `<meta property="og:description" content="I Core Vitamins Man får du bland annat vitamin C, zink och extrakt från frukt och bär.">` +
        `<meta property="og:site_name" content="Svenskt Kosttillskott">` +
        `</head></html>`
    )
    const html = decodeHtmlBytes(bytes, "text/html")
    const result = await parseHtmlMeta(html, "https://www.svensktkosttillskott.se/core-vitamins-man")
    expect(result.title).toBe("Core Vitamins Man | Multivitamin för män")
    expect(result.description).toBe(
      "I Core Vitamins Man får du bland annat vitamin C, zink och extrakt från frukt och bär."
    )
    expect(result.siteName).toBe("Svenskt Kosttillskott")
    expect(result.title).not.toContain("\uFFFD")
    expect(result.description).not.toContain("\uFFFD")
  })
})

describe("parseHtmlMeta", () => {
  const baseUrl = "https://example.com/page"

  test("extracts OpenGraph tags", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Test Title">
        <meta property="og:description" content="Test description text">
        <meta property="og:image" content="https://example.com/image.jpg">
        <meta property="og:site_name" content="Example Site">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result).toMatchObject({
      title: "Test Title",
      description: "Test description text",
      imageUrl: "https://example.com/image.jpg",
      siteName: "Example Site",
      contentType: "website",
      status: "completed",
    })
  })

  test("falls back to twitter:* tags", async () => {
    const html = `
      <html><head>
        <meta name="twitter:title" content="Twitter Title">
        <meta name="twitter:description" content="Twitter description">
        <meta name="twitter:image" content="https://example.com/tw.jpg">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result).toMatchObject({
      title: "Twitter Title",
      description: "Twitter description",
      imageUrl: "https://example.com/tw.jpg",
    })
  })

  test("falls back to <title> tag", async () => {
    const html = `
      <html><head>
        <title>Page Title</title>
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title).toBe("Page Title")
  })

  test("falls back to meta description", async () => {
    const html = `
      <html><head>
        <meta name="description" content="Meta description">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.description).toBe("Meta description")
  })

  test("resolves relative image URLs", async () => {
    const html = `
      <html><head>
        <meta property="og:image" content="/images/preview.jpg">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.imageUrl).toBe("https://example.com/images/preview.jpg")
  })

  test("extracts favicon from link tag", async () => {
    const html = `
      <html><head>
        <link rel="icon" href="/custom-favicon.png">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.faviconUrl).toBe("https://example.com/custom-favicon.png")
  })

  test("defaults favicon to /favicon.ico", async () => {
    const html = `<html><head></head></html>`
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.faviconUrl).toBe("https://example.com/favicon.ico")
  })

  test("handles apostrophes in double-quoted content attributes", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="McDonald's Restaurant Guide">
        <meta property="og:description" content="Tom's favorite spot">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title).toBe("McDonald's Restaurant Guide")
    expect(result.description).toBe("Tom's favorite spot")
  })

  test("handles double quotes in single-quoted content attributes", async () => {
    const html = `
      <html><head>
        <meta property='og:title' content='She said "hello"'>
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title).toBe('She said "hello"')
  })

  test("decodes HTML entities", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="Tom &amp; Jerry&#039;s &quot;Show&quot;">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title).toBe('Tom & Jerry\'s "Show"')
  })

  test("truncates long titles", async () => {
    const longTitle = "A".repeat(500)
    const html = `
      <html><head>
        <meta property="og:title" content="${longTitle}">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title!.length).toBe(300)
  })

  test("truncates long descriptions", async () => {
    const longDesc = "B".repeat(1000)
    const html = `
      <html><head>
        <meta property="og:description" content="${longDesc}">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.description!.length).toBe(500)
  })

  test("handles content before property in meta tag", async () => {
    const html = `
      <html><head>
        <meta content="Reversed Order" property="og:title">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title).toBe("Reversed Order")
  })

  test("falls back to URL-derived title/site when no metadata found", async () => {
    const html = `<html><head></head></html>`
    const result = await parseHtmlMeta(html, "https://news.example.com/articles/hello-world")
    expect(result.title).toBe("hello world")
    expect(result.description).toBeNull()
    expect(result.imageUrl).toBeNull()
    expect(result.siteName).toBe("news.example.com")
    expect(result.status).toBe("completed")
  })

  test("og:* tags take priority over twitter:* tags", async () => {
    const html = `
      <html><head>
        <meta property="og:title" content="OG Title">
        <meta name="twitter:title" content="Twitter Title">
        <meta property="og:description" content="OG Description">
        <meta name="twitter:description" content="Twitter Description">
      </head></html>
    `
    const result = await parseHtmlMeta(html, baseUrl)
    expect(result.title).toBe("OG Title")
    expect(result.description).toBe("OG Description")
  })
})

describe("extractOEmbedDescription", () => {
  test("extracts readable text from X/Twitter oEmbed blockquote HTML", () => {
    const html =
      '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">closing what&#39;s fixed was the pre-clean. <a href="https://t.co/YYNEbg7Q79">https://t.co/YYNEbg7Q79</a></p>&mdash; Peter</blockquote>'

    const description = extractOEmbedDescription(html)

    expect(description).toContain("closing what's fixed was the pre-clean.")
    expect(description).toContain("https://t.co/YYNEbg7Q79")
    expect(description).not.toContain("<a")
  })
})

/** Build a streaming text/html Response that yields the given chunks in order. */
function streamingHtmlResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
}

describe("createLinkPreviewWorker", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test("captures metadata streamed into <body> after </head> (Next.js App Router)", async () => {
    // Streaming-SSR frameworks emit a metadata-less <head> first, then stream the real
    // <title>/<meta og:*> into the body. The head closes in chunk 1; metadata arrives in chunk 2.
    const headChunk =
      `<html><head><link rel="preload" href="/_next/static/x.js"/>` +
      `<meta name="theme-color" content="#141413"/></head>` +
      `<body><header>nav</header><main>article body</main>`
    const metaChunk =
      `<title>Introducing Claude Opus 4.8 \\ Anthropic</title>` +
      `<meta name="description" content="Our latest model, Claude Opus 4.8, is an upgrade.">` +
      `<meta property="og:title" content="Introducing Claude Opus 4.8">` +
      `<meta property="og:description" content="Our latest model, Claude Opus 4.8, is an upgrade.">` +
      `<meta property="og:image" content="https://cdn.example.com/opus.jpg">` +
      `<meta property="og:site_name" content="Anthropic">` +
      `</body></html>`

    const fetchMock = mock(async () => streamingHtmlResponse([headChunk, metaChunk]))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const completePreviewsAndPublish = mock(async () => {})
    const worker = createLinkPreviewWorker({
      linkPreviewService: {
        extractAndCreatePending: mock(async () => [
          { id: "lp_900", url: "https://www.anthropic.com/news/claude-opus-4-8" },
        ]),
        getPreviewById: mock(async () => ({
          id: "lp_900",
          workspaceId: "ws_123",
          url: "https://www.anthropic.com/news/claude-opus-4-8",
          normalizedUrl: "https://www.anthropic.com/news/claude-opus-4-8",
          title: null,
          description: null,
          imageUrl: null,
          faviconUrl: null,
          siteName: null,
          contentType: "website",
          status: "pending",
          previewType: null,
          previewData: null,
          targetWorkspaceId: null,
          targetStreamId: null,
          targetMessageId: null,
          fetchedAt: null,
          expiresAt: null,
          createdAt: new Date("2026-05-29T10:00:00.000Z"),
        })),
        completePreviewsAndPublish,
        replacePreviewsForMessage: mock(async () => []),
        publishEmptyPreviews: mock(async () => {}),
      } as any,
      workspaceIntegrationService: {
        getGithubClient: mock(async () => null),
      } as any,
    })

    await worker({
      id: "job_900",
      name: "link_preview.extract",
      data: {
        workspaceId: "ws_123",
        streamId: "stream_123",
        messageId: "msg_900",
        contentMarkdown: "https://www.anthropic.com/news/claude-opus-4-8",
      },
    })

    expect(completePreviewsAndPublish).toHaveBeenCalledWith(
      "ws_123",
      "stream_123",
      "msg_900",
      [
        expect.objectContaining({
          id: "lp_900",
          skipped: false,
          overwrite: false,
          metadata: expect.objectContaining({
            title: "Introducing Claude Opus 4.8",
            description: "Our latest model, Claude Opus 4.8, is an upgrade.",
            imageUrl: "https://cdn.example.com/opus.jpg",
            siteName: "Anthropic",
            status: "completed",
          }),
        }),
      ],
      { forcePublish: undefined }
    )
  })

  test("keeps existing rich GitHub previews when refresh falls back from GitHub", async () => {
    const fetchMock = mock(async () => {
      throw new Error("generic fetch should not run when rich preview data already exists")
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const completePreviewsAndPublish = mock(async () => {})
    const worker = createLinkPreviewWorker({
      linkPreviewService: {
        extractAndCreatePending: mock(async () => [
          { id: "lp_123", url: "https://github.com/octocat/hello-world/pull/42" },
        ]),
        getPreviewById: mock(async () => ({
          id: "lp_123",
          workspaceId: "ws_123",
          url: "https://github.com/octocat/hello-world/pull/42",
          normalizedUrl: "https://github.com/octocat/hello-world/pull/42",
          title: "PR #42: Ship the thing",
          description: "Open",
          imageUrl: null,
          faviconUrl: "https://github.com/favicon.ico",
          siteName: "GitHub",
          contentType: "website",
          status: "completed",
          previewType: GitHubPreviewTypes.PR,
          previewData: {
            type: GitHubPreviewTypes.PR,
            url: "https://github.com/octocat/hello-world/pull/42",
            repository: {
              owner: "octocat",
              name: "hello-world",
              fullName: "octocat/hello-world",
              private: true,
            },
            data: {
              title: "Ship the thing",
              number: 42,
              state: "open",
              author: { login: "kris", avatarUrl: null },
              baseBranch: "main",
              headBranch: "feature",
              additions: 1,
              deletions: 1,
              reviewStatusSummary: {
                approvals: 0,
                changesRequested: 0,
                comments: 0,
                pendingReviewers: 0,
              },
              createdAt: "2026-04-07T10:00:00.000Z",
              updatedAt: "2026-04-07T10:00:00.000Z",
            },
            fetchedAt: "2026-04-07T10:00:00.000Z",
          },
          targetWorkspaceId: null,
          targetStreamId: null,
          targetMessageId: null,
          fetchedAt: new Date("2026-04-07T10:00:00.000Z"),
          expiresAt: new Date("2026-04-07T10:05:00.000Z"),
          createdAt: new Date("2026-04-07T10:00:00.000Z"),
        })),
        completePreviewsAndPublish,
        replacePreviewsForMessage: mock(async () => []),
        publishEmptyPreviews: mock(async () => {}),
      } as any,
      workspaceIntegrationService: {
        getGithubClient: mock(async () => null),
      } as any,
    })

    await worker({
      id: "job_123",
      name: "link_preview.extract",
      data: {
        workspaceId: "ws_123",
        streamId: "stream_123",
        messageId: "msg_123",
        contentMarkdown: "https://github.com/octocat/hello-world/pull/42",
      },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(completePreviewsAndPublish).toHaveBeenCalledWith(
      "ws_123",
      "stream_123",
      "msg_123",
      [{ id: "lp_123", skipped: true }],
      { forcePublish: undefined }
    )
  })

  test("upgrades cached generic GitHub previews to rich previews when integration is available", async () => {
    const completePreviewsAndPublish = mock(async () => {})
    const worker = createLinkPreviewWorker({
      linkPreviewService: {
        extractAndCreatePending: mock(async () => [
          { id: "lp_123", url: "https://github.com/octocat/hello-world/tree/main" },
        ]),
        getPreviewById: mock(async () => ({
          id: "lp_123",
          workspaceId: "ws_123",
          url: "https://github.com/octocat/hello-world/tree/main",
          normalizedUrl: "https://github.com/octocat/hello-world/tree/main",
          title: "Build software better, together",
          description: "Generic GitHub OGP",
          imageUrl: "https://github.com/image.png",
          faviconUrl: "https://github.com/favicon.ico",
          siteName: "GitHub",
          contentType: "website",
          status: "completed",
          previewType: null,
          previewData: null,
          targetWorkspaceId: null,
          targetStreamId: null,
          targetMessageId: null,
          fetchedAt: new Date("2026-04-07T10:00:00.000Z"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          createdAt: new Date("2026-04-07T10:00:00.000Z"),
        })),
        completePreviewsAndPublish,
        replacePreviewsForMessage: mock(async () => []),
        publishEmptyPreviews: mock(async () => {}),
      } as any,
      workspaceIntegrationService: {
        getGithubClient: mock(async () => ({
          async request(route: string, params?: Record<string, unknown>) {
            if (route === "GET /repos/{owner}/{repo}") {
              return {
                owner: { login: "octocat" },
                name: "hello-world",
                full_name: "octocat/hello-world",
                private: true,
              }
            }

            if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
              if (params?.path === "README.md" && params?.ref === "main") {
                return {
                  type: "file",
                  content: Buffer.from("# Hello\nworld").toString("base64"),
                }
              }
            }

            throw new Error(`Unexpected route: ${route}`)
          },
        })),
      } as any,
    })

    await worker({
      id: "job_123",
      name: "link_preview.extract",
      data: {
        workspaceId: "ws_123",
        streamId: "stream_123",
        messageId: "msg_123",
        contentMarkdown: "https://github.com/octocat/hello-world/tree/main",
      },
    })

    expect(completePreviewsAndPublish).toHaveBeenCalledWith(
      "ws_123",
      "stream_123",
      "msg_123",
      [
        expect.objectContaining({
          id: "lp_123",
          skipped: false,
          overwrite: true,
          metadata: expect.objectContaining({
            previewType: GitHubPreviewTypes.FILE,
            title: "README.md",
          }),
        }),
      ],
      { forcePublish: undefined }
    )
  })

  test("enriches X oEmbed previews with page image metadata when thumbnail is missing", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()

      if (url.startsWith("https://publish.twitter.com/oembed")) {
        return new Response(
          JSON.stringify({
            provider_name: "Twitter",
            author_name: "Peter Steinberger",
            html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">tweet text</p></blockquote>',
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }

      if (url.startsWith("https://x.com/steipete/status/2047957234664030380")) {
        const headers = new Headers(init?.headers)
        expect(headers.get("User-Agent")).toBe("Twitterbot/1.0")
        return new Response(
          '<html><head><meta name="twitter:image" content="https://pbs.twimg.com/media/abc123.jpg"></head></html>',
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        )
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const completePreviewsAndPublish = mock(async () => {})
    const worker = createLinkPreviewWorker({
      linkPreviewService: {
        extractAndCreatePending: mock(async () => [
          { id: "lp_123", url: "https://x.com/steipete/status/2047957234664030380" },
        ]),
        getPreviewById: mock(async () => ({
          id: "lp_123",
          workspaceId: "ws_123",
          url: "https://x.com/steipete/status/2047957234664030380",
          normalizedUrl: "https://x.com/steipete/status/2047957234664030380",
          title: null,
          description: null,
          imageUrl: null,
          faviconUrl: null,
          siteName: null,
          contentType: "website",
          status: "pending",
          previewType: null,
          previewData: null,
          targetWorkspaceId: null,
          targetStreamId: null,
          targetMessageId: null,
          fetchedAt: null,
          expiresAt: null,
          createdAt: new Date("2026-04-25T10:00:00.000Z"),
        })),
        completePreviewsAndPublish,
        replacePreviewsForMessage: mock(async () => []),
        publishEmptyPreviews: mock(async () => {}),
      } as any,
      workspaceIntegrationService: {
        getGithubClient: mock(async () => null),
      } as any,
    })

    await worker({
      id: "job_123",
      name: "link_preview.extract",
      data: {
        workspaceId: "ws_123",
        streamId: "stream_123",
        messageId: "msg_123",
        contentMarkdown: "https://x.com/steipete/status/2047957234664030380",
      },
    })

    expect(completePreviewsAndPublish).toHaveBeenCalledWith(
      "ws_123",
      "stream_123",
      "msg_123",
      [
        expect.objectContaining({
          id: "lp_123",
          skipped: false,
          overwrite: false,
          metadata: expect.objectContaining({
            title: "Peter Steinberger",
            description: "tweet text",
            imageUrl: "https://pbs.twimg.com/media/abc123.jpg",
            siteName: "Twitter",
            status: "completed",
          }),
        }),
      ],
      { forcePublish: undefined }
    )
  })

  test("uses media links from oEmbed HTML when canonical tweet page has no image metadata", async () => {
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()

      if (url.startsWith("https://publish.twitter.com/oembed")) {
        return new Response(
          JSON.stringify({
            provider_name: "Twitter",
            author_name: "Tran Mau Tri Tam",
            html: '<blockquote class="twitter-tweet"><p>Paste a URL. <a href="https://t.co/DwmswUYWSP">pic.twitter.com/DwmswUYWSP</a></p></blockquote>',
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }

      if (url.startsWith("https://x.com/tranmautritam/status/2047744367549612456")) {
        const headers = new Headers(init?.headers)
        expect(headers.get("User-Agent")).toBe("Twitterbot/1.0")
        return new Response("<html><head><title>tweet page</title></head></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }

      if (url.startsWith("https://t.co/DwmswUYWSP")) {
        return new Response(
          '<html><head><meta property="og:image" content="https://pbs.twimg.com/amplify_video_thumb/example.jpg:large"></head></html>',
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        )
      }

      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const completePreviewsAndPublish = mock(async () => {})
    const worker = createLinkPreviewWorker({
      linkPreviewService: {
        extractAndCreatePending: mock(async () => [
          { id: "lp_124", url: "https://x.com/tranmautritam/status/2047744367549612456" },
        ]),
        getPreviewById: mock(async () => ({
          id: "lp_124",
          workspaceId: "ws_123",
          url: "https://x.com/tranmautritam/status/2047744367549612456",
          normalizedUrl: "https://x.com/tranmautritam/status/2047744367549612456",
          title: null,
          description: null,
          imageUrl: null,
          faviconUrl: null,
          siteName: null,
          contentType: "website",
          status: "pending",
          previewType: null,
          previewData: null,
          targetWorkspaceId: null,
          targetStreamId: null,
          targetMessageId: null,
          fetchedAt: null,
          expiresAt: null,
          createdAt: new Date("2026-04-25T10:00:00.000Z"),
        })),
        completePreviewsAndPublish,
        replacePreviewsForMessage: mock(async () => []),
        publishEmptyPreviews: mock(async () => {}),
      } as any,
      workspaceIntegrationService: {
        getGithubClient: mock(async () => null),
      } as any,
    })

    await worker({
      id: "job_124",
      name: "link_preview.extract",
      data: {
        workspaceId: "ws_123",
        streamId: "stream_123",
        messageId: "msg_124",
        contentMarkdown: "https://x.com/tranmautritam/status/2047744367549612456",
      },
    })

    expect(completePreviewsAndPublish).toHaveBeenCalledWith(
      "ws_123",
      "stream_123",
      "msg_124",
      [
        expect.objectContaining({
          id: "lp_124",
          skipped: false,
          overwrite: false,
          metadata: expect.objectContaining({
            title: "Tran Mau Tri Tam",
            imageUrl: "https://pbs.twimg.com/amplify_video_thumb/example.jpg:large",
            siteName: "Twitter",
            status: "completed",
          }),
        }),
      ],
      { forcePublish: undefined }
    )
  })
})
