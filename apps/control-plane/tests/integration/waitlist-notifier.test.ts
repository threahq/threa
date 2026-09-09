import { afterEach, describe, expect, test } from "bun:test"
import { ThreaWaitlistNotifier } from "../../src/features/waitlist"

/**
 * ThreaWaitlistNotifier against a real HTTP server rather than a stubbed fetch,
 * so the assertions cover what actually goes over the wire: the message path
 * built from the configured ids, the bearer header, and the row-keyed
 * clientMessageId the backend dedupes on.
 */
describe("ThreaWaitlistNotifier", () => {
  let server: ReturnType<typeof Bun.serve> | null = null

  afterEach(async () => {
    await server?.stop(true)
    server = null
  })

  function startServer(handler: (req: Request, body: unknown) => Response) {
    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>
        requests.push({ url: new URL(req.url).pathname, auth: req.headers.get("authorization"), body })
        return handler(req, body)
      },
    })
    const notifier = new ThreaWaitlistNotifier({
      apiBaseUrl: `http://localhost:${server.port}/`,
      apiKey: "bot_key_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
    })
    return { notifier, requests }
  }

  test("posts the signup to the configured stream with a row-keyed clientMessageId", async () => {
    const { notifier, requests } = startServer(() => Response.json({ ok: true }))

    await notifier.notifySignup({ id: "wl_1", email: "new@example.com", source: "home" })

    expect(requests).toEqual([
      {
        url: "/api/v1/workspaces/ws_1/streams/stream_1/messages",
        auth: "Bearer bot_key_1",
        body: {
          content: "**New waitlist signup**\n\n`new@example.com` · from `home`",
          clientMessageId: "waitlist:wl_1",
          metadata: { source: "waitlist", "waitlist.id": "wl_1", "waitlist.source": "home" },
        },
      },
    ])
  })

  test("omits the source from the message and metadata when there is none", async () => {
    const { notifier, requests } = startServer(() => Response.json({ ok: true }))

    await notifier.notifySignup({ id: "wl_2", email: "new@example.com", source: null })

    expect(requests[0].body).toEqual({
      content: "**New waitlist signup**\n\n`new@example.com`",
      clientMessageId: "waitlist:wl_2",
      metadata: { source: "waitlist", "waitlist.id": "wl_2" },
    })
  })

  test("throws with the status and body when the API rejects the post", async () => {
    const { notifier } = startServer(() => new Response("forbidden", { status: 403 }))

    const promise = notifier.notifySignup({ id: "wl_3", email: "new@example.com", source: "home" })

    await expect(promise).rejects.toThrow("Threa API returned 403: forbidden")
  })
})
