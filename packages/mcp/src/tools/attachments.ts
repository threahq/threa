import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { EXTRACTION_CONTENT_TYPES } from "./constants"
import { runTool } from "./result"

export function registerAttachmentTools(server: McpServer, client: ThreaApiClient): void {
  server.registerTool(
    "search_attachments",
    {
      title: "Search attachments",
      description:
        "Search accessible attachments by filename or by their extracted content (Threa extracts text and a " +
        "summary from uploaded files). `query` is the search text (required). Narrow with `stream_ids` (source " +
        "streams) and `content_types`, which classify the extracted content: chart, table, diagram, screenshot, " +
        "photo, document, other. limit ≤ 50 (default 20). Each hit carries the attachment id, filename, mime " +
        "type, content type, and summary — call get_attachment for the full extracted text.",
      inputSchema: {
        query: z.string().min(1),
        stream_ids: z.array(z.string()).optional(),
        content_types: z.array(z.enum(EXTRACTION_CONTENT_TYPES)).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, stream_ids, content_types, limit }) =>
      runTool(() =>
        client.post("/attachments/search", {
          query,
          streams: stream_ids,
          contentTypes: content_types,
          limit,
        })
      )
  )

  server.registerTool(
    "get_attachment",
    {
      title: "Get an attachment",
      description:
        "Retrieve an attachment's metadata (filename, mime type, size, processing status) and its extracted " +
        "content when available: `data.extraction` carries a summary and `fullText` (the full extracted " +
        "text) once processing has finished — it is null while extraction is pending or when the file type " +
        "yields no text. Read the text here rather than downloading the file when you only need its content.",
      inputSchema: {
        attachment_id: z.string(),
      },
    },
    async ({ attachment_id }) => runTool(() => client.get(`/attachments/${encodeURIComponent(attachment_id)}`))
  )

  server.registerTool(
    "get_attachment_download_url",
    {
      title: "Get an attachment download URL",
      description:
        "Create a short-lived signed URL to download the raw bytes of an attachment. The response is " +
        "{ data: { url, expiresIn } } where expiresIn is the lifetime in seconds — fetch the bytes yourself promptly, the " +
        "URL expires. Prefer get_attachment when you only need the extracted text.",
      inputSchema: {
        attachment_id: z.string(),
      },
    },
    async ({ attachment_id }) => runTool(() => client.get(`/attachments/${encodeURIComponent(attachment_id)}/url`))
  )
}
