import { describe, expect, test } from "bun:test"
import { HERMES_INSTRUCTIONS, HermesApiError, HermesRunsClient, parseSseEvents } from "./hermes-client"

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

    expect(created).toEqual({ runId: "run_abc", replayed: false })
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
      body: { input: "Do the thing", session_id: "stream_1", instructions: HERMES_INSTRUCTIONS },
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
  test("reads status and output from a live Hermes-shaped listener", async () => {
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
      })
    } finally {
      await server.stop(true)
    }
  })
})

describe("HermesRunsClient.getRun fields", () => {
  test("reads a parked approval and a completed run's unconsumed steer", async () => {
    const { client } = clientWith((url) =>
      Response.json(
        url.endsWith("run_parked")
          ? {
              run_id: "run_parked",
              status: "waiting_for_approval",
              approval: { event: "approval.request", run_id: "run_parked", request_id: "req_1" },
            }
          : { run_id: "run_done", status: "completed", output: "ok", pending_steer: "tighten the ending" }
      )
    )
    expect({ parked: await client.getRun("run_parked"), done: await client.getRun("run_done") }).toEqual({
      parked: {
        runId: "run_parked",
        status: "waiting_for_approval",
        approval: { event: "approval.request", run_id: "run_parked", request_id: "req_1" },
      },
      done: { runId: "run_done", status: "completed", output: "ok", pendingSteer: "tighten the ending" },
    })
  })
})

function clientWith(handler: (url: string, init?: RequestInit) => Response): {
  client: HermesRunsClient
  seen: () => { url: string; body: unknown } | undefined
} {
  let seen: { url: string; body: unknown } | undefined
  const client = new HermesRunsClient({
    baseUrl: "http://127.0.0.1:8642",
    apiKey: "hermes-key",
    fetch: async (url, init) => {
      seen = {
        url: String(url),
        body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      }
      return handler(String(url), init)
    },
  })
  return { client, seen: () => seen }
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, code } }), { status })
}

async function caught(promise: Promise<unknown>): Promise<HermesApiError> {
  return (await promise.catch((error: unknown) => error)) as HermesApiError
}

describe("HermesRunsClient control endpoints", () => {
  test("steerRun posts the input and maps the accepted ack", async () => {
    const { client, seen } = clientWith(
      () => new Response(JSON.stringify({ object: "hermes.run.steer", run_id: "run_1", accepted: true }))
    )
    const result = await client.steerRun("run_1", "go left")
    expect({ result, seen: seen() }).toEqual({
      result: { runId: "run_1", accepted: true },
      seen: { url: "http://127.0.0.1:8642/v1/runs/run_1/steer", body: { input: "go left" } },
    })
  })

  test("steerRun surfaces run_not_accepting_steer", async () => {
    const { client } = clientWith(() => errorResponse(409, "run_not_accepting_steer", "Run is not accepting steer"))
    const error = await caught(client.steerRun("run_1", "go left"))
    expect({ status: error.status, code: error.code }).toEqual({ status: 409, code: "run_not_accepting_steer" })
  })

  test("steerRun surfaces invalid_steer_input", async () => {
    const { client } = clientWith(() => errorResponse(400, "invalid_steer_input", "input must be a non-empty string"))
    const error = await caught(client.steerRun("run_1", ""))
    expect({ status: error.status, code: error.code }).toEqual({ status: 400, code: "invalid_steer_input" })
  })

  test("stopRun reports the run's new status", async () => {
    const { client, seen } = clientWith(() => new Response(JSON.stringify({ run_id: "run_1", status: "stopping" })))
    const result = await client.stopRun("run_1")
    expect({ result, url: seen()?.url }).toEqual({
      result: { runId: "run_1", status: "stopping" },
      url: "http://127.0.0.1:8642/v1/runs/run_1/stop",
    })
  })

  test("stopRun surfaces run_not_active", async () => {
    const { client } = clientWith(() => errorResponse(409, "run_not_active", "No agent is attached to this run"))
    const error = await caught(client.stopRun("run_1"))
    expect({ status: error.status, code: error.code }).toEqual({ status: 409, code: "run_not_active" })
  })

  test("respondApproval posts the choice and the request id", async () => {
    const { client, seen } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            object: "hermes.run.approval_response",
            run_id: "run_1",
            choice: "once",
            request_id: "req_1",
            resolved: true,
          })
        )
    )
    const result = await client.respondApproval("run_1", { choice: "once", requestId: "req_1" })
    expect({ result, seen: seen() }).toEqual({
      result: { runId: "run_1", choice: "once", resolved: true },
      seen: {
        url: "http://127.0.0.1:8642/v1/runs/run_1/approval",
        body: { choice: "once", request_id: "req_1" },
      },
    })
  })

  test("respondApproval surfaces approval_not_pending", async () => {
    const { client } = clientWith(() => errorResponse(409, "approval_not_pending", "No approval is pending"))
    const error = await caught(client.respondApproval("run_1", { choice: "once" }))
    expect({ status: error.status, code: error.code }).toEqual({ status: 409, code: "approval_not_pending" })
  })

  test("respondApproval surfaces invalid_approval_choice", async () => {
    const { client } = clientWith(() => errorResponse(400, "invalid_approval_choice", "choice must be one of …"))
    const error = await caught(client.respondApproval("run_1", { choice: "maybe" }))
    expect({ status: error.status, code: error.code }).toEqual({ status: 400, code: "invalid_approval_choice" })
  })

  test("listModelOptions keeps only providers with a slug", async () => {
    const { client, seen } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            provider: "openrouter",
            model: "hermes-4",
            providers: [
              { slug: "openrouter", name: "OpenRouter", models: ["hermes-4", "glm-4.6"] },
              { name: "Nameless", models: ["x"] },
            ],
          })
        )
    )
    const options = await client.listModelOptions()
    expect({ options, url: seen()?.url }).toEqual({
      options: {
        provider: "openrouter",
        model: "hermes-4",
        providers: [{ slug: "openrouter", name: "OpenRouter", models: ["hermes-4", "glm-4.6"] }],
      },
      url: "http://127.0.0.1:8642/api/model/options",
    })
  })

  test("listModelOptions surfaces model_options_failed", async () => {
    const { client } = clientWith(() => errorResponse(500, "model_options_failed", "Failed to list model options."))
    const error = await caught(client.listModelOptions())
    expect({ status: error.status, code: error.code }).toEqual({ status: 500, code: "model_options_failed" })
  })

  test("createSession posts the id", async () => {
    const { client, seen } = clientWith(() => new Response(JSON.stringify({ id: "stream_1" }), { status: 201 }))
    await client.createSession("stream_1")
    expect(seen()).toEqual({ url: "http://127.0.0.1:8642/api/sessions", body: { id: "stream_1" } })
  })

  test("createSession surfaces a conflicting id", async () => {
    const { client } = clientWith(() => errorResponse(409, "session_exists", "Session already exists"))
    const error = await caught(client.createSession("stream_1"))
    expect({ status: error.status, code: error.code }).toEqual({ status: 409, code: "session_exists" })
  })

  test("lockSessionModel posts the runtime and reads back what was locked", async () => {
    const { client, seen } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            object: "hermes.session.model_lock",
            session_id: "stream_1",
            runtime: { provider: "openrouter", model: "hermes-4" },
          })
        )
    )
    const locked = await client.lockSessionModel("stream_1", { provider: "openrouter", model: "hermes-4" })
    expect({ locked, seen: seen() }).toEqual({
      locked: { sessionId: "stream_1", provider: "openrouter", model: "hermes-4" },
      seen: {
        url: "http://127.0.0.1:8642/api/sessions/stream_1/model",
        body: { provider: "openrouter", model: "hermes-4" },
      },
    })
  })

  test("lockSessionModel surfaces a missing session", async () => {
    const { client } = clientWith(() => errorResponse(404, "session_not_found", "Session not found"))
    const error = await caught(client.lockSessionModel("stream_1", { provider: "openrouter", model: "hermes-4" }))
    expect({ status: error.status, code: error.code }).toEqual({ status: 404, code: "session_not_found" })
  })
})

describe("HermesRunsClient.forkSession", () => {
  test("posts the fork id to the source session", async () => {
    const { client, seen } = clientWith(
      () =>
        new Response(JSON.stringify({ object: "hermes.session", session: { id: "stream_thread" } }), { status: 201 })
    )
    await client.forkSession("stream_root", "stream_thread")
    expect(seen()).toEqual({
      url: "http://127.0.0.1:8642/api/sessions/stream_root/fork",
      body: { id: "stream_thread" },
    })
  })

  test("surfaces a fork id that is already taken", async () => {
    const { client } = clientWith(() => errorResponse(409, "session_exists", "Session already exists"))
    const error = await caught(client.forkSession("stream_root", "stream_thread"))
    expect({ status: error.status, code: error.code }).toEqual({ status: 409, code: "session_exists" })
  })
})
