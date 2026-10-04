import { beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { StreamTypes, Visibilities } from "@threahq/types"
import { StreamRepository } from "../../src/features/streams"
import {
  SandboxService,
  SandboxSessionTokenService,
  StreamSandboxLeaseRepository,
  StreamSandboxRepository,
  recordSandboxReads,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxFile,
  type SandboxRunner,
} from "../../src/features/sandboxes"
import { streamId, workspaceId } from "../../src/lib/id"
import { createModelRegistry } from "@threahq/agent-runtime"
import type { ToolPrivacyPolicy } from "@threahq/types"
import { WorkspaceSettingsService } from "../../src/features/workspace-settings"
import { bindStreamSandbox, createRunCommandTool, type WorkspaceToolDeps } from "../../src/features/agents/tools"

class FakeRunner implements SandboxRunner {
  readonly live = new Set<string>()
  readonly created: Array<{ id: string; internet: boolean }> = []
  readonly destroyed: string[] = []
  readonly ran: Array<{ sandboxId: string; command: string }> = []
  readonly written: Array<{ sandboxId: string; path: string }> = []
  private next = 0
  /** Runs inside `exec`, while the command would be running. */
  duringExec: ((options: SandboxExecOptions) => Promise<void>) | null = null
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

  async exec(sandboxId: string, command: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    if (!this.live.has(sandboxId)) throw new Error(`exec on a missing box ${sandboxId}`)
    this.ran.push({ sandboxId, command })
    await this.duringExec?.(options)
    return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, truncated: false }
  }

  async destroy(sandboxId: string): Promise<void> {
    this.live.delete(sandboxId)
    this.destroyed.push(sandboxId)
  }
}

function target() {
  return { workspaceId: workspaceId(), streamId: streamId() }
}

describe("SandboxService", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  function run(
    service: SandboxService,
    at: { workspaceId: string; streamId: string },
    internet = false,
    reach: { readableStreamIds?: string[]; contentStreamIds?: string[] } = {}
  ) {
    return service.run({
      ...at,
      internet,
      readableStreamIds: reach.readableStreamIds ?? [at.streamId],
      contentStreamIds: reach.contentStreamIds ?? [],
      command: "echo ok",
      files: [],
      timeoutSec: 5,
    })
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

    // Another replica, its lease expired, binds while this run is still creating its box.
    runner.beforeCreateReturns = async () => {
      runner.live.add("other-1")
      await StreamSandboxRepository.insertIfAbsent(pool, {
        ...at,
        internet: false,
        sandboxId: "other-1",
        runner: "fake",
      })
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
      bound: "other-1",
      destroyed: ["fake-1"],
      ran: ["other-1"],
    })
  })

  test("the loser of a replace race still hears its box was replaced", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()

    await run(service, at)
    runner.live.delete("fake-1")
    // Another replica, its lease expired, replaces the dead box while this run is still creating its own.
    runner.beforeCreateReturns = async () => {
      runner.live.add("other-1")
      await StreamSandboxRepository.replace(pool, {
        ...at,
        internet: false,
        sandboxId: "other-1",
        runner: "fake",
        expectedSandboxId: "fake-1",
      })
    }
    const result = await run(service, at)

    expect({ replaced: result.replaced, destroyed: runner.destroyed, ranIn: runner.ran.at(-1)?.sandboxId }).toEqual({
      replaced: "expired",
      destroyed: ["fake-2"],
      ranIn: "other-1",
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
        readableStreamIds: [],
        contentStreamIds: [],
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
      readableStreamIds: [at.streamId],
      contentStreamIds: [],
      command: "cat /work/attachments/a.txt",
      files: [{ path: "/work/attachments/a.txt", data: new TextEncoder().encode("hi") }],
      timeoutSec: 5,
    })

    expect(runner.written).toEqual([{ sandboxId: "fake-1", path: "/work/attachments/a.txt" }])
  })

  test("a turn that cannot read everything the box holds gets a fresh box, and the old one is removed", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()
    const secret = streamId()

    await run(service, at, false, { readableStreamIds: [at.streamId, secret], contentStreamIds: [secret] })
    const narrower = await run(service, at, false)
    const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)

    expect({
      replaced: narrower.replaced,
      destroyed: runner.destroyed,
      ranIn: runner.ran.at(-1)?.sandboxId,
      content: row?.contentStreamIds,
    }).toEqual({ replaced: "access_changed", destroyed: ["fake-1"], ranIn: "fake-2", content: [] })
  })

  test("a wider turn's run waits for a narrower turn's command, so its content never lands while that command runs", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()
    const secret = streamId()
    const seen: string[][] = []
    let wider: Promise<unknown> = Promise.resolve()
    runner.duringExec = async () => {
      runner.duringExec = null
      wider = run(service, at, false, { readableStreamIds: [at.streamId, secret], contentStreamIds: [secret] })
      await new Promise((resolve) => setTimeout(resolve, 600))
      const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)
      seen.push(row?.contentStreamIds ?? [])
    }

    const narrower = await run(service, at)
    await wider

    expect({ seen, narrower: narrower.contentStreamIds, ran: runner.ran.map((r) => r.sandboxId) }).toEqual({
      seen: [[]],
      narrower: [],
      ran: ["fake-1", "fake-1"],
    })
  })

  test("a run takes over a lease its holder stopped renewing", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()
    await StreamSandboxLeaseRepository.take(pool, { ...at, leaseId: "sbl_crashed", ttlSec: 0 })

    const result = await run(service, at)

    expect(result.stdout).toBe("ok\n")
  })

  test("a command whose box was replaced while it ran has its output withheld", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()
    runner.duringExec = async () => {
      await StreamSandboxRepository.replace(pool, {
        ...at,
        internet: false,
        sandboxId: "other-1",
        runner: "fake",
        expectedSandboxId: "fake-1",
      })
    }

    await expect(run(service, at)).rejects.toThrow("output is withheld")
  })

  test("a turn that can read everything the box holds keeps it and reports what it holds", async () => {
    const runner = new FakeRunner()
    const service = new SandboxService({ pool, runner })
    const at = target()
    const design = streamId()

    await run(service, at, false, { readableStreamIds: [at.streamId, design], contentStreamIds: [design] })
    const later = await run(service, at, false, { readableStreamIds: [at.streamId, design] })

    expect({
      replaced: later.replaced,
      ranIn: runner.ran.map((r) => r.sandboxId),
      contentStreamIds: later.contentStreamIds,
    }).toEqual({ replaced: null, ranIn: ["fake-1", "fake-1"], contentStreamIds: [design] })
  })
})

describe("run_command", () => {
  let pool: Pool
  let workspaceSettings: WorkspaceSettingsService
  let sessionTokens: SandboxSessionTokenService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    workspaceSettings = new WorkspaceSettingsService(pool, createModelRegistry())
    sessionTokens = new SandboxSessionTokenService({ pool })
  })

  function commandTool(
    runner: FakeRunner,
    at: { workspaceId: string; streamId: string },
    policy: ToolPrivacyPolicy,
    invokingUserId: string | null = null
  ) {
    const service = new SandboxService({ pool, runner })
    const workspace = { db: pool, workspaceId: at.workspaceId, accessibleStreamIds: [at.streamId] } as WorkspaceToolDeps
    return createRunCommandTool(
      workspace,
      bindStreamSandbox(
        { service, workspaceSettings, sessionTokens },
        {
          ...at,
          sealed: false,
          streamToolPolicy: policy,
          personaId: "persona_ariadne",
          sessionId: "session_1",
          invokingUserId,
          capturedStreamIds: [at.streamId],
        }
      )!
    )
  }

  async function runCommand(tool: ReturnType<typeof commandTool>) {
    const input = { command: "echo ok" }
    const result = await tool.config.execute(input, { toolCallId: "tc_1" })
    return {
      output: JSON.parse(result.output) as Record<string, unknown>,
      trace: JSON.parse(tool.config.trace.formatContent(input, result)) as { headline: string },
    }
  }

  test("internet needs the workspace setting and the stream's web grant", async () => {
    const off = target()
    const on = target()
    const onWithoutWeb = { workspaceId: on.workspaceId, streamId: streamId() }
    await workspaceSettings.updateSettings(off.workspaceId, { sandboxInternet: false })
    await workspaceSettings.updateSettings(on.workspaceId, { sandboxInternet: true })
    const runner = new FakeRunner()

    const results = [
      await runCommand(commandTool(runner, off, null)),
      await runCommand(commandTool(runner, on, null)),
      await runCommand(commandTool(runner, onWithoutWeb, ["workspace"])),
    ]

    expect({
      reported: results.map((r) => r.output.internet),
      created: runner.created.map((c) => c.internet),
    }).toEqual({ reported: [false, true, false], created: [false, true, false] })
  })

  test("a command's token reads as the invoking user while it runs, and is revoked when it ends", async () => {
    const at = target()
    const runner = new FakeRunner()
    const during: Array<{ token: string; session: Awaited<ReturnType<typeof sessionTokens.validate>> }> = []
    runner.duringExec = async (options) => {
      const api = await options.api?.()
      if (api) during.push({ token: api.token, session: await sessionTokens.validate(api.token) })
    }

    await runCommand(commandTool(runner, at, null, "usr_invoker"))

    expect({
      during: during.map(
        ({ session }) =>
          session && {
            invokingUserId: session.invokingUserId,
            personaId: session.personaId,
            streamId: session.streamId,
            capturedStreamIds: session.capturedStreamIds,
          }
      ),
      after: await sessionTokens.validate(during[0]!.token),
    }).toEqual({
      during: [
        {
          invokingUserId: "usr_invoker",
          personaId: "persona_ariadne",
          streamId: at.streamId,
          capturedStreamIds: [at.streamId],
        },
      ],
      after: null,
    })
  })

  test("a stream the command's token read is cited by that command and held against the box", async () => {
    const at = target()
    const runner = new FakeRunner()
    const notes = streamId()
    await StreamRepository.insert(pool, {
      id: notes,
      workspaceId: at.workspaceId,
      type: StreamTypes.CHANNEL,
      visibility: Visibilities.PRIVATE,
      slug: "notes",
      createdBy: "usr_invoker",
    })
    runner.duringExec = async (options) => {
      const session = await sessionTokens.validate((await options.api!()).token)
      await recordSandboxReads(pool, session!, [notes])
    }

    const { output } = await runCommand(commandTool(runner, at, null, "usr_invoker"))
    const row = await StreamSandboxRepository.find(pool, at.workspaceId, at.streamId)

    expect({ contentFrom: output.contentFrom, content: row?.contentStreamIds }).toEqual({
      contentFrom: [{ streamId: notes, title: "notes" }],
      content: [notes],
    })
  })

  test("a command whose box another turn filled with unreadable content while it ran has its output withheld", async () => {
    const at = target()
    const runner = new FakeRunner()
    runner.duringExec = async () => {
      await StreamSandboxRepository.addContent(pool, { ...at, sandboxId: "fake-1", streamIds: [streamId()] })
    }

    const { output } = await runCommand(commandTool(runner, at, null, "usr_invoker"))

    expect(output.error).toBe(
      "Sandbox failed: another turn put files in this stream's sandbox while the command ran, so its output is withheld; run it again"
    )
  })

  test("a turn without an invoking user runs commands without a token", async () => {
    const runner = new FakeRunner()
    const apis: unknown[] = []
    runner.duringExec = async (options) => void apis.push(options.api)

    await runCommand(commandTool(runner, target(), null))

    expect(apis).toEqual([undefined])
  })

  test("a replaced sandbox is reported to the model and on the trace step", async () => {
    const at = target()
    const runner = new FakeRunner()
    const tool = commandTool(runner, at, null)

    await runCommand(tool)
    runner.live.clear()
    const { output, trace } = await runCommand(tool)

    expect({ replaced: output.sandboxReplaced, headline: trace.headline }).toEqual({
      replaced: "New sandbox: the previous one expired and its files are gone",
      headline: "$ echo ok · exit 0 · New sandbox: the previous one expired and its files are gone",
    })
  })
})
