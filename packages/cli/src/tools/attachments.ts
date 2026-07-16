import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ThreaApiClient } from "../api-client"
import { getAttachment, getAttachmentDownloadUrl } from "../ops"
import { runTool } from "./result"

export function registerAttachmentTools(server: McpServer, client: ThreaApiClient): void {
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
    async ({ attachment_id }) => runTool(() => getAttachment(client, attachment_id))
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
    async ({ attachment_id }) => runTool(() => getAttachmentDownloadUrl(client, attachment_id))
  )
}
