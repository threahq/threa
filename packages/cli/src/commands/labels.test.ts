import { afterEach, expect, spyOn, test } from "bun:test"
import { run } from "../cli"
import { jsonResponse, TEST_CONFIG } from "../test-support"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

test("label posts a stream assignment by name with appearance flags", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(201, { data: { label: { id: "lbl_1", name: "urgent" } } }))

  const result = await run(["label", "urgent", "stream_1", "--color", "#ff0000", "--emoji", "🔥"], {
    config: TEST_CONFIG,
    isTTY: false,
  })

  expect(result.exitCode).toBe(0)
  const init = fetchSpy.mock.calls[0]![1] as RequestInit
  expect(init.method).toBe("POST")
  expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe("/api/v1/workspaces/ws_1/labels/assignments")
  expect(JSON.parse(String(init.body))).toEqual({
    name: "urgent",
    color: "#ff0000",
    emoji: "🔥",
    resourceType: "stream",
    resourceId: "stream_1",
  })
})

test("unlabel deletes the assignment via query params and reports the removal", async () => {
  fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))

  const result = await run(["unlabel", "urgent", "stream_1", "--json"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(0)
  const url = new URL(String(fetchSpy.mock.calls[0]![0]))
  expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("DELETE")
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/labels/assignments")
  expect(url.searchParams.get("name")).toBe("urgent")
  expect(url.searchParams.get("resourceType")).toBe("stream")
  expect(url.searchParams.get("resourceId")).toBe("stream_1")
  expect(JSON.parse(result.stdout)).toEqual({ removed: true, name: "urgent", stream_id: "stream_1" })
})

test("label without a stream ref is a usage error (exit 2) before any HTTP", async () => {
  const result = await run(["label", "urgent"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("labels lists the actor's label catalog", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { labels: [{ id: "lbl_1", name: "urgent" }] } }))

  const result = await run(["labels", "--json"], { config: TEST_CONFIG, isTTY: false })

  expect(result.exitCode).toBe(0)
  expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("GET")
  expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe("/api/v1/workspaces/ws_1/labels")
})
