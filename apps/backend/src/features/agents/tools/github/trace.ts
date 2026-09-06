import type { SourceItem, TraceSource } from "@threahq/types"

/**
 * Convert SourceItem[] attached to a tool result into TraceSource[] for the session trace.
 * Preserves the "github" source type so the frontend can render GitHub-specific affordances.
 */
export function toTraceGithubSources(sources: SourceItem[] | undefined): TraceSource[] {
  if (!sources) return []
  const out: TraceSource[] = []
  for (const s of sources) {
    if (!s.url) continue
    out.push({
      type: "github",
      title: s.title,
      url: s.url,
      snippet: s.snippet,
    })
  }
  return out
}
