import type { Querier } from "../../db"
import { sql } from "../../db"

/**
 * Per-channel dedup clock for proactive owner re-wrap nudges (see the
 * `enclave_rewrap_notifications` migration). Each `claim*` method is a
 * compare-and-set: it stamps the channel's clock and returns whether THIS
 * caller won the right to emit, so a stream stuck unservable across many claim
 * polls (and many enclave instances) emits at most once per re-emit window.
 * The guard lives in the upsert's conflict clause, so the dedup holds under
 * concurrent pollers without a lock (INV-20).
 */
export const EnclaveRewrapNotificationsRepository = {
  /**
   * Try to claim the socket-nudge slot for a (workspace, root stream). Returns
   * true when the slot was free or its window has elapsed (caller emits), false
   * when another poller emitted within `reemitMs` (caller stays quiet). The
   * first insert always wins; a re-emit wins only once the prior stamp is older
   * than the window.
   */
  async claimSocketNudge(
    db: Querier,
    params: { workspaceId: string; rootStreamId: string; reemitMs: number }
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO enclave_rewrap_notifications (workspace_id, root_stream_id, last_socket_emit_at)
      VALUES (${params.workspaceId}, ${params.rootStreamId}, NOW())
      ON CONFLICT (workspace_id, root_stream_id) DO UPDATE
        SET last_socket_emit_at = NOW(), updated_at = NOW()
        WHERE enclave_rewrap_notifications.last_socket_emit_at IS NULL
           OR enclave_rewrap_notifications.last_socket_emit_at
              < NOW() - (${params.reemitMs} || ' milliseconds')::interval
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Try to claim the web-push-nudge slot for a (workspace, root stream). Same
   * compare-and-set as the socket slot, on its own independent clock — the
   * graced offline nudge re-arms on a longer window than the socket signal.
   */
  async claimWebpushNudge(
    db: Querier,
    params: { workspaceId: string; rootStreamId: string; reemitMs: number }
  ): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO enclave_rewrap_notifications (workspace_id, root_stream_id, last_webpush_emit_at)
      VALUES (${params.workspaceId}, ${params.rootStreamId}, NOW())
      ON CONFLICT (workspace_id, root_stream_id) DO UPDATE
        SET last_webpush_emit_at = NOW(), updated_at = NOW()
        WHERE enclave_rewrap_notifications.last_webpush_emit_at IS NULL
           OR enclave_rewrap_notifications.last_webpush_emit_at
              < NOW() - (${params.reemitMs} || ' milliseconds')::interval
    `)
    return (result.rowCount ?? 0) > 0
  },
}
