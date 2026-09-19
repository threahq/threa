import { afterEach, expect, spyOn, test } from "bun:test"
import { run } from "../cli"
import { jsonResponse, TEST_CONFIG } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

/**
 * A send first reads the stream, because a sealed one has to be sealed here
 * rather than discovered by having the plaintext rejected. So the POST is the
 * second call, and the stream read answers a plaintext stream.
 */
function serveSend(created: Response): void {
  fetchSpy.mockImplementation((async (input: RequestInfo | URL) =>
    new URL(String(input)).pathname.endsWith("/messages")
      ? created.clone()
      : jsonResponse(200, { data: { id: "stream_1", type: "channel" } })) as unknown as typeof fetch)
}

function postCall(): [RequestInfo | URL, RequestInit] {
  const call = fetchSpy.mock.calls.find((args) => (args[1] as RequestInit | undefined)?.method === "POST")
  return call as unknown as [RequestInfo | URL, RequestInit]
}

function sendBody(): Record<string, unknown> {
  return JSON.parse(String(postCall()[1].body)) as Record<string, unknown>
}

test("send with --new-conversation posts a new-intent directive and auto-generates a client message id", async () => {
  serveSend(jsonResponse(201, { data: { id: "msg_1" }, conversationId: "conv_1" }))

  const result = await run(
    ["messages", "send", "stream_1", "kickoff", "--new-conversation", "--metadata", "k=v", "--json"],
    {
      config: TEST_CONFIG,
    }
  )

  expect(result.exitCode).toBe(0)
  expect(new URL(String(postCall()[0])).pathname).toBe("/api/v1/workspaces/ws_1/streams/stream_1/messages")
  const body = sendBody()
  expect(body.content).toBe("kickoff")
  expect(body.conversation).toEqual({ intent: "new" })
  expect(body.metadata).toEqual({ k: "v" })
  expect(String(body.clientMessageId)).toMatch(/^mcp-/)
  const payload = JSON.parse(result.stdout) as { conversationId?: string; clientMessageId?: string }
  expect(payload.conversationId).toBe("conv_1")
  expect(payload.clientMessageId).toBe(String(body.clientMessageId))
})

test("send with --conversation appends an existing-intent directive", async () => {
  serveSend(jsonResponse(201, { data: { id: "msg_2" }, conversationId: "conv_9" }))

  const result = await run(["messages", "send", "stream_1", "follow up", "--conversation", "conv_9"], {
    config: TEST_CONFIG,
  })

  expect(result.exitCode).toBe(0)
  expect(sendBody().conversation).toEqual({ intent: "existing", conversationId: "conv_9" })
})

test("send with both --new-conversation and --conversation is a usage error (exit 2) before any HTTP", async () => {
  const result = await run(["messages", "send", "stream_1", "x", "--new-conversation", "--conversation", "conv_9"], {
    config: TEST_CONFIG,
  })

  expect(result.exitCode).toBe(2)
  expect(result.stdout).toBe("")
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("send reads content from stdin when the content arg is `-`", async () => {
  serveSend(jsonResponse(201, { data: { id: "msg_3" } }))

  const result = await run(["messages", "send", "stream_1", "-"], {
    config: TEST_CONFIG,
    readStdin: () => Promise.resolve("piped **body**\n"),
  })

  expect(result.exitCode).toBe(0)
  expect(sendBody().content).toBe("piped **body**\n")
})

test("edit sends a PATCH with the new content", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "msg_1", content: "edited" } }))

  const result = await run(["messages", "edit", "msg_1", "edited"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("PATCH")
  expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe("/api/v1/workspaces/ws_1/messages/msg_1")
  expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({ content: "edited" })
})

test("delete sends a DELETE and reports the id, handling a 204 body", async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))

  const result = await run(["messages", "delete", "msg_1", "--json"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("DELETE")
  expect(JSON.parse(result.stdout)).toEqual({ deleted: true, message_id: "msg_1" })
})
