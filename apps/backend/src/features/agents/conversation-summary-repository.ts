import type { Querier } from "../../db"
import { sql } from "../../db"

interface ConversationSummaryRow {
  id: string
  workspace_id: string
  stream_id: string
  persona_id: string
  summary: string | null
  summary_ciphertext: Buffer | null
  summary_envelope: unknown
  key_generation: number | null
  last_summarized_sequence: string
  created_at: Date
  updated_at: Date
}

export interface SealedSummary {
  /** Base64-encoded ciphertext of the in-enclave rolling summary. */
  ciphertext: string
  /** Stream envelope (iv/aad/keyGeneration) the enclave needs to re-open it. */
  envelope: unknown
  keyGeneration: number
}

export interface AgentConversationSummary {
  id: string
  workspaceId: string
  streamId: string
  personaId: string
  /** Plaintext rolling summary (companion path) — null on E2E rows. */
  summary: string | null
  /** Sealed rolling summary (enclave path) — null on plaintext rows. */
  sealed: SealedSummary | null
  lastSummarizedSequence: bigint
  createdAt: Date
  updatedAt: Date
}

interface UpsertConversationSummaryBase {
  id: string
  workspaceId: string
  streamId: string
  personaId: string
  lastSummarizedSequence: bigint
}

/**
 * Exactly one representation per upsert — a plaintext summary (companion, the
 * backend can read the source messages) or a sealed one (enclave, computed on
 * decrypted content the backend never sees). The discriminated union is the
 * enforcement the migration delegates to app code (no DB CHECK, INV-3).
 */
export type UpsertConversationSummaryParams =
  | (UpsertConversationSummaryBase & { summary: string; sealed?: never })
  | (UpsertConversationSummaryBase & { sealed: SealedSummary; summary?: never })

function mapRowToSummary(row: ConversationSummaryRow): AgentConversationSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    personaId: row.persona_id,
    summary: row.summary,
    sealed:
      row.summary_ciphertext && row.summary_envelope !== null && row.key_generation !== null
        ? {
            ciphertext: row.summary_ciphertext.toString("base64"),
            envelope: row.summary_envelope,
            keyGeneration: row.key_generation,
          }
        : null,
    lastSummarizedSequence: BigInt(row.last_summarized_sequence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, stream_id, persona_id, summary, summary_ciphertext,
  summary_envelope, key_generation, last_summarized_sequence, created_at, updated_at
`

export const ConversationSummaryRepository = {
  async findByStreamAndPersona(
    db: Querier,
    streamId: string,
    personaId: string
  ): Promise<AgentConversationSummary | null> {
    const result = await db.query<ConversationSummaryRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM agent_conversation_summaries
      WHERE stream_id = ${streamId}
        AND persona_id = ${personaId}
      LIMIT 1
    `)
    return result.rows[0] ? mapRowToSummary(result.rows[0]) : null
  },

  async upsert(db: Querier, params: UpsertConversationSummaryParams): Promise<AgentConversationSummary> {
    const isSealed = "sealed" in params && params.sealed !== undefined
    if (!isSealed && params.summary === undefined) {
      // The discriminated union enforces "exactly one representation" for typed
      // callers; this guards the same rule at runtime for an untyped caller (e.g.
      // an unvalidated request body), since the table carries no DB CHECK (INV-3)
      // and a silent all-null insert would be the worse failure (INV-11).
      throw new Error(
        "ConversationSummaryRepository.upsert requires exactly one representation: `summary` (plaintext) or `sealed`"
      )
    }
    const summary = isSealed ? null : (params.summary ?? null)
    const ciphertext = isSealed ? Buffer.from(params.sealed.ciphertext, "base64") : null
    const envelope = isSealed ? JSON.stringify(params.sealed.envelope) : null
    const keyGeneration = isSealed ? params.sealed.keyGeneration : null

    // The monotonic cursor decides whether the incoming summary supersedes the
    // stored one; every representation column (summary, summary_ciphertext,
    // summary_envelope, key_generation) moves together with it so a plaintext row
    // never keeps stale sealed bytes (or vice versa) after a flip.
    const result = await db.query<ConversationSummaryRow>(sql`
      INSERT INTO agent_conversation_summaries (
        id, workspace_id, stream_id, persona_id, summary, summary_ciphertext,
        summary_envelope, key_generation, last_summarized_sequence
      ) VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.streamId},
        ${params.personaId},
        ${summary},
        ${ciphertext},
        ${envelope},
        ${keyGeneration},
        ${params.lastSummarizedSequence.toString()}
      )
      ON CONFLICT (stream_id, persona_id) DO UPDATE SET
        summary = CASE
          WHEN EXCLUDED.last_summarized_sequence > agent_conversation_summaries.last_summarized_sequence
          THEN EXCLUDED.summary
          ELSE agent_conversation_summaries.summary
        END,
        summary_ciphertext = CASE
          WHEN EXCLUDED.last_summarized_sequence > agent_conversation_summaries.last_summarized_sequence
          THEN EXCLUDED.summary_ciphertext
          ELSE agent_conversation_summaries.summary_ciphertext
        END,
        summary_envelope = CASE
          WHEN EXCLUDED.last_summarized_sequence > agent_conversation_summaries.last_summarized_sequence
          THEN EXCLUDED.summary_envelope
          ELSE agent_conversation_summaries.summary_envelope
        END,
        key_generation = CASE
          WHEN EXCLUDED.last_summarized_sequence > agent_conversation_summaries.last_summarized_sequence
          THEN EXCLUDED.key_generation
          ELSE agent_conversation_summaries.key_generation
        END,
        last_summarized_sequence = GREATEST(
          agent_conversation_summaries.last_summarized_sequence,
          EXCLUDED.last_summarized_sequence
        ),
        updated_at = CASE
          WHEN EXCLUDED.last_summarized_sequence > agent_conversation_summaries.last_summarized_sequence
          THEN NOW()
          ELSE agent_conversation_summaries.updated_at
        END
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToSummary(result.rows[0])
  },
}
