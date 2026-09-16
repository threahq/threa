import { afterEach, expect, spyOn, test } from "bun:test"
import { ThreaApiClient, ThreaApiError } from "./api-client"
import { assertPrincipal } from "./principal"
import { jsonResponse, TEST_CONFIG } from "./test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

function client(): ThreaApiClient {
  return new ThreaApiClient({
    baseUrl: TEST_CONFIG.baseUrl,
    workspaceId: TEST_CONFIG.workspaceId,
    apiKey: TEST_CONFIG.apiKey,
  })
}

test("a matching declaration resolves after asking /me", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { kind: "bot", botId: "bot_1" } }))

  await assertPrincipal(client(), { ...TEST_CONFIG, principal: "bot" })

  expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).pathname).toBe("/api/v1/workspaces/ws_1/me")
})

test("a mismatched key refuses to run and names the real principal", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { kind: "user", userId: "usr_9" } }))

  await expect(assertPrincipal(client(), { ...TEST_CONFIG, principal: "bot" })).rejects.toThrow(
    'threa: config declares principal "bot" but the key belongs to user usr_9 (INV-11)'
  )
})

test("no declaration asks nothing", async () => {
  await assertPrincipal(client(), TEST_CONFIG)

  expect(fetchSpy.mock.calls).toEqual([])
})

test("a transient /me failure is retried, and a client error is not", async () => {
  const waits: number[] = []
  const sleep = async (ms: number) => {
    waits.push(ms)
  }
  fetchSpy
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
    .mockResolvedValueOnce(jsonResponse(200, { data: { kind: "bot", botId: "bot_1" } }))

  await assertPrincipal(client(), { ...TEST_CONFIG, principal: "bot" }, { retryDelaysMs: [5, 10, 20], sleep })
  expect(waits).toEqual([5, 10])

  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue(jsonResponse(401, { error: "bad key" }))
  const refused = assertPrincipal(client(), { ...TEST_CONFIG, principal: "bot" }, { retryDelaysMs: [5], sleep })
  await expect(refused).rejects.toBeInstanceOf(ThreaApiError)
  expect(fetchSpy.mock.calls.length).toBe(1)
})

test("retries end with the last transient error", async () => {
  fetchSpy.mockImplementation((async () => jsonResponse(502, { error: "bad gateway" })) as unknown as typeof fetch)

  await expect(
    assertPrincipal(client(), { ...TEST_CONFIG, principal: "bot" }, { retryDelaysMs: [0], sleep: async () => {} })
  ).rejects.toThrow("bad gateway")
  expect(fetchSpy.mock.calls.length).toBe(2)
})
