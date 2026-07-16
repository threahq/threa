import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { KNOWLEDGE_TYPES, MEMO_SCOPES, MEMO_TYPES } from "./constants"
import { runTool } from "./result"

export function registerMemoTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "search_memos",
    {
      title: "Search workspace memos",
      description:
        "Search Threa's GAM (General Agentic Memory): the knowledge automatically extracted and preserved from " +
        "this workspace's conversations — decisions, learnings, procedures, context, references. Search these " +
        "BEFORE asking a human, because the answer to 'what did we decide / how do we do X / why is it this way' " +
        "usually already lives here. `query` is the semantic search text (meaning-based retrieval): pass the " +
        "idea you're after even if you don't know the exact wording. Leave `query` empty to browse the most " +
        "recent memos. Set `exact: true` (or wrap the query in double quotes) to match the literal phrase " +
        "instead of by meaning. The rest are hard filters ANDed onto the results: `stream_ids` limits to source " +
        "streams; `memo_type` is the shape of the source (a single message vs. a whole conversation); " +
        "`knowledge_type` is the kind of knowledge; `tags` matches memo tags; `scope` is the memo's audience " +
        "(user = private to this key's user, stream = one stream, workspace = everyone). `before`/`after` bound " +
        "by ISO-8601 datetime. limit ≤ 100 (default 20). Use get_memo for a memo's source-message provenance.",
      inputSchema: {
        query: z.string().optional(),
        exact: z.boolean().optional(),
        stream_ids: z.array(z.string()).optional(),
        memo_type: z.array(z.enum(MEMO_TYPES)).optional(),
        knowledge_type: z.array(z.enum(KNOWLEDGE_TYPES)).optional(),
        tags: z.array(z.string()).optional(),
        scope: z.enum(MEMO_SCOPES).optional(),
        before: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ query, exact, stream_ids, memo_type, knowledge_type, tags, scope, before, after, limit }) =>
      runTool(() =>
        client.post("/memos/search", {
          query,
          exact,
          streams: stream_ids,
          memoType: memo_type,
          knowledgeType: knowledge_type,
          tags,
          scope,
          before,
          after,
          limit,
        })
      )
  )

  server.registerTool(
    "get_memo",
    {
      title: "Get a memo",
      description:
        "Retrieve one memo by id, together with its source stream and the source messages it was extracted " +
        "from (provenance) plus any successor memo id. Use this to trace a memory back to the exact " +
        "conversation that produced it.",
      inputSchema: {
        memo_id: z.string(),
      },
    },
    async ({ memo_id }) => runTool(() => client.get(`/memos/${encodeURIComponent(memo_id)}`))
  )
}
