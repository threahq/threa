import { createHash } from "node:crypto"
import { describe, expect, mock, test } from "bun:test"
import { createLinkPreviewHandlers } from "./handlers"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])
const ETAG = `"${createHash("sha256").update(PNG).digest("base64url")}"`

function createResponse() {
  const res: any = { headers: {} as Record<string, string> }
  res.set = (name: string, value: string) => {
    res.headers[name] = value
    return res
  }
  res.status = (code: number) => {
    res.statusCode = code
    return res
  }
  res.json = (body: unknown) => {
    res.body = body
    return res
  }
  res.send = (body: unknown) => {
    res.body = body
    return res
  }
  res.end = () => res
  return res
}

function handlersWith(icon: { contentType: string; bytes: Uint8Array } | null) {
  const getIcon = mock(async (_workspaceId: string, _host: string) => icon)
  const handlers = createLinkPreviewHandlers({
    linkPreviewService: {} as any,
    linkFaviconService: { getIcon } as any,
  })
  return { handlers, getIcon }
}

async function call(
  handlers: ReturnType<typeof createLinkPreviewHandlers>,
  host: string,
  headers: Record<string, string> = {}
) {
  const res = createResponse()
  const next = mock(() => {})
  await handlers.getFavicon({ params: { workspaceId: "ws_1", host }, headers } as any, res, next)
  return { res, next }
}

describe("getFavicon handler", () => {
  test("should serve the bytes with cache and safety headers when an icon is stored", async () => {
    const { handlers, getIcon } = handlersWith({ contentType: "image/png", bytes: PNG })
    const { res } = await call(handlers, "example.com:8443")

    expect({
      lookup: getIcon.mock.calls,
      status: res.statusCode,
      headers: res.headers,
      body: Array.from(res.body as Buffer),
    }).toEqual({
      lookup: [["ws_1", "example.com:8443"]],
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=604800",
        ETag: ETAG,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Content-Type": "image/png",
      },
      body: Array.from(PNG),
    })
  })

  test("should answer 304 when If-None-Match matches the ETag", async () => {
    const { handlers } = handlersWith({ contentType: "image/png", bytes: PNG })
    const { res } = await call(handlers, "example.com", { "if-none-match": ETAG })

    expect({ status: res.statusCode, body: res.body }).toEqual({ status: 304, body: undefined })
  })

  test("should answer 404 with a short cache when no icon is stored", async () => {
    const { handlers } = handlersWith(null)
    const { res } = await call(handlers, "example.com")

    expect({ status: res.statusCode, body: res.body, headers: res.headers }).toEqual({
      status: 404,
      body: { error: "Not found" },
      headers: { "Cache-Control": "private, max-age=300" },
    })
  })

  test("should look up the bracketed host when the link points at an IPv6 literal", async () => {
    const { handlers, getIcon } = handlersWith({ contentType: "image/png", bytes: PNG })
    const { res } = await call(handlers, "[2001:4860::8888]:8080")

    expect({ lookup: getIcon.mock.calls, status: res.statusCode }).toEqual({
      lookup: [["ws_1", "[2001:4860::8888]:8080"]],
      status: 200,
    })
  })

  test("should reject with 400 when the host is not a hostname", async () => {
    const { handlers, getIcon } = handlersWith(null)
    const { next } = await call(handlers, "evil.com/../x")

    const err = (next.mock.calls[0] as unknown[])[0] as { status: number; code: string }
    expect({ status: err.status, code: err.code, lookups: getIcon.mock.calls.length }).toEqual({
      status: 400,
      code: "VALIDATION_ERROR",
      lookups: 0,
    })
  })
})
