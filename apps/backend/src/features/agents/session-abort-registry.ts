import { logger } from "../../lib/logger"

export interface SessionAbortContext {
  workspaceId: string
  streamId: string
}

interface RegistryEntry {
  controller: AbortController
  context: SessionAbortContext
}

/**
 * Per-session AbortController registry for cooperative, graceful tool cancellation.
 *
 * Purpose: the socket handler for `agent_session:research:abort` (and similar future
 * events) needs a way to signal a running tool inside a session to stop cleanly. This
 * is deliberately NOT the same as `AgentRuntime.shouldAbort`, which throws and marks
 * the session as failed. Tools that use this signal are expected to return partial
 * results so the agent loop can continue.
 *
 * Scope: one controller per session. A session running tools sequentially within a
 * single LLM turn never has two overlapping tool calls, so a single controller is
 * sufficient. If a tool finishes normally the entry stays in place until the session
 * ends (cheap — it's just an AbortController); on session end the caller must
 * `unregister(sessionId)` to free the entry.
 */
export class SessionAbortRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  /**
   * Register a fresh AbortController for a session. Returns the controller so the
   * caller can pass its signal to the tool. If an entry already exists for the
   * session, the existing entry is returned (idempotent) — this allows the tool
   * layer's `toolSignalProvider` and the `runWorkspaceAgent` closure to both call
   * `register` without racing.
   */
  register(sessionId: string, context: SessionAbortContext): AbortController {
    const existing = this.entries.get(sessionId)
    if (existing && !existing.controller.signal.aborted) {
      return existing.controller
    }

    const controller = new AbortController()
    this.entries.set(sessionId, { controller, context })
    return controller
  }

  get(sessionId: string): AbortController | undefined {
    return this.entries.get(sessionId)?.controller
  }

  /**
   * Abort the registered controller for a session. Returns true if an entry existed
   * and was aborted, false if no entry was present. Does NOT remove the entry —
   * `unregister` is called by the owning code at session end.
   */
  abort(sessionId: string, reason?: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry) return false
    if (entry.controller.signal.aborted) return true
    try {
      entry.controller.abort(reason ?? "user_abort")
    } catch (err) {
      logger.warn({ err, sessionId }, "SessionAbortRegistry.abort threw")
      return false
    }
    return true
  }

  /**
   * Remove the registry entry for a session. Safe to call multiple times.
   * Should be called once the session ends so the registry doesn't leak entries.
   */
  unregister(sessionId: string): void {
    this.entries.delete(sessionId)
  }
}
