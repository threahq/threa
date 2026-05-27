import { trace, context } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"

/**
 * Shared OTEL test harness for agent runtime / researcher tests.
 *
 * Importing this module installs the AsyncLocalStorageContextManager and a
 * `BasicTracerProvider` backed by a single `InMemorySpanExporter`. We do it
 * once at module load (not per file) because `trace.setGlobalTracerProvider`
 * is global state — calling it from multiple test files races, and only the
 * last winner has its exporter wired up. Sharing one exporter avoids that
 * footgun.
 *
 * Tests should call `inMemoryExporter.reset()` at the start of each case to
 * isolate spans across cases.
 */
export const inMemoryExporter = new InMemorySpanExporter()

const contextManager = new AsyncLocalStorageContextManager()
contextManager.enable()
context.setGlobalContextManager(contextManager)

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(inMemoryExporter)],
})
trace.setGlobalTracerProvider(provider)
