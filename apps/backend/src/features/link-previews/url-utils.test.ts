import { describe, test, expect } from "bun:test"
import {
  normalizeUrl,
  extractUrls,
  detectContentType,
  isBlockedUrl,
  parseMessagePermalink,
  parseGitHubUrl,
  parseLinearUrl,
} from "./url-utils"

describe("normalizeUrl", () => {
  test("lowercases hostname", () => {
    expect(normalizeUrl("https://Example.COM/path")).toBe("https://example.com/path")
  })

  test("strips tracking parameters", () => {
    expect(normalizeUrl("https://example.com/page?utm_source=twitter&utm_medium=social&key=val")).toBe(
      "https://example.com/page?key=val"
    )
  })

  test("strips all tracking params when no other params remain", () => {
    expect(normalizeUrl("https://example.com/page?fbclid=abc&gclid=def")).toBe("https://example.com/page")
  })

  test("removes trailing slash from pathname", () => {
    expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path")
  })

  test("keeps root slash", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/")
  })

  test("removes default HTTPS port", () => {
    expect(normalizeUrl("https://example.com:443/path")).toBe("https://example.com/path")
  })

  test("removes default HTTP port", () => {
    expect(normalizeUrl("http://example.com:80/path")).toBe("http://example.com/path")
  })

  test("keeps non-default ports", () => {
    expect(normalizeUrl("https://example.com:8080/path")).toBe("https://example.com:8080/path")
  })

  test("removes fragment", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page")
  })

  test("preserves GitHub issue comment fragments", () => {
    expect(normalizeUrl("https://github.com/octocat/hello-world/issues/1#issuecomment-42")).toBe(
      "https://github.com/octocat/hello-world/issues/1#issuecomment-42"
    )
  })

  test("preserves GitHub file line ranges", () => {
    expect(normalizeUrl("https://github.com/octocat/hello-world/blob/main/src/app.ts#L14-L17")).toBe(
      "https://github.com/octocat/hello-world/blob/main/src/app.ts#L14-L17"
    )
  })

  test("normalizes GitHub file column anchors down to line ranges", () => {
    expect(normalizeUrl("https://github.com/octocat/hello-world/blob/main/src/app.ts#L14C2-L17C9")).toBe(
      "https://github.com/octocat/hello-world/blob/main/src/app.ts#L14-L17"
    )
    expect(normalizeUrl("https://github.com/octocat/hello-world/blob/main/src/app.ts#L14C2")).toBe(
      "https://github.com/octocat/hello-world/blob/main/src/app.ts#L14"
    )
  })

  test("preserves GitHub pull request diff anchors", () => {
    expect(
      normalizeUrl(
        "https://github.com/octocat/hello-world/pull/12/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R8-R10"
      )
    ).toBe(
      "https://github.com/octocat/hello-world/pull/12/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R8-R10"
    )
  })

  test("sorts remaining query params", () => {
    expect(normalizeUrl("https://example.com/page?z=1&a=2")).toBe("https://example.com/page?a=2&z=1")
  })

  test("returns lowercased input for invalid URLs", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url")
  })
})

describe("extractUrls", () => {
  test("extracts URLs from markdown links", () => {
    const md = "Check out [Google](https://google.com) and [GitHub](https://github.com)"
    expect(extractUrls(md)).toEqual(["https://google.com", "https://github.com"])
  })

  test("extracts markdown links with parentheses in URL", () => {
    const md = "[Wikipedia](https://en.wikipedia.org/wiki/Foo_(bar))"
    expect(extractUrls(md)).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"])
  })

  test("extracts bare URLs", () => {
    const md = "Visit https://example.com for more info"
    expect(extractUrls(md)).toEqual(["https://example.com"])
  })

  test("handles bare URLs with balanced parentheses (Wikipedia-style)", () => {
    const md = "See https://en.wikipedia.org/wiki/Foo_(bar) for details"
    expect(extractUrls(md)).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"])
  })

  test("strips unbalanced trailing paren from bare URL in prose", () => {
    const md = "(see https://example.com/page)"
    expect(extractUrls(md)).toEqual(["https://example.com/page"])
  })

  test("handles nested balanced parens in bare URLs", () => {
    const md = "Check https://en.wikipedia.org/wiki/Foo_(bar_(baz)) now"
    expect(extractUrls(md)).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar_(baz))"])
  })

  test("deduplicates by normalized URL", () => {
    const md = "Check [link](https://example.com/page?utm_source=twitter) and https://example.com/page"
    expect(extractUrls(md)).toEqual(["https://example.com/page?utm_source=twitter"])
  })

  test("skips attachment: links", () => {
    const md = "[file](attachment:abc123)"
    expect(extractUrls(md)).toEqual([])
  })

  test("skips mailto: and tel: links", () => {
    const md = "[email](mailto:foo@bar.com) [phone](tel:123)"
    expect(extractUrls(md)).toEqual([])
  })

  test("skips relative paths", () => {
    const md = "[local](/path/to/page)"
    expect(extractUrls(md)).toEqual([])
  })

  test("returns empty for no URLs", () => {
    expect(extractUrls("just plain text")).toEqual([])
  })

  test("handles mixed content", () => {
    const md = `
# Title
Some text with [a link](https://example.com/article) and more text.
Also see https://docs.example.com/guide for details.
[file](attachment:file_123)
    `
    expect(extractUrls(md)).toEqual(["https://example.com/article", "https://docs.example.com/guide"])
  })
})

describe("detectContentType", () => {
  test("detects image extensions", () => {
    expect(detectContentType("https://example.com/photo.jpg")).toBe("image")
    expect(detectContentType("https://example.com/photo.png")).toBe("image")
    expect(detectContentType("https://example.com/photo.gif")).toBe("image")
    expect(detectContentType("https://example.com/photo.webp")).toBe("image")
    expect(detectContentType("https://example.com/photo.svg")).toBe("image")
    expect(detectContentType("https://example.com/photo.avif")).toBe("image")
  })

  test("detects PDF", () => {
    expect(detectContentType("https://example.com/document.pdf")).toBe("pdf")
  })

  test("returns website for HTML and unknown extensions", () => {
    expect(detectContentType("https://example.com/page.html")).toBe("website")
    expect(detectContentType("https://example.com/page")).toBe("website")
    expect(detectContentType("https://example.com/")).toBe("website")
  })

  test("is case-insensitive", () => {
    expect(detectContentType("https://example.com/Photo.JPG")).toBe("image")
    expect(detectContentType("https://example.com/Doc.PDF")).toBe("pdf")
  })

  test("returns website for invalid URLs", () => {
    expect(detectContentType("not-a-url")).toBe("website")
  })
})

describe("isBlockedUrl", () => {
  test("blocks localhost", () => {
    expect(isBlockedUrl("http://localhost/admin")).toBe(true)
    expect(isBlockedUrl("http://localhost:8080/api")).toBe(true)
  })

  test("blocks loopback IPs", () => {
    expect(isBlockedUrl("http://127.0.0.1/")).toBe(true)
    expect(isBlockedUrl("http://127.0.0.1:3000/api")).toBe(true)
  })

  test("blocks private class A (10.x)", () => {
    expect(isBlockedUrl("http://10.0.0.1/internal")).toBe(true)
    expect(isBlockedUrl("http://10.255.255.255/")).toBe(true)
  })

  test("blocks private class B (172.16-31.x)", () => {
    expect(isBlockedUrl("http://172.16.0.1/")).toBe(true)
    expect(isBlockedUrl("http://172.31.255.255/")).toBe(true)
  })

  test("does not block non-private 172.x", () => {
    expect(isBlockedUrl("http://172.15.0.1/")).toBe(false)
    expect(isBlockedUrl("http://172.32.0.1/")).toBe(false)
  })

  test("blocks private class C (192.168.x)", () => {
    expect(isBlockedUrl("http://192.168.1.1/")).toBe(true)
  })

  test("blocks link-local (169.254.x)", () => {
    expect(isBlockedUrl("http://169.254.169.254/latest/meta-data/")).toBe(true)
  })

  test("blocks cloud metadata hostnames", () => {
    expect(isBlockedUrl("http://metadata.google.internal/")).toBe(true)
  })

  test("allows public URLs", () => {
    expect(isBlockedUrl("https://example.com/page")).toBe(false)
    expect(isBlockedUrl("https://github.com/user/repo")).toBe(false)
    expect(isBlockedUrl("https://en.wikipedia.org/wiki/Article")).toBe(false)
  })

  test("blocks unparseable URLs", () => {
    expect(isBlockedUrl("not-a-url")).toBe(true)
  })
})

describe("extractUrls SSRF filtering", () => {
  test("filters out private/internal URLs", () => {
    const md = "Check http://127.0.0.1:3000/admin and https://example.com/page"
    expect(extractUrls(md)).toEqual(["https://example.com/page"])
  })

  test("filters out localhost URLs", () => {
    const md = "[internal](http://localhost:8080/api) and [external](https://example.com)"
    expect(extractUrls(md)).toEqual(["https://example.com"])
  })

  test("filters out cloud metadata URLs", () => {
    const md = "See http://169.254.169.254/latest/meta-data/"
    expect(extractUrls(md)).toEqual([])
  })

  test("allows known app origins to bypass SSRF check", () => {
    const md = "See http://localhost:5173/w/ws_123/s/stream_456?m=msg_789"
    expect(extractUrls(md)).toEqual([])
    expect(extractUrls(md, ["http://localhost:5173"])).toEqual([
      "http://localhost:5173/w/ws_123/s/stream_456?m=msg_789",
    ])
  })
})

describe("parseMessagePermalink", () => {
  const origins = ["https://app.threa.io", "http://localhost:5173"]

  test("parses valid message permalink", () => {
    expect(parseMessagePermalink("https://app.threa.io/w/ws_123/s/stream_456?m=msg_789", origins)).toEqual({
      workspaceId: "ws_123",
      streamId: "stream_456",
      messageId: "msg_789",
    })
  })

  test("parses localhost permalink", () => {
    expect(parseMessagePermalink("http://localhost:5173/w/ws_abc/s/stream_def?m=msg_ghi", origins)).toEqual({
      workspaceId: "ws_abc",
      streamId: "stream_def",
      messageId: "msg_ghi",
    })
  })

  test("returns null for unrecognized origin", () => {
    expect(parseMessagePermalink("https://evil.com/w/ws_123/s/stream_456?m=msg_789", origins)).toBeNull()
  })

  test("returns null when missing message ID param", () => {
    expect(parseMessagePermalink("https://app.threa.io/w/ws_123/s/stream_456", origins)).toBeNull()
  })

  test("returns null for non-stream paths", () => {
    expect(parseMessagePermalink("https://app.threa.io/w/ws_123/drafts?m=msg_789", origins)).toBeNull()
  })

  test("returns null for invalid URL", () => {
    expect(parseMessagePermalink("not-a-url", origins)).toBeNull()
  })
})

describe("parseGitHubUrl", () => {
  test("parses pull request URLs", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world/pull/12")).toEqual({
      type: "github_pr",
      owner: "octocat",
      repo: "hello-world",
      number: 12,
    })
  })

  test("parses issue comment URLs", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world/issues/34#issuecomment-5678")).toEqual({
      type: "github_comment",
      owner: "octocat",
      repo: "hello-world",
      commentId: 5678,
      parentType: "issue",
      number: 34,
    })
  })

  test("parses pull request diff URLs with highlighted right-side ranges", () => {
    expect(
      parseGitHubUrl(
        "https://github.com/octocat/hello-world/pull/12/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R8-R10"
      )
    ).toEqual({
      type: "github_diff",
      owner: "octocat",
      repo: "hello-world",
      number: 12,
      diffPathHash: "b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5",
      anchorSide: "right",
      anchorStartLine: 8,
      anchorEndLine: 10,
    })
  })

  test("parses blob URLs with line ranges", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world/blob/main/src/app.ts#L10-L12")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "blob",
      blobPath: "main/src/app.ts",
      lineStart: 10,
      lineEnd: 12,
    })
  })

  test("parses blob URLs with query params and line ranges", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world/blob/main/README.md?plain=1#L1-L2")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "blob",
      blobPath: "main/README.md",
      lineStart: 1,
      lineEnd: 2,
    })
  })

  test("parses blob URLs with column anchors as line ranges", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world/blob/main/README.md?plain=1#L2-L4C1")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "blob",
      blobPath: "main/README.md",
      lineStart: 2,
      lineEnd: 4,
    })

    expect(parseGitHubUrl("https://github.com/octocat/hello-world/blob/main/README.md?plain=1#L2C1-L4C7")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "blob",
      blobPath: "main/README.md",
      lineStart: 2,
      lineEnd: 4,
    })

    expect(parseGitHubUrl("https://github.com/octocat/hello-world/blob/main/README.md?plain=1#L4C1")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "blob",
      blobPath: "main/README.md",
      lineStart: 4,
      lineEnd: 4,
    })
  })

  test("parses tree URLs as README file previews", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world/tree/main")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "tree",
      blobPath: "main/README.md",
      lineStart: null,
      lineEnd: null,
    })
  })

  test("parses repository root URLs as README previews", () => {
    expect(parseGitHubUrl("https://github.com/octocat/hello-world")).toEqual({
      type: "github_file",
      owner: "octocat",
      repo: "hello-world",
      source: "repo",
      blobPath: "README.md",
      lineStart: null,
      lineEnd: null,
    })
  })

  test("returns null for non-GitHub URLs", () => {
    expect(parseGitHubUrl("https://example.com/octocat/hello-world/pull/12")).toBeNull()
  })
})

describe("parseLinearUrl", () => {
  test("parses issue URLs with a slug suffix", () => {
    expect(parseLinearUrl("https://linear.app/threa/issue/ENG-123/some-title")).toEqual({
      type: "linear_issue",
      workspaceSlug: "threa",
      identifier: "ENG-123",
    })
  })

  test("parses issue URLs without a slug suffix", () => {
    expect(parseLinearUrl("https://linear.app/threa/issue/ENG-123")).toEqual({
      type: "linear_issue",
      workspaceSlug: "threa",
      identifier: "ENG-123",
    })
  })

  test("upcases lowercase team keys into a canonical identifier", () => {
    expect(parseLinearUrl("https://linear.app/threa/issue/eng-123")).toEqual({
      type: "linear_issue",
      workspaceSlug: "threa",
      identifier: "ENG-123",
    })
  })

  test("parses comment fragments into a comment match carrying the parent identifier", () => {
    expect(
      parseLinearUrl("https://linear.app/threa/issue/ENG-123/title#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    ).toEqual({
      type: "linear_comment",
      workspaceSlug: "threa",
      identifier: "ENG-123",
      commentId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    })
  })

  test("parses project URLs with trailing slug-id", () => {
    expect(parseLinearUrl("https://linear.app/threa/project/ship-the-thing-abc123")).toEqual({
      type: "linear_project",
      workspaceSlug: "threa",
      slugId: "ship-the-thing-abc123",
    })
  })

  test("discards trailing overview/updates segments on project URLs", () => {
    expect(parseLinearUrl("https://linear.app/threa/project/ship-the-thing-abc123/overview")).toEqual({
      type: "linear_project",
      workspaceSlug: "threa",
      slugId: "ship-the-thing-abc123",
    })
  })

  test("parses document URLs", () => {
    expect(parseLinearUrl("https://linear.app/threa/document/design-doc-xyz789")).toEqual({
      type: "linear_document",
      workspaceSlug: "threa",
      slugId: "design-doc-xyz789",
    })
  })

  test("returns null for unknown kinds", () => {
    expect(parseLinearUrl("https://linear.app/threa/team/eng")).toBeNull()
  })

  test("returns null for invalid identifiers", () => {
    expect(parseLinearUrl("https://linear.app/threa/issue/not-an-identifier")).toBeNull()
  })

  test("returns null for non-Linear URLs", () => {
    expect(parseLinearUrl("https://example.com/threa/issue/ENG-123")).toBeNull()
  })
})

describe("normalizeUrl — Linear fragments", () => {
  test("preserves comment fragment on Linear issue URLs", () => {
    const normalized = normalizeUrl(
      "https://linear.app/threa/issue/ENG-123/title#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    )
    expect(normalized).toContain("#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890")
  })

  test("strips non-comment fragments from Linear URLs", () => {
    const normalized = normalizeUrl("https://linear.app/threa/issue/ENG-123/title#section")
    expect(normalized).not.toContain("#section")
  })
})
