import { describe, test, expect } from "bun:test"
import { SubscribeCoalescer, unionSubjectChunks, type CoalescedBatch } from "./coalescer"
import { SUBJECTS_CAP, type AuditSubjectRef } from "./subjects"

const stream = (n: number): AuditSubjectRef => ({ type: "stream", id: `stream_${n}` })

describe("SubscribeCoalescer", () => {
  test("joins within the window merge into one batch with occurredAt at the first join", async () => {
    const batches: CoalescedBatch[] = []
    const coalescer = new SubscribeCoalescer({ emit: (b) => batches.push(b), flushMs: 30 })
    const before = new Date()
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [{ type: "workspace", id: "ws_1" }] })
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(1)] })
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(2)] })
    expect(batches).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 60))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ workspaceId: "ws_1", actorId: "usr_1" })
    expect(batches[0].subjects).toEqual([{ type: "workspace", id: "ws_1" }, stream(1), stream(2)])
    expect(batches[0].occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5)
    expect(batches[0].occurredAt.getTime()).toBeLessThanOrEqual(before.getTime() + 25)
  })

  test("duplicate refs in one window dedupe; separate (workspace, actor) keys batch separately", async () => {
    const batches: CoalescedBatch[] = []
    const coalescer = new SubscribeCoalescer({ emit: (b) => batches.push(b), flushMs: 20 })
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(1)] })
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(1)] })
    coalescer.add({ workspaceId: "ws_2", actorId: "usr_2", subjects: [stream(9)] })
    coalescer.flushAll()
    expect(batches).toHaveLength(2)
    expect(batches.find((b) => b.workspaceId === "ws_1")!.subjects).toEqual([stream(1)])
    expect(batches.find((b) => b.workspaceId === "ws_2")!.subjects).toEqual([stream(9)])
  })

  test("flushAll flushes immediately and cancels the timer (no double emit)", async () => {
    const batches: CoalescedBatch[] = []
    const coalescer = new SubscribeCoalescer({ emit: (b) => batches.push(b), flushMs: 20 })
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(1)] })
    coalescer.flushAll()
    expect(batches).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 40))
    expect(batches).toHaveLength(1)
  })

  test("a batch beyond SUBJECTS_CAP chunks instead of truncating", () => {
    const batches: CoalescedBatch[] = []
    const coalescer = new SubscribeCoalescer({ emit: (b) => batches.push(b), flushMs: 1000 })
    const subjects = Array.from({ length: SUBJECTS_CAP + 5 }, (_, i) => stream(i))
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects })
    coalescer.flushAll()
    expect(batches).toHaveLength(2)
    expect(batches[0].subjects).toHaveLength(SUBJECTS_CAP)
    expect(batches[1].subjects).toHaveLength(5)
    const all = batches.flatMap((b) => b.subjects.map((s) => s.id))
    expect(new Set(all).size).toBe(SUBJECTS_CAP + 5)
  })

  test("a join after a flush starts a new window with its own occurredAt", async () => {
    const batches: CoalescedBatch[] = []
    const coalescer = new SubscribeCoalescer({ emit: (b) => batches.push(b), flushMs: 1000 })
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(1)] })
    coalescer.flushAll()
    coalescer.add({ workspaceId: "ws_1", actorId: "usr_1", subjects: [stream(2)] })
    coalescer.flushAll()
    expect(batches).toHaveLength(2)
    expect(batches[1].subjects).toEqual([stream(2)])
    expect(batches[1].occurredAt.getTime()).toBeGreaterThanOrEqual(batches[0].occurredAt.getTime())
  })
})

describe("unionSubjectChunks", () => {
  test("unions with dedupe and chunks at the cap", () => {
    const lists = [
      [{ type: "workspace", id: "ws_1" }, stream(1)],
      [stream(1), stream(2)],
    ]
    expect(unionSubjectChunks(lists)).toEqual([[{ type: "workspace", id: "ws_1" }, stream(1), stream(2)]])

    const big = [Array.from({ length: SUBJECTS_CAP + 1 }, (_, i) => stream(i))]
    const chunks = unionSubjectChunks(big)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(SUBJECTS_CAP)
    expect(chunks[1]).toHaveLength(1)
  })

  test("empty input yields no chunks (no empty rows)", () => {
    expect(unionSubjectChunks([])).toEqual([])
  })
})
