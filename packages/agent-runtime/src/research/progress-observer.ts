import type { SourceItem, TraceSource } from "@threa/types"
import type { AgentEvent } from "../runtime/agent-events"
import type { AgentObserver } from "../runtime/agent-observer"
import { normalizeSourceType, readStringField } from "./research-support"

/**
 * Lightweight observer for the general research sub-agent's inner AgentRuntime.
 *
 * Two jobs, neither of which touches the database:
 *  1. Translate tool lifecycle events into human-readable substep text and
 *     forward it to `onSubstep`. The caller relays these to its own trace (the
 *     persona's research step on the backend, the sealed trace in the enclave),
 *     so the run renders a phase timeline.
 *  2. Accumulate citation sources as tools complete. The inner runtime only
 *     returns its merged `sources` on a clean finish; if the run is aborted
 *     (user stop / deadline) that return never happens, so we collect sources
 *     here too and the researcher falls back to them for partial results.
 */
export class ResearchProgressObserver implements AgentObserver {
  private readonly collectedSources: SourceItem[] = []
  private readonly seenSourceKeys = new Set<string>()

  constructor(private readonly onSubstep: (text: string) => void) {}

  /** Sources accumulated from completed tool calls, deduped by url+title. */
  get sources(): SourceItem[] {
    return this.collectedSources
  }

  async handle(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "tool:start":
        this.emit(describeToolStart(event.toolName, event.input))
        break
      case "tool:progress":
        if (event.substep.trim()) this.emit(event.substep)
        break
      case "tool:complete":
        this.collect(event.trace.sources)
        break
      default:
        break
    }
  }

  private emit(text: string): void {
    try {
      this.onSubstep(text)
    } catch {
      // Substep delivery is best-effort; never let trace plumbing fault the run.
    }
  }

  private collect(traceSources?: TraceSource[]): void {
    if (!traceSources) return
    for (const source of traceSources) {
      if (!source.url || !source.title) continue
      const key = `${source.url}|${source.title}`
      if (this.seenSourceKeys.has(key)) continue
      this.seenSourceKeys.add(key)
      this.collectedSources.push({
        type: normalizeSourceType(source.type),
        title: source.title,
        url: source.url,
        snippet: source.snippet,
      })
    }
  }
}

/** Human-readable phase text for a tool call, used as a substep. */
function describeToolStart(toolName: string, input: unknown): string {
  const query = readStringField(input, "query")
  const url = readStringField(input, "url")

  if (toolName === "web_search") return query ? `Searching the web: "${query}"` : "Searching the web…"
  if (toolName === "read_url") return url ? `Reading ${url}` : "Reading a page…"
  if (toolName.startsWith("github_")) return "Checking GitHub…"
  if (toolName.startsWith("linear_")) return "Checking Linear…"
  if (
    toolName === "search_messages" ||
    toolName === "search_streams" ||
    toolName === "search_users" ||
    toolName === "get_stream_messages" ||
    toolName === "search_attachments" ||
    toolName === "describe_memo"
  ) {
    return query ? `Searching the workspace: "${query}"` : "Searching the workspace…"
  }
  return "Researching…"
}
