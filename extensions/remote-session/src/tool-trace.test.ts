import { describe, expect, test } from "bun:test"
import { toolTraceContent } from "./tool-trace"

describe("toolTraceContent", () => {
  test("serializes the pi_tool_trace wire shape", () => {
    const sections = [
      { label: "Arguments" as const, body: '{"path":"a.ts"}', lang: "json" },
      { label: "Output" as const, body: "ok", lang: null },
    ]
    expect(JSON.parse(toolTraceContent({ headline: "Read a.ts", sections }))).toEqual({
      format: "pi_tool_trace",
      headline: "Read a.ts",
      sections,
    })
  })

  test("truncates the largest section to fit the payload limit", () => {
    const content = toolTraceContent({
      headline: "Run",
      sections: [
        { label: "Arguments", body: "short", lang: null },
        { label: "Output", body: '"x"\n'.repeat(5_000), lang: null },
      ],
    })
    const parsed = JSON.parse(content)
    expect(content.length).toBeLessThanOrEqual(9_500)
    expect(parsed.sections[0]).toEqual({ label: "Arguments", body: "short", lang: null })
    expect(parsed.sections[1].body).toMatch(/…\[section truncated; \d+ more characters\]$/)
  })

  test("trims every oversized section and caps the headline so the payload always fits", () => {
    const body = "y".repeat(5_000)
    const content = toolTraceContent({
      headline: "h".repeat(12_000),
      sections: [
        { label: "Arguments", body, lang: null },
        { label: "Output", body, lang: null },
        { label: "Details", body, lang: null },
      ],
    })
    const parsed = JSON.parse(content)
    expect({
      fits: content.length <= 9_500,
      headline: parsed.headline.length,
      labels: parsed.sections.map((s: { label: string }) => s.label),
    }).toEqual({
      fits: true,
      headline: 501,
      labels: ["Arguments", "Output", "Details"],
    })
  })
})
