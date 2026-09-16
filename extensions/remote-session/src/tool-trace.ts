// Wire format parsed by `apps/frontend/src/components/trace/trace-step.tsx`; duplicated because this package installs standalone.
const TOOL_TRACE_FORMAT = "pi_tool_trace"
const TOOL_TRACE_MAX_CHARS = 9_500
const HEADLINE_MAX_CHARS = 500
const TRUNCATION_MARKER = "\n\n…[section truncated;"

export type ToolTraceSectionLabel = "Arguments" | "Output" | "Error output" | "Details"

export interface ToolTraceSection {
  label: ToolTraceSectionLabel
  body: string
  lang: string | null
}

/**
 * Serialize a structured tool trace under the step content limit, trimming the
 * largest section first (the same algorithm as pi-remote and claude-code-remote).
 */
export function toolTraceContent(params: { headline: string; sections: ToolTraceSection[] }): string {
  const headline =
    params.headline.length <= HEADLINE_MAX_CHARS ? params.headline : `${params.headline.slice(0, HEADLINE_MAX_CHARS)}…`
  const sections = params.sections.map((section) => ({ ...section, originalBody: section.body }))

  for (let attempt = 0; attempt < 24; attempt++) {
    const payload = JSON.stringify({
      format: TOOL_TRACE_FORMAT,
      headline,
      sections: sections.map(({ originalBody: _originalBody, ...section }) => section),
    })
    if (payload.length <= TOOL_TRACE_MAX_CHARS) return payload

    const largestIndex = sections.reduce(
      (largest, section, index) => (section.body.length > sections[largest]!.body.length ? index : largest),
      0
    )
    const largest = sections[largestIndex]
    if (!largest || largest.originalBody.length === 0) break

    const overflow = payload.length - TOOL_TRACE_MAX_CHARS
    const currentVisibleLength = largest.body.includes(TRUNCATION_MARKER)
      ? largest.body.indexOf(TRUNCATION_MARKER)
      : largest.body.length
    const nextVisibleLength = Math.max(0, currentVisibleLength - Math.max(overflow + 256, 512))
    const omitted = largest.originalBody.length - nextVisibleLength
    largest.body = `${largest.originalBody.slice(0, nextVisibleLength).trimEnd()}${TRUNCATION_MARKER} ${omitted} more characters]`
  }

  return JSON.stringify({
    format: TOOL_TRACE_FORMAT,
    headline,
    sections: [{ label: "Details", body: "Trace content was too large to serialize safely.", lang: null }],
  })
}
