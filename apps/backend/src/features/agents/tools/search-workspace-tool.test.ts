import { describe, expect, mock, test } from "bun:test"
import type { FeatureFlagValue } from "@threa/types"
import { createSearchMessagesTool } from "./search-workspace-tool"
import type { WorkspaceToolDeps } from "./tool-deps"

function makeTool(searchFlag: FeatureFlagValue<"search">) {
  const search = mock(async () => ({ results: [], conversations: [], excludedE2eStreamCount: 0 }))
  const tool = createSearchMessagesTool({
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "ws_1",
    accessibleStreamIds: ["stream_1"],
    invokingUserId: "usr_1",
    searchFlag,
    searchService: { search } as unknown as WorkspaceToolDeps["searchService"],
    storage: {} as WorkspaceToolDeps["storage"],
    attachmentService: {} as WorkspaceToolDeps["attachmentService"],
    memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
  })
  return { tool, search }
}

describe("search_messages under the search flag", () => {
  test("off: searches without deep, forwards the flag and omits conversations from the output", async () => {
    const { tool, search } = makeTool("off")

    const result = await tool.config.execute({ query: "railway deploy", exact: false }, { toolCallId: "t1" })

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "railway deploy", deep: false, searchFlag: "off" })
    )
    expect(JSON.parse(result.output)).toEqual({
      query: "railway deploy",
      exact: false,
      results: [],
      message: "No matching messages found",
    })
  })

  test("on: searches deep and reports an empty conversations group", async () => {
    const { tool, search } = makeTool("on")

    const result = await tool.config.execute({ query: "railway deploy", exact: false }, { toolCallId: "t1" })

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ deep: true, searchFlag: "on" }))
    expect(JSON.parse(result.output)).toEqual({
      query: "railway deploy",
      exact: false,
      results: [],
      conversations: [],
      message: "No matching messages found",
    })
  })
})
