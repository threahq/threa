import { describe, expect, test } from "bun:test"
import { HermesApiError, HermesRunsClient, parseSseEvents } from "./hermes-client"

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe("HermesRunsClient.createRun", () => {
  test("sends the run body, idempotency and session-key headers, and maps the 202", async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | undefined
    const client = new HermesRunsClient({
      baseUrl: "http://127.0.0.1:8642/",
      apiKey: "hermes-key",
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        seen = {
          url: String(url),
          headers: Object.fromEntries(headers.entries()),
          body: JSON.parse(String(init?.body)) as unknown,
        }
        return new Response(JSON.stringify({ run_id: "run_abc", status: "started", replayed: false }), { status: 202 })
      },
    })

    const created = await client.createRun({
      input: "Do the thing",
      sessionId: "stream_1",
      idempotencyKey: "binv_1",
      sessionKey: "threa:ws_1:stream_root",
    })

    expect(created).toEqual({ runId: "run_abc", status: "started", replayed: false })
    expect({
      url: seen?.url,
      auth: seen?.headers.authorization,
      idempotency: seen?.headers["idempotency-key"],
      sessionKey: seen?.headers["x-hermes-session-key"],
      body: seen?.body,
    }).toEqual({
      url: "http://127.0.0.1:8642/v1/runs",
      auth: "Bearer hermes-key",
      idempotency: "binv_1",
      sessionKey: "threa:ws_1:stream_root",
      body: { input: "Do the thing", session_id: "stream_1" },
    })
  })

  test("turns a 409 idempotency conflict into a HermesApiError carrying its code", async () => {
    const client = new HermesRunsClient({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Idempotency-Key was already used with a different request payload",
              type: "invalid_request_error",
              param: null,
              code: "idempotency_key_conflict",
            },
          }),
          { status: 409 }
        ),
    })

    const error = (await client
      .createRun({ input: "x", sessionId: "s", idempotencyKey: "k", sessionKey: "sk" })
      .catch((caught: unknown) => caught)) as HermesApiError

    expect(error).toBeInstanceOf(HermesApiError)
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({
      status: 409,
      code: "idempotency_key_conflict",
      message: "Idempotency-Key was already used with a different request payload",
    })
  })
})

describe("SSE parsing", () => {
  test("skips keepalive comments, reassembles split frames, and joins multi-line data", async () => {
    const events = await collect(
      parseSseEvents(
        streamOf([
          ": keepalive\n\n",
          'data: {"event":"tool.started","run_id":"run_1","to',
          'ol":"Bash"}\n\n',
          'data: {"event":"run.completed",\ndata: "run_id":"run_1","output":"done"}\n\n',
        ])
      )
    )

    expect(events).toEqual([
      { event: "tool.started", run_id: "run_1", tool: "Bash" },
      { event: "run.completed", run_id: "run_1", output: "done" },
    ])
  })

  test("ends the iterator on the stream-closed comment", async () => {
    const events = await collect(
      parseSseEvents(
        streamOf([
          'data: {"event":"run.completed","run_id":"run_1","output":"ok"}\n\n',
          ": stream closed\n\n",
          'data: {"event":"never","run_id":"run_1"}\n\n',
        ])
      )
    )

    expect(events).toEqual([{ event: "run.completed", run_id: "run_1", output: "ok" }])
  })
})

describe("HermesRunsClient.streamEvents", () => {
  test("retries a run_not_found 404 from the subscribe race, then streams", async () => {
    let attempts = 0
    const slept: number[] = []
    const client = new HermesRunsClient({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-key",
      sleep: async (ms) => {
        slept.push(ms)
      },
      fetch: async () => {
        attempts += 1
        if (attempts < 2) {
          return new Response(JSON.stringify({ error: { message: "Run not found: run_1", code: "run_not_found" } }), {
            status: 404,
          })
        }
        return new Response(streamOf(['data: {"event":"run.completed","run_id":"run_1","output":"ok"}\n\n']), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    const events = await collect(client.streamEvents("run_1"))

    expect({ attempts, slept, events }).toEqual({
      attempts: 2,
      slept: [250],
      events: [{ event: "run.completed", run_id: "run_1", output: "ok" }],
    })
  })

  test("gives up after three run_not_found subscribes", async () => {
    let attempts = 0
    const client = new HermesRunsClient({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "hermes-key",
      sleep: async () => {},
      fetch: async () => {
        attempts += 1
        return new Response(JSON.stringify({ error: { message: "Run not found", code: "run_not_found" } }), {
          status: 404,
        })
      },
    })

    const error = (await collect(client.streamEvents("run_1")).catch((caught: unknown) => caught)) as HermesApiError

    expect({ attempts, status: error.status, code: error.code }).toEqual({
      attempts: 3,
      status: 404,
      code: "run_not_found",
    })
  })
})

describe("HermesRunsClient.getRun", () => {
  test("reads status, output and last_event from a live Hermes-shaped listener", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (request.headers.get("Authorization") !== "Bearer hermes-key") return new Response("no", { status: 401 })
        return Response.json({
          object: "hermes.run",
          run_id: "run_1",
          status: "completed",
          output: "all done",
          last_event: "run.completed",
        })
      },
    })
    try {
      const client = new HermesRunsClient({ baseUrl: server.url.origin, apiKey: "hermes-key" })
      expect(await client.getRun("run_1")).toEqual({
        runId: "run_1",
        status: "completed",
        output: "all done",
        lastEvent: "run.completed",
      })
    } finally {
      await server.stop(true)
    }
  })
})
