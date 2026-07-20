import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../cli"
import { fetchByPath, jsonResponse, TEST_CONFIG } from "../test-support"
import { resolveDownloadTarget } from "./attachments"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => {
  fetchSpy.mockReset()
})

const TS_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/

const USERS = { data: [{ id: "usr_k", name: "Kris", slug: "kris", email: "k@x.io", role: "admin" }] }
const STREAMS: Record<string, unknown> = {
  stream_root: { id: "stream_root", type: "channel", displayName: "engineering" },
  stream_thread: { id: "stream_thread", type: "thread", displayName: "deploy plan", rootStreamId: "stream_root" },
}

function workspaceFetch(overrides: (path: string) => Response | undefined): typeof fetch {
  return fetchByPath((path) => {
    const custom = overrides(path)
    if (custom) return custom
    if (path.endsWith("/users")) return jsonResponse(200, USERS)
    const streamId = path.split("/").pop()!
    if (path.includes("/streams/") && STREAMS[streamId]) return jsonResponse(200, { data: STREAMS[streamId] })
    return jsonResponse(404, { error: "unexpected", code: "NOT_FOUND" })
  })
}

test("search --what messages renders timestamp, stream scope, author, and a content snippet", async () => {
  fetchSpy.mockImplementation(
    workspaceFetch((path) =>
      path.endsWith("/messages/search")
        ? jsonResponse(200, {
            data: [
              {
                id: "msg_1",
                streamId: "stream_thread",
                authorId: "usr_k",
                authorType: "user",
                content: "WebSocket   error\nacross lines",
                createdAt: "2026-07-19T12:02:00.000Z",
                rank: 0.9,
              },
            ],
          })
        : undefined
    )
  )

  const result = await run(["search", "ws error", "--what", "messages"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  const [header, body] = result.stdout.split("\n")
  expect(header).toContain("msg_1")
  expect(header).toMatch(TS_RE)
  expect(header).toContain("engineering › deploy plan")
  expect(header).toContain("Kris")
  expect(body).toBe("  WebSocket error across lines")
})

test("conversations list renders status, message count, activity time, and stream scope", async () => {
  fetchSpy.mockImplementation(
    workspaceFetch((path) =>
      path.endsWith("/conversations")
        ? jsonResponse(200, {
            data: [
              {
                id: "conv_1",
                streamId: "stream_thread",
                rootStreamId: "stream_root",
                status: "active",
                messageCount: 12,
                topicSummary: "Deploy ordering",
                lastActivityAt: "2026-07-19T12:02:00.000Z",
                participantIds: [],
              },
            ],
            hasMore: false,
            cursor: null,
          })
        : undefined
    )
  )

  const result = await run(["conversations", "list"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  const [header, body] = result.stdout.split("\n")
  expect(header).toContain("conv_1")
  expect(header).toContain("active")
  expect(header).toContain("12 msgs")
  expect(header).toMatch(TS_RE)
  expect(header).toContain("engineering › deploy plan")
  expect(body).toBe("  Deploy ordering")
})

test("memos list browses via a query-less memo search and renders scope + title", async () => {
  fetchSpy.mockImplementation(
    workspaceFetch((path) =>
      path.endsWith("/memos/search")
        ? jsonResponse(200, {
            data: [
              {
                memo: {
                  id: "memo_1",
                  title: "Deploy order",
                  abstract: "Regions before control plane.",
                  knowledgeType: "procedure",
                  createdAt: "2026-07-19T12:02:00.000Z",
                },
                distance: 0,
                sourceStream: { id: "stream_thread", type: "thread", name: "deploy plan" },
                rootStream: { id: "stream_root", type: "channel", name: "engineering" },
              },
            ],
          })
        : undefined
    )
  )

  const result = await run(["memos", "list", "--limit", "5"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  const searchCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/memos/search"))!
  const body = JSON.parse(String((searchCall[1] as RequestInit).body)) as Record<string, unknown>
  expect(body.query).toBeUndefined()
  expect(body.limit).toBe(5)
  const [header, abstract] = result.stdout.split("\n")
  expect(header).toContain("memo_1")
  expect(header).toContain("procedure")
  expect(header).toContain("engineering › deploy plan")
  expect(abstract).toBe("  Deploy order — Regions before control plane.")
})

test("attachments list browses query-less and renders filename, mime, and stream", async () => {
  fetchSpy.mockImplementation(
    workspaceFetch((path) =>
      path.endsWith("/attachments/search")
        ? jsonResponse(200, {
            data: [
              {
                id: "att_1",
                filename: "report.pdf",
                mimeType: "application/pdf",
                contentType: "document",
                summary: "Q2 numbers",
                streamId: "stream_root",
                createdAt: "2026-07-19T12:02:00.000Z",
              },
            ],
          })
        : undefined
    )
  )

  const result = await run(["attachments", "list", "--stream", "stream_root"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  const searchCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/attachments/search"))!
  const body = JSON.parse(String((searchCall[1] as RequestInit).body)) as Record<string, unknown>
  expect(body.query).toBeUndefined()
  expect(body.streams).toEqual(["stream_root"])
  const [header, summary] = result.stdout.split("\n")
  expect(header).toContain("att_1")
  expect(header).toContain("report.pdf")
  expect(header).toContain("application/pdf")
  expect(header).toContain("engineering")
  expect(summary).toBe("  Q2 numbers")
})

test("attachments download writes the signed-URL bytes under the attachment's filename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threa-dl-"))
  fetchSpy.mockImplementation(
    fetchByPath((path) => {
      if (path.endsWith("/attachments/att_1"))
        return jsonResponse(200, { data: { id: "att_1", filename: "notes.txt" } })
      if (path.endsWith("/attachments/att_1/url"))
        return jsonResponse(200, { data: { url: "https://files.example/signed/notes.txt", expiresIn: 900 } })
      if (path.startsWith("/signed/")) return new Response("hello bytes")
      return jsonResponse(404, { error: "unexpected", code: "NOT_FOUND" })
    })
  )

  const result = await run(["attachments", "download", "att_1", dir], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(`downloaded att_1 → ${join(dir, "notes.txt")}`)
  expect(await Bun.file(join(dir, "notes.txt")).text()).toBe("hello bytes")
})

test("resolveDownloadTarget picks Chrome-style ` (n)` names on conflict, but honors explicit file paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "threa-dl-conflict-"))
  writeFileSync(join(dir, "report.pdf"), "existing")
  writeFileSync(join(dir, "report (1).pdf"), "existing too")

  expect(resolveDownloadTarget(dir, "report.pdf")).toBe(join(dir, "report (2).pdf"))
  expect(resolveDownloadTarget(join(dir, "report.pdf"), "ignored.pdf")).toBe(join(dir, "report.pdf"))
  expect(resolveDownloadTarget(join(dir, "fresh.pdf"), "ignored.pdf")).toBe(join(dir, "fresh.pdf"))
})

test("skill print writes the skill markdown to stdout", async () => {
  const result = await run(["skill", "print"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("threa")
  expect(result.stdout.length).toBeGreaterThan(500)
  expect(fetchSpy).not.toHaveBeenCalled()
})
