import { describe, expect, test } from "bun:test"
import { trace } from "@opentelemetry/api"
import { AgentStepTypes } from "@threa/types"
import { inMemoryExporter as exporter } from "./test-otel-setup"
import { OtelObserver } from "./otel-observer"

/**
 * Tracer provider, context manager, and exporter are all installed once via
 * `../test-otel-setup`. We import the shared exporter so multiple test files
 * (this one + `researcher-trace.test.ts`) don't race on `setGlobalTracerProvider`.
 *
 * This mirrors what `NodeSDK.start()` does in production (`apps/backend/src/
 * lib/langfuse/langfuse.ts`).
 */

function makeObserver(): OtelObserver {
  return new OtelObserver({
    sessionId: "session_test",
    streamId: "stream_test",
    personaId: "persona_test",
  })
}

describe("OtelObserver tool span nesting (Langfuse trace fix)", () => {
  test("nested spans created inside wrapToolExecution become children of the tool span", async () => {
    // Regression for the bug where workspace_research's planner/evaluator
    // `generateObject` calls were orphaned because the tool span was created
    // but never made the active context. The runtime now wraps each tool
    // execute in `wrapToolExecution`, which sets the tool span as active.
    exporter.reset()
    const observer = makeObserver()

    await observer.handle({ type: "session:start", sessionId: "session_test", inputSummary: "test" })
    await observer.handle({
      type: "tool:start",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      input: { query: "what did we decide" },
    })

    // Simulate the AI SDK creating a span for an inner generateObject call —
    // this is what `experimental_telemetry: { isEnabled: true }` does under
    // the hood. If `wrapToolExecution` propagates the tool span as active,
    // this span's parent is the tool span; otherwise it'd be the root.
    await observer.wrapToolExecution!("tc_1", async () => {
      const innerTracer = trace.getTracer("test")
      const innerSpan = innerTracer.startSpan("ai.generateObject")
      innerSpan.end()
    })

    await observer.handle({
      type: "tool:complete",
      toolCallId: "tc_1",
      toolName: "workspace_research",
      input: {},
      output: "{}",
      durationMs: 10,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: "{}" },
    })
    await observer.handle({
      type: "session:end",
      messagesSent: 0,
      sourceCount: 0,
    })

    const spans = exporter.getFinishedSpans()
    const innerSpan = spans.find((s) => s.name === "ai.generateObject")
    const toolSpan = spans.find((s) => s.name === "tool:workspace_research")
    const rootSpan = spans.find((s) => s.name === "companion-session")

    expect(rootSpan).toBeDefined()
    expect(toolSpan).toBeDefined()
    expect(innerSpan).toBeDefined()

    // The tool span should be a child of the root.
    expect(toolSpan?.parentSpanContext?.spanId).toBe(rootSpan!.spanContext().spanId)
    // And the inner AI SDK span should be a child of the TOOL span — this
    // is the property that was broken before the fix.
    expect(innerSpan?.parentSpanContext?.spanId).toBe(toolSpan!.spanContext().spanId)
  })

  test("wrapToolExecution falls back to the root context when the toolCallId is unknown", async () => {
    // Defensive: if a tool execute somehow gets called without a preceding
    // tool:start (unusual edge case), we should still nest under the root
    // rather than orphaning.
    exporter.reset()
    const observer = makeObserver()

    await observer.handle({ type: "session:start", sessionId: "session_test", inputSummary: "test" })

    await observer.wrapToolExecution!("tc_orphan", async () => {
      const innerTracer = trace.getTracer("test")
      const innerSpan = innerTracer.startSpan("inner-orphan")
      innerSpan.end()
    })

    await observer.handle({
      type: "session:end",
      messagesSent: 0,
      sourceCount: 0,
    })

    const spans = exporter.getFinishedSpans()
    const innerSpan = spans.find((s) => s.name === "inner-orphan")
    const rootSpan = spans.find((s) => s.name === "companion-session")

    expect(innerSpan?.parentSpanContext?.spanId).toBe(rootSpan!.spanContext().spanId)
  })

  test("wrapToolExecution cleans up its context entry on tool:complete", async () => {
    // After tool:complete, the toolContexts map should not retain the entry —
    // otherwise long-running sessions would leak contexts.
    exporter.reset()
    const observer = makeObserver()

    await observer.handle({ type: "session:start", sessionId: "session_test", inputSummary: "test" })
    await observer.handle({
      type: "tool:start",
      toolCallId: "tc_2",
      toolName: "workspace_research",
      stepType: AgentStepTypes.WORKSPACE_SEARCH,
      input: {},
    })
    await observer.handle({
      type: "tool:complete",
      toolCallId: "tc_2",
      toolName: "workspace_research",
      input: {},
      output: "{}",
      durationMs: 5,
      trace: { stepType: AgentStepTypes.WORKSPACE_SEARCH, content: "{}" },
    })

    // After the tool completes, calling wrapToolExecution with the same id
    // should fall back to the root context (not throw, not nest under the
    // dead tool span).
    await observer.wrapToolExecution!("tc_2", async () => {
      const innerTracer = trace.getTracer("test")
      innerTracer.startSpan("post-complete").end()
    })

    await observer.handle({
      type: "session:end",
      messagesSent: 0,
      sourceCount: 0,
    })

    const spans = exporter.getFinishedSpans()
    const postCompleteSpan = spans.find((s) => s.name === "post-complete")
    const rootSpan = spans.find((s) => s.name === "companion-session")

    expect(postCompleteSpan?.parentSpanContext?.spanId).toBe(rootSpan!.spanContext().spanId)
  })
})
