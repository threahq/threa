import { describe, expect, it, mock } from "bun:test"
import { createSaveMemoTool } from "./save-memo-tool"
import type { SaveMemoToolResult } from "./tool-deps"

const EXEC_OPTS = { toolCallId: "call_1" }

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

const input = {
  title: "Deploys only on Fridays after the smoke suite",
  abstract: "The team deploys only on Fridays, and only after the smoke suite passes.",
  knowledgeType: "decision" as const,
  keyPoints: [] as string[],
  tags: [] as string[],
  sourceMessageIds: ["msg_1"],
}

describe("save_memo tool", () => {
  it("saves a memo and reports the new id", async () => {
    const saveMemo = mock(
      async (): Promise<SaveMemoToolResult> => ({
        ok: true,
        memoId: "memo_new",
        title: input.title,
        deduped: false,
      })
    )
    const tool = createSaveMemoTool({ saveMemo })

    const result = await tool.config.execute(input, EXEC_OPTS)

    expect(saveMemo).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMessageIds: ["msg_1"], knowledgeType: "decision" })
    )
    expect(parse(result.output)).toMatchObject({ ok: true, memoId: "memo_new", deduped: false })
  })

  it("surfaces the deduped case so the model doesn't re-save", async () => {
    const saveMemo = mock(
      async (): Promise<SaveMemoToolResult> => ({
        ok: true,
        memoId: "memo_existing",
        title: "Existing",
        deduped: true,
      })
    )
    const tool = createSaveMemoTool({ saveMemo })

    const result = await tool.config.execute(input, EXEC_OPTS)
    const body = parse(result.output)

    expect(body).toMatchObject({ ok: true, memoId: "memo_existing", deduped: true })
    expect(body.note).toContain("already captured")
  })

  it("reports failure when the write fails", async () => {
    const saveMemo = mock(async (): Promise<SaveMemoToolResult> => ({ ok: false }))
    const tool = createSaveMemoTool({ saveMemo })

    const result = await tool.config.execute(input, EXEC_OPTS)

    expect(parse(result.output).ok).toBe(false)
  })

  it("rejects an empty title via the schema (min length)", () => {
    const tool = createSaveMemoTool({ saveMemo: mock(async () => ({ ok: false }) as SaveMemoToolResult) })
    expect(tool.config.inputSchema.safeParse({ ...input, title: "" }).success).toBe(false)
  })

  it("requires at least one source message via the schema", () => {
    const tool = createSaveMemoTool({ saveMemo: mock(async () => ({ ok: false }) as SaveMemoToolResult) })
    expect(tool.config.inputSchema.safeParse({ ...input, sourceMessageIds: [] }).success).toBe(false)
  })
})

describe("save_memo effects", () => {
  const effectsOf = async (result: SaveMemoToolResult) => {
    const tool = createSaveMemoTool({ saveMemo: mock(async () => result) })
    const out = await tool.config.execute(input, EXEC_OPTS)
    return tool.config.trace.effects?.(input, out)
  }

  it("declares the memo it captured", async () => {
    expect(await effectsOf({ ok: true, memoId: "memo_new", title: input.title, deduped: false })).toEqual([
      { kind: "memo", label: input.title, target: "memo_new" },
    ])
  })

  // A deduped save returned the memo that was already there; nothing was
  // written, so claiming a capture would be a lie the fallback can't tell apart.
  it("declares nothing when the save deduped", async () => {
    expect(await effectsOf({ ok: true, memoId: "memo_existing", title: "Existing", deduped: true })).toEqual([])
  })

  it("declares nothing when the write failed", async () => {
    expect(await effectsOf({ ok: false })).toEqual([])
  })
})
