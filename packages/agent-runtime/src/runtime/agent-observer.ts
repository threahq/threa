import type { AgentEvent } from "./agent-events"

/**
 * Observes agent runtime events without coupling tracking to execution.
 * Implementations handle DB persistence, OTEL spans, analytics, etc.
 */
export interface AgentObserver {
  handle(event: AgentEvent): Promise<void>
  cleanup?(): Promise<void>

  /**
   * Wrap an async operation with observer-provided context.
   * Used by OTEL to propagate the root span as the active context
   * so that child spans (e.g., from Vercel AI SDK) nest correctly.
   */
  wrapExecution?<T>(fn: () => Promise<T>): Promise<T>

  /**
   * Wrap a tool's execute() with observer-provided context that knows about
   * the tool's own span. Used by OTEL so that child spans created inside the
   * tool (e.g. nested AI SDK `generateObject` calls in the workspace
   * researcher) nest under the tool span instead of orphaning under the root.
   *
   * The runtime emits `tool:start` BEFORE invoking this so observers have a
   * chance to register the tool's context first. If no observer registers a
   * tool context, this is a no-op (the operation runs in the current
   * context, which is normally the root span context from `wrapExecution`).
   */
  wrapToolExecution?<T>(toolCallId: string, fn: () => Promise<T>): Promise<T>
}
