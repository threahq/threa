import { api } from "./client"
import type {
  ContextCategory,
  ListStreamContextOccurrencesResponse,
  ListStreamContextResponse,
  StreamContextScope,
} from "@threahq/types"

/** The narrowing filters both routes accept. `from` is an author **id** — the
 *  panel resolves `from:@slug` against workspace users before calling. */
export interface StreamContextFilters {
  q?: string
  from?: string
  /** ISO datetime. */
  before?: string
  /** ISO datetime. */
  after?: string
}

export interface ListStreamContextRequest extends StreamContextFilters {
  scope?: StreamContextScope
  category?: ContextCategory
  /** Serialized comma-separated; for a chip standing for more than one category. */
  categories?: ContextCategory[]
  cursor?: string
  limit?: number
}

export interface ListStreamContextOccurrencesRequest extends StreamContextFilters {
  category: ContextCategory
  groupKey: string
  scope?: StreamContextScope
  cursor?: string
  limit?: number
}

function toQueryString(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(","))
      continue
    }
    search.set(key, String(value))
  }
  const serialized = search.toString()
  return serialized ? `?${serialized}` : ""
}

export const streamContextApi = {
  /** One page of the "In this stream" feed, newest first. `counts` rides only
   *  on the first page; `mode: "client"` means the stream is sealed and the
   *  server holds no index for it. */
  list(
    workspaceId: string,
    streamId: string,
    request: ListStreamContextRequest = {}
  ): Promise<ListStreamContextResponse> {
    return api.get<ListStreamContextResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/context${toQueryString({ ...request })}`
    )
  },

  /** Every occurrence of one collapsed group, under the same active filters
   *  the collapsed row's `occurrenceCount` was counted with. */
  occurrences(
    workspaceId: string,
    streamId: string,
    request: ListStreamContextOccurrencesRequest
  ): Promise<ListStreamContextOccurrencesResponse> {
    return api.get<ListStreamContextOccurrencesResponse>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/context/occurrences${toQueryString({ ...request })}`
    )
  },
}
