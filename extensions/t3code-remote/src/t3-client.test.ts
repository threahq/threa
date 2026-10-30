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

  test("should round-trip pending questions, configuration and forks through the current MCP tools", async () => {
    const calls: unknown[] = []
    const selection = { instanceId: "codex", model: "gpt-5.5" }
    const question = { id: "runner", header: "Runner", question: "Which runner?", options: [] }
    const fetch = async (_url: string, init: RequestInit) => {
      const { method, id, params } = JSON.parse(String(init.body))
      if (method === "initialize")
        return Response.json({ jsonrpc: "2.0", id, result: {} }, { headers: { "mcp-session-id": "current" } })
      if (method === "notifications/initialized") return new Response(null, { status: 202 })
      calls.push(params)
      const args = params.arguments
      let result: unknown
      if (params.name === "t3_pending_request") {
        if (args.action === "list") result = { requestIds: ["request_1"] }
        else if (args.action === "read") result = { requestId: args.requestId, questions: [question] }
        else if (args.action === "respond") result = { accepted: true }
      } else if (params.name === "t3_thread_configure") {
        result = args.modelSelection ? { sequence: 2 } : { modelSelection: selection, runtimeMode: "full-access" }
      } else if (params.name === "t3_thread_transfer" && args.action === "fork") {
        result = { targetThreadId: "thread_fork" }
      }
      return sse({
        jsonrpc: "2.0",
        id,
        result:
          result === undefined
            ? { isError: true, content: [{ text: `Tool ${params.name} not found` }] }
            : { structuredContent: result },
      })
    }
    const client = new T3Client("http://t3.test", tokens(), fetch)
    const threadId = "thread_1"
    const pending = await client.call("t3_pending_request", { action: "list", threadId })
    const requestId = pending.requestIds[0]!
    const read = await client.call("t3_pending_request", { action: "read", threadId, requestId })
    const answered = await client.call("t3_pending_request", {
      action: "respond",
      threadId,
      requestId,
      answers: { runner: "Bun" },
    })
    const config = await client.call("t3_thread_configure", { threadId })
    const configured = await client.call("t3_thread_configure", { threadId, modelSelection: config.modelSelection })
    const fork = await client.call("t3_thread_transfer", {
      action: "fork",
      threadId,
      sourcePoint: { type: "latest_stable" },
      title: "Branch",
    })

    expect({ pending, read, answered, config, configured, fork, calls }).toEqual({
      pending: { requestIds: ["request_1"] },
      read: { requestId, questions: [question] },
      answered: { accepted: true },
      config: { modelSelection: selection, runtimeMode: "full-access" },
      configured: { sequence: 2 },
      fork: { targetThreadId: "thread_fork" },
      calls: [
        { name: "t3_pending_request", arguments: { action: "list", threadId } },
        { name: "t3_pending_request", arguments: { action: "read", threadId, requestId } },
        {
          name: "t3_pending_request",
          arguments: { action: "respond", threadId, requestId, answers: { runner: "Bun" } },
        },
        { name: "t3_thread_configure", arguments: { threadId } },
        { name: "t3_thread_configure", arguments: { threadId, modelSelection: selection } },
        {
          name: "t3_thread_transfer",
          arguments: { action: "fork", threadId, sourcePoint: { type: "latest_stable" }, title: "Branch" },
        },
      ],
    })
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

  test("calls that see the same dropped session re-open it once", async () => {
    let restarted = false
    const server = fakeServer((method, seen) =>
      restarted && method === "tools/call" && seen.session === "sess_1" ? new Response("", { status: 404 }) : undefined
    )
    let dropped = 0
    // The second 404 lands after the first call has already re-opened the session.
    const fetch = async (url: string, init: RequestInit) => {
      const res = await server.fetch(url, init)
      if (res.status === 404 && ++dropped === 2) await new Promise((resolve) => setTimeout(resolve, 20))
      return res
    }
    const client = new T3Client("http://t3.test", tokens(), fetch)
    await client.call("t3_thread_wait", WAIT)
    restarted = true

    await Promise.all([client.call("t3_thread_wait", WAIT), client.call("t3_thread_wait", WAIT)])

    expect(server.seen.filter(({ method }) => method === "initialize")).toHaveLength(2)
  })

  test("uploads bytes to the signed URL on the server's origin, without a token", async () => {
    const posted: Array<{ url: string; headers: unknown; body: string }> = []
    const answers = [new Response(null, { status: 204 }), new Response("expired", { status: 404 })]
    const fetch = async (url: string, init: RequestInit) => {
      posted.push({ url, headers: init.headers, body: new TextDecoder().decode(init.body as Uint8Array) })
      return answers.shift()!
    }
    const client = new T3Client("http://t3.test", tokens(), fetch)

    await client.upload("/api/attachments/upload/tok_1", new TextEncoder().encode("png-bytes"))
    const rejected = await client
      .upload("/api/attachments/upload/tok_2", new Uint8Array())
      .catch((e: Error) => e.message)

    expect({ posted, rejected }).toEqual({
      posted: [
        { url: "http://t3.test/api/attachments/upload/tok_1", headers: undefined, body: "png-bytes" },
        { url: "http://t3.test/api/attachments/upload/tok_2", headers: undefined, body: "" },
      ],
      rejected: "T3 Code upload answered 404: expired",
    })
  })

  test("a session dropped again right after re-opening fails the call", async () => {
    const server = fakeServer((method) => (method === "tools/call" ? new Response("", { status: 404 }) : undefined))
    const client = new T3Client("http://t3.test", tokens(), server.fetch)

    await expect(client.call("t3_thread_wait", WAIT)).rejects.toThrow("dropped the MCP session again")
  })
})
