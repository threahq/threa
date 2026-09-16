import { logger } from "../../lib/logger"

export interface SessionAbortContext {
  workspaceId: string
  streamId: string
}

interface RegistryEntry {
  controller: AbortController
  context: SessionAbortContext
  generation: number
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
   * `register` without racing. The entry belongs to one execution generation: a
   * newer generation replaces an older entry, and an older one never takes over
   * a newer entry.
   */
  register(sessionId: string, context: SessionAbortContext, generation: number): AbortController {
    const existing = this.entries.get(sessionId)
    if (existing && existing.generation > generation) {
      return new AbortController()
    }
    if (existing && existing.generation === generation && !existing.controller.signal.aborted) {
      return existing.controller
    }

    const controller = new AbortController()
    this.entries.set(sessionId, { controller, context, generation })
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
   * Remove the registry entry for a session if `generation` still owns it. Safe
   * to call multiple times; a replaced execution's cleanup leaves the newer entry.
   */
  unregister(sessionId: string, generation: number): void {
    if (this.entries.get(sessionId)?.generation === generation) this.entries.delete(sessionId)
  }
}
