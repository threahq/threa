import {
  TURN_DIGEST_INJECT_COUNT,
  formatTurnDigestsForPrompt,
  parseTurnDigestStepContent,
  type TurnDigestPromptEntry,
} from "@threa/agent-runtime"
import type { Querier } from "../../../db"
import { AgentSessionRepository, type RecentDigestStep } from "../session-repository"

/**
 * Build the "Prior Tool Work" system-context block for a companion turn from
 * the stream's recent completed sessions' `turn_digest` steps (C-1).
 *
 * Access re-filter (scope drift): a digest records the stream ids of the
 * workspace material it contains, and a stream that was readable when the
 * digest was written can be inaccessible NOW — so each digest is re-checked
 * against the location's current access set and dropped whole when any of its
 * source streams fell out of scope (findings are prose; they can't be
 * partially filtered). Web-derived content is exempt (public): a web-only
 * digest carries no source stream ids and always passes. Bot-initiated turns
 * have no invoking user (`accessibleStreamIds === null`), which means no
 * workspace access — only workspace-free digests inject.
 */
export function buildTurnDigestPromptBlock(
  rows: RecentDigestStep[],
  accessibleStreamIds: Set<string> | null
): string | null {
  const entries: TurnDigestPromptEntry[] = []
  // Rows arrive newest-session-first; the prompt reads oldest-first.
  for (const row of [...rows].reverse()) {
    const digest = parseTurnDigestStepContent(row.step.content)
    if (!digest) continue
    const inaccessible = digest.sourceStreamIds.some((id) => !accessibleStreamIds?.has(id))
    if (inaccessible) continue
    entries.push({
      completedAt: (row.sessionCompletedAt ?? row.sessionCreatedAt).toISOString(),
      digest,
    })
  }
  return formatTurnDigestsForPrompt(entries)
}

/** Fetch + filter + format in one call — the context build's single entry point. */
export async function loadTurnDigestPromptBlock(
  db: Querier,
  params: { streamId: string; personaId: string; accessibleStreamIds: Set<string> | null }
): Promise<string | null> {
  const rows = await AgentSessionRepository.findRecentDigestStepsByStream(db, {
    streamId: params.streamId,
    personaId: params.personaId,
    limit: TURN_DIGEST_INJECT_COUNT,
  })
  return buildTurnDigestPromptBlock(rows, params.accessibleStreamIds)
}
