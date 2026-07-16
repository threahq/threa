import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { ThreaApiError } from "../api-client"

export class UnresolvedRefError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnresolvedRefError"
  }
}

export class ToolInputError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "ToolInputError"
    this.code = code
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

export interface ErrorShape {
  code: string
  message: string
  hint?: string
}

export function toErrorShape(error: unknown): ErrorShape {
  if (error instanceof UnresolvedRefError) return { code: "UNRESOLVED_REF", message: error.message }
  if (error instanceof ToolInputError) return { code: error.code, message: error.message }
  if (error instanceof ThreaApiError) {
    const shape: ErrorShape = { code: error.code ?? `HTTP_${error.status}`, message: error.message }
    if (error.hint) shape.hint = error.hint
    return shape
  }
  return { code: "ERROR", message: error instanceof Error ? error.message : String(error) }
}

export function errorResult(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(toErrorShape(error), null, 2) }] }
}

export type Envelope<T> = { data: T }
export type PagedEnvelope<T> = { data: T[]; hasMore?: boolean; cursor?: string | null }
