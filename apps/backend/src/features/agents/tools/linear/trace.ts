import type { SourceItem, TraceSource } from "@threahq/types"

export function toTraceLinearSources(sources: SourceItem[] | undefined): TraceSource[] {
  return (sources ?? []).slice(0, 10).map((source) => ({
    type: "web",
    title: source.title,
    url: source.url,
    snippet: source.snippet,
  }))
}
