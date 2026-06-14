import type { Querier } from "../../db"
import { sql } from "../../db"
import type { DraftCommand, JSONContent } from "@threa/types"

interface DraftRow {
  id: string
  workspace_id: string
  user_id: string
  scope: string
  root_stream_id: string | null
  content_json: JSONContent | null
  content_markdown: string | null
  attachment_ids: string[]
  command: DraftCommand | null
  context_refs: Record<string, unknown>[] | null
  ciphertext: string | null
  envelope: unknown | null
  e2e_version: number | null
  version: number
  last_client_write_id: string | null
  client_updated_at: Date
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface Draft {
  id: string
  workspaceId: string
  userId: string
  scope: string
  rootStreamId: string | null
  contentJson: JSONContent | null
  contentMarkdown: string | null
  attachmentIds: string[]
  command: DraftCommand | null
  contextRefs: Record<string, unknown>[] | null
  ciphertext: string | null
  envelope: unknown | null
  e2eVersion: number | null
  /**
   * Optimistic-concurrency version. Starts at 1; every accepted CAS update
   * increments it. The client pushes the version its edit was based on as
   * `expectedVersion`; on mismatch the service SPLITS (keeps this row, inserts
   * a fresh draft for the incoming content) rather than overwriting.
   */
  version: number
  /**
   * Per-push idempotency key. A lost ack makes the client retry the same
   * upsert; matching this lets the service short-circuit to the existing row
   * so the retry doesn't read as drift and spuriously split.
   */
  lastClientWriteId: string | null
  clientUpdatedAt: Date
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/** Full composer payload for an insert (initial create or split). */
export interface InsertDraftParams {
  id: string
  workspaceId: string
  userId: string
  scope: string
  rootStreamId: string | null
  contentJson: JSONContent | null
  contentMarkdown: string | null
  attachmentIds: string[]
  command: DraftCommand | null
  contextRefs: Record<string, unknown>[] | null
  ciphertext: string | null
  envelope: unknown | null
  e2eVersion: number | null
  clientUpdatedAt: Date
  lastClientWriteId: string
}

/** Full-replacement update of a draft's content (drafts are whole-state). */
export interface CasUpdateDraftParams {
  workspaceId: string
  userId: string
  id: string
  expectedVersion: number
  rootStreamId: string | null
  contentJson: JSONContent | null
  contentMarkdown: string | null
  attachmentIds: string[]
  command: DraftCommand | null
  contextRefs: Record<string, unknown>[] | null
  ciphertext: string | null
  envelope: unknown | null
  e2eVersion: number | null
  clientUpdatedAt: Date
  lastClientWriteId: string
}

const COLUMNS =
  "id, workspace_id, user_id, scope, root_stream_id, content_json, content_markdown, attachment_ids, command, context_refs, ciphertext, envelope, e2e_version, version, last_client_write_id, client_updated_at, created_at, updated_at, deleted_at"

/**
 * Defensive cap on the per-user bootstrap read. Real stashes are far smaller;
 * this only bounds a pathological account so the list query can never scan an
 * unbounded set.
 */
const MAX_DRAFTS_PER_USER = 500

function mapRow(row: DraftRow): Draft {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    scope: row.scope,
    rootStreamId: row.root_stream_id,
    contentJson: row.content_json,
    contentMarkdown: row.content_markdown,
    attachmentIds: Array.isArray(row.attachment_ids) ? row.attachment_ids : [],
    command: row.command,
    contextRefs: row.context_refs,
    ciphertext: row.ciphertext,
    envelope: row.envelope,
    e2eVersion: row.e2e_version,
    version: row.version,
    lastClientWriteId: row.last_client_write_id,
    clientUpdatedAt: row.client_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

function jsonbOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}

export const DraftsRepository = {
  /**
   * Insert a draft, doing nothing on a primary-key collision. Returns the new
   * row when it landed, `null` when the id already existed — the service reads
   * that null as "row exists, go resolve it (idempotent retry / CAS / split)".
   * Split inserts pass a freshly minted id, so they always land.
   */
  async insertIfAbsent(db: Querier, params: InsertDraftParams): Promise<Draft | null> {
    const result = await db.query<DraftRow>(sql`
      INSERT INTO drafts (
        id, workspace_id, user_id, scope, root_stream_id,
        content_json, content_markdown, attachment_ids, command, context_refs,
        ciphertext, envelope, e2e_version, version, last_client_write_id,
        client_updated_at
      )
      VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.userId},
        ${params.scope},
        ${params.rootStreamId},
        ${jsonbOrNull(params.contentJson)}::jsonb,
        ${params.contentMarkdown},
        ${JSON.stringify(params.attachmentIds)}::jsonb,
        ${jsonbOrNull(params.command)}::jsonb,
        ${jsonbOrNull(params.contextRefs)}::jsonb,
        ${params.ciphertext},
        ${jsonbOrNull(params.envelope)}::jsonb,
        ${params.e2eVersion},
        1,
        ${params.lastClientWriteId},
        ${params.clientUpdatedAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Lock a draft row by (workspace, user, id) for the rest of the transaction.
   * Does NOT filter `deleted_at`, so a resolved tombstone is still locked and
   * visible — the service serializes concurrent upserts on the same id and
   * decides update-vs-split against a stable snapshot.
   */
  async findByIdForUpdate(db: Querier, workspaceId: string, userId: string, id: string): Promise<Draft | null> {
    const result = await db.query<DraftRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM drafts
      WHERE id = ${id} AND workspace_id = ${workspaceId} AND user_id = ${userId}
      FOR UPDATE
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Optimistic-concurrency update (INV-20). Replaces the whole composer payload
   * — a draft is full state, so a cleared field (removed attachment, emptied
   * command) is honored rather than COALESCE-preserved. The CAS in the WHERE
   * rejects when `version` has moved on; the service splits on a null return.
   * The `deleted_at IS NULL` guard keeps a resolved tombstone from being
   * revived through this path.
   */
  async casUpdate(db: Querier, params: CasUpdateDraftParams): Promise<Draft | null> {
    const result = await db.query<DraftRow>(sql`
      UPDATE drafts SET
        root_stream_id = ${params.rootStreamId},
        content_json = ${jsonbOrNull(params.contentJson)}::jsonb,
        content_markdown = ${params.contentMarkdown},
        attachment_ids = ${JSON.stringify(params.attachmentIds)}::jsonb,
        command = ${jsonbOrNull(params.command)}::jsonb,
        context_refs = ${jsonbOrNull(params.contextRefs)}::jsonb,
        ciphertext = ${params.ciphertext},
        envelope = ${jsonbOrNull(params.envelope)}::jsonb,
        e2e_version = ${params.e2eVersion},
        last_client_write_id = ${params.lastClientWriteId},
        client_updated_at = ${params.clientUpdatedAt},
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND deleted_at IS NULL
        AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * CAS soft-delete for resolve-on-send and explicit discard. Tombstones the
   * row only when `version` still matches, so a copy that drifted since the
   * send started survives as a stash entry instead of being collaterally
   * destroyed. Returns the tombstoned row on success, `null` on version drift.
   */
  async softDeleteCas(
    db: Querier,
    params: { workspaceId: string; userId: string; id: string; expectedVersion: number }
  ): Promise<Draft | null> {
    const result = await db.query<DraftRow>(sql`
      UPDATE drafts SET
        deleted_at = NOW(),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${params.id}
        AND workspace_id = ${params.workspaceId}
        AND user_id = ${params.userId}
        AND deleted_at IS NULL
        AND version = ${params.expectedVersion}
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Re-scope every live draft from `fromScope` to `toScope` (thread re-pointing).
   * When a not-yet-threaded message is converted to a thread, its reply drafts
   * must follow the message into the new thread stream so they keep roaming.
   *
   * Multi-user by design (no `user_id` filter): a shared `thread:{messageId}`
   * scope can hold reply drafts from several authors, and every owner's draft
   * follows the message — drafts stay private (each is delivered only to its own
   * `user:{userId}` room by the caller). Set-based single UPDATE (INV-56), no
   * select-then-write (INV-20).
   *
   * Bumps `version` so the client's drift-aware apply accepts the new scope: a
   * clean local row sees `version > baseVersion` and adopts it, while a row with
   * unpushed edits ignores the echo and its queued push splits CAS-safely
   * (expectedVersion now trails the server). Returns the re-scoped rows so the
   * caller can emit one `draft:upserted` per owner.
   */
  async rescopeByScope(
    db: Querier,
    params: { workspaceId: string; fromScope: string; toScope: string; rootStreamId: string | null }
  ): Promise<Draft[]> {
    const result = await db.query<DraftRow>(sql`
      UPDATE drafts SET
        scope = ${params.toScope},
        root_stream_id = ${params.rootStreamId},
        updated_at = NOW(),
        version = version + 1
      WHERE workspace_id = ${params.workspaceId}
        AND scope = ${params.fromScope}
        AND deleted_at IS NULL
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows.map(mapRow)
  },

  /**
   * Unconditional soft-delete for explicit discard (no CAS) — the user threw
   * the draft away, so drift doesn't matter. Idempotent on an already-deleted
   * row. Returns the row when it tombstoned, `null` when it was missing.
   */
  async softDelete(db: Querier, workspaceId: string, userId: string, id: string): Promise<Draft | null> {
    const result = await db.query<DraftRow>(sql`
      UPDATE drafts SET
        deleted_at = NOW(),
        updated_at = NOW(),
        version = version + 1
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      RETURNING ${sql.raw(COLUMNS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Bootstrap list for a user — every live draft, newest edit first. Powers the
   * stash and the cross-device seed (INV-53). Tombstones are excluded; cleanup
   * of old tombstones is out of scope for v1.
   *
   * The personal stash is a naturally bounded set, so this is a full read rather
   * than a paginated one — but it carries a defensive `MAX_DRAFTS_PER_USER` cap
   * so a pathological account can never return an unbounded result set on every
   * bootstrap. Newest-first means the cap, if ever hit, keeps the freshest drafts.
   */
  async listByUser(db: Querier, workspaceId: string, userId: string): Promise<Draft[]> {
    const result = await db.query<DraftRow>(sql`
      SELECT ${sql.raw(COLUMNS)}
      FROM drafts
      WHERE workspace_id = ${workspaceId}
        AND user_id = ${userId}
        AND deleted_at IS NULL
      ORDER BY client_updated_at DESC, id DESC
      LIMIT ${MAX_DRAFTS_PER_USER}
    `)
    return result.rows.map(mapRow)
  },
}
