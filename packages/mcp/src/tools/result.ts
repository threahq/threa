import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ThreaApiError } from "../api-client"

export class UnresolvedRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnresolvedRefError"
  }
}

export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

type QueryValue = string | number | boolean | string[] | undefined | null

export function buildQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item)
    } else {
      search.append(key, String(value))
    }
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ""
}

export function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }, null, 2) }] }
}

export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn())
  } catch (error) {
    return errorResult(error)
  }
}

export function errorResult(error: unknown): CallToolResult {
  if (error instanceof UnresolvedRefError) {
    return toolError("UNRESOLVED_REF", error.message)
  }
  if (error instanceof ThreaApiError) {
    const body: { code?: string; message: string; hint?: string } = { message: error.message }
    if (error.code) body.code = error.code
    if (error.hint) body.hint = error.hint
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ message }, null, 2) }] }
}

export type Envelope<T> = { data: T }
export type PagedEnvelope<T> = { data: T[]; hasMore?: boolean; cursor?: string | null }
