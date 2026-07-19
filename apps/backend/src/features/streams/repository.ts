import type { Querier } from "../../db"
import { sql } from "../../db"
import type {
  AuthorType,
  StreamType,
  StreamPurpose,
  Visibility,
  CompanionMode,
  MemoryMode,
  ThreadSummary,
  E2eActor,
  ThreaDocument,
} from "@threa/types"
import { StreamTypes } from "@threa/types"
import { parseArchiveStatusFilter, type ArchiveStatus } from "../../lib/sql-filters"

export type { StreamType, Visibility, CompanionMode, MemoryMode, ArchiveStatus }

interface StreamRow {
  id: string
  workspace_id: string
  type: string
  display_name: string | null
  slug: string | null
  description: string | null
  description_json: ThreaDocument | null
  visibility: string
  parent_stream_id: string | null
  parent_message_id: string | null
  root_stream_id: string | null
  companion_mode: string
  companion_persona_id: string | null
  memory_mode: string
  purpose: string | null
  created_by: string
  created_at: Date
  updated_at: Date
  archived_at: Date | null
  display_name_generated_at: Date | null
  /**
   * Optional columns from a LEFT JOIN against `e2e_streams`. Only the
   * `findById` family pulls them; bare `streams`-only queries leave the
   * fields undefined and `mapRowToStream` omits them on the result.
   */
  e2e_owner_user_key_id?: string | null
  e2e_actors?: { kind: string; keyId: string | null }[] | null
  /** Sealed display name (E2E streams only) — BYTEA + JSONB framing, both NULL until first rename. */
  e2e_name_ciphertext?: Buffer | null
  e2e_name_envelope?: unknown | null
}

/**
 * Shared row shape returned by both `findThreadSummaries` (batch) and
 * `findThreadSummaryByParentMessage` (single-parent). Both SELECT the same
 * column set with the same aliases so `threadSummaryFromRow` can map either
 * to a `ThreadSummary` without branching. A parity test in the integration
 * suite asserts the two entry points return identical `ThreadSummary`
 * objects for the same parent — drift in either query's SELECT fails it.
 *
 * `participant_ids` / `participant_types` are positionally aligned arrays:
 * `participant_ids[i]` has type `participant_types[i]`. Postgres doesn't
 * have a first-class tuple-of-records array for `ARRAY_AGG`, so we ship
 * the two aligned arrays and zip them in `threadSummaryFromRow`.
 */
interface ThreadSummaryRow {
  parent_message_id: string
  latest_message_id: string
  latest_author_id: string
  latest_author_type: string
  latest_content_markdown: string
  last_reply_at: Date
  participant_ids: string[]
  participant_types: string[]
}

function threadSummaryFromRow(row: ThreadSummaryRow): ThreadSummary {
  // Zip the aligned participant_ids / participant_types into a single
  // structured array. Any length mismatch would indicate a query bug — they
  // come from the same ARRAY_AGG ORDER BY in one row per parent, so in
  // practice they always match; guard defensively.
  const participants = row.participant_ids.map((id, i) => ({
    id,
    type: (row.participant_types[i] ?? "user") as AuthorType,
  }))
  return {
    lastReplyAt: row.last_reply_at.toISOString(),
    participants,
    latestReply: {
      messageId: row.latest_message_id,
      actorId: row.latest_author_id,
      actorType: row.latest_author_type as AuthorType,
      contentMarkdown: row.latest_content_markdown,
    },
  }
}

export interface Stream {
  id: string
  workspaceId: string
  type: StreamType
  displayName: string | null
  slug: string | null
  description: string | null
  descriptionJson: ThreaDocument | null
  visibility: Visibility
  parentStreamId: string | null
  parentMessageId: string | null
  rootStreamId: string | null
  companionMode: CompanionMode
  companionPersonaId: string | null
  /**
   * System purpose of the stream (`StreamPurposes`) or `null` for an ordinary
   * stream. `mapRowToStream` always sets it from the nullable column, so it is
   * present on every stream read from the DB; optional only so test fixtures
   * that predate it still typecheck. Readers treat an absent value as `null`.
   */
  purpose?: StreamPurpose | null
  /**
   * GAM memory automation gate. `mapRowToStream` always sets it from the
   * `NOT NULL DEFAULT 'auto'` column, so it is present on every stream read
   * from the DB; optional only so test fixtures that predate it still typecheck.
   * Readers treat an absent value as `"auto"`.
   */
  memoryMode?: MemoryMode
  createdBy: string
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
  displayNameGeneratedAt: Date | null
  /**
   * End-to-end encryption metadata, populated by callers that LEFT JOIN
   * `e2e_streams`. Optional so existing read paths and test fixtures
   * stay untouched; the create handler and stream bootstrap explicitly
   * populate them.
   */
  e2eEnabled?: boolean
  e2eOwnerKeyId?: string | null
  /**
   * Non-human actors the owner has invited into the encrypted stream. Drives
   * the frontend's SSK-wrap recipient set — an "enclave" actor means wrap the
   * SSK to every live EIK so Ariadne can decrypt. Populated by the same query
   * that sets `e2eOwnerKeyId`; an empty array is an E2E stream with no agents.
   */
  e2eActors?: E2eActor[]
}

export interface InsertStreamParams {
  id: string
  workspaceId: string
  type: StreamType
  displayName?: string
  slug?: string
  description?: string | null
  descriptionJson?: ThreaDocument | null
  visibility?: Visibility
  parentStreamId?: string
  parentMessageId?: string
  rootStreamId?: string
  companionMode?: CompanionMode
  companionPersonaId?: string
  memoryMode?: MemoryMode
  /** System-purpose marker (`StreamPurposes`); omit/null for an ordinary stream. */
  purpose?: StreamPurpose | null
  uniquenessKey?: string
  createdBy: string
}

export interface UpdateStreamParams {
  // `null` scrubs the plaintext name — used by a sealed-only E2E rename, where
  // the authoritative name lives in `e2e_streams.name_ciphertext`.
  displayName?: string | null
  slug?: string
  description?: string | null
  descriptionJson?: ThreaDocument | null
  visibility?: Visibility
  companionMode?: CompanionMode
  companionPersonaId?: string | null
  memoryMode?: MemoryMode
  archivedAt?: Date | null
  displayNameGeneratedAt?: Date | null
}

/** Preview of the last message in a stream for sidebar display */
export interface LastMessagePreview {
  authorId: string
  authorType: AuthorType
  content: any // ProseMirror JSONContent
  createdAt: Date
}

/** Stream with optional last message preview, for sidebar listing */
export interface StreamWithPreview extends Stream {
  lastMessagePreview: LastMessagePreview | null
}

export interface DmPeer {
  userId: string
  streamId: string
}

function mapRowToStream(row: StreamRow): Stream {
  const e2eOwnerKeyId = row.e2e_owner_user_key_id ?? undefined
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type as StreamType,
    displayName: row.display_name,
    slug: row.slug,
    description: row.description,
    descriptionJson: row.description_json,
    visibility: row.visibility as Visibility,
    parentStreamId: row.parent_stream_id,
    parentMessageId: row.parent_message_id,
    rootStreamId: row.root_stream_id,
    companionMode: row.companion_mode as CompanionMode,
    companionPersonaId: row.companion_persona_id,
    memoryMode: row.memory_mode as MemoryMode,
    purpose: (row.purpose as StreamPurpose | null) ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    displayNameGeneratedAt: row.display_name_generated_at,
    // Only expose the E2E fields when the query opted into the JOIN —
    // a bare `streams` SELECT leaves them as `undefined` so plaintext
    // callers don't have to special-case the placeholder.
    ...(e2eOwnerKeyId !== undefined && {
      e2eEnabled: true,
      e2eOwnerKeyId,
      e2eActors: (row.e2e_actors ?? []) as E2eActor[],
      // Sealed name travels base64 on the wire; both are null until first rename.
      sealedNameCiphertext: row.e2e_name_ciphertext ? row.e2e_name_ciphertext.toString("base64") : null,
      sealedNameEnvelope: row.e2e_name_envelope ?? null,
    }),
  }
}

/** Row type for stream with last message preview (from CTE query) */
interface StreamWithPreviewRow extends StreamRow {
  last_message_author_id: string | null
  last_message_author_type: string | null
  last_message_content: any | null // ProseMirror JSONContent
  last_message_at: Date | null
}

function mapRowToStreamWithPreview(row: StreamWithPreviewRow): StreamWithPreview {
  const stream = mapRowToStream(row)
  const lastMessagePreview: LastMessagePreview | null =
    row.last_message_author_id && row.last_message_content && row.last_message_at
      ? {
          authorId: row.last_message_author_id,
          authorType: row.last_message_author_type as AuthorType,
          content: row.last_message_content,
          createdAt: row.last_message_at,
        }
      : null

  return {
    ...stream,
    lastMessagePreview,
  }
}

const SELECT_FIELDS = `
  id, workspace_id, type, display_name, slug, description, description_json, visibility,
  parent_stream_id, parent_message_id, root_stream_id,
  companion_mode, companion_persona_id, memory_mode, purpose,
  created_by, created_at, updated_at, archived_at, display_name_generated_at
`

// SELECT list for queries that need the E2E flag inline. The LEFT JOIN keeps
// plaintext rows visible (the `e2e_owner_user_key_id` projection is just
// NULL for them) so callers don't have to branch on stream type.
const SELECT_FIELDS_WITH_E2E = `
  s.id, s.workspace_id, s.type, s.display_name, s.slug, s.description, s.description_json, s.visibility,
  s.parent_stream_id, s.parent_message_id, s.root_stream_id,
  s.companion_mode, s.companion_persona_id, s.memory_mode, s.purpose,
  s.created_by, s.created_at, s.updated_at, s.archived_at, s.display_name_generated_at,
  e.owner_user_key_id AS e2e_owner_user_key_id,
  e.name_ciphertext AS e2e_name_ciphertext,
  e.name_envelope AS e2e_name_envelope,
  (
    SELECT COALESCE(json_agg(json_build_object('kind', a.kind, 'actorId', a.actor_id, 'keyId', a.key_id) ORDER BY a.added_at), '[]'::json)
    FROM e2e_stream_actors a
    WHERE a.workspace_id = s.workspace_id AND a.stream_id = s.id
  ) AS e2e_actors
`

const FROM_STREAMS_WITH_E2E = `streams s LEFT JOIN e2e_streams e ON e.stream_id = s.id`

/**
 * System-purpose streams (e.g. a persona-editor test scratchpad) are real,
 * fully-functional streams but not user-facing channels — every workspace
 * stream-list path must exclude them so the workbench never leaks into the
 * sidebar, the Cmd-K archived list, or the public API. The live `stream:created`
 * socket path applies the same exclusion off the payload's `purpose` field
 * (workspace-sync), so client and server agree. Single predicate so the list
 * paths can't drift; `alias` prefixes it for joined queries (`s.purpose`).
 */
const purposeIsNull = (alias?: string) => `${alias ? `${alias}.` : ""}purpose IS NULL`

export const StreamRepository = {
  async findById(db: Querier, id: string): Promise<Stream | null> {
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS_WITH_E2E)} FROM ${sql.raw(FROM_STREAMS_WITH_E2E)} WHERE s.id = ${id}`
    )
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  async findByIdForWorkspace(db: Querier, id: string, workspaceId: string): Promise<Stream | null> {
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS_WITH_E2E)} FROM ${sql.raw(FROM_STREAMS_WITH_E2E)} WHERE s.id = ${id} AND s.workspace_id = ${workspaceId}`
    )
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  /**
   * Locks the stream row for update, skipping if already locked.
   * Returns null if not found or already locked by another transaction.
   */
  async findByIdForUpdate(db: Querier, id: string): Promise<Stream | null> {
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams WHERE id = ${id} FOR UPDATE SKIP LOCKED`
    )
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  async findByIds(db: Querier, ids: string[]): Promise<Stream[]> {
    if (ids.length === 0) return []
    const result = await db.query<StreamRow>(sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams WHERE id = ANY(${ids})`)
    return result.rows.map(mapRowToStream)
  },

  /**
   * Returns true when `ancestorCandidateId` equals `streamId`, is its parent
   * anywhere up the chain, or is the non-thread root (`root_stream_id`) of any
   * stream on the chain. Runs as a single recursive CTE — no app-level loop,
   * no arbitrary depth cap. The `root_stream_id` predicate gives a one-hop
   * short-circuit for the common thread→root share-to-parent case.
   */
  async isAncestor(db: Querier, ancestorCandidateId: string, streamId: string): Promise<boolean> {
    if (ancestorCandidateId === streamId) return true
    const result = await db.query<{ matched: boolean }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_stream_id, root_stream_id
        FROM streams
        WHERE id = ${streamId}

        UNION ALL

        SELECT s.id, s.parent_stream_id, s.root_stream_id
        FROM chain c
        JOIN streams s ON s.id = c.parent_stream_id
      )
      SELECT TRUE AS matched
      FROM chain
      WHERE id = ${ancestorCandidateId}
         OR root_stream_id = ${ancestorCandidateId}
      LIMIT 1
    `)
    return result.rows.length > 0
  },

  /**
   * `streamId` plus every stream nested beneath it (any depth), walking down
   * `parent_stream_id` in one recursive CTE. Used by the thread-split flow to
   * find the member messages that move with a thread: its own plus any deeper
   * sub-topic threads. Always includes `streamId` itself.
   */
  async listSelfAndDescendantIds(db: Querier, streamId: string): Promise<string[]> {
    const result = await db.query<{ id: string }>(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM streams WHERE id = ${streamId}
        UNION ALL
        SELECT s.id FROM streams s JOIN subtree t ON s.parent_stream_id = t.id
      )
      SELECT id FROM subtree
    `)
    return result.rows.map((row) => row.id)
  },

  /**
   * Active thread ids whose top-level root is `rootStreamId` (any nesting
   * depth — `root_stream_id` points at the non-thread ancestor, INV-62).
   * Used to route root lifecycle events (`stream:archived` / `stream:unarchived`)
   * to descendant thread rooms so clients viewing a thread receive them and
   * resolve the inherited archived state live, without a refresh.
   */
  async listThreadIdsByRoot(db: Querier, workspaceId: string, rootStreamId: string): Promise<string[]> {
    const result = await db.query<{ id: string }>(
      sql`SELECT id FROM streams
          WHERE workspace_id = ${workspaceId}
            AND root_stream_id = ${rootStreamId}
            AND type = ${StreamTypes.THREAD}
            AND archived_at IS NULL`
    )
    return result.rows.map((row) => row.id)
  },

  /**
   * List streams by a known set of IDs with optional filtering.
   * Used by the public API to fetch accessible stream details.
   */
  async listByIds(
    db: Querier,
    workspaceId: string,
    ids: string[],
    filters?: {
      types?: StreamType[]
      query?: string
      limit?: number
      cursorCreatedAt?: Date
      cursorId?: string
      includeArchived?: boolean
    }
  ): Promise<Stream[]> {
    if (ids.length === 0) return []

    const limit = filters?.limit ?? 50
    const conditions = [`id = ANY($1)`, `workspace_id = $2`, purposeIsNull()]
    if (!filters?.includeArchived) {
      // A live thread under an archived root is invisible in the app's stream
      // lists, so hide it here too — the row's own archived_at is not enough.
      conditions.push(
        `archived_at IS NULL`,
        `NOT EXISTS (
          SELECT 1 FROM streams root
          WHERE root.id = streams.root_stream_id AND root.archived_at IS NOT NULL
        )`
      )
    }
    const values: unknown[] = [ids, workspaceId]
    let paramIndex = 3

    if (filters?.types?.length) {
      conditions.push(`type = ANY($${paramIndex++})`)
      values.push(filters.types)
    }
    if (filters?.query) {
      const pattern = `%${filters.query}%`
      conditions.push(`(display_name ILIKE $${paramIndex} OR slug ILIKE $${paramIndex})`)
      paramIndex++
      values.push(pattern)
    }
    if (filters?.cursorCreatedAt && filters?.cursorId) {
      conditions.push(`(created_at, id) < ($${paramIndex}, $${paramIndex + 1})`)
      values.push(filters.cursorCreatedAt, filters.cursorId)
      paramIndex += 2
    }
    values.push(limit)

    const result = await db.query<StreamRow>(
      `SELECT ${SELECT_FIELDS} FROM streams
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $${paramIndex}`,
      values
    )
    return result.rows.map(mapRowToStream)
  },

  /**
   * Find a stream by its slug within a workspace.
   * Slugs are case-insensitive for matching.
   */
  async findBySlug(db: Querier, workspaceId: string, slug: string): Promise<Stream | null> {
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
          WHERE workspace_id = ${workspaceId} AND LOWER(slug) = LOWER(${slug})
          LIMIT 1`
    )
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  /**
   * Batched slug lookup (INV-56) for the mention/channel resolver. Slugs are
   * matched case-insensitively, mirroring `findBySlug`.
   */
  async findBySlugs(db: Querier, workspaceId: string, slugs: string[]): Promise<Stream[]> {
    if (slugs.length === 0) return []
    const lowered = slugs.map((slug) => slug.toLowerCase())
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
          WHERE workspace_id = ${workspaceId} AND LOWER(slug) = ANY(${lowered})`
    )
    return result.rows.map(mapRowToStream)
  },

  async findByUniquenessKey(db: Querier, workspaceId: string, uniquenessKey: string): Promise<Stream | null> {
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
          WHERE workspace_id = ${workspaceId} AND uniqueness_key = ${uniquenessKey}
          LIMIT 1`
    )
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  async listDmPeersForMember(
    db: Querier,
    workspaceId: string,
    userId: string,
    options?: { streamIds?: string[] }
  ): Promise<DmPeer[]> {
    const scopedStreamIds = options?.streamIds
    const hasStreamScope = scopedStreamIds !== undefined
    if (hasStreamScope && scopedStreamIds.length === 0) {
      return []
    }

    const result = await db.query<{ stream_id: string; member_id: string }>(sql`
      WITH dm_members AS (
        SELECT
          sm.stream_id,
          array_agg(DISTINCT sm.member_id ORDER BY sm.member_id) AS member_ids
        FROM stream_members sm
        JOIN streams s ON s.id = sm.stream_id
        WHERE s.workspace_id = ${workspaceId}
          AND s.type = 'dm'
          AND s.archived_at IS NULL
          AND (${!hasStreamScope} OR s.id = ANY(${scopedStreamIds ?? []}))
        GROUP BY sm.stream_id
        HAVING COUNT(DISTINCT sm.member_id) = 2
          AND bool_or(sm.member_id = ${userId})
      )
      SELECT
        stream_id,
        CASE
          WHEN member_ids[1] = ${userId} THEN member_ids[2]
          ELSE member_ids[1]
        END AS member_id
      FROM dm_members
    `)

    return result.rows.map((row) => ({
      userId: row.member_id,
      streamId: row.stream_id,
    }))
  },

  async list(
    db: Querier,
    workspaceId: string,
    filters?: {
      types?: StreamType[]
      parentStreamId?: string
      userMembershipStreamIds?: string[]
      archiveStatus?: ArchiveStatus[]
    }
  ): Promise<Stream[]> {
    const types = filters?.types
    const parentStreamId = filters?.parentStreamId
    const userMembershipStreamIds = filters?.userMembershipStreamIds
    const archiveStatus = filters?.archiveStatus

    const { includeActive, includeArchived, filterAll } = parseArchiveStatusFilter(archiveStatus)

    if (parentStreamId) {
      const result = await db.query<StreamRow>(
        sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
            WHERE workspace_id = ${workspaceId}
              AND parent_stream_id = ${parentStreamId}
              AND (${filterAll} OR (${includeArchived} AND archived_at IS NOT NULL) OR (${!includeArchived} AND archived_at IS NULL))
              AND ${sql.raw(purposeIsNull())}
            ORDER BY created_at DESC`
      )
      return result.rows.map(mapRowToStream)
    }

    if (userMembershipStreamIds !== undefined) {
      if (types && types.length > 0) {
        const result = await db.query<StreamRow>(
          sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
              WHERE workspace_id = ${workspaceId}
                AND type = ANY(${types})
                AND (${filterAll} OR (${includeArchived} AND archived_at IS NOT NULL) OR (${!includeArchived} AND archived_at IS NULL))
                AND (visibility = 'public' OR id = ANY(${userMembershipStreamIds}))
                AND ${sql.raw(purposeIsNull())}
              ORDER BY created_at DESC`
        )
        return result.rows.map(mapRowToStream)
      }

      const result = await db.query<StreamRow>(
        sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
            WHERE workspace_id = ${workspaceId}
              AND (${filterAll} OR (${includeArchived} AND archived_at IS NOT NULL) OR (${!includeArchived} AND archived_at IS NULL))
              AND (visibility = 'public' OR id = ANY(${userMembershipStreamIds}))
              AND ${sql.raw(purposeIsNull())}
            ORDER BY created_at DESC`
      )
      return result.rows.map(mapRowToStream)
    }

    if (types && types.length > 0) {
      const result = await db.query<StreamRow>(
        sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
            WHERE workspace_id = ${workspaceId}
              AND type = ANY(${types})
              AND (${filterAll} OR (${includeArchived} AND archived_at IS NOT NULL) OR (${!includeArchived} AND archived_at IS NULL))
              AND ${sql.raw(purposeIsNull())}
            ORDER BY created_at DESC`
      )
      return result.rows.map(mapRowToStream)
    }

    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
          WHERE workspace_id = ${workspaceId}
            AND (${filterAll} OR (${includeArchived} AND archived_at IS NOT NULL) OR (${!includeArchived} AND archived_at IS NULL))
            AND ${sql.raw(purposeIsNull())}
          ORDER BY created_at DESC`
    )
    return result.rows.map(mapRowToStream)
  },

  /**
   * List streams with last message preview, ordered by most recent activity.
   * Uses a CTE for efficient fetching of last message per stream.
   */
  async listWithPreviews(
    db: Querier,
    workspaceId: string,
    filters?: {
      types?: StreamType[]
      userMembershipStreamIds?: string[]
      archiveStatus?: ArchiveStatus[]
    }
  ): Promise<StreamWithPreview[]> {
    const types = filters?.types
    const userMembershipStreamIds = filters?.userMembershipStreamIds
    const archiveStatus = filters?.archiveStatus

    const { includeActive, includeArchived, filterAll } = parseArchiveStatusFilter(archiveStatus)

    // A thread inherits its top-level ancestor via `root_stream_id` (INV-62).
    // Archiving marks only the root row, so an active-only filter still returns
    // a thread whose root scratchpad/channel was archived — and the sidebar
    // (this bootstrap's consumer) would show it, since the frontend can't tell
    // the root is archived once it's pruned from the client cache. Exclude
    // active threads whose root is archived so they never enter the sidebar.
    // Applies in every branch because `listWithPreviews` is workspace-bootstrap
    // only, and a thread under an archived root is clutter in every view that
    // reads the bootstrap streams.
    const EXCLUDE_ARCHIVED_ROOT_THREADS = `AND NOT (
        s.type = '${StreamTypes.THREAD}'
        AND s.root_stream_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM streams root WHERE root.id = s.root_stream_id AND root.archived_at IS NOT NULL)
      )`

    const EXCLUDE_PURPOSED_STREAMS = `AND ${purposeIsNull("s")}`

    // CTE to get last message per stream. LEFT JOIN against
    // `e2e_streams` so the workspace bootstrap surfaces the E2E flag
    // inline — without it, cold-loaded sidebar rows have undefined
    // `e2eEnabled` until the per-stream bootstrap fires, which would let
    // the composer briefly treat an existing E2E scratchpad as plaintext
    // (the backend INV-E1 gate would still reject, but the UX shows an
    // unexplained 400).
    const SELECT_WITH_PREVIEW = `
      WITH last_messages AS (
        SELECT DISTINCT ON (stream_id)
          stream_id,
          author_id,
          author_type,
          content_json,
          created_at
        FROM messages
        WHERE deleted_at IS NULL
        ORDER BY stream_id, created_at DESC
      )
      SELECT
        s.${SELECT_FIELDS.split(",")
          .map((f) => f.trim())
          .join(", s.")},
        lm.author_id as last_message_author_id,
        lm.author_type as last_message_author_type,
        lm.content_json as last_message_content,
        lm.created_at as last_message_at,
        e.owner_user_key_id AS e2e_owner_user_key_id,
        e.name_ciphertext AS e2e_name_ciphertext,
        e.name_envelope AS e2e_name_envelope,
        (
          SELECT COALESCE(json_agg(json_build_object('kind', a.kind, 'actorId', a.actor_id, 'keyId', a.key_id) ORDER BY a.added_at), '[]'::json)
          FROM e2e_stream_actors a
          WHERE a.workspace_id = s.workspace_id AND a.stream_id = s.id
        ) AS e2e_actors
      FROM streams s
      LEFT JOIN last_messages lm ON lm.stream_id = s.id
      LEFT JOIN e2e_streams e ON e.stream_id = s.id
    `

    // Build query with visibility filter if user's membership stream IDs provided
    if (userMembershipStreamIds !== undefined) {
      if (types && types.length > 0) {
        const result = await db.query<StreamWithPreviewRow>(
          sql`${sql.raw(SELECT_WITH_PREVIEW)}
              WHERE s.workspace_id = ${workspaceId}
                AND s.type = ANY(${types})
                AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
                AND (s.visibility = 'public' OR s.id = ANY(${userMembershipStreamIds}))
                ${sql.raw(EXCLUDE_ARCHIVED_ROOT_THREADS)}
              ${sql.raw(EXCLUDE_PURPOSED_STREAMS)}
              ORDER BY COALESCE(lm.created_at, s.created_at) DESC`
        )
        return result.rows.map(mapRowToStreamWithPreview)
      }

      const result = await db.query<StreamWithPreviewRow>(
        sql`${sql.raw(SELECT_WITH_PREVIEW)}
            WHERE s.workspace_id = ${workspaceId}
              AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
              AND (s.visibility = 'public' OR s.id = ANY(${userMembershipStreamIds}))
              ${sql.raw(EXCLUDE_ARCHIVED_ROOT_THREADS)}
              ${sql.raw(EXCLUDE_PURPOSED_STREAMS)}
            ORDER BY COALESCE(lm.created_at, s.created_at) DESC`
      )
      return result.rows.map(mapRowToStreamWithPreview)
    }

    if (types && types.length > 0) {
      const result = await db.query<StreamWithPreviewRow>(
        sql`${sql.raw(SELECT_WITH_PREVIEW)}
            WHERE s.workspace_id = ${workspaceId}
              AND s.type = ANY(${types})
              AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
              ${sql.raw(EXCLUDE_ARCHIVED_ROOT_THREADS)}
              ${sql.raw(EXCLUDE_PURPOSED_STREAMS)}
            ORDER BY COALESCE(lm.created_at, s.created_at) DESC`
      )
      return result.rows.map(mapRowToStreamWithPreview)
    }

    const result = await db.query<StreamWithPreviewRow>(
      sql`${sql.raw(SELECT_WITH_PREVIEW)}
          WHERE s.workspace_id = ${workspaceId}
            AND (${filterAll} OR (${includeArchived} AND s.archived_at IS NOT NULL) OR (${!includeArchived} AND s.archived_at IS NULL))
            ${sql.raw(EXCLUDE_ARCHIVED_ROOT_THREADS)}
              ${sql.raw(EXCLUDE_PURPOSED_STREAMS)}
          ORDER BY COALESCE(lm.created_at, s.created_at) DESC`
    )
    return result.rows.map(mapRowToStreamWithPreview)
  },

  /**
   * Archived root streams visible to the viewer, as slim `Stream` rows (no
   * preview/membership/unread joins). `archived_at` is only ever set on root
   * rows (archiving marks only the root — see `resolveWritableMessageStream`
   * in the service), so this needs no thread→root resolution; threads are
   * excluded outright. Visibility mirrors `listWithPreviews`: public streams
   * plus streams the viewer is a member of, workspace-scoped (INV-8). Feeds
   * the bootstrap `archivedStreams` index so the client retains knowledge of
   * archival across reloads (drafts filters, saved/activity name resolution).
   */
  async listArchivedRoots(db: Querier, workspaceId: string, userId: string): Promise<Stream[]> {
    const result = await db.query<StreamRow>(
      sql`SELECT ${sql.raw(SELECT_FIELDS)} FROM streams s
          WHERE s.workspace_id = ${workspaceId}
            AND s.archived_at IS NOT NULL
            AND s.type != ${StreamTypes.THREAD}
            AND (
              s.visibility = 'public'
              OR EXISTS (
                SELECT 1 FROM stream_members m
                WHERE m.stream_id = s.id AND m.member_id = ${userId}
              )
            )
            AND ${sql.raw(purposeIsNull("s"))}
          ORDER BY s.archived_at DESC`
    )
    return result.rows.map(mapRowToStream)
  },

  async insert(db: Querier, params: InsertStreamParams): Promise<Stream> {
    const result = await db.query<StreamRow>(sql`
      INSERT INTO streams (
        id, workspace_id, type, display_name, slug, description, description_json, visibility,
        parent_stream_id, parent_message_id, root_stream_id,
        companion_mode, companion_persona_id, memory_mode, purpose, uniqueness_key, created_by
      ) VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.type},
        ${params.displayName ?? null},
        ${params.slug ?? null},
        ${params.description ?? null},
        ${params.descriptionJson ? JSON.stringify(params.descriptionJson) : null},
        ${params.visibility ?? "private"},
        ${params.parentStreamId ?? null},
        ${params.parentMessageId ?? null},
        ${params.rootStreamId ?? null},
        ${params.companionMode ?? "off"},
        ${params.companionPersonaId ?? null},
        ${params.memoryMode ?? "auto"},
        ${params.purpose ?? null},
        ${params.uniquenessKey ?? null},
        ${params.createdBy}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return mapRowToStream(result.rows[0])
  },

  /**
   * Atomically insert a stream with a uniqueness key or return the existing one.
   * Works with the partial unique index on (workspace_id, uniqueness_key).
   */
  async insertOrFindByUniquenessKey(
    db: Querier,
    params: InsertStreamParams & { uniquenessKey: string }
  ): Promise<{ stream: Stream; created: boolean }> {
    const insertResult = await db.query<StreamRow>(sql`
      INSERT INTO streams (
        id, workspace_id, type, display_name, slug, description, visibility,
        parent_stream_id, parent_message_id, root_stream_id,
        companion_mode, companion_persona_id, memory_mode, uniqueness_key, created_by
      ) VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.type},
        ${params.displayName ?? null},
        ${params.slug ?? null},
        ${params.description ?? null},
        ${params.visibility ?? "private"},
        ${params.parentStreamId ?? null},
        ${params.parentMessageId ?? null},
        ${params.rootStreamId ?? null},
        ${params.companionMode ?? "off"},
        ${params.companionPersonaId ?? null},
        ${params.memoryMode ?? "auto"},
        ${params.uniquenessKey},
        ${params.createdBy}
      )
      ON CONFLICT (workspace_id, uniqueness_key)
        WHERE uniqueness_key IS NOT NULL
      DO NOTHING
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)

    if (insertResult.rows.length > 0) {
      return { stream: mapRowToStream(insertResult.rows[0]), created: true }
    }

    const existing = await this.findByUniquenessKey(db, params.workspaceId, params.uniquenessKey)
    if (!existing) {
      throw new Error("Stream uniqueness conflict but existing stream not found")
    }
    return { stream: existing, created: false }
  },

  /**
   * Atomically insert a thread or return the existing one.
   * Uses ON CONFLICT DO NOTHING to handle race conditions where multiple
   * concurrent requests try to create a thread for the same parent message.
   *
   * @returns { stream, created } - The stream and whether it was newly created
   */
  async insertThreadOrFind(db: Querier, params: InsertStreamParams): Promise<{ stream: Stream; created: boolean }> {
    const insertResult = await db.query<StreamRow>(sql`
      INSERT INTO streams (
        id, workspace_id, type, display_name, slug, description, visibility,
        parent_stream_id, parent_message_id, root_stream_id,
        companion_mode, companion_persona_id, memory_mode, uniqueness_key, created_by
      ) VALUES (
        ${params.id},
        ${params.workspaceId},
        ${params.type},
        ${params.displayName ?? null},
        ${params.slug ?? null},
        ${params.description ?? null},
        ${params.visibility ?? "private"},
        ${params.parentStreamId ?? null},
        ${params.parentMessageId ?? null},
        ${params.rootStreamId ?? null},
        ${params.companionMode ?? "off"},
        ${params.companionPersonaId ?? null},
        ${params.memoryMode ?? "auto"},
        ${params.uniquenessKey ?? null},
        ${params.createdBy}
      )
      ON CONFLICT (parent_stream_id, parent_message_id)
        WHERE parent_message_id IS NOT NULL
      DO NOTHING
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)

    if (insertResult.rows.length > 0) {
      return { stream: mapRowToStream(insertResult.rows[0]), created: true }
    }

    const existing = await this.findByParentMessage(db, params.parentStreamId!, params.parentMessageId!)
    if (!existing) {
      throw new Error("Thread creation conflict but existing thread not found")
    }
    return { stream: existing, created: false }
  },

  async update(db: Querier, id: string, params: UpdateStreamParams): Promise<Stream | null> {
    const sets: string[] = []
    const values: unknown[] = []
    let paramIndex = 1

    if (params.displayName !== undefined) {
      sets.push(`display_name = $${paramIndex++}`)
      values.push(params.displayName)
    }
    if (params.slug !== undefined) {
      sets.push(`slug = $${paramIndex++}`)
      values.push(params.slug)
    }
    if (params.description !== undefined) {
      sets.push(`description = $${paramIndex++}`)
      values.push(params.description)
    }
    if (params.descriptionJson !== undefined) {
      sets.push(`description_json = $${paramIndex++}`)
      values.push(params.descriptionJson === null ? null : JSON.stringify(params.descriptionJson))
    }
    if (params.visibility !== undefined) {
      sets.push(`visibility = $${paramIndex++}`)
      values.push(params.visibility)
    }
    if (params.companionMode !== undefined) {
      sets.push(`companion_mode = $${paramIndex++}`)
      values.push(params.companionMode)
    }
    if (params.companionPersonaId !== undefined) {
      sets.push(`companion_persona_id = $${paramIndex++}`)
      values.push(params.companionPersonaId)
    }
    if (params.memoryMode !== undefined) {
      sets.push(`memory_mode = $${paramIndex++}`)
      values.push(params.memoryMode)
    }
    if (params.archivedAt !== undefined) {
      sets.push(`archived_at = $${paramIndex++}`)
      values.push(params.archivedAt)
    }
    if (params.displayNameGeneratedAt !== undefined) {
      sets.push(`display_name_generated_at = $${paramIndex++}`)
      values.push(params.displayNameGeneratedAt)
    }

    if (sets.length === 0) return this.findById(db, id)

    sets.push(`updated_at = NOW()`)
    values.push(id)

    const query = `
      UPDATE streams SET ${sets.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING ${SELECT_FIELDS}
    `
    const result = await db.query<StreamRow>(query, values)
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  async slugExistsInWorkspace(db: Querier, workspaceId: string, slug: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT 1 FROM streams
      WHERE workspace_id = ${workspaceId} AND slug = ${slug}
    `)
    return result.rows.length > 0
  },

  async isPublic(db: Querier, workspaceId: string, streamId: string): Promise<boolean> {
    const result = await db.query(sql`
      SELECT EXISTS(
        SELECT 1 FROM streams
        WHERE id = ${streamId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
          AND visibility = 'public'
      ) AS accessible
    `)
    return result.rows[0].accessible
  },

  /**
   * Insert a system stream for a member.
   * System streams are created atomically with the member in the same transaction,
   * so no ON CONFLICT handling is needed.
   */
  async insertSystemStream(
    db: Querier,
    params: { id: string; workspaceId: string; createdBy: string }
  ): Promise<Stream> {
    const result = await db.query<StreamRow>(sql`
      INSERT INTO streams (
        id, workspace_id, type, display_name, visibility,
        companion_mode, created_by
      ) VALUES (
        ${params.id},
        ${params.workspaceId},
        ${"system"},
        ${"Threa"},
        ${"private"},
        ${"off"},
        ${params.createdBy}
      )
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)

    return mapRowToStream(result.rows[0])
  },

  async findByTypeAndOwner(
    db: Querier,
    workspaceId: string,
    type: StreamType,
    createdBy: string
  ): Promise<Stream | null> {
    const result = await db.query<StreamRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
      WHERE workspace_id = ${workspaceId} AND type = ${type} AND created_by = ${createdBy}
      LIMIT 1
    `)
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  async findByParentMessage(db: Querier, parentStreamId: string, parentMessageId: string): Promise<Stream | null> {
    const result = await db.query<StreamRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)} FROM streams
      WHERE parent_stream_id = ${parentStreamId}
        AND parent_message_id = ${parentMessageId}
    `)
    return result.rows[0] ? mapRowToStream(result.rows[0]) : null
  },

  /**
   * Find all threads for messages in a given parent stream.
   * Returns a map of parentMessageId -> threadStreamId
   */
  async findThreadsForMessages(db: Querier, parentStreamId: string): Promise<Map<string, string>> {
    const result = await db.query<{ parent_message_id: string; id: string }>(sql`
      SELECT parent_message_id, id FROM streams
      WHERE parent_stream_id = ${parentStreamId}
        AND parent_message_id IS NOT NULL
    `)
    const map = new Map<string, string>()
    for (const row of result.rows) {
      map.set(row.parent_message_id, row.id)
    }
    return map
  },

  /**
   * Find threads for a specific set of message IDs within a parent stream.
   * Returns a map of parentMessageId -> threadStreamId
   */
  async findThreadsForMessageIds(
    db: Querier,
    parentStreamId: string,
    messageIds: string[]
  ): Promise<Map<string, string>> {
    if (messageIds.length === 0) return new Map()
    const result = await db.query<{ parent_message_id: string; id: string }>(sql`
      SELECT parent_message_id, id FROM streams
      WHERE parent_stream_id = ${parentStreamId}
        AND parent_message_id = ANY(${messageIds})
    `)
    const map = new Map<string, string>()
    for (const row of result.rows) {
      map.set(row.parent_message_id, row.id)
    }
    return map
  },

  async moveChildThreadsToParent(
    db: Querier,
    params: {
      workspaceId: string
      sourceParentStreamId: string
      destinationParentStreamId: string
      parentMessageIds: string[]
    }
  ): Promise<void> {
    if (params.parentMessageIds.length === 0) return

    // Batch moves only reparent threads inside the same root stream; callers
    // must keep source and destination roots aligned so root_stream_id remains
    // valid. The `workspace_id` filter is defense-in-depth for INV-8 — even
    // if a caller ever passes mismatched stream IDs, this UPDATE will refuse
    // to cross workspace boundaries.
    await db.query(sql`
      UPDATE streams
      SET parent_stream_id = ${params.destinationParentStreamId}, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND parent_stream_id = ${params.sourceParentStreamId}
        AND parent_message_id = ANY(${params.parentMessageIds})
    `)
  },

  /**
   * Find all threads for messages in a given parent stream, including reply counts.
   * Returns a map of parentMessageId -> { threadId, replyCount }
   * Counts only non-deleted replies so bootstrap matches the live thread-summary
   * semantics and doesn't resurrect deleted-only threads after refresh.
   */
  async findThreadsWithReplyCounts(
    db: Querier,
    parentStreamId: string,
    parentMessageIds?: string[]
  ): Promise<Map<string, { threadId: string; replyCount: number }>> {
    // An empty scope matches nothing — skip the round-trip entirely.
    if (parentMessageIds !== undefined && parentMessageIds.length === 0) {
      return new Map<string, { threadId: string; replyCount: number }>()
    }
    // `parentMessageIds === undefined` keeps the whole-stream behavior; passing a
    // list scopes the scan to those parents (bootstrap only needs summaries for
    // the messages in its window, not every thread in the stream). An empty list
    // matches nothing, returning an empty map without scanning.
    const result = await db.query<{ parent_message_id: string; id: string; reply_count: string }>(sql`
      SELECT
        s.parent_message_id,
        s.id,
        COUNT(m.id)::text AS reply_count
      FROM streams s
      LEFT JOIN messages m ON m.stream_id = s.id AND m.deleted_at IS NULL
      WHERE s.parent_stream_id = ${parentStreamId}
        AND s.parent_message_id IS NOT NULL
        AND (${parentMessageIds === undefined} OR s.parent_message_id = ANY(${parentMessageIds ?? []}))
      GROUP BY s.id, s.parent_message_id
    `)
    const map = new Map<string, { threadId: string; replyCount: number }>()
    for (const row of result.rows) {
      map.set(row.parent_message_id, {
        threadId: row.id,
        replyCount: parseInt(row.reply_count, 10),
      })
    }
    return map
  },

  /**
   * For each message in `parentStreamId` that has a thread with at least one
   * non-deleted reply, compute a ThreadSummary: last-reply timestamp, up to
   * three distinct user participant IDs, and the latest reply's
   * messageId/actorId/contentMarkdown.
   *
   * Returns a map keyed by parent message ID. Messages without replies (or
   * with only deleted replies) are absent from the map — callers must treat
   * absence as "no summary."
   *
   * Single CTE-based query (INV-56). `contentMarkdown` is emitted raw; callers
   * rendering it in preview UI strip via `stripMarkdownToInline()` (INV-60).
   *
   * Shares its row shape (`ThreadSummaryRow`) and row-to-domain mapping
   * (`threadSummaryFromRow`) with `findThreadSummaryByParentMessage` so the
   * two entry points cannot drift on their output shape.
   */
  async findThreadSummaries(
    db: Querier,
    parentStreamId: string,
    parentMessageIds?: string[]
  ): Promise<Map<string, ThreadSummary>> {
    // An empty scope matches nothing — skip the round-trip entirely.
    if (parentMessageIds !== undefined && parentMessageIds.length === 0) {
      return new Map<string, ThreadSummary>()
    }
    // `parentMessageIds === undefined` keeps the whole-stream behavior; passing a
    // list scopes the (potentially large) reply scan to just those parents so a
    // bootstrap of a deep stream doesn't summarize every thread it has ever had.
    const result = await db.query<ThreadSummaryRow>(sql`
      WITH thread_messages AS (
        SELECT
          s.parent_message_id,
          m.id,
          m.author_id,
          m.author_type,
          m.content_markdown,
          m.created_at
        FROM streams s
        JOIN messages m ON m.stream_id = s.id
        WHERE s.parent_stream_id = ${parentStreamId}
          AND s.parent_message_id IS NOT NULL
          AND m.deleted_at IS NULL
          AND (${parentMessageIds === undefined} OR s.parent_message_id = ANY(${parentMessageIds ?? []}))
      ),
      latest AS (
        SELECT DISTINCT ON (parent_message_id)
          parent_message_id, id, author_id, author_type, content_markdown, created_at
        FROM thread_messages
        ORDER BY parent_message_id, created_at DESC, id DESC
      ),
      participants_distinct AS (
        -- Pick the earliest reply row per (parent, author) so first_reply_at
        -- and first_reply_id come from the same row. Independent MIN()s could
        -- pair an early timestamp with a later id from the same author and
        -- destabilize the (first_reply_at, first_reply_id) tie-break.
        SELECT DISTINCT ON (parent_message_id, author_id, author_type)
          parent_message_id,
          author_id,
          author_type,
          created_at AS first_reply_at,
          id AS first_reply_id
        FROM thread_messages
        ORDER BY parent_message_id, author_id, author_type, created_at ASC, id ASC
      ),
      participants AS (
        SELECT
          parent_message_id,
          (ARRAY_AGG(author_id ORDER BY first_reply_at, first_reply_id))[1:3] AS author_ids,
          (ARRAY_AGG(author_type ORDER BY first_reply_at, first_reply_id))[1:3] AS author_types
        FROM participants_distinct
        GROUP BY parent_message_id
      )
      SELECT
        l.parent_message_id,
        l.id AS latest_message_id,
        l.author_id AS latest_author_id,
        l.author_type AS latest_author_type,
        l.content_markdown AS latest_content_markdown,
        l.created_at AS last_reply_at,
        COALESCE(p.author_ids, ARRAY[]::TEXT[]) AS participant_ids,
        COALESCE(p.author_types, ARRAY[]::TEXT[]) AS participant_types
      FROM latest l
      LEFT JOIN participants p USING (parent_message_id)
    `)

    const map = new Map<string, ThreadSummary>()
    for (const row of result.rows) {
      map.set(row.parent_message_id, threadSummaryFromRow(row))
    }
    return map
  },

  /**
   * Compute the thread summary for a single parent message. Returns null when
   * the parent has no non-deleted replies. Used by the real-time reply-count
   * path so the frontend can refresh ThreadCard content without waiting for
   * the next bootstrap.
   *
   * Optimized for the single-parent case (direct `parent_message_id` filter,
   * `LIMIT 1` on the latest reply, no per-parent grouping) but produces rows
   * shaped identically to `findThreadSummaries` so the shared
   * `threadSummaryFromRow` mapper can construct the domain object. The parity
   * is covered by a test that asserts both entry points return the same
   * `ThreadSummary` for a given parent.
   */
  async findThreadSummaryByParentMessage(db: Querier, parentMessageId: string): Promise<ThreadSummary | null> {
    const result = await db.query<ThreadSummaryRow>(sql`
      WITH thread_messages AS (
        SELECT
          s.parent_message_id,
          m.id,
          m.author_id,
          m.author_type,
          m.content_markdown,
          m.created_at
        FROM streams s
        JOIN messages m ON m.stream_id = s.id
        WHERE s.parent_message_id = ${parentMessageId}
          AND m.deleted_at IS NULL
      ),
      participants_distinct AS (
        -- Same DISTINCT ON pattern as findThreadSummaries — keep the SQL in
        -- sync so single-parent and batch results agree on participant order.
        SELECT DISTINCT ON (author_id, author_type)
          author_id,
          author_type,
          created_at AS first_reply_at,
          id AS first_reply_id
        FROM thread_messages
        ORDER BY author_id, author_type, created_at ASC, id ASC
      ),
      participants AS (
        SELECT
          (ARRAY_AGG(author_id ORDER BY first_reply_at, first_reply_id))[1:3] AS author_ids,
          (ARRAY_AGG(author_type ORDER BY first_reply_at, first_reply_id))[1:3] AS author_types
        FROM participants_distinct
      )
      SELECT
        l.parent_message_id,
        l.id AS latest_message_id,
        l.author_id AS latest_author_id,
        l.author_type AS latest_author_type,
        l.content_markdown AS latest_content_markdown,
        l.created_at AS last_reply_at,
        COALESCE((SELECT author_ids FROM participants), ARRAY[]::TEXT[]) AS participant_ids,
        COALESCE((SELECT author_types FROM participants), ARRAY[]::TEXT[]) AS participant_types
      FROM thread_messages l
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 1
    `)

    if (result.rows.length === 0) return null
    return threadSummaryFromRow(result.rows[0])
  },

  /**
   * Search for streams by display name or slug.
   * Uses pg_trgm trigram similarity for fuzzy matching (handles typos),
   * combined with ILIKE for exact substring matches.
   * Only searches within the provided stream IDs (for access control).
   */
  async searchByName(
    db: Querier,
    params: {
      streamIds: string[]
      query: string
      types?: StreamType[]
      limit?: number
    }
  ): Promise<Stream[]> {
    const { streamIds, query, types, limit = 10 } = params
    if (streamIds.length === 0) return []

    const pattern = `%${query}%`

    // Use separate queries for type-filtered vs unfiltered to avoid nested sql fragments
    if (types && types.length > 0) {
      const result = await db.query<StreamRow>(sql`
        SELECT ${sql.raw(SELECT_FIELDS)},
          GREATEST(
            COALESCE(similarity(display_name, ${query}), 0),
            COALESCE(similarity(slug, ${query}), 0)
          ) AS sim_score
        FROM streams
        WHERE id = ANY(${streamIds})
          AND type = ANY(${types})
          AND ${sql.raw(purposeIsNull())}
          AND (
            display_name % ${query}
            OR slug % ${query}
            OR display_name ILIKE ${pattern}
            OR slug ILIKE ${pattern}
          )
        ORDER BY sim_score DESC, display_name NULLS LAST
        LIMIT ${limit}
      `)
      return result.rows.map(mapRowToStream)
    }

    const result = await db.query<StreamRow>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)},
        GREATEST(
          COALESCE(similarity(display_name, ${query}), 0),
          COALESCE(similarity(slug, ${query}), 0)
        ) AS sim_score
      FROM streams
      WHERE id = ANY(${streamIds})
        AND ${sql.raw(purposeIsNull())}
        AND (
          display_name % ${query}
          OR slug % ${query}
          OR display_name ILIKE ${pattern}
          OR slug ILIKE ${pattern}
        )
      ORDER BY sim_score DESC, display_name NULLS LAST
      LIMIT ${limit}
    `)
    return result.rows.map(mapRowToStream)
  },
}
