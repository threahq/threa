import type { QueryConfig } from "pg"
import { AuthoredByKinds } from "@threahq/types"
import { composeSql, sql, type Querier } from "../../db"
import { roomReadableWithoutMembershipSql, roomReadersAllBrowseSql, streamAccessPredicateSql } from "../streams"
import { anyUserLacksBrowseSql } from "../workspaces"

/**
 * Who reads a memo's content once it leaves the repository. Every source stream of an agent-authored
 * memo must be readable by the whole audience:
 * - `users`: each listed user reads it, resolving threads to their roots.
 * - `room`: everyone in the room reads it, so a source is the room's own root or open to the whole
 *   room. A `QueryConfig` correlates the room to an outer row.
 * - `streams`: a principal with a fixed readable set and unknown downstream readers (bot keys,
 *   sandbox sessions); a source or its root is in the set. `browses` is whether the principal
 *   counts as a browsing workspace reader.
 */
export type MemoAudience =
  | { kind: "users"; userIds: readonly string[] }
  | { kind: "room"; roomStreamId: string | QueryConfig }
  | { kind: "streams"; streamIds: readonly string[]; browses: boolean }

const ALWAYS = sql`TRUE`
const NEVER = sql`FALSE`

function allOf(conditions: readonly QueryConfig[]): QueryConfig {
  return conditions.reduce<QueryConfig>((all, condition) => composeSql`${all} AND ${condition}`, ALWAYS)
}

/** Whether every reader the audience stands for browses the workspace. */
function audienceBrowsesSql(workspaceId: string, audience: MemoAudience): QueryConfig {
  switch (audience.kind) {
    case "users":
      return audience.userIds.length === 0
        ? NEVER
        : composeSql`NOT ${anyUserLacksBrowseSql(
            workspaceId,
            composeSql`SELECT t.id FROM unnest(${audience.userIds as string[]}::text[]) AS t(id)`
          )}`
    case "room":
      return roomReadersAllBrowseSql(workspaceId, audience.roomStreamId)
    case "streams":
      return audience.browses ? ALWAYS : NEVER
  }
}

export async function audienceBrowses(db: Querier, workspaceId: string, audience: MemoAudience): Promise<boolean> {
  const { rows } = await db.query<{ browses: boolean }>(
    composeSql`SELECT ${audienceBrowsesSql(workspaceId, audience)} AS browses`
  )
  return rows[0].browses
}

/** Whether the audience can read what an agent memo without recorded sources was written from: unknown, so only people who browse the workspace. */
function legacyAgentMemoVisibleSql(workspaceId: string, audience: MemoAudience): QueryConfig {
  return audience.kind === "streams" ? NEVER : audienceBrowsesSql(workspaceId, audience)
}

/** Whether the audience reads the source stream `prov.id`, whose row is `ps` and its effective root `pr`; NULL when the stream is missing. */
function sourceReadableSql(workspaceId: string, audience: MemoAudience): QueryConfig {
  switch (audience.kind) {
    case "users":
      return audience.userIds.length === 0
        ? NEVER
        : allOf(audience.userIds.map((userId) => streamAccessPredicateSql(workspaceId, userId, "prov.id")))
    case "room":
      return composeSql`(pr.id = ${audience.roomStreamId} OR ${roomReadableWithoutMembershipSql(workspaceId, audience.roomStreamId, "pr")})`
    case "streams":
      return composeSql`(ps.id = ANY(${audience.streamIds as string[]}) OR pr.id = ANY(${audience.streamIds as string[]}))`
  }
}

function audienceVisibleSql(workspaceId: string, audience: MemoAudience, memoAlias: string): QueryConfig {
  const memo = sql`${sql.raw(memoAlias)}`
  return composeSql`(
    CASE
      WHEN COALESCE(cardinality(${memo}.source_stream_ids), 0) = 0
        THEN (${memo}.authored_by_kind <> ${AuthoredByKinds.AGENT} OR ${legacyAgentMemoVisibleSql(workspaceId, audience)})
      ELSE (NOT ${memo}.requires_browse OR ${audienceBrowsesSql(workspaceId, audience)}) AND NOT EXISTS (
        SELECT 1
        FROM unnest(${memo}.source_stream_ids) AS prov(id)
        LEFT JOIN streams ps ON ps.id = prov.id AND ps.workspace_id = ${workspaceId}
        LEFT JOIN streams pr ON pr.id = COALESCE(ps.root_stream_id, ps.id) AND pr.workspace_id = ${workspaceId}
        WHERE NOT COALESCE(${sourceReadableSql(workspaceId, audience)}, FALSE)
      )
    END
  )`
}

/**
 * True when every audience may read the memo `memoAlias` names (a trusted SQL alias, never user
 * input). Memos with no recorded sources are governed by their location unless an agent wrote them:
 * those are legacy and visible only where every reader browses the workspace. An agent memo that
 * `requires_browse` is likewise visible only where every reader browses, and a source that matches
 * no stream hides the memo. No audiences means no gate.
 */
export function memoAudienceVisibleSql(
  workspaceId: string,
  audiences: readonly MemoAudience[],
  memoAlias: string
): QueryConfig {
  return allOf(audiences.map((audience) => audienceVisibleSql(workspaceId, audience, memoAlias)))
}
