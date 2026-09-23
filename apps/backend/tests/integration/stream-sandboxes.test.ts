import { beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import {
  SandboxService,
  StreamSandboxRepository,
  type SandboxExecResult,
  type SandboxFile,
  type SandboxRunner,
} from "../../src/features/sandboxes"
import { streamId, workspaceId } from "../../src/lib/id"

class FakeRunner implements SandboxRunner {
  readonly live = new Set<string>()
  readonly created: Array<{ id: string; internet: boolean }> = []
  readonly destroyed: string[] = []
  readonly ran: Array<{ sandboxId: string; command: string }> = []
  readonly written: Array<{ sandboxId: string; path: string }> = []
  private next = 0
  /** Runs inside `create`, after the box exists but before the service binds it. */
  beforeCreateReturns: (() => Promise<void>) | null = null

  constructor(readonly kind = "fake") {}

  async create(params: { internet: boolean }): Promise<string> {
    const id = `${this.kind}-${++this.next}`
    this.live.add(id)
    this.created.push({ id, internet: params.internet })
    const hook = this.beforeCreateReturns
    this.beforeCreateReturns = null
    await hook?.()
    return id
  }

  async alive(sandboxId: string): Promise<boolean> {
    return this.live.has(sandboxId)
  }

  async writeFiles(sandboxId: string, files: SandboxFile[]): Promise<void> {
    for (const file of files) this.written.push({ sandboxId, path: file.path })
  }

  async exec(sandboxId: string, command: string): Promise<SandboxExecResult> {
    if (!this.live.has(sandboxId)) throw new Error(`exec on a missing box ${sandboxId}`)
    this.ran.push({ sandboxId, command })
    return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, truncated: false }
  }

  async destroy(sandboxId: string): Promise<void> {
    this.live.delete(sandboxId)
    this.destroyed.push(sandboxId)
  }
}

describe("SandboxService", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  function target() {
    return { workspaceId: workspaceId(), streamId: streamId() }
  }

  function run(service: SandboxService, at: { workspaceId: string; streamId: string }, internet = false) {
    return service.run({ ...at, internet, command: "echo ok", files: [], timeoutSec: 5 })
  }

  test("a stream keeps its sandbox between runs", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    const first = await run(service, at)
    const second = await run(service, at)
    const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)

    expect({
      replaced: [first.replaced, second.replaced],
      stdout: second.stdout,
      created: runner.created,
      ran: runner.ran.map((r) => r.sandboxId),
      row: row && { sandboxId: row.sandboxId, runner: row.runner, internet: row.internet },
    }).toEqual({
      replaced: [null, null],
      stdout: "ok\n",
      created: [{ id: "fake-1", internet: false }],
      ran: ["fake-1", "fake-1"],
      row: { sandboxId: "fake-1", runner: "fake", internet: false },
    })
  })

  test("a box that is gone is replaced, and the run says so", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    await run(service, at)
    runner.live.delete("fake-1")
    const result = await run(service, at)
    const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)

    expect({ replaced: result.replaced, bound: row?.sandboxId, ranIn: runner.ran.at(-1)?.sandboxId }).toEqual({
      replaced: "expired",
      bound: "fake-2",
      ranIn: "fake-2",
    })
  })

  test("a changed internet setting replaces the box and removes the old one", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    await run(service, at, false)
    const result = await run(service, at, true)
    const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)

    expect({
      replaced: result.replaced,
      created: runner.created,
      destroyed: runner.destroyed,
      row: row && { sandboxId: row.sandboxId, internet: row.internet },
    }).toEqual({
      replaced: "network_changed",
      created: [
        { id: "fake-1", internet: false },
        { id: "fake-2", internet: true },
      ],
      destroyed: ["fake-1"],
      row: { sandboxId: "fake-2", internet: true },
    })
  })

  test("a box from another runner is never touched and counts as expired", async () => {
    const old = new FakeRunner("old")
    const current = new FakeRunner("new")
    const at = target()

    await run(new SandboxService({ pool, runner: old }), at)
    const result = await run(new SandboxService({ pool, runner: current }), at)

    expect({ replaced: result.replaced, oldDestroyed: old.destroyed, newCreated: current.created }).toEqual({
      replaced: "expired",
      oldDestroyed: [],
      newCreated: [{ id: "new-1", internet: false }],
    })
  })

  test("two first runs racing end up in one box, and the loser's box is removed", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    // The second run starts and binds while the first is still creating its box.
    runner.beforeCreateReturns = async () => {
      await run(service, at)
    }
    const result = await run(service, at)
    const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)

    expect({
      replaced: result.replaced,
      bound: row?.sandboxId,
      destroyed: runner.destroyed,
      ran: runner.ran.map((r) => r.sandboxId),
    }).toEqual({
      replaced: null,
      bound: "fake-2",
      destroyed: ["fake-1"],
      ran: ["fake-2", "fake-2"],
    })
  })

  test("the loser of a replace race still hears its box was replaced", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    await run(service, at)
    runner.live.delete("fake-1")
    // The other run replaces the dead box while this one is still creating its own.
    runner.beforeCreateReturns = async () => {
      await run(service, at)
    }
    const result = await run(service, at)

    expect({ replaced: result.replaced, destroyed: runner.destroyed, ranIn: runner.ran.at(-1)?.sandboxId }).toEqual({
      replaced: "expired",
      destroyed: ["fake-2"],
      ranIn: "fake-3",
    })
  })

  test("a box that could not be bound is removed", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const bind = spyOn(StreamSandboxRepository, "insertIfAbsent").mockRejectedValueOnce(new Error("pool exhausted"))

    try {
      await expect(run(service, target())).rejects.toThrow("pool exhausted")
    } finally {
      bind.mockRestore()
    }

    expect({ created: runner.created.map((c) => c.id), destroyed: runner.destroyed }).toEqual({
      created: ["fake-1"],
      destroyed: ["fake-1"],
    })
  })

  test("a run cancelled while its box is made never starts the command", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const controller = new AbortController()
    runner.beforeCreateReturns = async () => controller.abort(new Error("cancelled"))

    await expect(
      service.run({
        ...target(),
        internet: false,
        command: "echo ok",
        files: [],
        timeoutSec: 5,
        signal: controller.signal,
      })
    ).rejects.toThrow("cancelled")
    expect(runner.ran).toEqual([])
  })

  test("files are written into the box before the command runs", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    await service.run({
      ...at,
      internet: false,
      command: "cat /work/attachments/a.txt",
      files: [{ path: "/work/attachments/a.txt", data: new TextEncoder().encode("hi") }],
      timeoutSec: 5,
    })

    expect(runner.written).toEqual([{ sandboxId: "fake-1", path: "/work/attachments/a.txt" }])
  })
})
