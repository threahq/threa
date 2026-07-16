import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
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
    async ({ memo_id }) => runTool(() => client.get(`/memos/${encodeURIComponent(memo_id)}`))
  )
}
