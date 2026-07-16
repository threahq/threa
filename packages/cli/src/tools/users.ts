import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { listUsers } from "../ops"
import { runTool } from "./result"

export function registerUserTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "list_users",
    {
      title: "List workspace users",
      description:
        "List users in this workspace. Filter with `query` (text match on name or email — NOT slug; slugs resolve via the @slug ref form). Page by passing the " +
        "previous response's `cursor` value back as `after`; `hasMore` tells you when to stop. limit ≤ 200 " +
        "(default 50).",
      inputSchema: {
        query: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ query, after, limit }) => runTool(() => listUsers(client, { query, after, limit }))
  )
}
