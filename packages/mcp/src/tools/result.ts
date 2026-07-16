import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ThreaApiError } from "../api-client"

export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

export function errorResult(error: unknown): CallToolResult {
  if (error instanceof ThreaApiError) {
    const body: { code?: string; message: string; hint?: string } = { message: error.message }
    if (error.code) body.code = error.code
    if (error.hint) body.hint = error.hint
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ message }, null, 2) }] }
}
