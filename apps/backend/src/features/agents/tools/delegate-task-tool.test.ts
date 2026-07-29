import { describe, expect, it, mock } from "bun:test"
import { createDelegateTaskTool } from "./delegate-task-tool"
import type { DelegateTaskToolResult } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

const INPUT = {
  title: "Add rate limiting to the webhook endpoint",
  brief: "Implement a token bucket. Done when the e2e suite passes.",
  contextRefs: ["memo:memo_1", "shared-message:stream_1/msg_1"],
}

describe("delegate_task tool", () => {
  it("creates a delegation and echoes the id + dropped refs", async () => {
    const delegateTask = mock(
      async (): Promise<DelegateTaskToolResult> => ({
        ok: true,
        delegationId: "dlg_1",
        droppedRefs: [{ ref: "memo:memo_1", reason: "memo-not-active" }],
      })
    )
    const tool = createDelegateTaskTool({ delegateTask })

    const result = await tool.config.execute(INPUT, EXEC_OPTS)

    expect(delegateTask).toHaveBeenCalledWith(INPUT)
    const body = parse(result.output)
    expect(body).toMatchObject({
      ok: true,
      delegationId: "dlg_1",
      droppedRefs: [{ ref: "memo:memo_1", reason: "memo-not-active" }],
    })
  })

  it("defaults contextRefs to [] when the model omits them", async () => {
    const delegateTask = mock(
      async (): Promise<DelegateTaskToolResult> => ({ ok: true, delegationId: "dlg_1", droppedRefs: [] })
    )
    const tool = createDelegateTaskTool({ delegateTask })

    await tool.config.execute({ title: "t", brief: "b" } as never, EXEC_OPTS)

    expect(delegateTask).toHaveBeenCalledWith({ title: "t", brief: "b", contextRefs: [] })
  })

  it("surfaces a callback refusal as ok:false with the error", async () => {
    const delegateTask = mock(
      async (): Promise<DelegateTaskToolResult> => ({ ok: false, error: "delegations unavailable" })
    )
    const tool = createDelegateTaskTool({ delegateTask })

    const body = parse((await tool.config.execute(INPUT, EXEC_OPTS)).output)
    expect(body).toEqual({ ok: false, error: "delegations unavailable" })
  })

  it("catches a thrown callback error and reports ok:false without leaking internals", async () => {
    const delegateTask = mock(async (): Promise<DelegateTaskToolResult> => {
      throw new Error("pg down")
    })
    const tool = createDelegateTaskTool({ delegateTask })

    const body = parse((await tool.config.execute(INPUT, EXEC_OPTS)).output)
    expect(body).toEqual({ ok: false, error: "Failed to create delegation" })
  })
})

describe("delegate_task effects", () => {
  const effectsOf = async (result: DelegateTaskToolResult) => {
    const tool = createDelegateTaskTool({ delegateTask: mock(async () => result) })
    const out = await tool.config.execute(INPUT, EXEC_OPTS)
    return tool.config.trace.effects?.(INPUT, out)
  }

  it("declares the delegation it created", async () => {
    expect(await effectsOf({ ok: true, delegationId: "dlg_1", droppedRefs: [] })).toEqual([
      { kind: "delegation", label: INPUT.title, target: "dlg_1" },
    ])
  })

  it("declares nothing when the callback refused", async () => {
    expect(await effectsOf({ ok: false, error: "delegations unavailable" })).toEqual([])
  })
})
