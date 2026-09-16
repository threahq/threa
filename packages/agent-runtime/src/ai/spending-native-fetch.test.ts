import { describe, expect, it } from "bun:test"
import net from "node:net"
import { createAI } from "./ai"
import {
  OPENROUTER_CHAT_COMPLETIONS_URL,
  SpendingOutcomeUnknownError,
  type SpendingGate,
  type SpendingPolicyMode,
  type SpendingRouteProfile,
} from "./spending"

/**
 * The physical-attempt boundary proven against Bun's native fetch, not a fake:
 * the SDK and guard run for real, only the OpenRouter URL is rewritten to a
 * loopback raw-TCP server, and assertions read what that server received.
 */

const PROFILE: SpendingRouteProfile = {
  supportedParameters: ["reasoning", "include_reasoning", "seed", "max_tokens", "tools", "tool_choice"],
  model: "openai/gpt-5.6-luna",
  providerSlug: "openai",
  maxPromptTokens: 922_000,
  maxCompletionTokens: 128_000,
  promptUsdPerToken: "0.0000005",
  completionUsdPerToken: "0.0000018",
  requestUsd: "0",
}

const PAID_BODY = JSON.stringify({
  id: "gen-native",
  model: PROFILE.model,
  provider: "OpenAI",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, cost: 0.0000132 },
})

interface ObservedRequest {
  method: string
  path: string
  conn: number
  bodyBytes: number
}

type RawReply = { status: number; headers?: string[]; body?: string } | "destroy"

interface RawServer {
  origin: string
  requests: ObservedRequest[]
  close: () => Promise<void>
}

/** Minimal HTTP/1.1 keep-alive server: records each request only once its full body has arrived. */
async function startRawServer(route: (request: ObservedRequest) => RawReply): Promise<RawServer> {
  const requests: ObservedRequest[] = []
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = net.createServer((socket) => {
    const conn = ++connections
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffer = Buffer.alloc(0)
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      for (;;) {
        const headEnd = buffer.indexOf("\r\n\r\n")
        if (headEnd < 0) return
        const [line, ...headers] = buffer.subarray(0, headEnd).toString().split("\r\n")
        const lengthHeader = headers.find((header) => /^content-length:/i.test(header))
        const bodyBytes = lengthHeader ? Number(lengthHeader.split(":")[1]) : 0
        if (buffer.length < headEnd + 4 + bodyBytes) return
        buffer = buffer.subarray(headEnd + 4 + bodyBytes)
        const [method, path] = line!.split(" ")
        const request = { method: method!, path: path!, conn, bodyBytes }
        requests.push(request)
        const reply = route(request)
        if (reply === "destroy") {
          socket.destroy()
          return
        }
        const body = reply.body ?? ""
        socket.write(
          [
            `HTTP/1.1 ${reply.status} X`,
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            "Connection: keep-alive",
            ...(reply.headers ?? []),
            "",
            body,
          ].join("\r\n")
        )
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as net.AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

type LedgerCall = string

function ledgerGate(
  ledger: LedgerCall[],
  policy: SpendingPolicyMode = { mode: "protected", denial: null }
): SpendingGate {
  let next = 1
  return {
    async policyMode() {
      return policy
    },
    async routeFor({ modelId }) {
      return modelId === PROFILE.model ? PROFILE : null
    },
    async reserve() {
      const id = `att_${next++}`
      ledger.push(`reserve ${id}`)
      return { allowed: true, created: true, attempt: { id, state: "reserved" } }
    },
    async dispatch(_workspaceId, attemptId) {
      ledger.push(`dispatch ${attemptId}`)
      return { dispatched: true }
    },
    async settle({ attemptId }) {
      ledger.push(`settle ${attemptId}`)
    },
    async release(_workspaceId, attemptId) {
      ledger.push(`release ${attemptId}`)
    },
    async markUnknown(_workspaceId, attemptId) {
      ledger.push(`markUnknown ${attemptId}`)
    },
  }
}

function nativeAI(paidUrl: string, ledger: LedgerCall[], policy?: SpendingPolicyMode) {
  return createAI({
    openrouter: {
      apiKey: "dummy-key",
      fetch: (input, init) => {
        if (String(input) !== OPENROUTER_CHAT_COMPLETIONS_URL) throw new Error(`unexpected egress: ${String(input)}`)
        return fetch(paidUrl, init)
      },
    },
    spendingGate: ledgerGate(ledger, policy),
  })
}

async function paidCall(ai: ReturnType<typeof createAI>): Promise<unknown> {
  try {
    await ai.generateText({
      model: `openrouter:${PROFILE.model}`,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
      context: { workspaceId: "ws_a" },
      spending: {
        workspaceId: "ws_a",
        userId: "usr_1",
        sessionId: "sess_1",
        executionGeneration: 1,
        operationId: "op_1",
        purpose: "assistant_turn",
        requestKey: "step_1",
      },
    })
  } catch (error) {
    return error
  }
  return undefined
}

describe("guarded transport over native Bun fetch", () => {
  for (const status of [307, 308]) {
    for (const target of ["same-origin", "cross-origin"] as const) {
      it(`never re-sends a paid POST on a ${status} to a ${target} target`, async () => {
        const other = await startRawServer(() => ({ status: 200, body: PAID_BODY }))
        const redirecting = await startRawServer((request) =>
          request.path === "/paid"
            ? {
                status,
                headers: [`Location: ${target === "cross-origin" ? other.origin : ""}/redirected`],
              }
            : { status: 200, body: PAID_BODY }
        )
        try {
          const ledger: LedgerCall[] = []
          const error = await paidCall(nativeAI(`${redirecting.origin}/paid`, ledger))

          expect({
            error: error instanceof SpendingOutcomeUnknownError ? error.attempts : error,
            origin: redirecting.requests.map(({ method, path }) => `${method} ${path}`),
            other: other.requests.map(({ method, path }) => `${method} ${path}`),
            ledger,
          }).toEqual({
            error: [
              { attemptId: "att_1", status: "held", reason: "provider_request_failed", providerRequestSent: true },
            ],
            origin: ["POST /paid"],
            other: [],
            ledger: ["reserve att_1", "dispatch att_1", "markUnknown att_1"],
          })
        } finally {
          await redirecting.close()
          await other.close()
        }
      })
    }
  }

  it("never follows a 307 to another origin from an explicitly unprotected workspace's legacy fetch", async () => {
    const other = await startRawServer(() => ({ status: 200, body: PAID_BODY }))
    const redirecting = await startRawServer(() => ({
      status: 307,
      headers: [`Location: ${other.origin}/redirected`],
    }))
    try {
      const ledger: LedgerCall[] = []
      let error: unknown
      try {
        await nativeAI(`${redirecting.origin}/paid`, ledger, { mode: "unprotected" }).generateText({
          model: `openrouter:${PROFILE.model}`,
          messages: [{ role: "user", content: "hi" }],
          context: { workspaceId: "ws_a" },
        })
      } catch (caught) {
        error = caught
      }

      expect({
        failed: error instanceof Error,
        origin: redirecting.requests.map(({ method, path }) => `${method} ${path}`),
        other: other.requests.map(({ method, path }) => `${method} ${path}`),
        ledger,
      }).toEqual({ failed: true, origin: ["POST /paid"], other: [], ledger: [] })
    } finally {
      await redirecting.close()
      await other.close()
    }
  })

  it("holds without replaying when a reused socket closes after the full paid POST arrives", async () => {
    const server = await startRawServer((request) =>
      request.path === "/warm" ? { status: 200, body: "{}" } : "destroy"
    )
    try {
      const warm = await fetch(`${server.origin}/warm`)
      await warm.text()
      const ledger: LedgerCall[] = []
      const error = await paidCall(nativeAI(`${server.origin}/paid`, ledger))

      const [warmRequest, ...paid] = server.requests
      expect({
        error: error instanceof SpendingOutcomeUnknownError ? error.attempts : error,
        paid: paid.map(({ method, path, conn, bodyBytes }) => ({ method, path, conn, sentBody: bodyBytes > 0 })),
        ledger,
      }).toEqual({
        error: [{ attemptId: "att_1", status: "held", reason: "provider_request_failed", providerRequestSent: true }],
        paid: [{ method: "POST", path: "/paid", conn: warmRequest!.conn, sentBody: true }],
        ledger: ["reserve att_1", "dispatch att_1", "markUnknown att_1"],
      })
    } finally {
      await server.close()
    }
  })
})
