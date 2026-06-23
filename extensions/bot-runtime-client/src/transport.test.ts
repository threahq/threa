import { afterEach, describe, expect, it, mock } from "bun:test"
import { BotRuntimeTransport } from "./transport"
import { buildBotSocketUrl, parseWsHint } from "./ws-hint"

const HELLO = {
  instanceId: "inst_42",
  runtimeKind: "pi-local",
  supportedCapabilities: ["active-scratchpad"],
}

function makeTransport(): BotRuntimeTransport {
  return new BotRuntimeTransport({
    baseUrl: "https://app.example.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    hello: HELLO,
  })
}

interface CapturedRequest {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

function stubFetch(responder: (req: CapturedRequest) => Response): CapturedRequest[] {
  const calls: CapturedRequest[] = []
  global.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const req = { url, method: init?.method ?? "GET", body }
    calls.push(req)
    return responder(req)
  }) as unknown as typeof fetch
  return calls
}

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

describe("ws-hint helpers", () => {
  it("defaults path and namespace, then targets the /bot namespace", () => {
    const hint = parseWsHint({ url: "https://ws-eu.example.test" })
    expect(hint).toEqual({ url: "https://ws-eu.example.test", path: "/socket.io/", namespace: "/bot" })
    expect(buildBotSocketUrl(hint!)).toBe("https://ws-eu.example.test/bot")
  })

  it("preserves a query string when appending the namespace", () => {
    const hint = parseWsHint({ url: "https://ws.example.test/?region=eu" })!
    expect(buildBotSocketUrl(hint)).toBe("https://ws.example.test/bot?region=eu")
  })

  it("rejects a missing url", () => {
    expect(parseWsHint({ url: "" })).toBeUndefined()
    expect(parseWsHint({})).toBeUndefined()
  })
})

describe("HTTP fallback (no socket connected)", () => {
  it("unrolls a step batch into one POST per step with instanceId + claimToken", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const transport = makeTransport()

    await transport.recordSteps(
      "binv_1",
      "tok_1",
      [
        { stepType: "thinking", content: "a" },
        { stepType: "tool_call", content: "b" },
      ],
      "Working…"
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe("https://app.example.test/api/v1/workspaces/ws_1/bot-invocations/binv_1/steps")
    expect(calls[0]!.body).toEqual({
      instanceId: "inst_42",
      claimToken: "tok_1",
      stepType: "thinking",
      content: "a",
      statusText: "Working…",
    })
    expect(calls[1]!.body).toMatchObject({ stepType: "tool_call", content: "b" })
  })

  it("renews over HTTP and reports notFound on a 404", async () => {
    const calls = stubFetch((req) =>
      req.url.includes("/renew") ? new Response(null, { status: 404 }) : new Response("{}", { status: 200 })
    )
    const transport = makeTransport()

    const result = await transport.renewClaim("binv_gone", "tok_1", 120)

    expect(result).toEqual({ notFound: true })
    expect(calls[0]!.url).toBe("https://app.example.test/api/v1/workspaces/ws_1/bot-invocations/binv_gone/renew")
    expect(calls[0]!.body).toEqual({ instanceId: "inst_42", claimToken: "tok_1", claimTtlSeconds: 120 })
  })

  it("renews over HTTP and reports found on a 200", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const transport = makeTransport()
    expect(await transport.renewClaim("binv_1", "tok_1", 120)).toEqual({ notFound: false })
  })

  it("posts the presence body verbatim", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const transport = makeTransport()
    const body = { runtimeKind: "pi-local", instanceId: "inst_42", status: "busy", acceptingInvocations: false }

    await transport.updatePresence(body)

    expect(calls[0]!.url).toBe("https://app.example.test/api/v1/workspaces/ws_1/bot-runtime/presence")
    expect(calls[0]!.body).toEqual(body)
  })

  it("does nothing for an empty step batch", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 200 }))
    const transport = makeTransport()
    await transport.recordSteps("binv_1", "tok_1", [])
    expect(calls).toHaveLength(0)
  })
})
