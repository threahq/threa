import { afterEach, expect, spyOn, test } from "bun:test"
import { ThreaApiClient, ThreaApiError } from "./api-client"
import { jsonResponse } from "./test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function makeClient(sleep: (ms: number) => Promise<void> = async () => {}): ThreaApiClient {
  return new ThreaApiClient({
    baseUrl: "https://app.threa.io/",
    workspaceId: "ws_1",
    apiKey: "threa_uk_secret",
    sleep,
  })
}

test("get builds the workspace path with a bearer header and parses the data envelope", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { kind: "user" } }))
  const client = makeClient()

  const result = await client.get<{ data: { kind: string } }>("/me")

  expect(result.data.kind).toBe("user")
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  expect(url).toBe("https://app.threa.io/api/v1/workspaces/ws_1/me")
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer threa_uk_secret")
  expect(init.method).toBe("GET")
})

test("post serializes the body with a json content-type", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { id: "msg_1" } }))
  const client = makeClient()

  await client.post("/streams/stream_1/messages", { content: "hi" })

  const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  expect(init.method).toBe("POST")
  expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
  expect(init.body).toBe(JSON.stringify({ content: "hi" }))
})

test("error body maps into ThreaApiError status/code/message", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(400, { error: "bad input", code: "VALIDATION_ERROR" }))
  const client = makeClient()

  const error = (await client.get("/streams").catch((e) => e)) as ThreaApiError
  expect(error).toBeInstanceOf(ThreaApiError)
  expect(error.status).toBe(400)
  expect(error.code).toBe("VALIDATION_ERROR")
  expect(error.message).toBe("bad input")
})

test("404 carries the missing-scope hint", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(404, { error: "no stream", code: "NOT_FOUND" }))
  const client = makeClient()

  const error = (await client.get("/streams/stream_x").catch((e) => e)) as ThreaApiError
  expect(error.status).toBe(404)
  expect(error.hint).toMatch(/scope/i)
})

test("429 retries with exponential backoff then succeeds", async () => {
  const delays: number[] = []
  fetchSpy
    .mockResolvedValueOnce(jsonResponse(429, { error: "slow down", code: "RATE_LIMITED" }))
    .mockResolvedValueOnce(jsonResponse(429, { error: "slow down", code: "RATE_LIMITED" }))
    .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }))
  const client = makeClient(async (ms) => {
    delays.push(ms)
  })

  const result = await client.get<{ data: { ok: boolean } }>("/me")

  expect(result.data.ok).toBe(true)
  expect(delays).toEqual([2_000, 4_000])
})

test("429 gives up after three retries and throws with a rate-limit hint", async () => {
  const delays: number[] = []
  fetchSpy.mockResolvedValue(jsonResponse(429, { error: "slow down", code: "RATE_LIMITED" }))
  const client = makeClient(async (ms) => {
    delays.push(ms)
  })

  const error = (await client.get("/me").catch((e) => e)) as ThreaApiError
  expect(error).toBeInstanceOf(ThreaApiError)
  expect(error.status).toBe(429)
  expect(error.hint).toMatch(/rate limited/i)
  expect(delays).toEqual([2_000, 4_000, 8_000])
})

test("204 returns undefined without parsing a body", async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
  const client = makeClient()

  expect(await client.delete("/messages/msg_1")).toBeUndefined()
})
