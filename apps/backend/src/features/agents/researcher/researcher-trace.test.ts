import { describe, expect, test } from "bun:test"
import { trace, context, SpanStatusCode } from "@opentelemetry/api"
import { inMemoryExporter as exporter } from "@threa/agent-runtime/test-otel-setup"
import { withResearcherSpan } from "./researcher-trace"

describe("withResearcherSpan", () => {
  test("nests under the active span and records langfuse input/output", async () => {
    exporter.reset()
    const outerTracer = trace.getTracer("test-outer")
    const outer = outerTracer.startSpan("outer")
    const outerCtx = trace.setSpan(context.active(), outer)

    await context.with(outerCtx, async () => {
      await withResearcherSpan(
        "ws-research:test",
        {
          input: { phase: "test", n: 3 },
          extractOutput: (r: number) => ({ doubled: r }),
          attributes: { "ws.test.tag": "value" },
        },
        async () => 21
      )
    })
    outer.end()

    const spans = exporter.getFinishedSpans()
    const outerSpan = spans.find((s) => s.name === "outer")
    const childSpan = spans.find((s) => s.name === "ws-research:test")
    expect(outerSpan).toBeDefined()
    expect(childSpan).toBeDefined()
    expect(childSpan?.parentSpanContext?.spanId).toBe(outerSpan!.spanContext().spanId)
    expect(childSpan?.attributes["langfuse.observation.input"]).toBe(JSON.stringify({ phase: "test", n: 3 }))
    expect(childSpan?.attributes["langfuse.observation.output"]).toBe(JSON.stringify({ doubled: 21 }))
    expect(childSpan?.attributes["ws.test.tag"]).toBe("value")
    expect(childSpan?.status.code).toBe(SpanStatusCode.OK)
  })

  test("makes itself the active context for spans created inside fn", async () => {
    exporter.reset()
    await withResearcherSpan("ws-research:parent", {}, async () => {
      const innerTracer = trace.getTracer("test-inner")
      innerTracer.startSpan("inner-child").end()
    })

    const spans = exporter.getFinishedSpans()
    const parent = spans.find((s) => s.name === "ws-research:parent")
    const child = spans.find((s) => s.name === "inner-child")
    expect(parent).toBeDefined()
    expect(child?.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId)
  })

  test("on error, sets ERROR status, rethrows, and does not record output", async () => {
    exporter.reset()
    await expect(
      withResearcherSpan(
        "ws-research:fails",
        { input: { x: 1 }, extractOutput: () => "should-not-be-recorded" },
        async () => {
          throw new Error("boom")
        }
      )
    ).rejects.toThrow("boom")

    const span = exporter.getFinishedSpans().find((s) => s.name === "ws-research:fails")
    expect(span).toBeDefined()
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(span?.status.message).toBe("boom")
    expect(span?.attributes["langfuse.observation.output"]).toBeUndefined()
  })
})
