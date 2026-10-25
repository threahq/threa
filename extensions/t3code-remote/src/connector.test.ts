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
    store.save({ threads: { stream_root: "thread_a" }, model, spawns })

    expect(store.load()).toEqual({ threads: { stream_root: "thread_a" }, model, spawns })
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
