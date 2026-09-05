import { describe, expect, test, mock } from "bun:test"
import { createWorkspaceResearchTool } from "./workspace-research-tool"
import type { WorkspaceAgentResult } from "../researcher"

const baseResult: WorkspaceAgentResult = {
  retrievedContext: "## Retrieved Knowledge\nUseful workspace details.",
  sources: [
    {
      type: "workspace" as const,
      title: "Design Notes",
      url: "/w/ws_1/streams/stream_1?message=msg_1",
      snippet: "Important prior decision",
    },
  ],
  memos: [
    {
      memo: {} as unknown as import("../../memos").Memo,
      distance: 0.1,
      sourceStream: null,
    },
  ],
  messages: [],
  attachments: [],
  substeps: [
    { text: "Planning queries…", at: "2026-04-10T12:00:00.000Z" },
    { text: "Searching memos, messages, and attachments…", at: "2026-04-10T12:00:01.000Z" },
  ],
}

describe("workspace_research tool", () => {
  test("should pass query + opts to workspace agent and return structured AgentToolResult", async () => {
    const runWorkspaceAgent = mock(async (_query: string, _opts: unknown) => baseResult)

    const tool = createWorkspaceResearchTool({ runWorkspaceAgent, searchFlag: "on" })
    const onProgress = mock((_s: string) => {})
    const controller = new AbortController()
    const result = await tool.config.execute(
      { query: "What were the design decisions?" },
      { toolCallId: "test", onProgress, signal: controller.signal }
    )

    expect(runWorkspaceAgent).toHaveBeenCalledTimes(1)
    const [calledQuery, calledOpts] = runWorkspaceAgent.mock.calls[0] ?? []
    expect(calledQuery).toBe("What were the design decisions?")
    expect(calledOpts).toMatchObject({
      signal: controller.signal,
    })
    expect(typeof (calledOpts as { deadlineAt: number }).deadlineAt).toBe("number")

    const status = JSON.parse(result.output)
    expect(status).toMatchObject({
      status: "ok",
      partial: false,
      partialReason: null,
      contextAdded: true,
      sourceCount: 1,
      memoCount: 1,
      messageCount: 0,
      attachmentCount: 0,
    })
    expect(Array.isArray(status.substeps)).toBe(true)
    expect(status.substeps).toHaveLength(2)

    expect(result.sources).toEqual([
      {
        title: "Design Notes",
        url: "/w/ws_1/streams/stream_1?message=msg_1",
        type: "workspace",
        snippet: "Important prior decision",
      },
    ])

    expect(result.systemContext).toBe("## Retrieved Knowledge\nUseful workspace details.")
  })

  test("propagates onProgress substeps to the runtime onProgress callback", async () => {
    const runWorkspaceAgent = mock(
      async (_query: string, opts: { onSubstep: (s: string) => void }): Promise<WorkspaceAgentResult> => {
        opts.onSubstep("Planning queries…")
        opts.onSubstep("Searching memos, messages, and attachments…")
        return baseResult
      }
    )

    const onProgress = mock((_s: string) => {})
    const tool = createWorkspaceResearchTool({ runWorkspaceAgent, searchFlag: "on" })
    await tool.config.execute({ query: "q" }, { toolCallId: "test", onProgress })

    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress.mock.calls[0]?.[0]).toBe("Planning queries…")
    expect(onProgress.mock.calls[1]?.[0]).toBe("Searching memos, messages, and attachments…")
  })

  test("serializes partial results with partialReason in the output JSON", async () => {
    const runWorkspaceAgent = mock(
      async (): Promise<WorkspaceAgentResult> => ({
        ...baseResult,
        partial: true,
        partialReason: "user_abort",
      })
    )

    const tool = createWorkspaceResearchTool({ runWorkspaceAgent, searchFlag: "on" })
    const result = await tool.config.execute({ query: "q" }, { toolCallId: "test" })
    const parsed = JSON.parse(result.output)
    expect(parsed.status).toBe("partial")
    expect(parsed.partial).toBe(true)
    expect(parsed.partialReason).toBe("user_abort")
  })
})
