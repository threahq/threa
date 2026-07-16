import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { applyLabel, listLabels, removeLabel } from "../ops"
import type { RefResolver } from "../resolver"
import { runTool } from "./result"

export function registerLabelTools(server: McpServer, client: ThreaApiClient, resolver: RefResolver): void {
  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description:
        "List this key actor's labels and their resource assignments. Every label is private to the actor " +
        "the API key acts as; you never see another actor's labels.",
      inputSchema: {},
    },
    async () => runTool(() => listLabels(client))
  )

  server.registerTool(
    "apply_label",
    {
      title: "Apply a label to a stream",
      description:
        "Attach a label to a stream, identifying the label by its `name`. The label is found-or-created for " +
        "this key actor (labels are private per actor and keyed by their text), then assigned — so re-applying " +
        "the same name is idempotent. Any appearance field you supply (`color` as #RRGGBB, `emoji`, " +
        "`description`) overwrites that field on the existing label every time, not only at creation — so omit " +
        "them unless you intend to recolor/re-emoji the label wherever it is already used. `stream_id` accepts a " +
        "stream_ id or `#channel-slug`.",
      inputSchema: {
        name: z.string().min(1).max(100),
        stream_id: z.string(),
        color: z.string().optional(),
        emoji: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ name, stream_id, color, emoji, description }) =>
      runTool(() => applyLabel(client, resolver, { name, streamRef: stream_id, color, emoji, description }))
  )

  server.registerTool(
    "remove_label",
    {
      title: "Remove a label from a stream",
      description:
        "Remove this key actor's assignment of a label (identified by its `name`) from a stream (`stream_id` " +
        "accepts a stream_ id or `#channel-slug`). The label itself is not deleted, only its assignment to this stream.",
      inputSchema: {
        name: z.string().min(1).max(100),
        stream_id: z.string(),
      },
    },
    async ({ name, stream_id }) => runTool(() => removeLabel(client, resolver, { name, streamRef: stream_id }))
  )
}
