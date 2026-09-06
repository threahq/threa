import type { AccessLogSink } from "@threahq/agent-runtime"
import { logger } from "../../lib/logger"
import type { AccessLogService } from "./service"
import { aiOperation } from "./operations"
import type { AuditSubjectRef } from "./subjects"

/**
 * Maps `createAI` sink events to `disclose` access-log rows (design §7.3). Lives
 * in the backend because agent-runtime never imports it — the wrapper only knows
 * the `AccessLogSink` shape. Actor is the persona when the agent loop threaded a
 * `personaId` into telemetry metadata, otherwise the background system operation.
 */
export function createAiAccessLogSink(accessLogService: AccessLogService): AccessLogSink {
  return {
    record(event) {
      const workspaceId = event.context?.workspaceId
      if (!workspaceId) {
        logger.warn(
          { functionId: event.functionId, provider: event.provider, model: event.modelId },
          "ai access-log disclose skipped: no workspaceId in context"
        )
        return
      }

      const personaId = readPersonaId(event.metadata)
      const detail: Record<string, unknown> = { provider: event.provider, model: event.modelId }
      const count = event.metadata?.count
      if (typeof count === "number") detail.count = count
      // Session correlation lives in detail — auth_ref is reserved for
      // credential/channel refs (uak_/bak_/dlg_/sconn_), and an agent session
      // id mixed in there would pollute forensic auth_ref queries.
      if (event.context?.sessionId) detail.sessionId = event.context.sessionId

      accessLogService.record({
        workspaceId,
        actorType: personaId ? "persona" : "system",
        actorId: personaId ?? `system:${event.functionId}`,
        onBehalfOfUserId: event.context?.userId ?? null,
        operation: aiOperation(event.functionId),
        accessKind: "disclose",
        outcome: "success",
        subjects: readSubjectRefs(event.metadata),
        detail,
      })
    },
  }
}

function readPersonaId(metadata: Record<string, unknown> | undefined): string | null {
  const personaId = metadata?.personaId
  return typeof personaId === "string" && personaId.length > 0 ? personaId : null
}

/**
 * Subject refs threaded through telemetry metadata (design §9 PR3) so the GIN
 * `subjects` index can find AI egress of a stream/conversation. Malformed entries
 * are dropped; absent or all-invalid yields `undefined` so the row stores no
 * subjects rather than an empty list.
 */
function readSubjectRefs(metadata: Record<string, unknown> | undefined): AuditSubjectRef[] | undefined {
  const raw = metadata?.subjectRefs
  if (!Array.isArray(raw)) return undefined
  const refs: AuditSubjectRef[] = []
  for (const entry of raw) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const { type, id } = entry as { type?: unknown; id?: unknown }
      if (typeof type === "string" && typeof id === "string") refs.push({ type, id })
    }
  }
  return refs.length > 0 ? refs : undefined
}
