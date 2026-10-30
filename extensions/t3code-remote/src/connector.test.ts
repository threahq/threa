import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileThreadStore } from "./connector"

describe("createFileThreadStore", () => {
  test("starts empty without a file and keeps what it saved", () => {
    const store = createFileThreadStore(join(mkdtempSync(join(tmpdir(), "t3threads-")), "threads.json"))
    expect(store.load()).toEqual({ threads: {} })

    const model = { instanceId: "codex", model: "gpt-5.5", options: [{ id: "reasoningEffort", value: "high" }] }
    const spawns = { msg_spawn: { title: "helper", model }, stream_thread: { title: "other" } }
    const delivered = { thread_a: "run_2" }
    const posted = { thread_a: ["run_4"] }
    store.save({ threads: { stream_root: "thread_a" }, model, spawns, delivered, posted })

    expect(store.load()).toEqual({ threads: { stream_root: "thread_a" }, model, spawns, delivered, posted })
  })

  test("reads a file written before spawns were kept", () => {
    const path = join(mkdtempSync(join(tmpdir(), "t3threads-")), "threads.json")
    writeFileSync(
      path,
      JSON.stringify({ threads: { stream_root: "thread_a" }, model: { instanceId: "codex", model: "gpt-5.5" } })
    )

    expect(createFileThreadStore(path).load()).toEqual({
      threads: { stream_root: "thread_a" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    })
  })

  test.each(['{"threads": {"stream_root": "thr', "[]", "null"])(
    "a damaged file throws rather than reading as no links: %p",
    (content) => {
      const path = join(mkdtempSync(join(tmpdir(), "t3threads-")), "threads.json")
      writeFileSync(path, content)

      expect(() => createFileThreadStore(path).load()).toThrow(`Could not read ${path}`)
    }
  )
})

test("should retain only valid posted and owed run IDs from disk", () => {
  const path = join(mkdtempSync(join(tmpdir(), "t3threads-")), "threads.json")
  writeFileSync(
    path,
    JSON.stringify({
      threads: {},
      posted: { a: ["run_1", "", 7, "run_1"], b: "run_2" },
      owed: { a: [null, "run_3"], b: [] },
    })
  )
  expect(createFileThreadStore(path).load()).toEqual({ threads: {}, posted: { a: ["run_1"] }, owed: { a: ["run_3"] } })
})

test("should persist attachment identity and owed delivery together across file-store restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "t3threads-")), "threads.json")
  const state = {
    threads: { stream_root: "thread_a" },
    attachments: { thread_a: { run_1: "request_1" } },
    owed: { thread_a: ["run_1"] },
  }
  createFileThreadStore(path).save(state)
  expect(createFileThreadStore(path).load()).toEqual(state)
})
