import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { getMemo, recallMemos } from "../ops"
import { runTool } from "./result"

export function registerMemoTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "get_memo",
    {
      title: "Get a memo",
      description:
        "Retrieve one memo by id, together with its source stream and the source messages it was extracted " +
        "from (provenance) plus any successor memo id. Use this to trace a memory back to the exact " +
        "conversation that produced it. Find memos in the first place with the `search` tool (what: 'memos').",
      inputSchema: {
        memo_id: z.string(),
      },
    },
    async ({ memo_id }) => runTool(() => getMemo(client, memo_id))
  )

  server.registerTool(
    "recall_memos",
    {
      title: "Recall memos for a message",
      description:
        "Pass the message you are about to answer and get back the few memos that actually help with it, " +
        "scored for relevance (at most 5). An empty `data` with outcome 'nothing_relevant' or 'no_candidates' " +
        "means memory holds nothing useful for it; 'unscored', 'timeout' or 'failed' mean recall could not " +
        "judge, so fall back to the `search` tool (what: 'memos'). Each call runs a model, so recall once per " +
        "message rather than per idea; use `search` to explore.",
      inputSchema: {
        message: z.string().min(1),
      },
    },
    async ({ message }) => runTool(() => recallMemos(client, message))
  )
}
