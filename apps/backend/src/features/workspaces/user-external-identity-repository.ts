import type { Querier } from "../../db"
import { sql } from "../../db"

export interface ExternalIdentity {
  provider: string
  externalTeamId: string
  externalUserId: string
}

export interface UserExternalIdentity extends ExternalIdentity {
  userId: string
}

interface UserExternalIdentityRow {
  provider: string
  external_team_id: string
  external_user_id: string
  user_id: string
}

function mapRow(row: UserExternalIdentityRow): UserExternalIdentity {
  return {
    provider: row.provider,
    externalTeamId: row.external_team_id,
    externalUserId: row.external_user_id,
    userId: row.user_id,
  }
}

export const UserExternalIdentityRepository = {
  async findByIdentities(
    db: Querier,
    workspaceId: string,
    identities: ExternalIdentity[]
  ): Promise<UserExternalIdentity[]> {
    if (identities.length === 0) return []

    const result = await db.query<UserExternalIdentityRow>(sql`
      SELECT i.provider, i.external_team_id, i.external_user_id, i.user_id
      FROM user_external_identities i
      JOIN unnest(
        ${identities.map((identity) => identity.provider)}::text[],
        ${identities.map((identity) => identity.externalTeamId)}::text[],
        ${identities.map((identity) => identity.externalUserId)}::text[]
      ) AS wanted(provider, external_team_id, external_user_id)
        ON wanted.provider = i.provider
        AND wanted.external_team_id = i.external_team_id
        AND wanted.external_user_id = i.external_user_id
      WHERE i.workspace_id = ${workspaceId}
    `)
    return result.rows.map(mapRow)
  },

  async insertManyIfAbsent(db: Querier, workspaceId: string, links: UserExternalIdentity[]): Promise<void> {
    if (links.length === 0) return

    await db.query(sql`
      INSERT INTO user_external_identities (workspace_id, provider, external_team_id, external_user_id, user_id)
      SELECT ${workspaceId}::text, provider, external_team_id, external_user_id, user_id
      FROM unnest(
        ${links.map((link) => link.provider)}::text[],
        ${links.map((link) => link.externalTeamId)}::text[],
        ${links.map((link) => link.externalUserId)}::text[],
        ${links.map((link) => link.userId)}::text[]
      ) AS link(provider, external_team_id, external_user_id, user_id)
      ON CONFLICT DO NOTHING
    `)
  },

  async deleteForUser(db: Querier, workspaceId: string, userId: string): Promise<void> {
    await db.query(sql`
      DELETE FROM user_external_identities WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    `)
  },
}
