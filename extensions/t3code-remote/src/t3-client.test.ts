import { describe, expect, test } from "bun:test"
import { T3AuthError } from "./auth"
import { T3Client, T3ToolError, type T3TokenSource } from "./t3-client"

interface Seen {
  method: string
  token: string
  session: string | null
}

function fakeServer(answer: (method: string, seen: Seen, count: number) => Response | undefined) {
  const seen: Seen[] = []
  const fetch = async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    const { method, id } = JSON.parse(String(init.body)) as { method: string; id?: number }
    const entry = {
      method,
      token: headers.authorization!.replace("Bearer ", ""),
      session: headers["mcp-session-id"] ?? null,
    }
    seen.push(entry)
    const custom = answer(method, entry, seen.filter((candidate) => candidate.method === method).length)
    if (custom) return custom
    if (method === "initialize")
      return Response.json({ jsonrpc: "2.0", id, result: {} }, { headers: { "mcp-session-id": `sess_${seen.length}` } })
    if (method === "notifications/initialized") return new Response(null, { status: 202 })
    return sse({
      jsonrpc: "2.0",
      id,
      result: { structuredContent: { runId: "run_1", status: "completed", timedOut: false } },
    })
  }
  return { fetch, seen }
}

function sse(message: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function tokens(renewed = "tok_new"): T3TokenSource & { renewals: number } {
  let current = "tok_old"
  const source = {
    renewals: 0,
    token: async () => current,
    renew: async () => {
      source.renewals += 1
      current = renewed
      return current
    },
  }
  return source
}

const WAIT = { threadId: "thread_1", runId: "run_1", timeoutMs: 10 }

describe("T3Client", () => {
  test("opens one session and reads an SSE tool result", async () => {
    const server = fakeServer(() => undefined)
    const client = new T3Client("http://t3.test", tokens(), server.fetch)

    expect(await client.call("t3_thread_wait", WAIT)).toEqual({ runId: "run_1", status: "completed", timedOut: false })
    await client.call("t3_thread_wait", WAIT)

    expect(server.seen.map(({ method, session }) => [method, session])).toEqual([
      ["initialize", null],
      ["notifications/initialized", "sess_1"],
      ["tools/call", "sess_1"],
      ["tools/call", "sess_1"],
    ])
  })

  test("a tool error carries the orchestrator's code", async () => {
    const server = fakeServer((method) =>
      method === "tools/call"
        ? Response.json({
            jsonrpc: "2.0",
            id: 3,
            result: {
              isError: true,
              content: [{ text: JSON.stringify({ code: "thread_not_sendable", message: "busy" }) }],
            },
          })
        : undefined
    )
    const client = new T3Client("http://t3.test", tokens(), server.fetch)

    const error = await client.call("t3_thread_wait", WAIT).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(T3ToolError)
    expect({ code: (error as T3ToolError).code, message: (error as Error).message }).toEqual({
      code: "thread_not_sendable",
      message: "T3 Code t3_thread_wait failed: busy",
    })
  })

  test("renews the token once on a 401 and retries", async () => {
    const server = fakeServer((_method, seen) =>
      seen.token === "tok_old" ? new Response("", { status: 401 }) : undefined
    )
    const auth = tokens()
    const client = new T3Client("http://t3.test", auth, server.fetch)

    await client.call("t3_thread_wait", WAIT)

    expect(auth.renewals).toBe(1)
    expect(server.seen.map(({ method, token }) => [method, token])).toEqual([
      ["initialize", "tok_old"],
      ["initialize", "tok_new"],
      ["notifications/initialized", "tok_new"],
      ["tools/call", "tok_new"],
    ])
  })

  test("a token rejected after renewal is an auth error", async () => {
    const server = fakeServer(() => new Response("", { status: 401 }))
    const client = new T3Client("http://t3.test", tokens(), server.fetch)

    await expect(client.call("t3_thread_wait", WAIT)).rejects.toBeInstanceOf(T3AuthError)
  })

  test("re-opens a session the server dropped and retries the call", async () => {
    const server = fakeServer((method, _seen, count) =>
      method === "tools/call" && count === 2 ? new Response("", { status: 404 }) : undefined
    )
    const client = new T3Client("http://t3.test", tokens(), server.fetch)

    await client.call("t3_thread_wait", WAIT)
    await client.call("t3_thread_wait", WAIT)

    expect(server.seen.map(({ method, session }) => [method, session])).toEqual([
      ["initialize", null],
      ["notifications/initialized", "sess_1"],
      ["tools/call", "sess_1"],
      ["tools/call", "sess_1"],
      ["initialize", null],
      ["notifications/initialized", "sess_5"],
      ["tools/call", "sess_5"],
    ])
  })

  test("a session dropped again right after re-opening fails the call", async () => {
    const server = fakeServer((method) => (method === "tools/call" ? new Response("", { status: 404 }) : undefined))
    const client = new T3Client("http://t3.test", tokens(), server.fetch)

    await expect(client.call("t3_thread_wait", WAIT)).rejects.toThrow("dropped the MCP session again")
  })
})
