import { sql } from "../../db"
import type { Querier } from "../../db"

export interface StreamSandboxRow {
  workspaceId: string
  streamId: string
  sandboxId: string
  runner: string
  internet: boolean
  /** Streams the box's files may hold content from. */
  contentStreamIds: string[]
}

const SELECT_FIELDS = `workspace_id, stream_id, sandbox_id, runner, internet, content_stream_ids`

function mapRow(row: Record<string, unknown>): StreamSandboxRow {
  return {
    workspaceId: row.workspace_id as string,
    streamId: row.stream_id as string,
    sandboxId: row.sandbox_id as string,
    runner: row.runner as string,
    internet: row.internet as boolean,
    contentStreamIds: row.content_stream_ids as string[],
  }
}

interface SandboxBinding {
  workspaceId: string
  streamId: string
  sandboxId: string
  runner: string
  internet: boolean
}

export const StreamSandboxRepository = {
  async find(db: Querier, workspaceId: string, streamId: string): Promise<StreamSandboxRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      SELECT ${sql.raw(SELECT_FIELDS)}
      FROM stream_sandboxes
      WHERE workspace_id = ${workspaceId} AND stream_id = ${streamId}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Null when another caller bound a sandbox to the stream first. */
  async insertIfAbsent(db: Querier, binding: SandboxBinding): Promise<StreamSandboxRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      INSERT INTO stream_sandboxes (workspace_id, stream_id, sandbox_id, runner, internet)
      VALUES (${binding.workspaceId}, ${binding.streamId}, ${binding.sandboxId}, ${binding.runner}, ${binding.internet})
      ON CONFLICT (workspace_id, stream_id) DO NOTHING
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** Null when the stream's sandbox is no longer `expectedSandboxId`. */
  async replace(
    db: Querier,
    binding: SandboxBinding & { expectedSandboxId: string }
  ): Promise<StreamSandboxRow | null> {
    const result = await db.query<Record<string, unknown>>(sql`
      UPDATE stream_sandboxes
      SET sandbox_id = ${binding.sandboxId}, runner = ${binding.runner}, internet = ${binding.internet},
        content_stream_ids = '{}', created_at = NOW()
      WHERE workspace_id = ${binding.workspaceId}
        AND stream_id = ${binding.streamId}
        AND sandbox_id = ${binding.expectedSandboxId}
      RETURNING ${sql.raw(SELECT_FIELDS)}
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /** False when the stream's sandbox is no longer `sandboxId`. */
  async addContent(
    db: Querier,
    params: { workspaceId: string; streamId: string; sandboxId: string; streamIds: string[] }
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE stream_sandboxes
      SET content_stream_ids = ARRAY(SELECT DISTINCT unnest(content_stream_ids || ${params.streamIds}::text[]))
      WHERE workspace_id = ${params.workspaceId}
        AND stream_id = ${params.streamId}
        AND sandbox_id = ${params.sandboxId}
      RETURNING sandbox_id
    `)
    return result.rows.length > 0
  },
}

interface SandboxLease {
  workspaceId: string
  streamId: string
  leaseId: string
}

export const StreamSandboxLeaseRepository = {
  /** True when `leaseId` now holds the stream's sandbox: nobody held it, or the holder's lease expired. */
  async take(db: Querier, lease: SandboxLease & { ttlSec: number }): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO stream_sandbox_leases (workspace_id, stream_id, lease_id, expires_at)
      VALUES (${lease.workspaceId}, ${lease.streamId}, ${lease.leaseId}, NOW() + make_interval(secs => ${lease.ttlSec}))
      ON CONFLICT (workspace_id, stream_id) DO UPDATE
        SET lease_id = EXCLUDED.lease_id, expires_at = EXCLUDED.expires_at
        WHERE stream_sandbox_leases.expires_at < NOW()
      RETURNING lease_id
    `)
    return result.rows.length > 0
  },

  /** False when the lease expired and someone else took it. */
  async renew(db: Querier, lease: SandboxLease & { ttlSec: number }): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE stream_sandbox_leases
      SET expires_at = NOW() + make_interval(secs => ${lease.ttlSec})
      WHERE workspace_id = ${lease.workspaceId} AND stream_id = ${lease.streamId} AND lease_id = ${lease.leaseId}
      RETURNING lease_id
    `)
    return result.rows.length > 0
  },

  async release(db: Querier, lease: SandboxLease): Promise<void> {
    await db.query(sql`
      DELETE FROM stream_sandbox_leases
      WHERE workspace_id = ${lease.workspaceId} AND stream_id = ${lease.streamId} AND lease_id = ${lease.leaseId}
    `)
  },
}
